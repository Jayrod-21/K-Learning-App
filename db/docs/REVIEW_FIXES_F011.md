# RE-REVIEW — F-011 fix-pass verification (commit `72e5f01` + uncommitted fixes)

**Reviewer:** independent re-reviewer (did not write the feature, the reviews, or the fixes).
**Inputs:** `REVIEW_F011_{client,routes,scoring}.md`, `FIX_REPORT_F011.md` (treated as claims, verified against code), `git diff` of the uncommitted fix-pass.
**Method:** re-ran both suites in the prescribed node:20-slim containers, re-derived the band math independently, and ran five live mutation probes (break the defended code, confirm the new test goes red, restore).

## Verdict: **PASS**

Every finding the fix-pass claims to address is genuinely fixed, every new test is
non-vacuous (proven by mutation, not by inspection), no PRAISE'd behavior was
touched, and both suites are green on the exact working tree. The two questions
this re-review was charged to answer definitively:

1. **Does the corrupt-evidence test truly catch a re-anchor deletion?** YES — proven
   by live mutation, not inference (see SF-1 below).
2. **Does the intro test truly catch the count?** YES — proven by live mutation:
   reverting the constants to 12/8/2 fails exactly the new intro test (see B1).

## Suite results (re-run, not trusted from the report)

| Suite | Result |
|---|---|
| Client `tsc --noEmit` | TC=0 |
| Client `eslint .` | LINT=0 |
| Client `vitest run` | **699 passed (699)** |
| Client `npm run build` | BUILD=0 |
| Server `vitest run` (routes/diagnostic + services/diagnostic/scoring) | **59 passed (59)** — was 57 at `72e5f01`; +2 are the SF-1/SF-2 route tests |
| Server `tsc --noEmit` | STC=0 (fix report's claim independently confirmed) |

Working tree confirmed restored byte-identical after each mutation probe
(`git diff --stat` = same 5 files, 211 insertions / 6 deletions; zero mutation residue).

---

## Finding-by-finding

### R3 B1 (BLOCKER) — intro advertised 8 items / 2 per section / 12 min → **FIXED**

- `client/src/pages/Diagnostic.tsx:116-118`: `INTRO_TOTAL_MINS = 20`,
  `INTRO_TOTAL_ITEMS = 16`, `INTRO_PER_SECTION = 4`. Cross-referenced to
  `ITEMS_PER_DIMENSION` in `server/src/routes/diagnostic.ts` (verified: `= 4` at
  `:81`, `TARGET_ITEM_COUNT = SCHEDULE.length // 16` at `:91`) in a comment block
  that also warns "retune all three together" — exactly what the review asked for.
- Module docstring at `:98-100` updated ("4 each … 16 items, ~20 min adaptive").
  No stale "8 items"/"2 each"/"12 min" text remains anywhere in the file.
- Intro no longer contradicts the run: the taking-screen total comes from the
  server (`progress.total`, `Diagnostic.tsx:691`) — the intro constants feed only
  the intro copy, so 16-promise → /16 progress bar now agree. Verified the
  constant change cannot break the taking screen (it never reads them).
- **New test is non-vacuous — mutation-verified.** Reverting the constants to
  12/8/2 (MUTATION D) fails "F-011: the intro advertises the real 16-item /
  4-per-section test shape" while all other Diagnostic tests stay green. The test
  asserts presence (`/20 min · 16 items/`, four `'4 items'` rows) AND absence
  (`/8 items/`, `'2 items'`, `/12 min/`) — it would fail against the pre-fix copy
  on the presence assertions alone. (Note: "16 items" does not match `/8 items/`,
  so no self-collision; the 20-min figure is a reasonable adaptive scaling of the
  old 12-min/8-item baseline.)

### R2 SF-1 (SHOULD-FIX) — parser guard + min/max re-anchor had no failing test → **FIXED, MUTATION-VERIFIED**

New route test "corrupt evidence.dimensionStats (F-011 fixpass R2 SF-1)"
(`server/tests/routes/diagnostic.test.ts`) seeds a real snapshot then raw-UPDATEs
`evidence` to the review's exact hostile payload (wrong-typed field / array entry /
null entry / finite-but-inverted 90-over-10 band). I ran both mutations the
original review said the old suite missed:

