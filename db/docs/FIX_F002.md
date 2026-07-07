# FIX — F-002 fixpass findings (REVIEW_F002_selection.md + REVIEW_F002_math.md)

Branch `feat/f002-diagnostic-l1l2`. All fixes server-side:
`server/src/routes/diagnostic.ts` + regression tests in
`server/tests/routes/diagnostic.test.ts`. Scoring math / bands / migration 039
untouched (R1 passed those).

## B-1 (BLOCKER) — L1/L2 generator seeds targeted a dead tag → FIXED

- **Change**: new `seedProficiencyForTarget(target)` in diagnostic.ts maps the
  target band → the content tag the seed query should match:
  `L1 → 'basic'`, `L2 → 'basic'`, `L3/L4/L5+ → unchanged`. Both
  `pickVocabSeed` and `pickGrammarSeed` now iterate
  `[seedProficiencyForTarget(target), null]` instead of `[target, null]`, so a
  beginner vocab/grammar item seeds from the `basic`-tagged pool (1716 vocab +
  114 kgiu rows) with the existing any-level fallback intact.
- **Tests** (both fail without the fix / guard the fallback):
  - `L1/L2 vocab/grammar items seed from basic-tagged content, not a random
    any-level row (fixpass B-1)` — seeds 1 `basic` vs 9 `L3` rows per section,
    drives an all-skip run (vocab slots at bands L2,L1,L1,L1; grammar L1×4),
    asserts all 8 generated responses carry the basic row's `source_ref` and a
    recorded difficulty ≤ 2. Without the fix the odds of passing are (1/10)^8.
  - `L1/L2 seed picking falls back to any level when no basic content exists
    (fixpass B-1)` — no basic rows anywhere; all 8 generated slots still serve,
    seeded from the L3 rows.

## SF-1 — server REFERENCES missing L1/L2 rungs → FIXED

- **Change**: server `REFERENCES` const now leads with
  `{ id: 'L1', label: 'TOPIK 1', kr: '1급', value: 10 }` and
  `{ id: 'L2', label: 'TOPIK 2', kr: '2급', value: 25 }`, lowest-first —
  values match the client `DIAGNOSTIC_SNAPSHOT_FIXTURE` and the
  `estimateToScore` anchors {1→10, 2→25}. The `emptySnapshot()` "matches the
  client fixture" comment is true again (7 refs both sides). Emitted by
  `/latest`, `/finish`, `/history` (shared const).
- **Test**: `snapshot references include the L1/L2 ladder, lowest-first
  (fixpass SF-1)` — pins the full id order
  `['L1','L2','L3','L4','L5','L6','native']`, the exact L1/L2 rows, and strict
  monotonic values, so server-vs-mock drift can't recur.

## SF-2 — higher-band asymmetry (advanced users drew ~40% TOPIK I) → FIXED

- **Change**: one band→paper mapping `paperForBand(band)` —
  `L1/L2 → 'TOPIK I'`, `L3/L4/L5+ → 'TOPIK II'`. `pickTopikRow` attempts,
  most→least targeted:
  - L3/L4/L5+: `{proficiency: band, paper}` → `{proficiency: null, paper}` →
    any. The middle attempt is the one that fires in production (all corpus
    proficiency is NULL) — advanced bands now prefer TOPIK II symmetrically.
  - L1/L2: `{proficiency: null, 'TOPIK I'}` → any (unchanged behavior; no rows
    are tagged L1/L2, so no proficiency attempt).
- **Tests**:
  - `pickTopikRow prefers TOPIK II items for L3+ bands and falls back to any
    when TOPIK II runs short (fixpass SF-2)` — 1 untagged TOPIK II + 9 untagged
    TOPIK I reading rows (real corpus shape); ordinal 1 (band L4) must serve
    THE TOPIK II row (1/10 chance without the fix); later L1-band slots serve
    TOPIK I.
  - `an L3+ band with NO TOPIK II items still serves (paper preference falls
    back to any) (fixpass SF-2)` — TOPIK I-only pool; ordinal 1 still serves.

## NITs

- **N-2 (magic `'TOPIK I'` string) → FIXED** (in-file, trivial): named
  `TopikPaper` type + `TOPIK_PAPER_I`/`TOPIK_PAPER_II` constants; the paper
  filter is built from `paperForBand`, no bare literals left in the SQL path.
- **N-1 (enrich/recognize prompts enumerate old proficiency set) → NOT
  changed**: lives in `prompts/enrich.ts` / `prompts/recognize_grammar.ts`
  (out of the touched files) and is a deliberate-intent question (should
  content tagging ever emit L1/L2?), not a mechanical fix. Deferred — noted
  for backlog.
- Math-review NITs (scoring.test.ts header comment, `bandForTheta(NaN)`,
  `plan.ts` L3 floor, enum sort order) — out of scope per instructions (no
  scoring/band/migration changes); untouched.

## Verify

`npx tsc --noEmit` → STC=0. Full server vitest suite in node:20-slim
(testcontainers Postgres): see final run — all files/tests pass, including the
5 new regression tests (diagnostic route suite 41 → 46).
