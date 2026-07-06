# FIX REPORT — F-011 fixpass (post-review, commit 72e5f01)

Fixer: independent fix-pass agent (did not write/review feature). Inputs:
`db/docs/REVIEW_F011_client.md` (R3), `db/docs/REVIEW_F011_routes.md` (R2),
`db/docs/REVIEW_F011_scoring.md` (R1).

## Dispositions

### BLOCKER (R3 B1) — intro advertises old 8-item shape → **FIXED**
`client/src/pages/Diagnostic.tsx`
- Constants (was 12/8/2): `INTRO_TOTAL_MINS = 20`, `INTRO_TOTAL_ITEMS = 16`,
  `INTRO_PER_SECTION = 4`. Time scaled from 8→12min baseline (16 items ≈ 24min
  linear; 20 chosen — adaptive runs shorter, round value).
- Comment block above constants cross-references `ITEMS_PER_DIMENSION` in
  `server/src/routes/diagnostic.ts` + warns the taking-screen progress bar
  counts to the server total ("retune all three together").
- Stale module docstring (was "2 each … 8 items, ~12 min") → "4 each … 16
  items, ~20 min".
- New test `Diagnostic.test.tsx` — "F-011: the intro advertises the real
  16-item / 4-per-section test shape": asserts eyebrow `/20 min · 16 items/`,
  `getAllByText('4 items')` length 4, and absence of `/8 items/`, `'2 items'`,
  `/12 min/`.

### SHOULD-FIX (R3 S1) — defensive band paths untested → **FIXED**
- NEW `client/src/lib/skillBand.test.ts` — `clampScore`: in-range passthrough,
  out-of-range clamp, NaN→0. `hasVisibleBand`: undefined edges (3 combos),
  equal pairs (45/45, 0/0, 100/100), real range, clamped-equal collapse
  (101&102→false, −3&−1→false), inverted 68/52→true, NaN pins
  (NaN,70→true / NaN,NaN→false / NaN,0→false — current contract pinned
  explicitly with comment pointing at R3 N1's candidate `Number.isFinite`
  tightening; any change must be deliberate).
- `client/src/components/SkillBar.test.tsx` — new render test: inverted pair
  `scoreLow=68, scoreHigh=52` asserts band renders SORTED — `left: 52%`,
  `width: 16%` (non-negative), aria-label `range 52–68` (sorted, not raw).
  Deleting the min/max sort in SkillBar or the clamp-compare in
  `hasVisibleBand` now fails tests.

### SHOULD-FIX (R3 S2) — DoneBlock "Scoring against" verb → **FIXED**
`client/src/pages/Diagnostic.tsx` DoneBlock hint: "Scoring against TOPIK II
L4 reference." → "Comparing against TOPIK II L4 reference." (comparison
anchor, not an awarded score). `git grep 'Scoring against'` → 0 hits.

### SHOULD-FIX (R2 SF-1) — parser guard + re-anchor had no failing test → **FIXED**
`server/tests/routes/diagnostic.test.ts` — new describe "corrupt
evidence.dimensionStats (F-011 fixpass R2 SF-1)". Seeds a snapshot
(estimates reading 5 / listening 4 / vocab 4 / grammar 4.75) then raw-UPDATEs
`evidence` to the review's hostile payload: `reading: {n:"x"}` (wrong-typed
field), `listening: [1]` (array), `vocab: null`, `grammar` finite-but-INVERTED
band (scoreLow 90 > scoreHigh 10). Asserts `/latest` 200 (no throw), all 4
dims finite with `0 ≤ scoreLow ≤ score ≤ scoreHigh ≤ 100`, malformed dims
degrade to exact zero-width at recomputed score (70/70/70, 55/55/55,
55/55/55), grammar re-anchored to 66/66/66; `/history` same row → same
degradation. Mutation coverage: deleting the `Number.isFinite`/`typeof`
validation → NaN edges → red; replacing `Math.min/max` re-anchor with
passthrough → 90/10 inversion → red.

### SHOULD-FIX (R2 SF-2) — partial short pool (1–3 items) untested → **FIXED**
`server/tests/routes/diagnostic.test.ts` — new describe "partial short pool
… (F-011 fixpass R2 SF-2)". Seeds exactly 2 reading topik rows (schedule
wants 4), 0 listening, vocab+grammar via stub; drives run to finish. Asserts
snapshot keys = [grammar, reading, vocab] (reading KEPT on 2 items, listening
omitted at 0), exact 2-item scoring (2/2 at L4 → estimate 4.75 → score 66,
band [62, 71] — non-zero and wider than the 4-item run's [63, 70]), and
persisted `evidence.dimensionStats.reading = { n: 2, correct: 2 }` (true
served count). Pins pickTopikItem already-served exclusion + skip-and-continue
loop composing mid-run.

### NIT (R1 N1) — Agresti-Coull z=2/z=1 mismatch docstring → **FIXED**
`server/src/services/diagnostic/scoring.ts` `dimensionResult` docstring, added:
"(Statistical note: +2/+4 is the classic z=2 Agresti-Coull smoothing, used
here under a z=1 (BAND_Z) interval — intentional, deliberately conservative
at the p extremes.)" No behavior change.

### Other NITs (R3 N1–N3, R2 N-1–N-4, R1 NIT-2–4) → **DEFERRED**
Per fixpass instructions ("skip other nits"). Note R2 N-1 (stale
`seed.ts:281-283` docstring "the route never reads them") is now doubly stale
— the new SF-1 test reads evidence directly — flagged for a future sweep.

## PRAISE'd behavior — untouched
Band math, defensive parser, degrade-to-no-band, "Level 4"/"5 min ago"
removal: no source changes on server route/scoring logic or client band
logic. Only client copy/constants + docstrings + tests changed. Changed
files: `client/src/pages/Diagnostic.tsx`, `client/src/pages/Diagnostic.test.tsx`,
`client/src/lib/skillBand.test.ts` (new), `client/src/components/SkillBar.test.tsx`,
`server/src/services/diagnostic/scoring.ts` (comment only),
`server/tests/routes/diagnostic.test.ts`.

## Verify (dockerized node:20-slim, per fixpass charter)

Client (`npm ci && tsc && lint && vitest run && build`):
```
TC=0
LINT=0 (eslint . — 0 errors / 0 warnings)
Tests  699 passed (699)
BUILD=0
```

Server (`npm ci && tsc && vitest run tests/routes/diagnostic.test.ts tests/services/diagnostic/scoring.test.ts`):
```
STC=0
Tests  59 passed (59)   [was 57: 35 routes + 22 scoring; +2 new route tests]
Duration  31.16s
```
