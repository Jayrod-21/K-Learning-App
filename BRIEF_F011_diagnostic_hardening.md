# Coding Brief — F-011: Diagnostic hardening (cheap heuristic pass)

**For:** a focused Fable/Claude coding session. **Repo:** Korean Master.
**Branch off `rebuild`.** Self-contained — everything needed is below.

## Goal & scope

Make the diagnostic *more trustworthy without* a psychometrics rebuild. Two
changes only:

1. **More items per dimension** (2 → 4) so a single lucky/unlucky guess can't
   swing a skill a full level, and make the per-dimension score use *all* the
   items (proportion-correct), not a 3-bucket delta.
2. **Confidence band + honest labeling** so measurement noise reads as
   uncertainty, not as real change on the (upcoming) progress graph.

**Explicitly OUT of scope** (deferred to the later "validated test" effort):
guessing/chance correction, adaptive stopping rule (item count stays fixed),
calibrated item bank / real IRT. Do **not** implement these.

## Background — what the diagnostic is today (so you don't misread it)

- 8 items/run, **2 per dimension** (reading, listening, vocab, grammar), fixed
  interleaved `SCHEDULE`. Reading/listening come from the `topik_items` corpus
  (no Claude); vocab/grammar are Claude-generated per run.
- Ability θ is a heuristic staircase (seed 4.0, ±decaying step, clamp [2,6]) —
  **not IRT**. Leave the θ staircase (`cat.ts`) alone; this brief does not touch it.
- Per-dimension estimate (`scoring.ts`) = mean(item difficulty) + a crude delta
  (all-correct +0.5 / none −1.0 / mixed 0). "Difficulty" is the item's proficiency
  *label* mapped to a number (basic=2/L3=3/L4=4/L5+=5.5).
- Score curve maps estimate 0–6 → 0–100 (piecewise-linear; 6→85, never 100).

---

## ⚠️ Read before you start — cross-dependencies

- **B-006 (diagnostic freezes):** each `/answer` currently generates the NEXT item
  synchronously via a blocking Claude call before responding. This brief **doubles
  the Claude-generated items** (vocab 2→4, grammar 2→4 = 8 Claude calls/run), which
  makes the frozen-feel *worse*. Strongly recommend doing **B-006 first or in the
  same session** (decouple next-item generation from grading). At minimum, verify
  latency is acceptable before merging.
- **B-007 (stale retake + hardcoded results copy):** overlaps the exact
  `ResultsBlock` lines this brief relabels (`Diagnostic.tsx:890`, `:894-896`). Do
  them together to avoid conflicts.
- **F-010 (progress history page):** the rubric change here bumps `RUBRIC_VERSION`;
  the history page must compare like rubric versions. Note it there.

---

## Change 1 — more items per dimension + proportion-based scoring

### 1a. Schedule: 2 → 4 per dimension

**File:** `server/src/routes/diagnostic.ts:60-73`

Replace the hardcoded 8-element `SCHEDULE` with one derived from a constant, so the
count is a one-line knob later:

```ts
/** Items served per dimension. 4 balances reliability against Claude cost
 *  (vocab+grammar are generated → 2*ITEMS_PER_DIMENSION Claude calls/run). */
const ITEMS_PER_DIMENSION = 4;

/** Interleaved serve schedule: DIMENSION_ORDER repeated ITEMS_PER_DIMENSION times
 *  → reading,listening,vocab,grammar, reading,... Interleaving spreads adaptivity
 *  across skills. */
const SCHEDULE: readonly DiagnosticDimensionKey[] = Array.from(
  { length: ITEMS_PER_DIMENSION },
  () => DIMENSION_ORDER,
).flat();

const TARGET_ITEM_COUNT = SCHEDULE.length; // now 16
```

