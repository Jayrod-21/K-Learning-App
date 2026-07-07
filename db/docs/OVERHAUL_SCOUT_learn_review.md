# Overhaul scout — Today carousel / LEARN / REVIEW library / Progress mastery

Read-only infra audit, 2026-07-07. Scope: determine exactly what backend/DB/client
already exists vs. what's net-new for the planned overhaul (Today grammar
BANKABLE/DUE carousel; LEARN grammar-practice + vocab-flashcards pages; REVIEW
library — vocab by difficulty+genre, grammar by level; Progress vocab/grammar
mastery chart). No code was written for this audit; all evidence is file:line
or live `km-db` query output.

---

## 1. Grammar SRS / bankable / due — the key question

**Verdict: EXISTS (server + DB), PARTIAL (client re-home needed for a Today carousel).**

The memory hypothesis — "much of the grammar SRS already exists" — is **confirmed
and actually exceeded**. Migration `019_grammar_drill_attempts.up.sql` (lines
25-28) states FSRS-production coupling was "DEFERRED (FU-NF-42)" at the time it
was written, but the very next migration, `020_grammar_production_card_uniq.up.sql`,
and the current `server/src/routes/grammarDrill.ts` show the coupling was **built**
in the same pass (comment cites "ADR-003 amendment 2026-07-02"). The deferral note
in 019 is stale relative to the shipped code.

What exists, concretely:

- **Bank model** — `grammar_entries` table (migration 001) + `graduated_at`
  column (migration 033). `server/src/routes/grammar.ts`:
  - `POST /grammar/bank` (164-204) — upsert bank row.
  - `GET /grammar/bank` (206-225) — list, `graduated_at` rides along.
  - `POST /grammar/bank/:id/graduate` (272-278) / `POST /grammar/bank/:id/readmit`
    (280-286) via shared `setGraduation()` (233-270). Idempotent graduate
    (`COALESCE(graduated_at, now())`), NULL-out readmit. FSRS state on the
    production card is untouched by either (comment lines 15-23 of 033).
  - `GET /grammar/suggestions/weekly` (325-366) — 15 not-yet-banked KGIU
    patterns, stable per ISO week, excludes graduated rows. This is the
    **BANKABLE** half of the Today carousel, already wired end-to-end
    (server route + `grammarService` + `Grammar.tsx` List tab consumes it —
    confirmed via `onBank` wiring, `Grammar.tsx:898`).
- **Production-card FSRS scheduling — genuinely implemented, not deferred.**
  `server/src/routes/grammarDrill.ts` `POST /grammar-drill/:attemptId/submit`
  (253-523):
  - Resolve-or-create a `vocab_cards` row with `face='production'`,
    `grammar_entry_id` set (steps 4b-4c, lines 359-414), guarded by the
    partial unique index `uq_vocab_cards_user_grammar_production` (migration
    020, lines 50-52) — one production card per (user, pattern).
  - Maps the Claude verdict → FSRS rating (`ratingFromVerdict`,
    `services/grammarScheduler.ts`) and advances the card through the SAME
    shared engine (`services/fsrs.ts`) the vocab review route uses (step 4d-4e,
    lines 416-462).
  - Appends an immutable `card_reviews` snapshot (4f, lines 471-497) —
    identical shape to the vocab review path.
  - All of it — score UPDATE, auto-bank, card upsert, card advance, review
    snapshot — is one transaction (`withTransaction`, line 330); a scheduling
    bug 500s loudly rather than half-persisting (documented decision, lines
    301-311).
- **A real grammar DUE queue already exists — it's `GET /vocab/cards/due`,
  not a separate `/grammar/due`.** `server/src/routes/vocab.ts` `/cards/due`
  (147-261) `LEFT JOIN grammar_entries` (231-234) so a grammar production
  card carries `grammar_pattern_display` / `grammar_pattern_key` /
  `grammar_summary_en` inline, and the WHERE clause (239) excludes graduated
  patterns: `(c.grammar_entry_id IS NULL OR ge.graduated_at IS NULL)`. This is
  the exact "DUE" half of the carousel, server-side, today.
- **Client already splits vocab vs. grammar cards out of this one queue.**
  `client/src/pages/Review.tsx` `isGrammarProductionCard()` (186-193) +
  `dueCardToGrammar()` (196-209) + `GrammarReviewSection` component
  (1144-1184) render a "Grammar production · N due" list that deep-links into
  `/grammar` with `location.state.drillTarget` (600-613), which `Grammar.tsx`
  reads (line 143) to auto-open the Drill tab. **This is effectively the
  DUE-grammar carousel logic already written — it just lives inside the
  Review page's Session tab, not a Today-page carousel component.**

