# Review — F-011 Scoring Math Slice (commit 72e5f01)

**Scope:** `server/src/services/diagnostic/scoring.ts` (`estimateForDimension`,
`dimensionResult`, `resultsByDimension`, `RUBRIC_VERSION`, constants) +
`server/tests/services/diagnostic/scoring.test.ts`, reviewed against
`BRIEF_F011_diagnostic_hardening.md` §1b and §2a.

**Reviewer stance:** independent; did not write this code. All key statistical
properties were re-derived by hand and cross-checked with an independent
numerical replication of the formulas (not by trusting the shipped tests).

## Verdict: PASS

0 BLOCKER · 0 SHOULD-FIX · 4 NIT · 4 PRAISE

Test suite: `tests/services/diagnostic/scoring.test.ts` — **22/22 passed**
(run in the prescribed node:20-slim container).

---

## By-hand verification of the probed properties

All numbers below computed independently from the source formulas at
`scoring.ts:119-131` (ESTIMATE_SPREAD=1.5, BAND_Z=1.0), then confirmed by a
scripted sweep. `w` = scoreHigh − scoreLow in score points.

### estimateForDimension (`scoring.ts:68-75`)

`estimate = round2(clampEstimate(mean(difficulty) + 1.5·(p − 0.5)))`.

- **Symmetric + monotonic in p:** yes — delta is linear in p, ±0.75 at the
  extremes. At base 4: 0/4→3.25, 1/4→3.63, 2/4→4.00, 3/4→4.38, 4/4→4.75.
  All five **distinct and correctly ordered**; the adjacent gap is
  ESTIMATE_SPREAD/n = 0.375 at n=4, far above the 0.01 round2 granularity —
  no rounding collapse is possible for any n the schedule can produce (n ≤ 4;
  collapse would require n > ~75).
- **Clamp:** applied (`clampEstimate` to [1,6]) *before* `round2`; round2 of a
  value in [1,6] cannot exit [1,6]. Correct order of operations.
- **null on 0 items:** preserved (`scoring.ts:69`); this also guards every
  division in the file — no NaN/Infinity path exists (n ≥ 1 downstream, and
  pTilde ∈ (0,1) strictly, so the sqrt argument is always > 0).

### dimensionResult band (`scoring.ts:119-131`)

`pTilde=(k+2)/(n+4)`, `se=1.5·√(pTilde(1−pTilde)/(n+4))`, `margin=1.0·se`,
band endpoints = `estimateToScore(clampEstimate(estimate ± margin))`.

1. **Non-zero width at p=0 and p=1 — CONFIRMED by hand.**
   n=4, k=4: pTilde = 6/8 = 0.75 → se = 1.5·√(0.1875/8) = 0.2296 → margin
   0.2296 est units ≈ 3.4 score points/side. Result: estimate 4.75, score 66,
   band [63, 70], width 7. n=4, k=0 is the mirror: 3.25 → 44, band [40, 47],
   width 7. The +2/+4 smoothing keeps pTilde strictly inside (0,1) for every
   (n,k), so se > 0 always — the acceptance criterion holds structurally, not
   just at tested points.
2. **Narrows as n grows — CONFIRMED.** The `/(n+4)` denominator drives it, and
   at p extremes pTilde also moves away from 0.5 as n grows, so both factors
   shrink se. Widths: p=1 → n=2 gives 9 vs n=4 gives 7; p=0 → 9 vs 7;
   p=0.5 → 10 vs 8. Monotone in n at fixed p.
3. **Widest near p=0.5 — CONFIRMED.** pTilde(1−pTilde) is maximized at
   pTilde=0.5, which occurs exactly at k=n/2. Margins at n=4: k=2 → 0.2652 >
   k=1,3 → 0.2567 > k=0,4 → 0.2296.
4. **Ordering + bounds through estimateToScore — CONFIRMED, and provably, not
   just empirically.** `estimateToScore` (`scoring.ts:159-189`) is monotone
   non-decreasing everywhere: every anchor segment has positive slope (all are
   exactly 15/level as currently tabled), the below-anchor extrapolation uses
   the same positive slope, `clampScore` and `Math.round` are both monotone
   non-decreasing maps. Since estimate−margin ≤ estimate ≤ estimate+margin and
   estimate ∈ [1,6] (so clamping the endpoints never crosses the center),
   composition preserves scoreLow ≤ score ≤ scoreHigh; clampScore bounds all
   three to [0,100]. My independent sweep (n=1..6 × all k × difficulty 1.0–6.0
   step 0.1, 966 cells) found **zero violations**. A nonlinear future anchor
   table stays safe as long as anchor scores remain ascending (see NIT-3).
5. **Units — no confusion.** margin lives in estimate (0–6) units
   (annotated at `scoring.ts:126`) and is only ever consumed via
   estimateToScore; it is never added to a 0–100 score. At the current 15
   pts/level slope, the n=4 extreme margin of 0.23 est ≈ 3.4 score pts/side —
   a sensible, modest band for BAND_Z=1.

### Edge cases

- **n=1:** defined and sane — margin 0.3286 (wider than any n=4 case, as it
  should be), e.g. n=1 k=0 d=4 → band [39, 49] around 44. Covered by the
  exhaustive test loop (`scoring.test.ts:134`).
- **Clamp-edge collapse:** at estimate=6 (e.g. 4/4 at difficulty 6) the band
  is one-sided — scoreHigh = score = 85, scoreLow 82 (width 3, non-zero).
  Mirrored at the floor (estimate=1 → [10, 13]). Deliberate, documented in the
  docstring (`scoring.ts:113-116`), and pinned for the ceiling by a test.
