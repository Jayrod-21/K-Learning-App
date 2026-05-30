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
 *  can be re-graded. */
export const RUBRIC_VERSION = 'v1.0.0';

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

/**
 * Per-dimension estimate (0–6) from that dimension's (≤2) responses.
 *
 *   base   = mean(difficulty of the dimension's served items)
 *   both correct → base + 0.5
 *   one correct  → base
 *   none correct → base − 1.0
 *   then clamp to [1, 6].
 *
 * Returns `null` when the dimension had ZERO served items (an empty pool that
 * could not be filled) — the caller omits that dimension from the snapshot.
 *
 * The formula generalizes beyond exactly-2 items (an empty-pool run may serve
 * 1): "both" = all correct, "none" = none correct, otherwise "some" = base.
 */
export function estimateForDimension(responses: readonly ScoredResponse[]): number | null {
  if (responses.length === 0) return null;
  const base =
    responses.reduce((sum, r) => sum + r.difficulty, 0) / responses.length;
  const correctCount = responses.filter((r) => r.isCorrect).length;

  let delta: number;
  if (correctCount === responses.length) {
    delta = 0.5; // all correct
  } else if (correctCount === 0) {
    delta = -1.0; // none correct
  } else {
    delta = 0.0; // mixed
  }
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

/**
 * Map a 0–6 estimate to a 0–100 score via a piecewise-linear curve through the
 * anchors { 3→40, 4→55, 5→70, 6→85, 7→100 }, clamped to [0, 100].
 *
 * The anchors intentionally run past 6 (the estimate ceiling) to 7→100 so that
 * a perfect TOPIK-6-level estimate (6) lands at 85 ("strong") rather than a
 * misleading 100 — 100 is reserved for native-level, which the diagnostic does
 * not measure. Below the first anchor (est < 3) the curve extrapolates down the
 * 3→40 / 4→55 slope (15 points per level) and clamps at 0.
 */
export function estimateToScore(estimate: number): number {
  // Anchor table: [estimate, score], ascending by estimate.
  const anchors: ReadonlyArray<readonly [number, number]> = [
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
