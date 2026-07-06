# Review — Reference tab filters + grammar detail (F-003/F-004/F-005), Add-to-review wiring (B-013)

**Branch:** `track-a-integration` · **Reviewer:** independent senior review (no code written by reviewer)
**Scope:** `server/src/routes/vocab.ts`, `server/src/routes/grammar.ts`, `client/src/pages/Reference.tsx`,
`client/src/pages/Review.tsx`, `client/src/services/{vocab,grammar}.ts`, `client/src/types/domain.ts`,
plus `server/tests/routes/{vocab,grammar}.test.ts`, `client/src/pages/{Reference,Review}.test.tsx`.

Verified independently: re-read every file in full, cross-checked the DB enum definitions
(`db/migrations/001_core_schema.up.sql`, `002_darakwon_corpora.up.sql`) against the Zod schemas, and
**ran the targeted test files against real infra** (not trusted from the task description):

- Client: `vitest run src/pages/Reference.test.tsx src/pages/Review.test.tsx` → **39/39 pass**.
- Server: `vitest run tests/routes/vocab.test.ts tests/routes/grammar.test.ts` (real Postgres via
  Testcontainers, not mocked) → **113/113 pass**, ~66s wall time.

## Verdict: **PASS WITH CONDITIONS**

No blockers. F-003/F-004/F-005 are correctly parameterized, correctly enum-gated, and the stale-fetch
guard on the grammar detail Sheet is implemented correctly. B-013's per-click seed logic (idempotent,
error-handled, refetch-only-on-real-change) is solid. Two real SHOULD-FIX items keep this from a clean
PASS: (1) the grammar detail Sheet drops the corpus's actual teaching content (examples/formation/
dialogues) despite fetching it, which is a real product gap for a language-reference feature, not just
polish; (2) the pre-existing "Study this list" / "Add all to my bank" buttons were left fully inert
(no `onClick`, not `disabled`) rather than disabled or removed, which is a shipped broken affordance.

## Findings

### BLOCKER
None found. No string interpolation into SQL, no enum bypass, no XSS surface, no auth/ownership gap in
the touched code.

### SHOULD-FIX

1. **Grammar detail Sheet renders only `explanation` + `unit`, discarding the fields that make a
   grammar-reference detail actually useful for a learner** — `client/src/pages/Reference.tsx:1037-1051`
   (`GrammarDetailSheet`). `GET /grammar/kgiu/:id` (`server/src/routes/grammar.ts:107-114`) already
   selects and returns `formation_rules`, `examples`, `dialogues`, `vocabulary`, `tips`, `compare_with`,
   `exercises`, `cultural_notes` — none of which are rendered. For a pattern like `-는 반면에`
   ("whereas/while on the other hand"), a one-line English gloss with no example sentence is
   materially less useful than the same detail view on `pages/Grammar.tsx` (which the docstring at
   `Reference.tsx:15-19` explicitly says this Sheet "mirrors"). This is a judgment call the task asked
   me to make explicitly: I'd call it an acceptable **v1 cut** only if tracked as a near-term follow-up
   — the data is untyped `jsonb` (`KgiuEntryDetail.examples: unknown` etc. in
   `client/src/types/domain.ts:1152-1163`), so rendering it safely requires a runtime shape check the
   agent reasonably deferred. But it should not be left un-ticketed: the endpoint is over-fetching
   (paying the query cost for `formation_rules`/`examples`/etc. on every tap) for zero rendered value,
   and the UX gap is real, not cosmetic.

2. **"Study this list" / "Add all to my bank" buttons are fully inert — no `onClick`, no `disabled` —
   and ship as apparently-functional gold/ghost buttons** — `client/src/pages/Review.tsx:1764-1779`.
   The B-013 commit's own docstring (`Review.tsx:110-120`) correctly reasons that `/vocab/cards/init`
   seeds by corpus, not list membership, so a per-list "Study this list" button has nowhere honest to
   route today (`CustomVocabList`/`SourceVocabListItem` carry no `corpus` field —
   `client/src/types/domain.ts:540-572`). That reasoning is sound, and I agree a corpus-level "Add to
   review" card at the Lists-tab level (not per-list) is the right home for the wired feature. But the
   conclusion applied to these two pre-existing buttons is wrong: leaving a visibly-clickable,
   non-disabled `<Button variant="gold">`/`<Button variant="ghost">` with a leading icon and a real
   label, that silently no-ops on click, is a shipped defect — a user has no way to know the button
   doesn't work. `SENIOR_ENGINEER_BAR.md` §0 ("no dead code... never ship a shortcut silently") and
   §2.6 (every interactive control must do what its affordance promises) both apply. Minimum fix: add
   `disabled` (with a tooltip/title, or just omit the buttons entirely from the render) until they're
   wired, so the UI doesn't lie about capability. No test exercises this path either (confirmed: no
   `Study this list` / `Add all to my bank` references anywhere in `Review.test.tsx`), so it wasn't
   even pinned as "known, deferred" — it's simply unaddressed.

