# REVIEW — Phase 2 G2: hanja on the vocab_cards FSRS XOR (F-075, migration 050) + cardReview.ts extraction

Independent review, branch `feat/phase2-g2-new-tables`, HEAD `7d8a2f4`.
Scope: `db/migrations/050_hanja_cards.{up,down}.sql`, `db/tests/test_migration_050.py`,
`server/src/services/cardReview.ts`, `server/src/routes/hanja.ts`,
`server/src/routes/vocab.ts`, `server/tests/routes/hanja.test.ts`.

## VERDICT: APPROVE — 0 BLOCKERS, 1 SHOULD-FIX, 3 NITs

The XOR extension is correct and hole-free, the refactor is provably
behavior-preserving, there is exactly one FSRS engine, the down migration is
clean, and the IDOR surface is closed and tested. Gates pass 131/131.

## Gates (targeted, per instructions — no full suite)

`cd server && npx vitest run tests/routes/hanja.test.ts tests/routes/vocab.test.ts`
→ **2 files passed, 131/131 tests passed, 0 failed** (298.66s, real
Postgres-16 testcontainer). Note: `server/tests/routes/vocab.test.ts` was NOT
modified on this branch (last touched in `295df90`), so the pre-refactor vocab
review contract suite passing green against the post-refactor code is direct
evidence the extraction preserved behavior.

## Refactor safety — the `cardReview.ts` extraction (verified line-by-line)

Compared `git diff 1a48a03^ 1a48a03 -- server/src/routes/vocab.ts` against
`server/src/services/cardReview.ts:70-194`. The lifted transaction is
byte-equivalent to the old inline handler:

- Same `SELECT … FOR UPDATE` existence/ownership check (`cardReview.ts:83-100`),
  same 404-vs-409 split (FU-NF-8), same `FOR UPDATE` serialization.
- Same versioned `UPDATE` SQL and parameter order (`cardReview.ts:129-157`),
  including the `lapses + CASE WHEN 'again'` increment and `elapsed_days = 0`.
- Same append-only `card_reviews` INSERT with BEFORE-from-locked-row /
  AFTER-from-engine snapshots and the `reps === 0 ? -1 : 0` never-reviewed
  sentinel (`cardReview.ts:167-191`).
- Wire-visible error strings are byte-identical: `cardNoun` is caller-supplied
  (`'vocab card'` from `vocab.ts:349`), so `"vocab card not found"` /
  `"vocab card version is stale"` are unchanged on the vocab route.
- Only two additions, both inert for vocab: the SELECT now also reads
  `hanja_character_id` (`cardReview.ts:93`), and the opt-in
  `requireHanjaTarget` gate (`cardReview.ts:105-109`) which vocab.ts does not
  pass. FSRS scheduling and `card_reviews` logging for vocab are untouched.

## Queue partition — no cross-contamination

- Vocab due queue excludes hanja: `AND c.hanja_character_id IS NULL`
  (`vocab.ts:272`). Hanja due queue requires the hanja leg and joins
  `hanja_characters` (`hanja.ts:663-672`). The partition is tested end-to-end
  in `hanja.test.ts:495-510` (hanja card appears ONLY in `/hanja/cards/due`,
  vocab card ONLY in `/vocab/cards/due`).
- `/vocab/mastery` is unaffected: the summary filters
  `vocab_entry_id IS NOT NULL` (`vocab.ts:804`) and the word list INNER JOINs
  `vocab_entries` (`vocab.ts:832-833`), so hanja cards can't surface blank.

## One engine

Hanja reviews go through `applyCardReview` → `services/fsrs.ts.schedule()`
(`cardReview.ts:121`), the same engine vocab and grammar drills use.
`grep 'function schedule|BASE_STABILITY' server/src/services/*.ts` hits only
`fsrs.ts:124,180` — no parallel scheduler exists. `hanja.test.ts:520-593`
proves real engine output (good → learning/stability 3/due ~3d;
again → relearning/~10-min re-queue) and the shared `card_reviews` trail.

## Migration 050 — XOR, FK, unique, reversibility

- **XOR:** `050_hanja_cards.up.sql:103-112` recreates
  `ck_vocab_cards_target_xor` as a 5-leg CASE-sum `= 1`, same name as 001
  (`001_core_schema.up.sql:715-720`). The CASE expression can never evaluate
  to NULL, so there is no NULL-passes-CHECK escape; two-target and zero-target
  inserts are rejected — tested through the real chain
  (`test_migration_050.py:360-379`) and the applied chain
  (`hanja.test.ts:672-684`). Pre-050 vocab/grammar rows survive byte-identical
  (`test_migration_050.py:327-328`).
- **FK:** targets `hanja_characters(id)` — the surrogate identity PK
  (`016_hanja.up.sql:80`), not the `char` natural UNIQUE — with
  `ON DELETE CASCADE ON UPDATE RESTRICT` (`050….up.sql:87-97`), asserted from
  `pg_constraint` (`confdeltype = 'c'`, `test_migration_050.py:336-346`), and
  a header that honestly argues CASCADE vs the grammar leg's RESTRICT
  (shared reference data, upsert-only loader, no soft delete). Guarded via
  `pg_constraint` for re-runnability, the 002 §9 idiom.
- **Partial UNIQUE:** `uq_vocab_cards_user_hanja_face` on
  `(user_id, hanja_character_id, face) WHERE hanja_character_id IS NOT NULL
  AND deleted_at IS NULL` (`050….up.sql:122-124`) correctly mirrors 020's
  guard (`020….up.sql:50-52`); not pinning `face` is a defensible widening
  (one card per face, future production face covered). Duplicate-live
  rejected / other-face allowed / soft-deleted-frees-slot all tested
  (`test_migration_050.py:381-389`, `hanja.test.ts:416-427,686-698`).
