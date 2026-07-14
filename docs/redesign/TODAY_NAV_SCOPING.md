# Today page — nav + card-count scoping doc

**Read-only investigation.** Branch `feat/mobile-hardening`. Client
`client/src/`, server `server/src/`. No code was changed to produce this
document.

---

## A. Card-count mismatch — "665 due" (Today) vs "0 cards due" (`/learn/vocab`)

### A1. Where Today's number comes from

`Today.tsx:373-376` fetches the plan via `useEndpointOrMock('today', ...,
{ realFn: () => fetchToday() })`. `fetchToday` (`client/src/services/plan.ts:44-56`)
calls `GET /plan/today` and maps the wire field `dueCount` onto the domain
field `reviewCount`. The Vocab tile (`Today.tsx:613-624`) renders
`today.data.reviewCount` directly as "N cards due" / "N장" and its `onClick`
navigates to `/learn/vocab` (`Today.tsx:633-637`).

Server-side, `server/src/routes/plan.ts:212-222`:

```sql
SELECT count(*)::int AS due_count
  FROM vocab_cards
 WHERE user_id = $1
   AND due_at <= now()
   AND suspended_at IS NULL
   AND deleted_at IS NULL
   AND hanja_character_id IS NULL
```

This is an **unbounded, exact total** — every non-suspended, non-deleted,
non-hanja `vocab_cards` row whose `due_at` has passed, for this user, full
stop. No `LIMIT`. This is the "665."

### A2. Where `/learn/vocab`'s number comes from

`/learn/vocab` renders `Review.tsx`. The landing view (`Review.tsx:667-691`,
rendered when there's no `?list=`/`?study=` param — i.e. exactly where Today's
Vocab tile lands) shows a "Review queue" card whose count is `dueCount`, wired
from `due.data?.length ?? null` (`Review.tsx:673`, `LandingView` prop
`dueCount`). `due` is `useEndpointOrMock('review:due', ..., { realFn: dueRealFn })`
(`Review.tsx:495-497`), and `dueRealFn` (`Review.tsx:463-476`):

```ts
const rows = await vocabService.getDueCards();   // no limit arg
const grammar: GrammarProductionCard[] = [];
const ui: StudyCard[] = [];
for (const d of rows) {
  if (isGrammarProductionCard(d)) { grammar.push(dueCardToGrammar(d)); continue; }
  ui.push(dueCardToStudyCard(d));
}
setGrammarCards(...grammar...);
return ui;   // due.data — this is what dueCount = .length reads
```

`getDueCards()` (`client/src/services/vocab.ts:187-197`) calls
`GET /vocab/cards/due` with **no `limit` param**, so the server default
applies. Server-side, `server/src/routes/vocab.ts:169-171,222-289`:

```ts
const DueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
...
SELECT c.id, c.face, ... 
  FROM vocab_cards c
  LEFT JOIN vocab_entries ve ON ve.id = c.vocab_entry_id
  LEFT JOIN grammar_entries ge ON ge.id = c.grammar_entry_id AND ge.user_id = c.user_id AND ge.deleted_at IS NULL
 WHERE c.user_id = $1
   AND c.deleted_at IS NULL
   AND c.suspended_at IS NULL
   AND c.due_at <= now()
   AND (c.grammar_entry_id IS NULL OR ge.graduated_at IS NULL)
   AND c.hanja_character_id IS NULL
 ORDER BY c.due_at
 LIMIT $2
res.status(200).json({ cards });   // <-- no `total` field at all
```

### A3. Why they differ — root cause (structural, confirmed)

1. **`/vocab/cards/due` returns a PAGE, not a total.** It has no
   `COUNT(*) OVER()` window field (contrast the sibling list route just above
   it in the same file, `vocab.ts:150-160`, which *does* carry a `total` this
   way). The route's only signal of "how many are due" is `cards.length` of
   whatever page came back — capped at the Zod default `limit: 20` when the
   client omits the param (which it does here), and hard-capped at `200` even
   if the client asked for more. **`/learn/vocab`'s displayed count can
   structurally never exceed ~20 (or 200 with a code change), no matter how
   large the real due backlog is.** This alone explains an order-of-magnitude
   gap between "665" and whatever small number the landing page could ever
   show.