### NIT

3. **`seedReview` calls `initCards` sequentially, not `Promise.all`** — `client/src/pages/Review.tsx:632-668`.
   Correctness is fine (each call is its own idempotent server-side transaction; the comment at
   line 626-631 explains the choice), but it costs an extra network round-trip per click for no
   correctness benefit — two independent idempotent POSTs could safely run in parallel and the summed
   `inserted` count would still be exactly correct. Not worth blocking on.

4. **`GrammarTab.openDetail` doesn't pass an `AbortSignal` to `grammarService.getPattern`**
   (`client/src/pages/Reference.tsx:886`) — the stale-response guard (`detailIdRef`) correctly prevents
   a superseded fetch from painting the wrong row, so this is not a correctness bug, but a fast double-
   tap across two rows burns a wasted in-flight request that the client can't cancel. `getPattern`
   already accepts an optional `signal` (`client/src/services/grammar.ts:58-66`); wiring one up would
   be a small, free improvement.

### PRAISE

5. **F-003/F-005 filter parameterization is textbook-correct.** Both `vocab.ts:96-119` and
   `grammar.ts:59-86` bind `domain`/`book_level` as `$n::content_domain` / `$n::book_level` — never
   string-interpolated — and the Zod enums (`z.enum(['general','research','business'])`,
   `z.enum(['beginner','intermediate','advanced'])`) are byte-for-byte identical to the actual Postgres
   enum definitions I cross-checked in `db/migrations/001_core_schema.up.sql:118` and
   `002_darakwon_corpora.up.sql:71`. An out-of-band value 400s at the Zod boundary before ever reaching
   SQL — confirmed with real integration tests (`?domain=sports`, `?book_level=expert` → 400,
   `error.code === 'validation_error'`) that I re-ran and watched pass against a live Postgres
   container, not just read.

6. **The pager-reset-on-filter-change is handled correctly and is covered by a real test.**
   `Reference.tsx:550-553` resets `offset` to 0 whenever `q`/`domain`/`level` change, and
   `Reference.test.tsx:459-500` asserts the refetch carries `offset: 0` after a filter click — this is
   exactly the kind of test that would fail on the pre-fix code (there was no filter to reset against).

7. **The stale-fetch guard on the grammar detail Sheet is correctly implemented.**
   `detailIdRef.current` is set to the tapped row's id *before* the `await`
   (`Reference.tsx:880-881`), and both the success and catch paths check
   `detailIdRef.current !== row.id` before calling `setDetail`/`setDetailError`
   (`Reference.tsx:887-895`) — a slow settle for a previously-tapped row cannot paint over a newer tap.
   This is the correct pattern (compare-on-resolve, not cancel-on-dispatch) and matches the same idiom
   used elsewhere in this file (`VocabularyTab`, `DictionaryTab` via `AbortController`).

8. **B-013's error/idempotent/refetch paths are all correct and each is backed by a real, would-fail-
   on-old-code test.** `Review.tsx:632-669`: both corpora are always attempted (loop doesn't early-continue
   on the first success), the zero-inserted case gets honest copy instead of a false "Added 0 cards"
   (`Review.tsx:649-655`), `refetchDue()` fires only when `insertedTotal > 0` (no wasted round-trip on
   the no-op case), and the `seeding` flag double-guards the in-flight state on both the callback
   (`if (seeding) return`) and the `disabled` prop. All three of `Review.test.tsx:423-497` (both-corpora
   success, idempotent-zero-no-refetch, error-message-and-re-enable) genuinely exercise these branches —
   confirmed by running them against the real component tree, not reading them.

## Detailed notes by area

