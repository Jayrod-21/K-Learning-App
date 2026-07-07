# RE-REVIEW — F-002 fixpass fixes (uncommitted on top of 0111373)

Independent re-reviewer (did not write the fixes). Scope: the three fixes from
`db/docs/FIX_F002.md` addressing `REVIEW_F002_selection.md` (B-1, SF-1, SF-2)
and `REVIEW_F002_math.md` (SF-1 duplicate). Working tree diff:
`server/src/routes/diagnostic.ts` (+87/−24) and
`server/tests/routes/diagnostic.test.ts` (+201) only.

Verification performed:

- **Full run** in node:20-slim (testcontainers Postgres):
  `npx tsc --noEmit` → **STC=0**; `vitest run tests/routes/diagnostic.test.ts
  tests/services/diagnostic` → **4 files, 91/91 passed** (route suite 46,
  services 45).
- **Mutation probes** — each fix reverted one at a time (single-line surgical
  mutants), targeted test run per mutant, source restored byte-identical
  afterward:
  - M1 (seed map → `return target`): **KILLED** — the B-1 basic-seeding test
    fails (1 failed / 45 skipped).
  - M2 (delete the `L1` REFERENCES row): **KILLED** — the SF-1 ladder test
    fails.
  - M3 (`paperForBand` → always TOPIK I): **KILLED** — the SF-2
    prefers-TOPIK-II test fails.

## VERDICT: **PASS** — all three fixes HOLD, no regressions found

---

## B-1 (BLOCKER) — L1/L2 generator seed mapping → **HOLDS**

`seedProficiencyForTarget` (diagnostic.ts:384-386) maps `L1|L2 → 'basic'`,
else identity, and BOTH `pickVocabSeed` and `pickGrammarSeed` iterate
`[seedProficiencyForTarget(target), null]`. Verified:

- **The test proves the behavior**: the B-1 test seeds 1 `basic` + 9 `L3`
  rows per section, drives an all-skip run (vocab slots at bands L2,L1,L1,L1;
  grammar L1×4 — staircase arithmetic re-checked: θ 4.0→3.0→2.1→1.3→1.0),
  and asserts all 8 generated responses carry the basic row's `source_ref`
  with recorded difficulty ≤ 2. Without the fix the pass probability is
  (1/10)^8 — stochastic in principle, deterministic in practice; the M1 probe
  killed it on the first run.
- **Fallback guarded**: the second B-1 test (no basic rows anywhere) proves
  the `null` fallback still supplies seeds — all 8 slots serve from L3 rows;
  an empty basic pool cannot starve a run.
- **No band where the mapping is wrong**: `DiagnosticTargetLevel` is exactly
  `'L1'|'L2'|'L3'|'L4'|'L5+'` (models.ts:206) — no `'basic'` input case
  exists, the ternary is total, and L3/L4/L5+ pass through unchanged (91/91
  includes every pre-existing L3+/generator test). The SQL cast
  `$n::proficiency_level` accepts `'basic'` (original enum member).

## SF-1 — server REFERENCES L1/L2 rungs → **HOLDS**

`REFERENCES` (diagnostic.ts:759-767) now leads with
`{L1, 'TOPIK 1', '1급', 10}` and `{L2, 'TOPIK 2', '2급', 25}`. Verified:

- **Values match everything they must match**: the scoring anchors
  (scoring.ts:175-176 — `[1, 10]`, `[2, 25]`) and the client
  `DIAGNOSTIC_SNAPSHOT_FIXTURE` + populated fixture
  (client/src/data/mocks/diagnostic.ts) — id/label/kr/value identical,
  7 rows both sides, lowest-first. The `emptySnapshot()` "matches the client
  fixture" comment is true again.
- **Wire coverage**: only two builders emit references — `emptySnapshot()`
  (line 779) and the populated snapshot builder (line 883) — both use the
  shared const, and `/latest`, `/finish`, `/history` all route through them.
  The new server test pins the full id order
  `['L1','L2','L3','L4','L5','L6','native']`, the exact L1/L2 rows, and
  strict monotonic values against a live `/latest` response — the
  mock-vs-wire gap cannot silently recur (M2 probe: removing the L1 line
  fails the test).