2. **The client further shrinks that page.** `dueRealFn` partitions the
   already-tiny page into `ui` (plain vocab/sentence/topik cards → counted)
   and `grammar` (production cards bound for the Grammar Drill tab →
   NOT counted in `dueCount`, shown in a separate "Grammar production" row
   instead). Because the query orders `ORDER BY c.due_at` (oldest-overdue
   first), if the oldest ~20 overdue rows in a large backlog happen to skew
   toward grammar-production cards (plausible for an account with a long
   grammar-drill history), `ui.length` can land at exactly **0** even though
   the page fetch itself succeeded and the true backlog is huge. This is the
   most likely proximate explanation for the specific value "0" the user saw
   — not provable without a live DB inspection, but it is consistent with
   every piece of code above and requires no other assumption.
3. **Perception nuance for the builder:** when `dueCount === 0` (not `null`,
   not errored) and `grammarCards.length === 0`, `LandingView`'s
   `hasDueWork` (`Review.tsx:761-762`) is `false`, so the **entire** "Review
   queue" section (`Review.tsx:861-896`) is omitted from the DOM — there is
   no literal "0 cards due" string rendered anywhere. The user's "shows 0
   cards due" is an accurate *functional* description (nothing to review is
   surfaced) but the fix must not assume there's a literal "0" text node to
   go find.
4. **Secondary, minor contributor:** Today's count does not exclude
   graduated grammar-production cards (`ge.graduated_at IS NOT NULL`) the way
   `/vocab/cards/due` does. A user with many graduated patterns still sitting
   in `vocab_cards` with a past `due_at` would see Today's total slightly
   *higher* than the true actionable-vocab backlog even after fixing (1)/(2).
   Minor relative to the LIMIT-20 gap, but worth folding into a single
   source of truth (see recommendation below) rather than leaving two
   independently-drifting predicates.

### A4. What "Due now → click" should open, and the reconciliation fix

**What it should open:** the actual FSRS due-review flashcard session, i.e.
`/learn/vocab?study=due` (`Review.tsx:608-631`, the `study === 'due'` branch —
already a fully-built, working session view). Today's Vocab tile currently
navigates to bare `/learn/vocab` (the lists-first landing, `Review.tsx:667`),
which requires an *extra* tap (scroll to "Review queue" → tap "Study") before
the user reaches the thing the tile promised. This is itself a Part-B
deep-link gap — see the per-tile table below — but it also matters for
reconciliation: whichever screen the user lands on must show a due-count that
matches what they're about to study.

**Recommended fix (server + client, both additive):**

1. **Server:** give `/vocab/cards/due` a real, unbounded `total` — either (a)
   a `COUNT(*) OVER()` window column on the existing query (matches the house
   pattern at `vocab.ts:150-160`) restricted by the *same* WHERE the page
   uses (i.e. including the `graduated_at` exclusion — this becomes the
   single canonical "how many vocab cards are actually due" predicate), or
   (b) a tiny dedicated `GET /vocab/cards/due/count` if a separate lightweight
   endpoint is preferred (Today doesn't need the row payload, only the
   count). Either way this is a pure **additive** response-shape change — new
   field/new route, no migration, no breaking change to existing consumers.
2. **Server:** make `plan.ts`'s `dueCount` query consume the *same* predicate
   (add the `graduated_at` exclusion) so there is one source of truth for
   "cards due," not two hand-maintained copies that can silently diverge
   again.
3. **Client:** `Review.tsx`'s `LandingView` due-count should read the new
   `total` field instead of `due.data?.length` — decoupling "how many cards
   are due" from "how many rows did this one page fetch."