- Update the module docstring at `diagnostic.ts:21` ("bounded to ≤4 calls per run
  by the fixed 8-item, 2-each schedule") → up to `2*ITEMS_PER_DIMENSION` (8) Claude
  calls, 16-item schedule.
- **Corpus pool check:** `pickTopikItem` already excludes already-served ids and
  falls back from an exact band to "any band" when tagging is sparse. With 4
  reading + 4 listening needed per run, confirm `topik_items` has enough usable
  rows (≥4 with `jsonb_array_length(options) >= 2`) per section; if a pool is
  short, `buildItemForSection` returns `null` and `serveNextItem` skips that
  ordinal — which is fine, scoring already handles a dimension that received
  `< ITEMS_PER_DIMENSION` items (and omits one that got 0). Add a `log`/comment so
  short-pool skips are observable, not silent.

### 1b. Scoring: use proportion correct, not a 3-bucket delta

**File:** `server/src/services/diagnostic/scoring.ts:40-70` (`estimateForDimension`)

The current all/none/mixed delta wastes the extra items (1/4, 2/4, 3/4 all collapse
to delta 0). Replace with a smooth, symmetric, monotonic proportion adjustment:

```ts
/** Estimate spread: how far proportion-correct can move the estimate off the
 *  mean served difficulty. p=1 → +SPREAD/2, p=0 → −SPREAD/2. */
const ESTIMATE_SPREAD = 1.5; // ±0.75 level at the extremes

export function estimateForDimension(responses: readonly ScoredResponse[]): number | null {
  if (responses.length === 0) return null;
  const base = responses.reduce((s, r) => s + r.difficulty, 0) / responses.length;
  const p = responses.filter((r) => r.isCorrect).length / responses.length; // 0..1
  const delta = ESTIMATE_SPREAD * (p - 0.5);
  return round2(clampEstimate(base + delta));
}
```

This gives 4/4→+0.75, 3/4→+0.375, 2/4→0, 1/4→−0.375, 0/4→−0.75 — every item
counts. Keep the `null`-on-zero-items contract. `ESTIMATE_SPREAD` is tunable; 1.5 is
a reasonable start (close to the old ±0.5…−1.0 intent but symmetric).

### 1c. Bump the rubric version

**File:** `server/src/services/diagnostic/scoring.ts:13`

`RUBRIC_VERSION = 'v1.0.0'` → `'v1.1.0'` (the formula changed). The snapshot table's
`ck_diagnostic_snapshots_rubric_version_shape` CHECK accepts any semver; the
`evidence` JSONB already stores per-item records so old runs remain re-gradable.

---

## Change 2 — confidence band + honest labeling

### 2a. Compute a per-dimension confidence band (server)

Add a helper to `scoring.ts`. The key nuance: **with few items, p=0 or p=1 is common
and must NOT produce a zero-width "we're certain" band.** Use an Agresti-Coull–style
smoothed proportion so 4/4 still yields a real interval.

```ts
/** Z for the band. 1.0 ≈ a 68% ("±1 SE") band — intentionally modest so the UI
 *  doesn't look alarmist. */
const BAND_Z = 1.0;

export interface DimensionResult {
  readonly estimate: number;   // 0–6
  readonly score: number;      // 0–100 (estimateToScore(estimate))
  readonly scoreLow: number;   // 0–100 band floor
  readonly scoreHigh: number;  // 0–100 band ceiling
  readonly n: number;          // items served in this dimension
}

/** Confidence band in SCORE points for one dimension. Smoothed proportion
 *  (Agresti-Coull, +2 successes / +4 trials) keeps the band non-zero at p=0/1
 *  and widens it for inconsistent (mid-p) answers; it also narrows as n grows. */
export function dimensionResult(responses: readonly ScoredResponse[]): DimensionResult | null {
  const estimate = estimateForDimension(responses);
  if (estimate === null) return null;
  const n = responses.length;
  const k = responses.filter((r) => r.isCorrect).length;
  const pTilde = (k + 2) / (n + 4);
  const seEstimate = ESTIMATE_SPREAD * Math.sqrt((pTilde * (1 - pTilde)) / (n + 4));
  const margin = BAND_Z * seEstimate; // in estimate (0–6) units
  const score = estimateToScore(estimate);
  const scoreLow = estimateToScore(clampEstimate(estimate - margin));
  const scoreHigh = estimateToScore(clampEstimate(estimate + margin));
  return { estimate, score, scoreLow, scoreHigh, n };
}
```

Provide a `resultsByDimension(responses)` sibling to `estimatesByDimension` that
returns `Record<DiagnosticDimensionKey, DimensionResult | null>`.

### 2b. Persist + surface the band (no migration needed)

The snapshot table stores only per-dimension *estimate* columns, so recompute-on-read
needs n/p. **Store the band in the existing `evidence` JSONB** — avoids a migration.

- **File:** `server/src/routes/diagnostic.ts` finish handler (~`:959`, `:976`).
  Compute `resultsByDimension(scored)` and add to the `evidence` object a
  `dimensionStats` block: `{ reading: {n, correct, estimate, score, scoreLow,
  scoreHigh}, listening: {...}, ... }`. Keep writing the estimate columns as today.
- **File:** `diagnostic.ts:620-633` — extend `SnapshotDimensionDTO` with
  `readonly scoreLow: number; readonly scoreHigh: number;`.
- **File:** `diagnostic.ts:663-683` (`buildSnapshotDTO`) — it currently takes only
  `estimates`. Change its signature to also accept the per-dimension band (either
  pass the `dimensionStats` map, or pass the `DimensionResult`s directly) and
  populate `scoreLow/scoreHigh` on each dimension. Fallback if a stat is missing:
  `scoreLow = scoreHigh = score` (degrades to no band, never crashes).
- **`/latest` reader** (~`diagnostic.ts:1077-1097`) — ensure it selects the
  `evidence` column and reads `evidence.dimensionStats` to rebuild the band (today
  it likely rebuilds the DTO from estimate columns only). If reading `evidence` is
  undesirable there, derive `n`/`correct` per dimension from `evidence.items[]`
  (already stored) instead — either is fine; pick one and be consistent.

### 2c. Render the band + honest labels (client)

- **Types + fixture:** add `scoreLow`/`scoreHigh` to the client `DiagnosticSnapshot`
  dimension type and to `DIAGNOSTIC_SNAPSHOT_FIXTURE`
  (`client/src/data/mocks/diagnostic.ts:25`) so mock mode compiles and shows a band.
- **`ResultsBlock`** (`client/src/pages/Diagnostic.tsx:869-906`):
  - Map `scoreLow/scoreHigh` into the `SkillRow`s (extend `SkillRow`).
  - **Honest labeling (also fixes the false copy flagged in B-007):**
    - `:890` `Diagnostic · completed 5 min ago` → drop the fake "5 min ago"; use
      `Quick placement estimate` (or derive time from `captured_at` if wired for
      B-007).
    - `:894-896` `Against TOPIK II Level 4` → replace the hardcoded level with an
      honest framing, e.g. a sub line: *"A short adaptive quiz — a rough placement
      estimate, not an official TOPIK score. Bands show how confident each result
      is."*
- **`SkillsCompare`** (`client/src/components/SkillsCompare.tsx`): render the band as
  a lighter range behind/around each skill's score marker (from `scoreLow` to
  `scoreHigh`). Add an `aria-label` conveying "estimated X, range Low–High". Keep it
  subtle (a translucent range), not a second bold bar.