**The gap, precisely:** no new DB schema, no new due-query, no new
scheduling logic is needed. What's missing is purely a client re-home/repackage:
1. A Today-page carousel component that calls the *same* `/vocab/cards/due`
   and reuses `isGrammarProductionCard`/`dueCardToGrammar` (currently
   private to `Review.tsx` — would need extracting to a shared hook/lib) to
   render a swipeable BANKABLE (from `/grammar/suggestions/weekly`) + DUE
   (from `/vocab/cards/due`) carousel.
2. Live data is thin: `grammar_drill_attempts` has 9 rows, **0 scored**
   (`scored_at IS NOT NULL` count = 0), and 0 rows in `vocab_cards` with
   `face='production' AND grammar_entry_id IS NOT NULL` on the live `km-db` —
   the code path exists and is exercised by tests but has not actually run a
   real scored drill end-to-end in this DB yet, so treat "works" as
   code-verified, not production-verified.

---

## 2. Vocab flashcards — complete loop?

**Verdict: EXISTS — complete, production-grade flashcard study loop.**

- `GET /vocab/cards/due` (vocab.ts 147-261) — FSRS due queue, joins
  `vocab_entries` for real Korean/English/example/source fields (B-009 fix,
  comment 179-189).
- `POST /vocab/cards/:cardId/reviews` (292-439) — **server-authoritative**
  FSRS scheduling (ADR-003 amendment 2026-07-02): client sends only
  `rating` + `expected_version`; server reads current card state
  `FOR UPDATE` (324-339), derives next state via `services/fsrs.ts`
  `schedule()`, optimistic-concurrency UPDATE (362-396), appends
  `card_reviews` snapshot (397-425).
- `POST /vocab/cards/init` (451-499) — idempotent recognition-card seeding
  from a corpus slice (`NOT EXISTS` guard, no unique constraint needed).
- Client: `client/src/pages/Review.tsx` `SessionPanel` (862-1128) — flip
  animation, 4 FSRS rating buttons (`Again/Hard/Good/Easy`, 855-860),
  spacebar-to-reveal (493-507), optimistic advance + rollback-on-409
  (538-593), "More examples" KRDICT lazy-load drawer (884-933), study-time
  logging on unmount (509-536).
- Live DB: 243 `vocab_cards` rows with `face='recognition' AND
  vocab_entry_id IS NOT NULL`; 53 `card_reviews` rows recorded.

This is a fully wired, tested, real-data-backed loop. Re-homing it into
LEARN's "vocab flashcards page" is a page-level move (route + nav), not a
feature build. The one thing currently entangled with Review.tsx that a
re-home must account for: the grammar-due section (`GrammarReviewSection`)
and the Lists/All tabs are siblings in the same file — a literal lift-and-shift
would carry grammar-due UI into LEARN unless deliberately left behind for the
new REVIEW library page.

---

## 3. Vocab + grammar LIBRARY (for the new REVIEW page)

**Verdict: PARTIAL.** Difficulty filtering exists for both; genre filtering
exists but is coarser than the corpus's real genre/theme granularity for
vocab, and grammar has no genre-equivalent concept at all (by design — see
below).

### Vocab (`vocab_entries`, `GET /vocab/entries`)

- Route `server/src/routes/vocab.ts` `/entries` (54-139) already accepts
  `domain` (content_domain enum) and `book_level` (beginner/intermediate/
  advanced) query filters (comment F-003, lines 65-70), plus `proficiency`
  (basic/L3/L4/L5+) and free-text `q`.
- `client/src/pages/Reference.tsx` `DictionaryTab` (752-...) already wires
  genre (`domain`) + difficulty (`book_level`) filter controls (comment
  lines 19, 545-547, 573-574) — this is F-003, already shipped.
- **Live DB values** (`vocab_entries`):
  - `domain`: `general` (3071 rows), `research` (12), `business` (108) — a
    coarse 3-value genre proxy.
  - `book_level`: `beginner`, `intermediate` — difficulty band.
  - `proficiency`: `basic`, `L3` — finer difficulty tier, also filterable.
  - `theme` (e.g. `"01 인간 / People"`, `"02 행동 / Actions"`, `"11
    교통/통신 / Transportation & Communication"` — 30+ distinct real chapter/
    topic values) exists as a column and is already selected in `/vocab/entries`
    (line 105) and `/vocab/mastery` word rows, but **is NOT exposed as a query
    filter parameter** — there's no `theme` in `VocabSearchQuerySchema`
    (54-76). This is the actual "genre/chapter" granularity a REVIEW library
    would want; today only the coarser `domain` enum is filterable.
- **Gap to close:** add a `theme` (or `theme` + free-text `q`-on-theme)
  filter param to `/vocab/entries`, or repurpose `domain` if 3 buckets is
  judged sufficient "genre" for the library view. Both difficulty axes
  (`proficiency`, `book_level`) are already filterable with no server changes
  needed.

