/**
 * Anchored-IRT person estimation (F-212 Phase 2) — PURE math, no I/O, no DB,
 * no clock (like diagnostic/cat.ts + scoring.ts).
 *
 * Model: Rasch/1PL with a GLOBAL discrimination `a` (the 2PL seam for
 * Phase 3). Item difficulties `b` are FIXED — Phase-1 anchored on the 0–6 θ
 * scale (anchors.ts / normalize.ts) — and only the PERSON θ is estimated,
 * via EAP (expected a posteriori): Bayesian, bounded by the grid, and with an
 * honest posterior-SD standard error even at all-right/all-wrong extremes
 * where an MLE diverges.
 *
 * Likelihood (LOCKED decision): the weighted CONTINUOUS-Bernoulli form is
 * applied uniformly —
 *
 *   ℓ(θ) = Σ_i w_i · [ o_i·ln P_i(θ) + (1 − o_i)·ln(1 − P_i(θ)) ]
 *
 * with graded outcome o_i ∈ [0, 1]. Binary sources (o ∈ {0, 1}) reduce to the
 * exact Rasch Bernoulli likelihood; graded sources (FSRS ratings, score
 * ratios) contribute partial credit. Nothing is dichotomized.
 *
 * Numerical stability: ℓ is computed in log-space and the max is subtracted
 * before exponentiation; P is clamped into [ε, 1−ε] so o·ln P never hits
 * ln(0).
 *
 * Every tunable lives in `EstimatorConfig` — no inline magic numbers — so the
 * locked Phase-2 constants are auditable in one place and Phase 3 can retune
 * without spelunking.
 */

/** Version tag stamped on every estimate (and its persisted sample) so a
 *  future estimator change can distinguish historical rows. */
export const ESTIMATOR_VERSION = 'eap-1pl-1.0';

/**
 * Probability clamp for the log-likelihood: P is confined to [ε, 1−ε] before
 * ln(). A numerical guard, not a tunable — at |a·(θ−b)| ≤ 5·a·gridspan the
 * logistic never actually reaches 0/1, but a guard beats a NaN if the grid or
 * anchors ever widen.
 */
export const P_EPSILON = 1e-9;

/** All Phase-2 estimator tunables (LOCKED values in DEFAULT_ESTIMATOR_CONFIG). */
export interface EstimatorConfig {
  /** Global item discrimination (1PL). Phase-3 per-item calibration seam. */
  readonly a: number;
  /** Prior θ ~ Normal(priorMean, priorSd), truncated to the grid. */
  readonly priorMean: number;
  readonly priorSd: number;
  /** EAP quadrature grid: [gridMin, gridMax] inclusive, step gridStep. */
  readonly gridMin: number;
  readonly gridMax: number;
  readonly gridStep: number;
  /** Recency half-life: evidence weight w = 0.5^(ageDays / halfLifeDays). */
  readonly halfLifeDays: number;
  /** Hard evidence window: rows older than now − windowDays are not fetched. */
  readonly windowDays: number;
  /** Min-evidence gate: emit an estimate only if nUsed ≥ minNUsed AND
   *  effN ≥ minEffN (effN = Σ w_i over placed items). */
  readonly minNUsed: number;
  readonly minEffN: number;
  /** κ — multiplicative weight discount for GRADED (non-binary) outcomes.
   *  1.0 = off (locked for Phase 2); the seam exists because a graded
   *  self-rating carries less item information than a scored answer. */
  readonly gradedDiscount: number;
}

/**
 * The LOCKED Phase-2 configuration: a=1.0; prior N(3.5, 1.5²); 51-node grid
 * 1.0…6.0 step 0.1; half-life 30 d over a 180 d window; gate nUsed ≥ 5 ∧
 * effN ≥ 3; κ=1.0 (off).
 */
export const DEFAULT_ESTIMATOR_CONFIG: EstimatorConfig = {
  a: 1.0,
  priorMean: 3.5,
  priorSd: 1.5,
  gridMin: 1.0,
  gridMax: 6.0,
  gridStep: 0.1,
  halfLifeDays: 30,
  windowDays: 180,
  minNUsed: 5,
  minEffN: 3,
  gradedDiscount: 1.0,
};

/** One placed evidence item, likelihood-ready. */
export interface LikelihoodItem {
  /** Anchored difficulty on the 0–6 θ scale (b ≠ null — placed items only). */
  readonly b: number;
  /** Graded outcome ∈ [0, 1]. */
  readonly outcome: number;
  /** Recency weight w ∈ (0, 1]. */
  readonly weight: number;
  /** True when the outcome came from a graded (non-binary) source — the κ
   *  discount seam. Defaults false (binary). */
  readonly graded?: boolean;
}

/** Point estimate + honest uncertainty from the EAP posterior. */
export interface EapResult {
  /** Posterior mean θ̂ (unclamped/unrounded — callers apply clampTheta /
   *  thetaToNumeric from diagnostic/cat.ts). */
  readonly theta: number;
  /** Posterior SD — the standard error. Finite even at all-right/all-wrong. */
  readonly se: number;
}

/** Item response function: P(θ) = σ(a·(θ − b)), σ the logistic. */
export function irf(theta: number, b: number, a: number): number {
  return 1 / (1 + Math.exp(-a * (theta - b)));
}