---

## Tests to update / add

- `server/tests/services/diagnostic/scoring.test.ts` — update for the new
  `estimateForDimension` formula; **add `dimensionResult` tests** asserting the band
  (1) narrows as n grows (n=2 wider than n=4 at the same p), (2) is **non-zero at
  p=0 and p=1** (the critical case), (3) is widest near p=0.5, (4) `scoreLow ≤ score
  ≤ scoreHigh` and all in [0,100].
- `server/tests/services/diagnostic/cat.test.ts` — unaffected (θ untouched); run to
  confirm no incidental breakage.
- `server/tests/routes/diagnostic.test.ts` — update any assertion of item count
  (8→16 / `TARGET_ITEM_COUNT`), and the snapshot DTO shape (new `scoreLow/scoreHigh`
  fields, `evidence.dimensionStats`).
- `client/src/pages/Diagnostic.test.tsx` and
  `client/src/components/SkillsCompare.test.tsx` — assert the band renders and the
  honest label/disclaimer is present; no "5 min ago"/"Level 4" literal.
- `client/src/services/diagnostic.test.ts` — update the snapshot type/shape.

Run: server `npm test` (vitest) + typecheck, client `npm test` + typecheck. (No
Python involved.) See `TESTS.md` for the exact suite commands.

---

## Acceptance criteria

- [ ] Diagnostic serves `ITEMS_PER_DIMENSION` (=4) items/dimension, 16 total; a
      dimension whose pool is exhausted still scores from the items it got (≥1) and
      is omitted only at 0.
- [ ] Per-dimension estimate uses proportion correct — 1/4, 2/4, 3/4 give distinct
      results (all items influence the score).
- [ ] Each dimension returns a confidence band `[scoreLow, scoreHigh]` that:
      narrows as n grows, is **never zero-width at 0/4 or 4/4**, and widens for
      inconsistent (≈2/4) answers.
- [ ] Results UI shows the band and honest framing ("rough placement estimate, not
      an official score"); the false "completed 5 min ago" / "Level 4" literals are
      gone.
- [ ] `RUBRIC_VERSION` = `v1.1.0`; old snapshots still load (`/latest` doesn't throw
      on `v1.0.0` rows).
- [ ] All server + client suites and typechecks green.

## Notes for the reviewer

- θ staircase (`cat.ts`) is intentionally untouched — this pass improves *scoring
  and honesty*, not the ability estimator. The seed-at-L4 middle-bias remains; the
  new bands will correctly show *low confidence* for beginners, which is the right
  interim behavior until L1/L2 (F-002) and a calibrated bank land.
- Keep `ESTIMATE_SPREAD`, `BAND_Z`, and `ITEMS_PER_DIMENSION` as named constants so
  they're easy to tune from usage data later.