### F-003 (`GET /vocab/entries` domain + book_level) — `server/src/routes/vocab.ts:46-131`
- Zod schema (`vocab.ts:53-67`): `domain: z.enum(['general','research','business']).optional()`,
  `book_level: z.enum(['beginner','intermediate','advanced']).optional()` — matches
  `content_domain`/`book_level` Postgres enums exactly (verified against migrations 001 + 002).
- SQL (`vocab.ts:97-109`): `AND ($4::content_domain IS NULL OR domain = $4::content_domain) AND
  ($5::book_level IS NULL OR book_level = $5::book_level)` — fully parameterized, correctly ANDed with
  the existing `q`/`corpus`/`proficiency` predicates. Positional params ($1..$7) verified to match the
  bound array order 1:1.
- Server test coverage (`server/tests/routes/vocab.test.ts:144-213`) covers: domain-only narrows,
  book_level-only narrows, and domain+book_level+q composing with AND semantics (a row matching `q` but
  wrong `domain` is correctly excluded — this is the test most likely to catch a regression to OR
  semantics). Bad-enum-value → 400 is table-tested (`:280-312`).

### F-005 (`GET /grammar/kgiu` domain + book_level) — `server/src/routes/grammar.ts:31-92`
- Identical pattern to F-003, same enums, same parameterization discipline
  (`grammar.ts:73-74`: `$4::content_domain`, `$5::book_level`). Cross-checked positional param order
  against the bound array (`grammar.ts:77-85`) — correct.
- Server tests (`server/tests/routes/grammar.test.ts:113-193`) mirror F-003's structure and additionally
  assert the AND-composition against a genuinely disjoint fixture (`researchOnlyId` tagged research but
  NOT beginner, vs. the target row tagged both) — a real discriminating test, not a tautology.

### F-004 (grammar row → detail Sheet) — `client/src/pages/Reference.tsx:812-1055`
- Rows are real `<button type="button">` elements (`Reference.tsx:944-959`), keyboard-operable,
  labelled via `aria-label`. Correctly avoids the "div with onClick" a11y smell.
- `openDetail` (`Reference.tsx:879-897`) calls `grammarService.getPattern(row.id)` — the real numeric
  KGIU id, confirmed by the test assertion `expect(grammarSvc.getPattern).toHaveBeenCalledWith(100)`
  (`Reference.test.tsx:387`).
- Loading/error/retry: `detailLoading` renders a `role="status"` line; `detailError` renders
  `<ErrorCard onRetry>`; retry re-invokes `openDetail(openRow)` (`Reference.tsx:966-975`). The
  error-path test (`Reference.test.tsx:398-416`) confirms a 404 from `getPattern` surfaces the server's
  message text inline inside the dialog without crashing the row list.
- See SHOULD-FIX #1 for the examples/formation/dialogues omission.

### B-013 (Review "Add to review") — `client/src/pages/Review.tsx`
- `SEED_CORPORA` + `SEED_LIMIT` design (`Review.tsx:110-134`): reasonable. 100/corpus × 2 corpora = 200
  max inserts per click is bounded by the `InitBodySchema` server ceiling (500) and, more importantly,
  is decoupled from user-facing burden because `GET /vocab/cards/due` still pages at its own default
  limit (20) — the comment at `Review.tsx:130-134` correctly identifies this. Not aggressive in
  practice.
- Per-list vs. corpus-level placement: agreed with the agent's call — see SHOULD-FIX #2 for the caveat
  about the two buttons left in place.
- Idempotent-zero, error, and refetch-only-on-success paths are all correct — see PRAISE #8.

## Test adequacy

All new/changed tests assert observable behavior (response body, DOM text, mock call args) and are
shaped to fail on the pre-fix code (pre-fix, there was no `domain`/`book_level` param, no detail Sheet,
no `initCards` call site) — this isn't a case of tests merely re-describing the implementation. I
independently re-ran the four test files in question against live infra (Postgres via Testcontainers for
the server suites; jsdom + RTL for the client suites) rather than trusting the reported 607/648 totals,
and all pass: 39/39 client, 113/113 server for the touched files.

The one coverage gap: **no test pins the "Study this list"/"Add all to my bank" inertness** as an
intentional, tracked state (see SHOULD-FIX #2) — there's nothing for a future PR to trip on if someone
"fixes" one of these buttons in a way that reintroduces the corpus/list-membership mismatch the B-013
docstring warns about.