- **Seed INSERT relies on column defaults** — verified against 001:
  every NOT NULL FSRS column has a DEFAULT and `due_at DEFAULT now()`
  (`001_core_schema.up.sql:670-697`), so
  `INSERT (user_id, face, hanja_character_id)` (`hanja.ts:587`) is complete.
- **Down (ADR-013 + reversibility):** no top-level BEGIN/COMMIT in either
  file; the runner owns the tx, so the `DELETE FROM vocab_cards WHERE
  hanja_character_id IS NOT NULL` (`050….down.sql:24`) and the 4-leg XOR
  restore commit-or-abort together — ordering is correct (rows removed before
  the narrower CHECK revalidates). The header's destructive-gate claim is
  accurate: `DESTRUCTIVE_PATTERNS` matches only DROP TABLE/SCHEMA/DATABASE/
  TRUNCATE after comment-stripping (`db/migrate.py:83-86,312-313`), and
  "DROP TABLE" appears only inside comments in 050.down. Down + re-up round
  trip proven on real data with the vocab card's own review row surviving
  (`test_migration_050.py:413-482`).

## IDOR / security

- `applyCardReview` filters BOTH the locked SELECT and the UPDATE on
  `user_id` (`cardReview.ts:96,142`); cross-user review → 404 with no
  existence leak and no write, tested (`hanja.test.ts:624-638`). Due queue
  user-scoped (`hanja.ts:666`), tested (`hanja.test.ts:484-493`).
- Hanja review route rejects non-hanja cards as 404 via `requireHanjaTarget`
  (`hanja.ts:726`, `cardReview.ts:105-109`) — no side door for other card
  families; tested (`hanja.test.ts:640-649`).
- `CardReviewBodySchema` is `.strict()` with an explicit tamper-probe test
  (`scheduled_days_after` → 400, `hanja.test.ts:662-667`); ids Zod-bounded to
  MAX_SAFE_INTEGER/INT4 (`hanja.ts:488-489`); scheduling fully
  server-authoritative (ADR-003 amendment honored).

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **`server/src/routes/plan.ts:205-214` — `dueCount` now includes hanja
   cards while the Review queue excludes them.** GET /plan/today counts ALL
   due `vocab_cards` with no `hanja_character_id IS NULL` filter, but
   `/vocab/cards/due` (`vocab.ts:272`) no longer serves hanja cards and no
   client consumes `/hanja/cards/due` yet (zero references under
   `client/src`). Once a user seeds hanja cards, the Today "reviews due"
   count exceeds what the Review screen can drain — a phantom-workload bug in
   waiting. (A smaller precedent already exists: graduated grammar cards,
   `vocab.ts:271`.) Fix belongs in the client-wiring slice: either exclude
   hanja from plan's count until the hanja review UI ships, or report the
   split explicitly.

### NIT
2. **`db/tests/test_migration_050.py:64-69` (and `050….up.sql:25-28`) — stale
   "048/049 do not exist on this branch" claim.** `048_tickets` and
   `049_vocab_list_entries_multitype` are now present in
   `db/migrations/` (Group 2 merge, `1d7897a`). `PRE_050 = "047"` remains
   functionally sound (neither 048 nor 049 touches `vocab_cards`), but the
   comments now mislead a future reader about what "the pre-050 schema" is.
3. **One-directional family guard.** `/hanja/cards/:cardId/reviews` 404s a
   non-hanja card, but `POST /vocab/cards/:cardId/reviews`
   (`vocab.ts:343-350`) will still rate a hanja card — it passes no family
   constraint, consistent with its pre-existing generic behavior (it also
   rates grammar/sentence/topik cards). No integrity risk (identical write
   path, same engine and log), but the "no side door" posture only points one
   way. Worth deciding deliberately when the client contract settles.
4. **pg deprecation warning during the gate run** ("Calling client.query()
   when the client is already executing a query is deprecated … removed in
   pg@9.0") — surfaced while running the two suites; likely a test-helper
   concurrency pattern, not this slice's code (`cardReview.ts` awaits every
   query sequentially). Worth locating before a pg major bump.

### PRAISE
- The extraction is a model refactor: verbatim lift verified against the
  parent commit, wire messages kept byte-identical via `cardNoun`, and the
  untouched pre-refactor vocab contract suite doubles as the regression
  proof.
- `test_migration_050.py` is exactly what a populated-table ALTER needs:
  real migration chain via `migrate.main()`, pre-050 rows seeded in the
  pre-050 shape, FK posture asserted from `pg_constraint` rather than prose,
  and a down/re-up round trip that checks the vocab card's own review row
  survived the hanja DELETE.
- The 050 up header's CASCADE-vs-RESTRICT argument (loader is upsert-only,
  shared reference data, SET NULL would trip the XOR) is the kind of recorded
  reasoning that prevents a future "fix" from re-breaking it.

## Coordination notes
- **Client wiring is absent by design** — no `client/src` reference to
  `/hanja/cards/*`. The plan.ts count fix (SHOULD-FIX 1) and the hanja review
  UI should land in the same slice.
- **nginx allow-list:** `/hanja` is a pre-existing top-level prefix (Pass 7
  routes are live), so no km-lb regex change is needed for these endpoints —
  the F-012 /ttmik trap does not apply here.
- **Deploy ordering:** `cardReview.ts:93` SELECTs `hanja_character_id`, so
  the new server build hard-requires migration 050. The deploy runner applies
  migrations before the new color starts, which satisfies this — but do not
  hot-patch the code onto a container whose DB hasn't run 050.