- **MUTATION A — re-anchor → passthrough** (`Math.min(stat.scoreLow, score)` →
  `stat.scoreLow`, same for high, `diagnostic.ts:799-800`): test **FAILS**
  (grammar's inverted 90/10 violates `scoreLow ≤ score`). Restored; green.
- **MUTATION B — field validation disabled** (`if (!valid) continue` neutralized,
  `diagnostic.ts:768`): test **FAILS** (`Number.isFinite(d.scoreLow)` → false;
  NaN reached the wire). Restored; green.

The test is definitively NOT vacuous — it is the regression tripwire the review
demanded. Assertions are exact (reading 70/70/70, listening 55/55/55, vocab
55/55/55, grammar re-anchored 66/66/66 — score values independently re-derived
from the estimates), plus the unconditional `0 ≤ low ≤ score ≤ high ≤ 100` sweep
and a `/history` cross-check on the same row. One quibble (see New findings N-A):
the `/history` leg checks only grammar, not all four dimensions — acceptable since
parser and DTO builder are shared code, but the fix report's "same degradation"
phrasing slightly oversells it.

### R2 SF-2 (SHOULD-FIX) — partial short pool (1–3 items) untested → **FIXED**

New route test "partial short pool — a dimension exhausted mid-run still scores"
seeds exactly 2 reading rows / 0 listening rows, drives a full run, and asserts:

- snapshot keys exactly `['grammar','reading','vocab']` — reading KEPT at n=2,
  listening omitted at n=0 (the middle ground the full/empty extremes missed);
- exact 2-item scoring: reading score 66, band **[62, 71]**. I re-derived this
  independently (pTilde = 4/6, se = 1.5·√(0.2222/6) ≈ 0.2887 est units, estimate
  4.75 ± margin → scores 62/71) — correct, and strictly WIDER than the 4-item
  run's [63, 70], so the test pins that the band honestly reflects smaller n;
- persisted `evidence.dimensionStats.reading = { n: 2, correct: 2 }` read back
  via raw SQL — the true served count, not the scheduled 4.

Non-vacuous by construction: dropping reading on pool exhaustion fails the keys
assertion; recording the scheduled n instead of the served n fails the `n === 2`
assertion; a zero-width or 4-item-width band fails the exact edge assertions.

### R3 S1 (SHOULD-FIX) — defensive band paths untested → **FIXED, MUTATION-VERIFIED**

- New `client/src/lib/skillBand.test.ts` (12 tests): clampScore passthrough /
  clamp / NaN→0; hasVisibleBand undefined edges (3 combos), degenerate pairs,
  real range, clamped-equal collapse (101&102, −3&−1), inverted 68/52→true, and
  the NaN contract pinned explicitly with a comment pointing at R3 N1's candidate
  `Number.isFinite` tightening.
- `SkillBar.test.tsx`: new inverted-pair render test asserting sorted geometry
  (`left: 52%`, `width: 16%`) and the sorted aria range "range 52–68".
- **MUTATION C — min/max sort removed from SkillBar** (`SkillBar.tsx:106-111` →
  raw clamped edges): the new inverted-pair test **FAILS** (7 others pass).
  Restored; green.
- **MUTATION E — clamp-before-compare removed from hasVisibleBand**
  (`skillBand.ts:33` → raw `!==`): two skillBand tests **FAIL** (clamped-equal
  collapse + NaN contract). Restored; green.

The defensive geometry is now pinned by failing tests, not comment claims —
exactly what S1 asked for.

### R3 S2 (SHOULD-FIX) — "Scoring against" verb → **FIXED**

`Diagnostic.tsx:998`: "Comparing against TOPIK II L4 reference." Repo-wide grep
for "Scoring against" → 0 hits. (The review's suggested phrasing included
"the … reference line"; the shipped copy drops those words — same semantic fix,
cosmetic difference only.)

### R1 N1 (NIT) — Agresti-Coull z=2/z=1 docstring note → **FIXED**

`server/src/services/diagnostic/scoring.ts:112-114`: the exact note R1 requested,
added inside the `dimensionResult` docstring. Diff verified **comment-only** — the
3 added lines are all inside the `/** … */` block; zero logic characters changed;
all 22 scoring tests still pass and STC=0.

### Other NITs (R3 N1-N3, R2 N-1-N-4, R1 NIT-2-4) → **DEFERRED (as chartered)**

Per fixpass instructions. The fix report correctly flags that R2 N-1
(`seed.ts:281-283` "the route never reads them" docstring) is now doubly stale —
the new SF-1 test reads evidence directly. Still open; still a nit.

---

## PRAISE'd behavior — confirmed untouched

The diff touches zero band/scoring/route logic: `client/src/lib/skillBand.ts`,
`SkillBar.tsx`, `SkillsCompare.tsx`, and `server/src/routes/diagnostic.ts` have
no source changes; `scoring.ts` changed comment-only. Specifically re-verified:

- **Band math (R1 P1-P4):** all 22 scoring tests pass; formulas untouched.
- **Defensive parser + re-anchor (R2 P-1/P-2):** untouched — and now finally
  test-pinned (the whole point of SF-1).
- **Degrade-to-no-band (R3 praise):** `hasVisibleBand` unchanged; the
  SkillsCompare legend-gating and degenerate-pair tests still present and green.
- **"Level 4"/"5 min ago" removal (R3 praise):** anti-regression assertions
  (`queryByText(/Level 4/)`, `queryByText(/min ago/i)`) still in
  `Diagnostic.test.tsx`; still green.

## Regressions: **none found**

699/699 client, 59/59 server, tsc clean both sides, eslint clean, client build
clean. The intro-constant change cannot reach the taking screen or progress bar
(server-fed `progress.total`). The scoring.ts change is provably comment-only.

## New findings (minor, non-blocking)

- **N-A (NIT):** the SF-1 test's `/history` leg asserts only grammar's re-anchored
  band, not the three malformed-entry degradations. Parser + DTO builder are
  shared between `/latest` and `/history`, so coverage is real, but two more
  `toMatchObject` lines would make the "same row → same degradation" claim
  literal. Fold into a future sweep with R2 N-1.
- **N-B (observation):** the intro test's absence regex `/8 items/` would
  false-match a future "18 items"/"28 items" copy — in the conservative direction
  (extra failure, never a missed one). No action needed.

## Recommendation

**Ship.** Commit the fix-pass as-is (5 modified files + new
`client/src/lib/skillBand.test.ts` + the four `db/docs/*F011*.md` documents).
The blocker is closed with a mutation-proof test, both SHOULD-FIX coverage gaps
are closed with mutation-proof tests, and the deferred nits are correctly scoped
for a later sweep.

## Mutation-probe evidence (all restored after each run)

| # | Mutation | Expected red test | Result |
|---|---|---|---|
| A | re-anchor `Math.min/max` → passthrough (`routes/diagnostic.ts:799-800`) | corrupt-evidence | **FAILED** (1 failed / 36 skipped) |
| B | `if (!valid) continue` disabled (`routes/diagnostic.ts:768`) | corrupt-evidence | **FAILED** (`expected false to be true` on finiteness) |
| C | SkillBar min/max sort removed (`SkillBar.tsx:106-111`) | inverted-pair render | **FAILED** (1 failed / 7 passed) |
| D | intro constants → 12/8/2 (`Diagnostic.tsx:116-118`) | intro shape test | **FAILED** |
| E | `hasVisibleBand` clamp-compare removed (`skillBand.ts:33`) | clamped-equal + NaN pins | **FAILED** (2 tests) |

Post-restore confirmation: the three touched client test files re-run green
(34 passed / 34); `git diff --stat` identical to the pre-probe fix diff; grep for
"MUTATION" across all touched source files → 0 hits.