### Grammar (`kgiu_entries`, `GET /grammar/kgiu`)

- Route `server/src/routes/grammar.ts` `/kgiu` (56-98) already accepts
  `corpus`, `proficiency`, `domain`, and `book_level` filters (comment F-005,
  lines 43-48).
- `client/src/pages/Reference.tsx` `GrammarTab` (895-...) already wires
  `domain` + `book_level` filters (900-901, 925-926) — F-005, shipped.
- **Live DB values** (`kgiu_entries`): `book_level` = `beginner` (114),
  `intermediate` (94), `advanced` (86) — exactly the beginner/intermediate/
  advanced level filter the REVIEW spec asks for, already queryable with no
  changes.
- `category` (e.g. `reason`, `particle`, `time`, `conjecture`, `condition`,
  40 distinct free-text values post-migration-034) is a **linguistic**
  category, not a genre/chapter — there is no grammar analog to vocab's
  `theme`. This is a real content difference, not a gap: KGIU grammar entries
  aren't organized by topic/genre the way vocab is, so "grammar by level" (the
  spec's actual ask) is fully satisfiable today via `book_level`; a "grammar by
  genre" filter would have nothing meaningful to filter on.

**Bottom line for §3:** grammar-by-level — **zero gap**, filter param and data
both already live. Vocab-by-difficulty — zero gap (`proficiency`/`book_level`
already filterable). Vocab-by-genre — **small gap**: the coarse `domain` enum
is filterable now, but the richer `theme` column that actually reads as
"genre/chapter" (30+ real values) needs one query-param addition to
`VocabSearchQuerySchema` + the SQL WHERE clause; the UI filter-control pattern
to copy already exists twice (DictionaryTab, GrammarTab).

---

## 4. Mastery data (for Progress — genuinely new view)

**Verdict: EXISTS for vocab (shipped, F-013). MISSING for grammar (no
route, no client) — but all underlying state needed to build it is already
captured; this is a pure read/aggregation gap, not a data-collection gap.**

### Vocab mastery — already shipped (F-013)

- `server/src/routes/vocab.ts` `GET /vocab/mastery` (854-934): buckets
  `vocab_cards` (`vocab_entry_id IS NOT NULL` only, explicitly excluding
  grammar/sentence/topik cards — comment 849-852) into
  `new` / `learning` / `reviewing` / `mastered` via `fsrs_state` +
  a stability threshold (`MASTERY_MATURE_DAYS = 21`, lines 821, 832-844).
  Returns a summary + paginated, bucket-filterable word list.
- `client/src/pages/Progress.tsx` `WordMasterySection` (766-...) — mastery
  bar chart + legend (`MasteryBar`, 713-764) + filterable word list, already
  on the Progress page (mounted at line 232). This is the "vocab mastery
  chart" the spec asks for — it exists today, full stop.

### Grammar mastery — does not exist as a route or view

- No `/grammar/mastery` route (grepped `grammar.ts`, `grammarDrill.ts` — no
  match).
- **But the state to build one is already 100% present**, on the exact same
  tables the vocab version reads:
  - `vocab_cards` rows with `grammar_entry_id IS NOT NULL AND face =
    'production'` carry the identical FSRS columns (`fsrs_state`,
    `stability`, `difficulty`, `reps`, `lapses`, `due_at`) the vocab mastery
    query already buckets on — the `BUCKET_CASE`/`BUCKET_PREDICATE` SQL
    fragments (vocab.ts 832-844) would work verbatim against
    `grammar_entry_id IS NOT NULL` instead of `vocab_entry_id IS NOT NULL`.
  - `grammar_entries.graduated_at` (migration 033) is a second, independent
    "mastered" signal — a user-declared "I know this" state distinct from
    FSRS stability — that vocab has no equivalent of. A grammar mastery
    metric arguably wants to combine both: FSRS bucket (algorithmic) +
    graduated flag (user-declared), which vocab's F-013 doesn't need to
    reconcile.
  - `card_reviews` (append-only FSRS history) already logs every grammar
    drill submission identically to vocab reviews (grammarDrill.ts 471-497
    vs. vocab.ts 401-425) — same table, same shape — so a history/trend view
    needs no new logging.
  - `GET /grammar/series` (grammar.ts 393-426) already gives a 30-day
    average-drill-score time series per user, which is a *different* metric
    (score trend) than mastery (state bucket), but confirms the data pipeline
    for a grammar-progress chart already exists in parallel.
- **Live DB reality check:** only 6 `grammar_entries` rows (2 graduated), 9
  `grammar_drill_attempts` (0 scored), 0 production cards with
  `grammar_entry_id IS NOT NULL` currently in `km-db` — the feature is
  code-complete but has essentially no real usage history yet, so a grammar
  mastery chart would render mostly empty on this instance until drills are
  actually run and scored.