4. **Client:** Today's Vocab tile `onClick` should navigate to
   `/learn/vocab?study=due` instead of bare `/learn/vocab` (Part B, but
   listed here too since it's the other half of "the number and the click
   target must describe the same thing").

With (1)+(2)+(3), Today's number and `/learn/vocab`'s landing-page number
become the same computation, and (4) makes the click land directly in the
session that count describes.

---

## B. Tiles don't deep-link to the referenced item

Route table (`client/src/App.tsx:131-137`):

| Path | Element |
|---|---|
| `/learn/topik` | `Topik.tsx` |
| `/learn/listen` | `Ttmik.tsx` |
| `/learn/vocab` | `Review.tsx` |
| `/learn/grammar` | `Grammar.tsx` |
| `/learn/writing` | `Writing.tsx` |
| `/learn/hanja` | `Hanja.tsx` |
| `/learn/reading` | `Reading.tsx` |

Key structural fact used throughout this section: **`TodayTask`
(`client/src/types/domain.ts:505-510`) carries only `{ title, mins, level,
tag }` — no id of any kind.** `plan.ts` never selects the underlying row's
identifying columns (`ttmik_lessons.lesson_level`/`lesson_number`,
`iyagi_episodes.episode_number`, `writing_prompts.id`), only `l.id`/`e.id`
internally for the per-day hash and never returns them. So **no tile can be
deep-linked today without a server change** — the client has nothing to link
with even where the target page already supports a deep link.

### B1. Vocab / Due now

- **Item shown:** `today.data.reviewCount` (a count, not a specific card).
- **Current nav:** `navigate('/learn/vocab')` (`Today.tsx:636`) → landing.
- **Target support:** `/learn/vocab?study=due` already exists and is fully
  built (`Review.tsx:608-631`, reachable today only via the landing page's
  own "Study" button, `Review.tsx:882-889`).
- **Fix:** client-only. Change the tile's `onClick` to
  `navigate('/learn/vocab?study=due')`. No server change needed for the nav
  itself (the count fix in A4 is separate/parallel).

### B2. Grammar

- **Item shown:** none — the tile is static ("Grammar drills" / generic copy,
  `Today.tsx:643-671`). Today never surfaces a *specific* grammar pattern on
  this tile (contrast the due-queue's "Grammar production" section on
  `/learn/vocab`, which does show specific patterns and already deep-links
  via `drillTarget`, see B-below).
- **Current nav:** `navigate('/learn/grammar')` → landing. **This is correct
  as-is** — there is no specific item to deep-link to.
- **Target support (for context/reuse):** `Grammar.tsx` already accepts a
  one-shot deep link via `location.state.drillTarget` (`Grammar.tsx:190-210,
  432-458`) — exactly the mechanism `Review.tsx`'s own due-queue Grammar
  section uses (`Review.tsx:545-558`). If a future iteration wants Today's
  Grammar tile to show and drill a *specific* banked pattern, this mechanism
  already exists; it's simply unused by Today today because Today has no
  specific pattern to show.
- **Fix:** none required for B. (Possible future feature, not a bug.)

### B3. Hanja

- **Item shown:** none — static tile (`Today.tsx:673-694`), same shape as
  Grammar.
- **Current nav:** `navigate('/learn/hanja')` → landing. **Correct as-is.**
- **Fix:** none required.

### B4. Reading

- **Item shown:** a specific `ttmik_lessons` row's `title`
  (`plan.ts:247-273`, `today.data.reading.title`).
- **Current nav:** `navigate('/learn/reading')` (`Today.tsx:478`).
- **Target support — WRONG DOMAIN, not just "not deep-linked":**
  `Reading.tsx` (`/learn/reading`) is the uploaded-books/AI-generated-story
  reader — its content model is `reading_chapters`/`reading_passages`
  (migration 044) and Claude-generated stories (`?book=`, `?chapter=`,
  `?story=` params, `Reading.tsx:183-191`). It has **no relationship at all**
  to `ttmik_lessons` (confirmed: no reference to `ttmik_lessons`/
  `ttmik_sentences` anywhere in `server/src/routes/reading.ts` or
  `client/src/services/reading.ts`). TTMIK lesson content (the actual row
  Today's Reading tile displays) is served from a **different page entirely**
  — `Ttmik.tsx` at `/learn/listen`, via `?corpus=ttmik&level=N&lesson=N`
  (`Ttmik.tsx:399-435`; server `GET /ttmik/lessons/:level/:number`,
  `server/src/routes/ttmik.ts:176-227`). TTMIK lessons carry real "reading"
  content (`transcript`/`highlights` text, per `ttmik.ts:11-23`) alongside
  optional audio — they are legitimately a reading task, just hosted on the
  "Listen" page's `corpus=ttmik` tab, not on the page literally named
  Reading.
- **This means clicking Today's "Reading" tile today does not just fail to
  deep-link — it sends the user to a feature (personal book/story library)
  that has nothing to do with the lesson title they just saw.** This is the
  most severe finding in Part B and needs a product decision, not just a
  code fix:
  - **Option 1 (repoint):** change the tile's `onClick` to navigate to
    `/learn/listen?corpus=ttmik&level=<L>&lesson=<N>` (same domain as the
    content actually shown). Requires `plan.ts` to additionally
    `SELECT l.lesson_level, l.lesson_number` and return them on the wire
    (`reading: { ..., level: number, lesson: number }` — additive field(s)
    alongside the existing `level: LevelLabel` display string, which must
    stay for the tile's own "L3/L4/L5+" badge — name the new fields
    distinctly, e.g. `lessonLevel`/`lessonNumber`, to avoid colliding with
    the existing `level: LevelLabel`).
  - **Option 2 (re-source):** keep `/learn/reading` as the tile's target, but
    change what `plan.ts`'s "reading" task selects — pull from
    `reading_chapters`/generated stories instead of `ttmik_lessons`, so the
    displayed title and the click target actually agree. This changes the
    *content* Today recommends for reading, not just the nav, and needs
    product sign-off on whether the daily-rotation/leveling logic
    (`estimateToBookLevel`, `planDateSql` hash) has an equivalent in the
    `reading_chapters` domain.
  - This scoping doc does not pick between them — flag to the user/product
    owner before a builder implements either.

### B5. Listening

- **Item shown:** a specific `iyagi_episodes` row's `title`
  (`plan.ts:275-298`).
- **Current nav:** `navigate('/learn/listen')` (`Today.tsx:502`) — **correct
  domain** (Iyagi is hosted on this same page), but bare, so it lands on
  `Ttmik.tsx`'s corpus-picker `landing` view (`parseListenView` returns
  `{ kind: 'landing' }` when no `corpus` param, `Ttmik.tsx:404-427`), not the
  specific episode.
- **Target support:** `/learn/listen?corpus=iyagi&episode=N` already works
  (`Ttmik.tsx:416-421`, `episodePath()` builder at `Ttmik.tsx:434-436`).
- **Fix:** server + client.
  - **Server (additive):** `plan.ts`'s listening query
    (`plan.ts:278-290`) selects `e.title` and a derived `sentence_count` from
    `e.id` but never selects `e.episode_number` (the column
    `Ttmik.tsx`/`ttmik.ts` key episodes by, confirmed distinct from `id` at
    `ttmik.ts:258-262,283-284`). Add `e.episode_number AS episode_number` to
    the SELECT and return it as a new field, e.g.
    `listening: { ..., episodeNumber: number }`.
  - **Client:** change the tile's `onClick` to
    `navigate('/learn/listen?corpus=iyagi&episode=' + episodeNumber)`.

### B6. Writing

- **Item shown:** a specific `writing_prompts` row's `title`
  (`plan.ts:300-337`).
- **Current nav:** `navigate('/learn/writing')` (`Today.tsx:539`) — correct
  domain, but bare.
- **Target support — partial, and not the same mechanism the doc comment
  implies:** `Writing.tsx` accepts a one-shot deep link via
  `location.state.generatedTopic` (`Writing.tsx:287-316, 377-408`), but that
  path is specifically for **Claude-generated free topics**
  (`GeneratedWritingPrompt`, `source: 'generated'`) produced by
  `WritingTopicGenerator` — it is a *different* code path from the
  **bank prompt** flow that actually serves `writing_prompts` rows. Bank
  prompts are fetched **randomly** — `fetchRandomWritingPrompt(rubric)`
  (`Writing.tsx:445-485`) — with no existing way to request one **specific**
  bank prompt by id; the only per-prompt identifier used client-side today
  is `task.prompt.id` handed back to the grading endpoint *after* a prompt
  was already randomly drawn (`Writing.tsx:517-527`), not used for lookup.
  Today's Writing tile shows a specific bank row (deterministic per-day pick,
  same `md5(...)` idiom as Reading/Listening) but there is **no mechanism at
  all today to open that exact bank prompt** — reusing `generatedTopic`
  would be a lie (it's not Claude-generated, it's a bank row) and would also
  desync `promptId` from the grading call's `source: 'bank'` contract.