/**
 * Recency weight 0.5^(ageDays / halfLifeDays). Ages are clamped at 0 so a
 * clock-skewed "future" row can never weigh MORE than fresh evidence (>1).
 */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays)) {
    throw new RangeError(`ageDays must be finite, got ${ageDays}`);
  }
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/** An item's effective likelihood weight: w · (graded ? κ : 1). */
function effectiveWeight(item: LikelihoodItem, config: EstimatorConfig): number {
  return item.weight * (item.graded === true ? config.gradedDiscount : 1);
}

/**
 * Weighted continuous-Bernoulli log-likelihood at θ over placed items.
 * P is clamped into [ε, 1−ε] so the log terms stay finite.
 */
export function logLikelihood(
  theta: number,
  items: readonly LikelihoodItem[],
  config: EstimatorConfig,
): number {
  let ll = 0;
  for (const item of items) {
    const raw = irf(theta, item.b, config.a);
    const p = Math.min(1 - P_EPSILON, Math.max(P_EPSILON, raw));
    ll +=
      effectiveWeight(item, config) *
      (item.outcome * Math.log(p) + (1 - item.outcome) * Math.log(1 - p));
  }
  return ll;
}

/** The quadrature nodes X = {gridMin, gridMin+step, …, gridMax} (inclusive). */
export function thetaGrid(config: EstimatorConfig): number[] {
  const { gridMin, gridMax, gridStep } = config;
  if (!(gridStep > 0) || !(gridMax > gridMin)) {
    throw new RangeError(
      `invalid grid: [${gridMin}, ${gridMax}] step ${gridStep}`,
    );
  }
  const nodeCount = Math.round((gridMax - gridMin) / gridStep) + 1;
  const nodes: number[] = new Array<number>(nodeCount);
  for (let k = 0; k < nodeCount; k += 1) {
    // Multiply-then-add (not repeated +=) so float error does not accumulate
    // across 51 nodes; the last node lands exactly on gridMax after rounding.
    nodes[k] = Math.min(gridMax, gridMin + k * gridStep);
  }
  return nodes;
}

/**
 * EAP estimate over the grid.
 *
 *   log W_k = ℓ(X_k) + ln g(X_k)      g = Normal(priorMean, priorSd) density
 *   W_k     = exp(log W_k − max_k)    (max subtracted → no overflow/underflow)
 *   θ̂       = Σ X_k·W_k / Σ W_k
 *   SE      = sqrt( Σ (X_k − θ̂)²·W_k / Σ W_k )   (posterior SD)
 *
 * The prior's normalization constant cancels in the ratio, so only the
 * exponent −((x−μ)/σ)²/2 is carried. With NO items the posterior is the
 * grid-truncated prior (θ̂ ≈ priorMean) — the min-evidence gate keeps such a
 * result from ever being emitted, but the math stays well-defined.
 */
export function eapEstimate(
  items: readonly LikelihoodItem[],
  config: EstimatorConfig,
): EapResult {
  const nodes = thetaGrid(config);
  const logWeights = nodes.map((x) => {
    const z = (x - config.priorMean) / config.priorSd;
    return logLikelihood(x, items, config) - 0.5 * z * z;
  });
  const maxLogWeight = Math.max(...logWeights);

  let total = 0;
  let mean = 0;
  const weights = logWeights.map((lw) => Math.exp(lw - maxLogWeight));
  for (let k = 0; k < nodes.length; k += 1) {
    total += weights[k]!;
    mean += nodes[k]! * weights[k]!;
  }
  mean /= total;

  let variance = 0;
  for (let k = 0; k < nodes.length; k += 1) {
    const d = nodes[k]! - mean;
    variance += d * d * weights[k]!;
  }
  variance /= total;

  return { theta: mean, se: Math.sqrt(variance) };
}

/**
 * Weighted Fisher information at θ: I = Σ w_i·a²·P_i·(1−P_i) (κ applied via
 * the same effective weight as the likelihood). Retained for the EAP
 * cross-check (posterior SD ≈ 1/√(I + I₀) in the well-identified regime) and
 * as the Phase-4 item-selection seam.
 */
export function fisherInfo(
  theta: number,
  items: readonly LikelihoodItem[],
  config: EstimatorConfig,
): number {
  let info = 0;
  for (const item of items) {
    const p = irf(theta, item.b, config.a);
    info += effectiveWeight(item, config) * config.a * config.a * p * (1 - p);
  }
  return info;
}

/**
 * Information-based SE approximation: 1/√(I + I₀), I₀ = 1/σ₀² the prior's
 * information. The EAP posterior SD is the authoritative SE; this is the
 * closed-form cross-check.
 */
export function seFromInfo(info: number, priorSd: number): number {
  return 1 / Math.sqrt(info + 1 / (priorSd * priorSd));
}

/** The min-evidence gate: nUsed ≥ minNUsed AND effN ≥ minEffN. */
export function meetsEvidenceGate(
  nUsed: number,
  effN: number,
  config: EstimatorConfig,
): boolean {
  return nUsed >= config.minNUsed && effN >= config.minEffN;
}