- **Gap to close:** one new route (`GET /grammar/mastery`, mirroring
  `/vocab/mastery`'s shape but filtering `grammar_entry_id IS NOT NULL` and
  folding in `graduated_at`) + one new Progress-page section
  (`GrammarMasterySection`, mirroring `WordMasterySection`). No migration, no
  new columns, no new instrumentation — genuinely just a read-side view over
  data already being written on every drill submit.

---

## Per-capability verdict table

| Capability | Verdict | Evidence (file:line / SQL) | Gap to close |
|---|---|---|---|
| Grammar bank (create/list) | EXISTS | `server/src/routes/grammar.ts:164-225` (`POST`/`GET /grammar/bank`) | none |
| Grammar graduate/readmit | EXISTS | `db/migrations/033_grammar_entry_graduation.up.sql`; `grammar.ts:227-286` | none |
| Grammar weekly bankable suggestions | EXISTS | `grammar.ts:288-366` (`GET /grammar/suggestions/weekly`) | Today-carousel UI needs to consume this (currently only `Grammar.tsx` List tab does) |
| Grammar production-card FSRS scheduling | EXISTS (contradicts 019's own "deferred" note) | `db/migrations/020_grammar_production_card_uniq.up.sql`; `server/src/routes/grammarDrill.ts:301-500` | none server-side; 0 scored attempts live on `km-db` — unexercised in prod |
| Grammar DUE queue | EXISTS (reuses vocab queue, not a separate endpoint) | `server/src/routes/vocab.ts:147-261` (LEFT JOIN `grammar_entries`, graduation-excluded at line 239) | none server-side |
| Grammar DUE client split | EXISTS but embedded in Review.tsx, not Today | `client/src/pages/Review.tsx:186-209, 1144-1184` | extract `isGrammarProductionCard`/`dueCardToGrammar` to a shared module; build Today carousel component |
| Grammar practice/drill UI | EXISTS | `client/src/pages/Grammar.tsx` `DrillPanel` (934, 1447-...) | re-home into LEARN as its own page (route move, not rebuild) |
| Vocab flashcard study loop | EXISTS — complete | `vocab.ts:147-439` (due+reviews); `Review.tsx:862-1128` (`SessionPanel`) | re-home `SessionPanel` into LEARN as "vocab flashcards page" (route move) |
| Vocab-by-difficulty filter | EXISTS | `vocab.ts:54-139` (`proficiency`, `book_level` params); `Reference.tsx` `DictionaryTab` | none |
| Vocab-by-genre filter | PARTIAL | `domain` filterable (`vocab.ts:69`); richer `theme` column exists (30+ real values, e.g. `01 인간 / People`) but not a query param | add `theme` to `VocabSearchQuerySchema` + WHERE clause |
| Grammar-by-level filter | EXISTS | `grammar.ts:37-98` (`book_level` param); `Reference.tsx` `GrammarTab` | none |
| Vocab mastery chart | EXISTS — shipped (F-013) | `vocab.ts:818-934` (`GET /vocab/mastery`); `Progress.tsx:766-...` (`WordMasterySection`) | none |
| Grammar mastery chart | MISSING (route + view); state fully present | no `/grammar/mastery` route (grep confirmed); reusable columns: `vocab_cards.fsrs_state/stability` where `grammar_entry_id IS NOT NULL`, plus `grammar_entries.graduated_at` | new route mirroring `/vocab/mastery` + new `GrammarMasterySection` on Progress; no schema change |

---

## Bottom line

1. **Grammar bankable/due is ~90% built already** — bank, graduate/readmit,
   weekly suggestions, production-card FSRS scheduling, and a due queue
   (via `/vocab/cards/due`'s grammar JOIN) all exist and are exercised by the
   current Review.tsx grammar section. The only real gap is a Today-page
   carousel component that reuses this existing data/logic instead of a new
   backend — plus the caveat that 0 scored drills exist on live `km-db` today,
   so it's code-verified but not yet production-proven.
2. **Yes — vocab flashcards is a complete, tested, real-data-backed study
   loop** (due queue + server-authoritative FSRS reviews + full session UI);
   re-homing it into LEARN is a page/route move, not new engineering.
3. **Grammar-by-level and vocab-by-difficulty filter with zero new work;
   vocab-by-genre works today only at the coarse 3-value `domain` level** — the
   richer per-chapter `theme` data exists in the DB but needs one new query
   param to become filterable.
4. **Enough state exists to build both mastery views without new data
   collection** — vocab's is already shipped (F-013); grammar's needs only a
   new read-side route/view over `vocab_cards` (production face) +
   `grammar_entries.graduated_at`, both already written on every drill submit.