- **Fix:** server + client, and this is the one tile needing a genuinely new
  mechanism rather than reuse of an existing one.
  - **Server (additive):** `plan.ts`'s writing query
    (`plan.ts:306-321`) never selects `id`. Add `id` to the SELECT and return
    it, e.g. `writing: { ..., promptId: number }`.
  - **Server (additive, likely needed):** `Writing.tsx`'s bank flow has no
    "fetch prompt by id" call today — only "fetch one random active prompt
    for a rubric" (`fetchRandomWritingPrompt`). Add a small
    `GET /writing/prompts/:id` (or extend the existing random-prompt route
    to accept an optional `id` param) returning the same
    `GeneratedWritingPrompt`-shaped payload the random draw returns, gated
    the same way (`is_active`/`rubric IS NOT NULL`, matching `plan.ts`'s own
    `rubric IS NOT NULL` invariant, `plan.ts:301-305`).
  - **Client:** add a new `location.state` shape, e.g.
    `{ bankPromptId: number }`, read it in `Writing.tsx` alongside
    `readGeneratedTopic`, and on presence fetch that specific prompt via the
    new route instead of falling into the random-draw effect
    (`Writing.tsx:449-485`). Today's tile passes
    `navigate('/learn/writing', { state: { bankPromptId: today.data.writing... } })`.