- **`correct` source:** `responses.filter((r) => r.isCorrect)` — same field
  the estimate uses; the route builds it from `r.is_correct === true`
  (`routes/diagnostic.ts:1245`), so a skip/null grades as incorrect,
  consistent with the documented contract (`scoring.ts:29-30`).

### Test adequacy + mutation check

Properties 1–4 are pinned with real assertions, not existence checks:

- **Mutating pTilde back to k/n** → at 4/4, p(1−p)=0 → margin 0 → zero-width
  band → the two named non-zero-width tests (`scoring.test.ts:110-120`,
  strict `<`/`>` against score) **FAIL**. The acceptance criterion's critical
  case is directly asserted. Setting BAND_Z=0 fails the same tests.
- **Removing the /(n+4) n-dependence** → at p=0.5 the n=2 and n=4 widths
  become equal → strict `>` at `scoring.test.ts:125` **FAILS**.
- **Reverting the 3-bucket delta** → 1/4, 2/4, 3/4 would all read 4.0 → the
  exact-value + strict-ordering assertions at `scoring.test.ts:59-68` **FAIL**.
- **Widest-at-0.5** asserted with strict inequalities (`:128-131`); verified
  the underlying margins have ≥1 rounded-score-point separation in every
  comparison the tests make (9>7, 9>7, 10>8, 8>7), so none of them pass
  by rounding luck.
- Ordering/bounds pinned exhaustively over n∈{1..4} × all k × difficulties
  including both clamp edges (`:133-145`).

---

## Findings

### NIT-1 — "Agresti-Coull" smoothing/z mismatch (scoring.ts:108-109, 124)
`(k+2)/(n+4)` is the classic **z=2** ("add 2 successes and 2 failures")
Agresti-Coull smoothing, but the band multiplies by BAND_Z=1.0. A
convention-consistent z=1 AC would use `(k+0.5)/(n+1)`. The mix is exactly
what the brief prescribes and errs conservative (wider at p extremes — the
desired direction), and the BAND_Z comment hedges with "≈ a 68% band", but a
one-line docstring note ("z=2 smoothing under a z=1 band, deliberately
conservative at the extremes") would spare the next statistician this exact
double-take. No behavior change wanted.

### NIT-2 — band covers only binomial noise in p (scoring.ts:119-131)
`base` (mean served difficulty) is treated as exact, but the served
difficulties come from the noisy θ staircase, so the interval understates
total uncertainty. Explicitly out of scope per the brief (θ untouched,
band intentionally modest) — recording it so the limitation is on file for
the future calibrated-bank effort.

### NIT-3 — ordering guarantee silently depends on estimateToScore monotonicity
Property 4 holds because every anchor segment in `estimateToScore`
(`scoring.ts:161-167`) has a positive slope. A future edit that makes anchor
scores non-ascending would break scoreLow ≤ score ≤ scoreHigh, and the
exhaustive test only samples grid points. Cheap guard: a test asserting
`estimateToScore` is non-decreasing over a fine sweep of [0, 7], or a comment
on the anchor table stating the invariant `dimensionResult` relies on.

### NIT-4 — floor-collapse case untested (scoring.test.ts:147-154)
The ceiling collapse (estimate clamps at 6 → one-sided band) has a dedicated
test; the symmetric floor case (e.g. difficulty 1.5, 0/4 → estimate 1 →
scoreLow = score = 10, scoreHigh 13) does not. The generic bounds loop covers
its safety but not its shape. Two-line addition.

### PRAISE-1 — exhaustive ordering/bounds sweep (scoring.test.ts:133-145)
n × k × difficulty grid including both clamp edges (1.5 and 6) is exactly the
right way to pin property 4 against the clamp/rounding interactions; my
independent, finer sweep found nothing it misses in the reachable range.

### PRAISE-2 — the acceptance criteria map one-to-one onto named tests
Non-zero at p=0 and p=1 each get their own strict-inequality test; the
narrowing and widest-at-0.5 properties are asserted with strict comparisons.
Every plausible regression mutation I traced (pTilde→k/n, drop n-dependence,
revert 3-bucket, BAND_Z→0) fails at least one clearly named test.

### PRAISE-3 — honest, documented clamp-edge behavior (scoring.ts:113-116, test :147-154)
The one-sided band at the scale ceiling isn't papered over — it's documented
("collapses toward the clamp edge but keeps its inward tail") and pinned by a
test that asserts the lower tail survives. That's the correct behavior and
the correct level of candor about it.

### PRAISE-4 — unit discipline
The `// in estimate (0–6) units` annotation (scoring.ts:126) plus routing all
score-space conversion through the single `estimateToScore`/`clampEstimate`
pair eliminates the est-vs-score unit-confusion class of bug entirely; the
constants (ESTIMATE_SPREAD, BAND_Z) are exported, named, and documented as
tunables per the brief.

---

## Bottom line

The math is correct, matches the brief's §1b/§2a formulas exactly, and the
two highest-risk properties hold definitively: the Agresti-Coull smoothing
makes a zero-width band **structurally impossible** for any served dimension
(pTilde never reaches 0 or 1), and ordering/bounds preservation through
`estimateToScore` follows from monotone composition, confirmed by a
966-cell independent sweep with zero violations. Tests would catch every
regression probed. Ship it; the four NITs are polish.