## SF-2 — symmetric TOPIK II preference → **HOLDS**, L1/L2 behavior NOT regressed

`paperForBand` (diagnostic.ts:190-195): `L1/L2 → 'TOPIK I'`, else
`'TOPIK II'` — a total mapping over the closed `DiagnosticBand` union.
`pickTopikRow` attempt list:

- **L1/L2 unchanged**: `bandProficiency` is `null` for L1/L2, so the list
  collapses to exactly the R2-approved pair
  `[{proficiency: null, 'TOPIK I'}, {null, null}]`. The pre-existing
  approved test ("prefers TOPIK I items for L1/L2 bands…", test line 1176)
  still passes — beginners still get TOPIK I with fallback.
- **L3/L4/L5+ now prefer TOPIK II**: attempts
  `{band, 'TOPIK II'}` → `{null, 'TOPIK II'}` → any. The new test uses the
  real corpus shape (all proficiency-untagged): 1 TOPIK II + 9 TOPIK I
  reading rows; ordinal 1 (band L4) must serve THE TOPIK II row (1/10 by
  chance) — M3 probe killed it. The exhaustion test (TOPIK I-only pool)
  proves the any-fallback keeps the run whole.
- **SQL sound**: the paper filter is a parameterized equality
  (`t.topik_level = $n`) on the always-present `topik_tests` JOIN; the
  answerable guard (≥2 options, non-null answer, no bare ①②③④) lives in
  the base WHERE, so it applies to every attempt identically. No
  interpolation; the N-2 magic-string fix (`TopikPaper` +
  `TOPIK_PAPER_I/II` constants) removes the silent-typo failure mode.

## Regression sweep — clean

- **Existing route tests**: 46/46 pass, including the advanced-run tests that
  seed L4-tagged rows — those default to `topikLevel: 'TOPIK II'` in the
  seed helper, so the new `{band, paper}` attempt-1 still matches them; the
  R2-approved F-002 TOPIK-I test's assertions (ordinal 5 = the TOPIK I row,
  9/13 fallback TOPIK II) hold under the new attempt list by construction
  and by run.
- **Seed-map change and L3+ gen**: identity pass-through for L3/L4/L5+;
  every pre-existing generator test passes.
- **Math/migration untouched**: `git diff` outside the two files is empty —
  `scoring.ts`, `cat.ts`, `migrations/039_*` byte-identical to 0111373;
  services suite (45 tests, incl. F-011 band + R1-approved anchors) all pass.
- **tsc/lint**: `tsc --noEmit` exit 0.

## New findings (none blocking)

1. **NIT** — For L3+, attempt 1 now requires the band tag AND the TOPIK II
   paper: a hypothetical L4-tagged item inside a TOPIK I test would only be
   reachable via the final any-fallback. Zero rows match that shape today
   (all corpus proficiency is NULL) and the semantics are arguably correct
   (an advanced user shouldn't get a TOPIK I paper item preferentially even
   if band-tagged); noting for the record only.
2. **NIT (inherited)** — a TOPIK I item served to an L3+ user via the any
   fallback is still recorded at `difficulty = band` (NULL-proficiency
   fallback in buildTopikItem). Pre-existing, flagged in the original review
   as such; SF-2 reduces its frequency, does not eliminate it. Backlog with
   the deferred N-1 (prompt proficiency enumeration, prompts/enrich.ts /
   recognize_grammar.ts).
3. The B-1 kill test is probabilistic ((1/10)^8 survival) rather than
   strictly deterministic — acceptable; the fix report discloses it and the
   probe killed on first run.

## Bottom line

All four diagnostic dimensions now genuinely target level: L1/L2 runs draw
reading/listening from TOPIK I and seed vocab/grammar generation from the
`basic`-tagged pools (with proven any-level fallback), L3+ runs prefer
TOPIK II, and the live reference chart ships the TOPIK 1/2 rungs matching
the scoring anchors and the client mock. Every fix is pinned by a test that
demonstrably fails when the fix is reverted. Ready to commit.