### B7. TOPIK (main tile + F-007 resume banner)

- **Item shown (main tile):** none specific — generic "TOPIK study practice" /
  "Shuffled past questions, one at a time" (`Today.tsx:762-780`), which
  describes **Study mode**, not Mock mode.
- **Item shown (resume banner):** a specific in-progress **mock exam**
  attempt (`AttemptState`, section + answered count,
  `Today.tsx:440-454`), fetched via `fetchAttempt()` — the same
  `GET /topik/attempt` the Mock-mode UI itself polls on mount
  (`MockMode.tsx:413`, `client/src/services/topik.ts:189-197`).
- **Current nav (both):** bare `navigate('/learn/topik')`
  (`Today.tsx:448-449, 777-778`).
- **Target support, and a confirmed bug:** `Topik.tsx` gates every **fresh**
  visit (no `?mode=` param) behind a Study/Mock **chooser sheet**
  (`chooserOpen` seeded from `searchParams.get('mode') === null`,
  `Topik.tsx:216-225`). The code's own comment says: *"a deep link that
  already names an explicit mode (Today's 'Mock' tile, a bookmarked URL)
  skips the chooser"* (`Topik.tsx:218`) — i.e. the mechanism to skip straight
  to Mock mode (`?mode=mock`) already exists and the comment explicitly
  anticipates Today using it. **Today's actual `onClick` handlers never set
  `mode=mock`** — both the main tile and the resume banner navigate bare, so
  every click (including "Resume exam") lands on the chooser sheet first,
  requiring an extra tap before `MockMode.tsx`'s own resume-detection
  (`fetchAttempt` on mount, `MockMode.tsx:413`, `resumeAttempt`,
  `MockMode.tsx:450`) can even run. **This is a real, independently-provable
  regression**, not a "nice to have": the resume banner's entire purpose
  (one-tap resume of an in-progress exam) is defeated by a missing query
  param the surrounding code was clearly written to expect.
- **Fix — client-only, no server change:**
  - Resume banner: `navigate('/learn/topik?mode=mock')`. (`MockMode.tsx`'s
    own mount-time `fetchAttempt` + `resumeAttempt` then does the rest —
    no further wiring needed once the chooser is skipped.)
  - Main tile: since its copy describes Study mode, either leave it bare
    (current chooser is arguably fine for a first-time-today entry point) or
    — for consistency with "the tile's copy should match the click target" —
    change to `navigate('/learn/topik?mode=study')` to skip the chooser
    outright. Low-stakes either way; flag to product but not a hard
    requirement like the resume-banner fix.

### B8. Review mistakes (folded into the TOPIK carousel)

- **Item shown:** none — a static shortcut link, not a specific mistake
  (`Today.tsx:781-792`).
- **Current nav:** `navigate('/review/mistakes')` → `Mistakes` page
  (`App.tsx:118`), the library index. **Correct as-is** — nothing specific is
  promised, nothing specific needs to be opened.
- **Fix:** none required.

### Per-tile summary table

| Tile | Specific item shown? | Current nav | Desired deep-link | Target page already supports it? | Server field needed? |
|---|---|---|---|---|---|
| Vocab / Due now | Count only (no item id) | `/learn/vocab` | `/learn/vocab?study=due` | Yes (`Review.tsx` `study=due` branch) | No (nav fix); count fix is separate (A4) |
| Grammar | No | `/learn/grammar` | — (no change) | n/a | No |
| Hanja | No | `/learn/hanja` | — (no change) | n/a | No |
| Reading | Yes (ttmik_lessons title) | `/learn/reading` | **Wrong page** — needs product call: repoint to `/learn/listen?corpus=ttmik&level=&lesson=` OR re-source Today's reading pick from `reading_chapters` | Repoint option: yes, `Ttmik.tsx` already parses `corpus=ttmik` | Yes — `lesson_level`/`lesson_number` (repoint option) |
| Listening | Yes (iyagi_episodes title) | `/learn/listen` (bare) | `/learn/listen?corpus=iyagi&episode=N` | Yes (`Ttmik.tsx` already parses `corpus=iyagi&episode=`) | Yes — `episode_number` |
| Writing | Yes (writing_prompts title) | `/learn/writing` (bare) | Open that exact bank prompt | No — only random-bank-draw + Claude-generated-topic paths exist today; needs new "fetch by id" mechanism | Yes — `writing_prompts.id`; likely also a new `GET /writing/prompts/:id` route |
| TOPIK main tile | No (describes Study mode) | `/learn/topik` (bare → chooser) | `/learn/topik?mode=study` (optional) | Yes | No |
| TOPIK resume banner | Yes (in-progress mock attempt) | `/learn/topik` (bare → chooser) | `/learn/topik?mode=mock` (**bug fix, not optional**) | Yes — comment at `Topik.tsx:218` confirms this was the intended mechanism | No |
| Review mistakes | No | `/review/mistakes` | — (no change) | n/a | No |

---

## Build plan

### What the Today builder changes (client, `Today.tsx` + its onClick handlers)

1. Vocab tile: `navigate('/learn/vocab')` → `navigate('/learn/vocab?study=due')`.
2. TOPIK resume banner: `navigate('/learn/topik')` → `navigate('/learn/topik?mode=mock')`.
3. TOPIK main tile (optional, low-stakes): → `navigate('/learn/topik?mode=study')`.
4. Listening tile: once `plan.ts` returns `episodeNumber`, change to
   `navigate('/learn/listen?corpus=iyagi&episode=' + String(episodeNumber))`.
5. Reading tile: **blocked on the product decision in B4.** Once decided —
   either repoint to `/learn/listen?corpus=ttmik&level=...&lesson=...` (needs
   `lessonLevel`/`lessonNumber` from the plan payload) or leave the nav as-is
   and change what content the plan surfaces.
6. Writing tile: once the new `bankPromptId`-by-id mechanism exists on
   `Writing.tsx` + a lookup route, change to
   `navigate('/learn/writing', { state: { bankPromptId: ... } })`.
7. Grammar / Hanja / Review-mistakes: no change.

None of (1)-(3) or the Grammar/Hanja/Mistakes items require waiting on any
other team — they're pure client nav-string edits and can ship immediately,
independently, in the same PR as the rest of the Today work.

### What each target page needs

- **`Review.tsx`** (`/learn/vocab`): no target-page change — `study=due` is
  already fully built. Separately, `LandingView`'s `dueCount` prop needs to
  switch from `due.data?.length` to the new server `total` (see A4 #3) — this
  is a `Review.tsx` change, but it's a *count-display* fix, independent of
  the *nav* fix in item 1 above; can land in the same PR or split, builder's
  choice.
- **`Ttmik.tsx`** (`/learn/listen`): no change needed for Listening (already
  parses `corpus=iyagi&episode=`). For Reading-repoint (if chosen): no change
  needed either — `corpus=ttmik&level=&lesson=` is already parsed
  (`Ttmik.tsx:399-411`).
- **`Writing.tsx`**: needs the new `bankPromptId` deep-link branch (parallel
  to the existing `readGeneratedTopic`/`generatedTopic` branch) that fetches
  a specific prompt by id instead of drawing randomly.
- **`Topik.tsx`**: no change — the `?mode=mock`/`?mode=study` chooser-skip
  already exists and works; Today was simply not using it.
- **`Grammar.tsx`, `Hanja.tsx`, `Mistakes`**: no change.

### Server / plan-payload changes required — additive/expand-contract for the shared blue-green DB

All required server changes are **pure response-shape additions to existing
read-only GET routes** — no schema migration, no column added to any table
(every field named below already exists on `ttmik_lessons` / `iyagi_episodes`
/ `writing_prompts` / `vocab_cards`), no breaking change to any existing
consumer:

1. `plan.ts` — add `lesson_level`/`lesson_number` to the reading SELECT
   (only if Reading is repointed, B4 option 1), add `episode_number` to the
   listening SELECT (B5), add `id` to the writing SELECT (B6). Each is a new
   JSON field on an existing nested object (`reading`/`listening`/`writing`)
   — purely additive, safe to deploy to one blue/green color while the other
   still runs the old shape (older client code simply won't read the new
   field; no client currently breaks if the field is absent, since these are
   genuinely new fields, not renamed/removed ones).
2. `plan.ts` — align `dueCount`'s WHERE with `/vocab/cards/due`'s
   `graduated_at` exclusion (A4 #2). Behavior-only change to an existing
   field's value, no shape change.
3. `vocab.ts` — add a `total` (or `COUNT(*) OVER()`) to `/vocab/cards/due`'s
   response (A4 #1). Additive field on an existing route.
4. `writing.ts` (or wherever the random-prompt route lives) — add a new
   `GET /writing/prompts/:id` route, or an optional `id` query param on the
   existing random-draw route (B6). Purely additive — a new route/param, no
   change to the existing random-draw behavior when the param is absent.

None of these require a DB migration or touch `db/migrations/`; all are
Express route/query changes only. Because they're additive, they're safe
under this repo's blue/green deploy protocol without any expand/contract
migration sequencing — old and new server code can run side-by-side against
the same schema with no compatibility gap.

### Splitting into builders without file conflicts

Suggested 3-way split, each touching a disjoint file set:

- **Builder 1 — Today nav + count fixes (client-only, ships first, no
  dependencies):** `Today.tsx` items 1-3 above (Vocab tile, TOPIK resume
  banner, TOPIK main tile) + `Review.tsx`'s `dueCount` source swap to `total`
  (contingent on Builder 3 landing the `total` field first, or stubbed to
  fall back to `.length` until it does). Files: `client/src/pages/Today.tsx`,
  `client/src/pages/Review.tsx`.
- **Builder 2 — Writing deep-link (server + client, self-contained new
  mechanism):** the new `GET /writing/prompts/:id` route + `Writing.tsx`'s
  `bankPromptId` branch + `Today.tsx`'s Writing tile `onClick` (a small,
  clearly-scoped addition to `Today.tsx` that Builder 1 can rebase around
  easily, or Builder 1 can take it directly since it's one `onClick` line).
  Files: `server/src/routes/writing.ts`, `client/src/services/writing.ts`,
  `client/src/pages/Writing.tsx`, (+ one line in `Today.tsx`).
- **Builder 3 — plan.ts payload additions + due-count total (server-only,
  additive, no client dependency to land first):**
  `episode_number`/`lesson_level`/`lesson_number`/writing `id` on
  `/plan/today`, the `graduated_at` alignment, and the `total` field on
  `/vocab/cards/due`. Files: `server/src/routes/plan.ts`,
  `server/src/routes/vocab.ts`, plus their existing route tests.

Recommended order: **Builder 3 first** (pure server, unblocks everyone),
then **Builder 1 and Builder 2 in parallel** (both only need Builder 3's new
fields to exist on the wire; neither touches the other's files except the
single `Today.tsx` `onClick` line for Writing, which should be sequenced
after Builder 1's other `Today.tsx` edits land, or coordinated as a single
combined `Today.tsx` diff). The Reading tile (B4) should be **held out of
all three builders** until product picks an option — it's the one item in
this doc that isn't a mechanical fix, it's a decision.
