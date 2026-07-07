/**
 * Diagnostic scoring — pure functions that turn a run's graded responses into
 * per-dimension estimates (0–6) and into the 0–100 scores the client renders.
 *
 * No I/O: the route gathers the responses, calls these helpers, and persists
 * the result. Keeping the math here makes the scoring rules unit-testable and
 * keeps the rubric in one auditable place (versioned by `RUBRIC_VERSION`).
 */

/** Semver of the scoring rubric. Must match the diagnostic_snapshots
 *  `^v\d+\.\d+\.\d+$` CHECK. Bump when the formulas below change so old runs
 *  can be re-graded.
 *
 *  v1.1.0 (F-011): per-dimension estimate moved from the 3-bucket
 *  all/none/mixed delta to a smooth proportion-correct adjustment
 *  (`ESTIMATE_SPREAD`), and dimensions gained an Agresti-Coull confidence
 *  band (`dimensionResult`).
 *
 *  v1.2.0 (F-002): the 0–6 band semantics changed — the diagnostic ladder
 *  gained L1/L2 (θ floor 2.0 → 1.0, 5-band cuts) and `estimateToScore` gained
 *  low anchors (1→10, 2→25) so L1/L2 scores are anchored, not extrapolated.
 *  (The anchor VALUES coincide with the old extrapolation, but estimates in
 *  [1, 2.5) now occur in real runs; F-010 history must compare like
 *  versions.) */
export const RUBRIC_VERSION = 'v1.2.0';

/** The four diagnostic dimensions, in the fixed display order. */
export const DIMENSION_ORDER = ['reading', 'listening', 'vocab', 'grammar'] as const;
export type DiagnosticDimensionKey = (typeof DIMENSION_ORDER)[number];

/** One graded response, reduced to the fields scoring needs. */
export interface ScoredResponse {
  readonly section: DiagnosticDimensionKey;
  /** Served difficulty on the 0–6 scale. */
  readonly difficulty: number;
  /** Graded result; a skip is `false`. */
  readonly isCorrect: boolean;
}

/** Clamp helper for the estimate range. Estimates are bounded [1, 6]. */
function clampEstimate(value: number): number {
  if (value < 1) return 1;
  if (value > 6) return 6;
  return value;
}

/** Round to 2 decimals so the estimate fits NUMERIC(3,2) exactly. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Estimate spread: how far proportion-correct can move the estimate off the
 *  mean served difficulty. p=1 → +SPREAD/2, p=0 → −SPREAD/2. Tunable; 1.5
 *  (±0.75 level at the extremes) is close to the old ±0.5…−1.0 intent but
 *  symmetric. */
export const ESTIMATE_SPREAD = 1.5;

/**
 * Per-dimension estimate (0–6) from that dimension's responses.
 *
 *   base  = mean(difficulty of the dimension's served items)
 *   p     = proportion correct (a skip counts as incorrect)
 *   delta = ESTIMATE_SPREAD * (p − 0.5)
 *   then clamp to [1, 6].
 *
 * Smooth, symmetric and monotonic in p — every item counts. At the standard
 * 4-item schedule: 4/4 → +0.75, 3/4 → +0.375, 2/4 → 0, 1/4 → −0.375,
 * 0/4 → −0.75. (The old rubric's all/none/mixed delta collapsed 1/4, 2/4 and
 * 3/4 to the same result, wasting most of the evidence.)
 *
 * Returns `null` when the dimension had ZERO served items (an empty pool that
 * could not be filled) — the caller omits that dimension from the snapshot.
 * A short pool (1..ITEMS_PER_DIMENSION−1 items) still scores from what it got.
 */
export function estimateForDimension(responses: readonly ScoredResponse[]): number | null {
  if (responses.length === 0) return null;
  const base =
    responses.reduce((sum, r) => sum + r.difficulty, 0) / responses.length;
  const p = responses.filter((r) => r.isCorrect).length / responses.length; // 0..1
  const delta = ESTIMATE_SPREAD * (p - 0.5);
  return round2(clampEstimate(base + delta));
}

/**
 * Group graded responses by dimension and compute each estimate. Dimensions
 * with no responses map to `null` (omitted by the DTO builder). Always returns
 * an entry for all four dimensions in canonical order so the caller can iterate
 * deterministically.
 */
