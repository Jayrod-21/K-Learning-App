# REVIEW — F-002 scoring-math + migration slice (commit 0111373)

Reviewer: independent (psychometrics + Postgres). Scope: `server/src/services/diagnostic/cat.ts`,
`scoring.ts`, `db/migrations/039_proficiency_level_l1_l2.{up,down}.sql`, `cat.test.ts`,
`scoring.test.ts` (+ route/plan ripple checks). Suite run: `vitest run tests/services/diagnostic`
in node:20-slim → **45/45 passed**.

## VERDICT: PASS — 0 BLOCKERS, 1 SHOULD-FIX, 4 NITs

The band math is correct, the low anchors are exactly collinear with the old curve (no historical
score changes anywhere), F-011's confidence band is byte-identical, the migration is safe on the
deployed PG16, and — the crux — a true beginner genuinely reaches L1 within 4 answers of the
16-item run. Tests pin every boundary on both sides and would catch the plausible mutations.

---

## Crux: can a true beginner actually reach L1/L2? — YES, verified

Staircase from `SEED_THETA = 4.0` (cat.ts:20), all-wrong/skip, steps `max(0.4, 1.0−0.1(n−1))`
(cat.ts:106-111), answerNumber counted **globally** across the run under the /answer row lock
(diagnostic.ts:981-989):

```
n=1: 4.0 − 1.0 = 3.0   → next item band L3
n=2: 3.0 − 0.9 = 2.1   → band L2
n=3: 2.1 − 0.8 = 1.3   → band L1
n=4: 1.3 − 0.7 = 0.6 → clamp THETA_MIN → 1.0
n=5..16: pinned at 1.0 — every remaining item serves at L1
```

The "4 skips reach exactly 1.0" claim is arithmetically right (0.6 pre-clamp, floored at the new
`THETA_MIN = 1.0`, cat.ts:27). By ordinal 5 of 16 the run serves L1 items in all four dimensions.

Placement follows through scoring (interleaved schedule reading,listening,vocab,grammar ×4;
generated-item difficulty = `proficiencyToNumber(target)`, topik difficulty = row tag else band):

- reading: difficulties 4,1,1,1 → base 1.75, p=0 → 1.75−0.75 = **1.00** → score **10**
- listening: 3,1,1,1 → 1.5−0.75 → clamp **1.00** → **10**
- vocab: 2,1,1,1 → 1.25−0.75 → clamp **1.00** → **10**
- grammar: 1,1,1,1 → 1.0−0.75 → clamp **1.00** → **10**

All four dimensions land on the 1→10 L1 anchor. A partial beginner (misses L4/L3, hits L1/L2
items) settles θ≈2, estimates ≈2 → score ≈25 (L2 anchor). **The feature is not inert**; the
old 2.0 floor / 'basic' collapse is genuinely gone. Pinned end-to-end by the route test
(`diagnostic.test.ts` "F-002 — L1/L2 in the diagnostic": all-skip run asserts
`ability_estimate = '1.00'`, servedLevels contain L1 and L2, vocab/grammar score = 10).

## Band cuts + θ range (cat.ts:78-84) — correct

- If-chain over strict `<` with terminal else: **monotonic, non-overlapping, exhaustive** — every
  real θ (incl. all of [1,6]) maps to exactly one band. Cuts 1.5 / 2.5 / 3.5 / 4.75 match the
  design and are sensible midpoints of the anchors {1,2,3,4,5.5}.
- Boundary landings: 1.5→L2, 2.5→L3, 3.5→L4, 4.75→L5+ — each intended, each pinned from BOTH
  sides in cat.test.ts:29-48 (1.49/1.5, 2.49/2.5, 3.49/3.5, 4.74/4.75). Mutation check: nudging
  any cut ±0.1, swapping `<` for `<=`, or reordering branches fails at least one assertion.
- `'basic'` is unreachable: excluded from the `DiagnosticBand` type (cat.ts:33) AND swept at
  runtime across [1,6] in cat.test.ts:52-56. `targetLevelForTheta` is now the identity (the old
  basic→L3 floor is gone) — pinned at cat.test.ts:59-70.
- `proficiencyToNumber` (cat.ts:44-64): L1=1, L2=2, basic=2 with a `never` exhaustiveness guard.
  The only basic/L2 conflation point is `buildTopikItem` difficulty (a 'basic'-tagged topik row
  scores as difficulty 2) — that is the documented intent (content tag ≈ L2 anchor), and nothing
  maps numbers BACK to labels through 'basic'. Consistent.

## Score anchors (scoring.ts:172-204) — collinear, no historical drift

Verified against the pre-commit source (`git show 0111373~1`): the old curve's below-3
extrapolation used slope (55−40)/(4−3) = **15/level**, so old(1) = 40−2·15 = 10 and
old(2) = 40−15 = 25 — the new anchors {1→10, 2→25} reproduce the old outputs **exactly**, for
every estimate (not just ≥3; old snapshots with estimates in [1,3) — possible pre-F-002 since
`clampEstimate` already floored at 1 — re-render identically through /latest, /trajectory,
/history). Monotonic: all six segment slopes = 15 > 0; `clampScore` bounds [0,100];
`Math.round` preserves monotonicity. Pinned: anchors 1–6 exact, midpoints, sub-1 extrapolation
(0.5→3, 0→0), 0.05-step monotonic sweep + strict increase across anchors
(scoring.test.ts:192-232).

## F-011 Agresti-Coull band — intact

The commit's scoring.ts diff is ONLY the `RUBRIC_VERSION` constant + the two anchor rows +
comments; `ESTIMATE_SPREAD`, `BAND_Z`, `estimateForDimension`, `dimensionResult` are
byte-identical. At the floor: estimate clamps to 1, margin ≥ 0 and finite (pTilde ∈ (0,1),
n ≥ 1), scoreLow = estimateToScore(clamp(1−m)) = 10 (clamp edge), scoreHigh > 10, everything in
[0,100], no NaN/negative possible. The new floor-behavior test (scoring.test.ts:156-168) pins
exactly this, mirroring the existing ceiling test.

## RUBRIC_VERSION v1.2.0 — warranted; old snapshots load

- Bump is semantically defensible: the anchor TABLE changed and the θ floor moved, so the
  distribution of estimates a run can produce changed, even though the estimate→score map is
  numerically unchanged. F-010's compare-like-versions posture is served conservatively.