export function estimatesByDimension(
  responses: readonly ScoredResponse[],
): Record<DiagnosticDimensionKey, number | null> {
  const out = {} as Record<DiagnosticDimensionKey, number | null>;
  for (const dim of DIMENSION_ORDER) {
    out[dim] = estimateForDimension(responses.filter((r) => r.section === dim));
  }
  return out;
}

/** Z for the confidence band. 1.0 ≈ a 68% ("±1 SE") band — intentionally
 *  modest so the UI doesn't look alarmist. Tunable. */
export const BAND_Z = 1.0;

/** One dimension's full scored result: point estimate, 0–100 score, and the
 *  confidence band around the score. */
export interface DimensionResult {
  readonly estimate: number;   // 0–6
  readonly score: number;      // 0–100 (estimateToScore(estimate))
  readonly scoreLow: number;   // 0–100 band floor
  readonly scoreHigh: number;  // 0–100 band ceiling
  readonly n: number;          // items served in this dimension
}

/**
 * Confidence band in SCORE points for one dimension. Smoothed proportion
 * (Agresti-Coull, +2 successes / +4 trials) keeps the band non-zero at p=0/1
 * — with few items, a 4/4 or 0/4 is common and must NOT read as certainty —
 * and widens it for inconsistent (mid-p) answers; it also narrows as n grows.
 * (Statistical note: +2/+4 is the classic z=2 Agresti-Coull smoothing, used
 * here under a z=1 (BAND_Z) interval — intentional, deliberately conservative
 * at the p extremes.)
 *
 * The margin is computed in estimate (0–6) units and mapped through the same
 * score curve as the point estimate, with the same [1, 6] clamp, so at the
 * scale ceiling/floor the band collapses toward the clamp edge but keeps its
 * inward tail. Returns `null` for a zero-item dimension (same contract as
 * `estimateForDimension`).
 */
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

/**
 * Group graded responses by dimension and compute each full result (estimate,
 * score, band). Sibling of `estimatesByDimension`: dimensions with no
 * responses map to `null`; all four dimensions are always present, in
 * canonical order.
 */
export function resultsByDimension(
  responses: readonly ScoredResponse[],
): Record<DiagnosticDimensionKey, DimensionResult | null> {
  const out = {} as Record<DiagnosticDimensionKey, DimensionResult | null>;
  for (const dim of DIMENSION_ORDER) {
    out[dim] = dimensionResult(responses.filter((r) => r.section === dim));
  }
  return out;
}

/**
 * Map a 0–6 estimate to a 0–100 score via a piecewise-linear curve through the
 * anchors { 1→10, 2→25, 3→40, 4→55, 5→70, 6→85, 7→100 }, clamped to [0, 100].
 *
 * The low anchors 1→10 and 2→25 (F-002) pin the L1/L2 range explicitly now
 * that estimates below 2.5 occur in real runs — anchored, not extrapolated.
 * (They lie on the same 15-points-per-level line, so no historical score
 * changes value.) The anchors intentionally run past 6 (the estimate ceiling)
 * to 7→100 so that a perfect TOPIK-6-level estimate (6) lands at 85
 * ("strong") rather than a misleading 100 — 100 is reserved for native-level,
 * which the diagnostic does not measure. Below the first anchor (est < 1) the
 * curve extrapolates down the 1→10 / 2→25 slope and clamps at 0.
 */
export function estimateToScore(estimate: number): number {
  // Anchor table: [estimate, score], ascending by estimate.
  const anchors: ReadonlyArray<readonly [number, number]> = [
    [1, 10],
    [2, 25],
    [3, 40],
    [4, 55],
    [5, 70],
    [6, 85],
    [7, 100],
  ];

  // Below the first anchor: extrapolate on the first segment's slope.
  const [e0, s0] = anchors[0]!;
  const [e1, s1] = anchors[1]!;
  if (estimate <= e0) {
    const slope = (s1 - s0) / (e1 - e0);
    return clampScore(s0 + slope * (estimate - e0));
  }

  // Within / above the table: find the bracketing segment.
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [lo, loScore] = anchors[i]!;
    const [hi, hiScore] = anchors[i + 1]!;
    if (estimate <= hi) {
      const slope = (hiScore - loScore) / (hi - lo);
      return clampScore(loScore + slope * (estimate - lo));
    }
  }

  // Above the last anchor.
  return 100;
}

function clampScore(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}