- No reader rejects by version: `dimensionStatsFromEvidence` (diagnostic.ts:777-803) is
  version-agnostic and never-throw; /latest and /history rebuild v1.1.0 bands verbatim and
  degrade stat-less dimensions to zero width. Pinned by the new route test ("an old v1.1.0
  snapshot still loads…") through BOTH /latest and /history.

## Migration 039 — clean

- Each `ADD VALUE IF NOT EXISTS … BEFORE 'L3'` is its own top-level statement (up.sql:22,24).
  On PG12+ (deployed image is postgres:16-alpine) ADD VALUE may run inside a transaction as long
  as the same tx doesn't USE the new value — nothing in 039 does, and migrate.py's
  per-migration-tx runner explicitly forbids inner tx-control statements, so the runner contract
  holds. Idempotent re-apply via IF NOT EXISTS. Mirrors the accepted 028/031/032 stance.
- Ordering: L1 BEFORE 'L3', then L2 BEFORE 'L3' → `('basic','L1','L2','L3','L4','L5+')` —
  correct, and difficulty-monotonic above 'basic'. 'basic' preserved (1716+114 tagged rows
  undisturbed; no backfill, matching the design).
- Down = documented no-op (`SELECT 1` so the runner records it). Acceptable: pg cannot drop enum
  values; the values are inert if unused; same posture as 016/021/028/031/032. Reversible-enough.
- Bounds ripple: `diagnostic_runs.ability_estimate CHECK BETWEEN 0 AND 6` (014:89) and the
  snapshot estimate CHECKs (001:453) already admit 1.0 — no constraint violation from the new
  floor.

## Test adequacy — strong

Every probed property is pinned: band cuts (both sides of every boundary), never-emits-basic
(type + runtime sweep), θ-reaches-1.0 on a 4-skip staircase (cat.test.ts:113-120, exact-value
assertion), the low anchors (exact), monotonicity + bounds (sweep), floor-band sanity, rubric
bump, plus the E2E route test that drives a real all-skip run to `ability_estimate = '1.00'`
with corpus-shaped seeds (untagged TOPIK I rows) and score 10, and the TOPIK-I-preference +
exhaustion-fallback test made deterministic despite `ORDER BY random()`. A wrong cut point, a
reverted THETA_MIN, a slower staircase, or a broken anchor would each fail at least one test.

---

## Findings

### BLOCKER — none

### SHOULD-FIX

1. **Server snapshot `REFERENCES` lacks the L1/L2 reference lines the client was promised** —
   `server/src/routes/diagnostic.ts:722-728`. The commit added `{ id:'L1', value:10 }` /
   `{ id:'L2', value:25 }` to the client mock fixture and widened the client `ReferenceBand` id
   union (client/src/types/domain.ts) "so a beginner placement has real reference lines" — but
   the LIVE `/latest`//`finish`//`history` DTOs still ship only L3/L4/L5/L6/native. A real
   beginner therefore renders score 10 on a chart whose lowest reference line is TOPIK 3 at 40;
   only dev-mock mode shows the honest ladder. Mock/server drift, and the one place the F-002
   user-visible promise falls short. Fix: add the two rows to `REFERENCES` (values 10/25 per the
   anchor table). Out of the strict math slice (route file) but squarely an F-002 semantic gap.

### NIT

2. **Stale header comment** — `server/tests/services/diagnostic/scoring.test.ts:4-5` still says
   "Rubric v1.1.0 (F-011)" while the file now asserts v1.2.0.
3. **`bandForTheta(NaN)` → 'L5+'** — `cat.ts:78-84`: all `<` comparisons are false for NaN, so a
   NaN θ silently reads as the TOP band. Unreachable today (θ comes from a NUMERIC(3,2) column or
   finite arithmetic), but the module's siblings (`stepForAnswer`) guard their inputs; a one-line
   `Number.isFinite` guard or comment would match the house posture.
4. **`estimateToProficiency` still floors at L3** — `server/src/routes/plan.ts:134-141`: a
   placed-L1 learner's Today plan targets L3-band writing prompts. Pre-existing (estimates < 3.5
   occurred before F-002; the prompt bank has no sub-L3 rows), NOT a regression — but F-002 makes
   the mismatch visible. Backlog candidate.
5. **Enum sort order vs numeric anchors** — after 039 the enum orders `basic < L1 < L2` while
   numerically basic ≡ 2 (the L2 anchor). No current SQL ranges/sorts on `proficiency_level`
   (plan.ts:308 is equality-only), and the up.sql comment documents the ordering — just keep it
   in mind before anyone writes `ORDER BY proficiency`.

### PRAISE

- Boundary tests pin every cut from both sides — the band-cut suite is genuinely
  mutation-resistant, not decorative.
- The all-skip E2E route test is the right crux test: real corpus-shaped seeds (proficiency-NULL
  TOPIK I rows), deterministic despite shuffled generated answers (skips) and
  `ORDER BY random()` (pool sized to one), asserting the persisted θ, the served bands, AND the
  anchored scores.
- The anchor extension was done the disciplined way: verified collinear with the old
  extrapolation so the rubric bump carries zero historical repricing — and the code comment says
  exactly that.
- Migration prose explains the PG ADD VALUE transaction rule, the BEFORE ordering rationale, and
  the precedent migrations — an auditor needs nothing else.
