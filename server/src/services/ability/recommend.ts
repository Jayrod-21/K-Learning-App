/**
 * Next-exercise recommender (F-212 Phase 4) — PURE scoring/ranking, no I/O,
 * no DB, no clock (like irt.ts). Turns the Phase-2 per-dimension ability
 * estimates + per-dimension due-load into ONE ranked "do this next"
 * recommendation over reading / listening / vocab / grammar (writing HELD in
 * v1 — see the Phase-4 locked decisions).
 *
 * Two-stage scoring (locked design):
 *
 *   Stage A — WHICH dimension. For each dimension d with a Phase-2 estimate:
 *     insufficient(d) → A(d) = EXPLORE_BASE (1.0). Any sufficient dimension's
 *       terms sum strictly below 1.0 (the uncertainty term is strictly <
 *       W_UNCERTAINTY because a post-gate posterior SD is strictly below the
 *       prior SD), so an insufficient dimension always outranks every
 *       sufficient one — exploration dominance by construction.
 *     else A(d) = W_DEFICIT·clamp((θ_ref − θ_d)/SPREAD, 0, 1)
 *               + W_DUE·clamp(dueCount_d/DUE_SAT, 0, 1)
 *               + W_UNCERTAINTY·clamp(se_d/PRIOR_SD, 0, 1)
 *       θ_ref = max θ over SUFFICIENT dimensions — the learner's OWN current
 *       peak, so "deficit" means "furthest behind yourself", never distance
 *       to an absolute target. dueCount is only ever nonzero for vocab /
 *       grammar (the FSRS-backed dimensions); due-load is a WEIGHTED
 *       competition term, never a hard override.
 *     Ties break by CORE_DIMENSION_ORDER (a total order over the four dimensions,
 *     so the tie-break is fully deterministic per (user, day) already — the
 *     md5 seed is only ever consulted at Stage B, where item keys can tie).
 *
 *   Stage B — WHICH item inside the winning dimension. Target difficulty
 *     b* = clamp(θ_d + TARGET_OFFSET, θ_MIN, θ_MAX) — deliberately ABOVE the
 *     estimate (p ≈ 0.4: winnable, not comfortable). Insufficient dimension →
 *     b* = PROBE_CENTER_B (3.5, the probe center of the 1–6 scale).
 *     B(c) = Proximity(b_c, b*) = exp(−(b_c − b*)² / (2·TAU²)); an item with
 *     no difficulty signal (b = null — chapters, listening episodes) scores
 *     the fixed NEUTRAL_PROX instead — neither privileged nor excluded.
 *     Ties break by md5(userKey‖dayKey‖itemKey), then itemKey — deterministic
 *     per (user, Seoul-day), the same determinism contract as plan.ts's own
 *     md5 selection idiom.
 *
 * Every recommendation carries an HONEST, bilingual reason: the reasonCode is
 * the DOMINANT Stage-A term (or 'exploration' for an insufficient dimension,
 * 'baseline' when no term contributes), and the composed reasonEn/reasonKr
 * state only what the evidence actually supports — never "optimal path"
 * claims.
 *
 * STATELESS v1: nothing here reads or writes state; determinism per
 * (user, Seoul-day) comes entirely from the caller-supplied keys. The
 * variety-penalty term is DEFERRED to the stateful v2 (needs a
 * recommendation_events log) and is deliberately absent, not zero-weighted.
 *
 * All tunables live in RECOMMENDER_CONFIG — no inline magic numbers. SPREAD
 * and PRIOR_SD are wired to the SAME locked constants the estimator uses
 * (ESTIMATE_SPREAD, DEFAULT_ESTIMATOR_CONFIG.priorSd) so the scales can
 * never drift apart.
 */

import { createHash } from 'node:crypto';
import { CORE_DIMENSION_ORDER, ESTIMATE_SPREAD } from '../diagnostic/scoring.js';
import { DEFAULT_ESTIMATOR_CONFIG } from './irt.js';
import type { AbilityDimension } from './anchors.js';

/** The four recommendable dimensions (writing HELD in v1). */
export type RecommendDimension = Exclude<AbilityDimension, 'writing'>;

/** Why a dimension won — the dominant Stage-A term (see reasonCode above). */
export type ReasonCode =
  | 'weakest_dimension'
  | 'due_backlog'
  | 'low_confidence'
  | 'exploration'
  | 'baseline';

/** All Phase-4 recommender tunables (LOCKED values in RECOMMENDER_CONFIG). */
export interface RecommenderConfig {
  /** Stage-A term weights. Sum to 1.0; the variety term is deferred to v2. */
  readonly wDeficit: number;
  readonly wDue: number;
  readonly wUncertainty: number;
  /** Stage-A score of an insufficient dimension — dominates every sufficient
   *  score (see module note). */
  readonly exploreBase: number;
  /** Due-load saturation: dueCount ≥ DUE_SAT contributes the full wDue. */
  readonly dueSat: number;
  /** Stage-B proximity bandwidth τ. */
  readonly tau: number;
  /** b* = clamp(θ + targetOffset, θmin, θmax) — the winnable-not-comfortable
   *  offset (p ≈ 0.4 under the 1PL model). */
  readonly targetOffset: number;
  /** Deficit normalizer — LOCKED to the diagnostic's ESTIMATE_SPREAD. */
  readonly spread: number;
  /** Uncertainty normalizer — LOCKED to the estimator's prior SD. */
  readonly priorSd: number;
  /** Stage-B score for an item with no difficulty signal (b = null). */
  readonly neutralProx: number;
  /** b* for an insufficient dimension — the probe center of the θ scale. */
  readonly probeCenterB: number;
  /** The θ scale bounds b* is clamped into (the diagnostic's 1–6 scale). */
  readonly thetaMin: number;
  readonly thetaMax: number;
}

/**
 * The LOCKED Phase-4 configuration: weights 0.5/0.3/0.2, EXPLORE_BASE 1.0,
 * DUE_SAT 20, τ 0.75, TARGET_OFFSET 0.4, SPREAD = ESTIMATE_SPREAD (1.5),
 * PRIOR_SD = the estimator's 1.5, NEUTRAL_PROX 0.5, probe center 3.5 on the
 * 1–6 grid.
 */
export const RECOMMENDER_CONFIG: RecommenderConfig = {
  wDeficit: 0.5,
  wDue: 0.3,
  wUncertainty: 0.2,
  exploreBase: 1.0,
  dueSat: 20,
  tau: 0.75,
  targetOffset: 0.4,
  spread: ESTIMATE_SPREAD,
  priorSd: DEFAULT_ESTIMATOR_CONFIG.priorSd,
  neutralProx: 0.5,
  probeCenterB: 3.5,
  thetaMin: 1,
  thetaMax: 6,
};

/** One dimension's Stage-A inputs, distilled from the Phase-2 estimate. */
export interface DimensionSignal {
  dimension: RecommendDimension;
  /** θ̂ on the 1–6 scale, or null when insufficient. */
  theta: number | null;
  /** Posterior SD, or null when insufficient. */
  se: number | null;
  insufficient: boolean;
  /** FSRS cards due for this dimension — nonzero only for vocab/grammar. */
  dueCount: number;
}

/** One concrete exercise a dimension can offer (built by candidates.ts). */
export interface CandidateItem {
  /** Stable unique key (`reading:story:12`, `vocab:card:7`, …) — the Stage-B
   *  md5 tie-break input, so it must be unique within the dimension. */
  itemKey: string;
  /** Anchored difficulty on the θ scale, or null when the item carries no
   *  difficulty signal (chapters, listening episodes). */
  b: number | null;
  deepLink: string;
  level: string;
  title: string;
  mins: number;
  // ── Optional deep-link id fields, mirroring the TodayTask union so the
  // client's existing href builders work unchanged.
  sourceKind?: 'chapter' | 'story';
  chapterId?: number;
  storyId?: number;
  corpus?: 'iyagi';
  episodeNumber?: number;
}

/** The wire shape /plan/today attaches (additive). */
export interface Recommendation {
  dimension: RecommendDimension;
  /** True when this dimension had insufficient evidence — the reason is an
   *  honest "let's find out", never a deficit claim. */
  exploratory: boolean;
  reasonCode: ReasonCode;
  reasonEn: string;
  reasonKr: string;
  level: string;
  deepLink: string;
  title: string;
  mins: number;
  sourceKind?: 'chapter' | 'story';
  chapterId?: number;
  storyId?: number;
  corpus?: 'iyagi';
  episodeNumber?: number;
}

/** The decomposed Stage-A terms — kept visible for reason attribution + tests. */
export interface DimensionScoreTerms {
  deficit: number;
  due: number;
  uncertainty: number;
}

export interface DimensionScore {
  score: number;
  exploratory: boolean;
  terms: DimensionScoreTerms;
}

export interface RankInput {
  /** The md5 determinism seed halves — plan.ts passes String(userId) and the
   *  Seoul plan date (the same boundary its SQL selection hashes pin). */
  userKey: string;
  dayKey: string;
  /** One signal per recommendable dimension (CORE_DIMENSION_ORDER order). */
  dimensions: readonly DimensionSignal[];
  /** Per-dimension candidate items; a missing/empty list means the dimension
   *  has nothing to offer and is skipped in ranking. */
  candidates: Partial<Record<RecommendDimension, readonly CandidateItem[]>>;
  config?: RecommenderConfig;
}

export interface RankResult {
  recommendation: Recommendation | null;
  /** Runner-up dimensions' best items, in Stage-A rank order. */
  alternatives: Recommendation[];
}

/** clamp x into [0, 1]. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Exploration-dominance guard margin. Under the LOCKED config the invariant
 * "any insufficient dimension outranks any sufficient one" already holds by
 * the estimator's posterior-SD math (max sufficient sum ≈ 0.96 < EXPLORE_BASE
 * 1.0), but that makes it an EMERGENT property of remote constants — a future
 * weight retune could silently break it. dimensionScore therefore caps every
 * SUFFICIENT score strictly below exploreBase by this margin, making the
 * invariant LOCAL and retune-proof. A no-op under the locked config.
 */
const EXPLORATION_DOMINANCE_EPS = 1e-9;

/** Deterministic md5 hex of the joined parts (the plan.ts hash idiom in JS). */
function md5Key(...parts: string[]): string {
  return createHash('md5').update(parts.join('')).digest('hex');
}

/**
 * Stage-B target difficulty: b* = clamp(θ + TARGET_OFFSET, θmin, θmax), or
 * the probe center when the dimension has no estimate (insufficient).
 */
export function targetDifficulty(
  theta: number | null,
  config: RecommenderConfig = RECOMMENDER_CONFIG,
): number {
  if (theta === null) return config.probeCenterB;
  return Math.min(config.thetaMax, Math.max(config.thetaMin, theta + config.targetOffset));
}

/**
 * Stage A — one dimension's priority score. `thetaRef` is the max θ over the
 * SUFFICIENT dimensions (null only when no dimension is sufficient, in which
 * case a sufficient signal falls back to its own θ — a zero deficit).
 */
export function dimensionScore(
  signal: DimensionSignal,
  thetaRef: number | null,
  config: RecommenderConfig = RECOMMENDER_CONFIG,
): DimensionScore {
  if (signal.insufficient || signal.theta === null) {
    return {
      score: config.exploreBase,
      exploratory: true,
      terms: { deficit: 0, due: 0, uncertainty: 0 },
    };
  }
  const ref = thetaRef ?? signal.theta;
  const deficit = config.wDeficit * clamp01((ref - signal.theta) / config.spread);
  const due = config.wDue * clamp01(signal.dueCount / config.dueSat);
  const uncertainty = config.wUncertainty * clamp01((signal.se ?? 0) / config.priorSd);
  return {
    // Capped strictly below exploreBase so exploration dominance holds by
    // construction, whatever the weights (see EXPLORATION_DOMINANCE_EPS).
    score: Math.min(
      deficit + due + uncertainty,
      config.exploreBase - EXPLORATION_DOMINANCE_EPS,
    ),
    exploratory: false,
    terms: { deficit, due, uncertainty },
  };
}

/**
 * Stage B — one item's proximity score to the target difficulty b*:
 * exp(−(b − b*)²/(2τ²)), or NEUTRAL_PROX when the item carries no difficulty.
 */
export function itemScore(
  b: number | null,
  bStar: number,
  config: RecommenderConfig = RECOMMENDER_CONFIG,
): number {
  if (b === null) return config.neutralProx;
  const d = b - bStar;
  return Math.exp(-(d * d) / (2 * config.tau * config.tau));
}

/** Dimension display names for the bilingual reason composer. */
const DIMENSION_LABELS: Readonly<
  Record<RecommendDimension, { en: string; kr: string }>
> = {
  reading: { en: 'reading', kr: '읽기' },
  listening: { en: 'listening', kr: '듣기' },
  vocab: { en: 'vocabulary', kr: '어휘' },
  grammar: { en: 'grammar', kr: '문법' },
};

/**
 * The reasonCode for a scored dimension: 'exploration' when insufficient,
 * else the DOMINANT Stage-A term (exact ties resolve deficit → due →
 * uncertainty, the term order of the score itself), or 'baseline' when no
 * term contributed at all.
 */
export function reasonCodeFor(score: DimensionScore): ReasonCode {
  if (score.exploratory) return 'exploration';
  const { deficit, due, uncertainty } = score.terms;
  const max = Math.max(deficit, due, uncertainty);
  if (max <= 0) return 'baseline';
  if (deficit === max) return 'weakest_dimension';
  if (due === max) return 'due_backlog';
  return 'low_confidence';
}

/**
 * Honest bilingual reason copy. States only what the evidence supports:
 * a deficit claim only for 'weakest_dimension', a backlog count only for
 * 'due_backlog', and a no-claims "let's build a read" for 'exploration'.
 */
export function composeReason(
  code: ReasonCode,
  dimension: RecommendDimension,
  dueCount: number,
): { reasonEn: string; reasonKr: string } {
  const { en, kr } = DIMENSION_LABELS[dimension];
  switch (code) {
    case 'weakest_dimension':
      return {
        reasonEn: `Your ${en} is currently your weakest area, so this exercise is pitched just above your level there.`,
        reasonKr: `지금 ${kr} 실력이 가장 약한 영역이라, 그 수준보다 조금 높은 연습을 추천해요.`,
      };
    case 'due_backlog':
      return {
        reasonEn: `You have ${String(dueCount)} ${en} card${dueCount === 1 ? '' : 's'} due for review — clearing them keeps your memory schedule on track.`,
        reasonKr: `복습 기한이 된 ${kr} 카드가 ${String(dueCount)}장 있어요 — 지금 복습하면 기억 일정이 밀리지 않아요.`,
      };
    case 'low_confidence':
      return {
        reasonEn: `Your ${en} estimate is the least certain right now — more practice here will sharpen it.`,
        reasonKr: `지금은 ${kr} 실력 추정치가 가장 불확실해요 — 연습하면 더 정확해져요.`,
      };
    case 'exploration':
      return {
        reasonEn: `There isn't enough recent evidence on your ${en} yet — let's build a read on it.`,
        reasonKr: `아직 ${kr} 실력을 판단할 근거가 부족해요 — 함께 알아가 봐요.`,
      };
    case 'baseline':
      return {
        reasonEn: `A steady next step for your ${en} practice.`,
        reasonKr: `꾸준한 ${kr} 연습을 위한 다음 단계예요.`,
      };
    default: {
      const _never: never = code;
      return _never;
    }
  }
}

/** Index in CORE_DIMENSION_ORDER — the deterministic Stage-A tie-break. */
function dimensionOrderIndex(dimension: RecommendDimension): number {
  return (CORE_DIMENSION_ORDER as readonly string[]).indexOf(dimension);
}

/**
 * Rank dimensions (Stage A) then items (Stage B) into a primary
 * recommendation + alternatives.
 *
 *   - ALL dimensions insufficient → cold start → null (the client keeps its
 *     existing deterministic tiles; recommending on zero evidence would be a
 *     dishonest guess).
 *   - A dimension with no candidates is skipped (nothing to act on) — the
 *     next-ranked dimension takes its place. No dimension has candidates →
 *     null.
 *   - alternatives = each remaining candidate-bearing dimension's best item,
 *     in Stage-A rank order (the primary's dimension is never repeated).
 */
export function rankRecommendations(input: RankInput): RankResult {
  const config = input.config ?? RECOMMENDER_CONFIG;
  const { userKey, dayKey, dimensions, candidates } = input;

  if (dimensions.length === 0 || dimensions.every((d) => d.insufficient)) {
    return { recommendation: null, alternatives: [] };
  }

  // θ_ref = max θ over sufficient dimensions.
  let thetaRef: number | null = null;
  for (const d of dimensions) {
    if (!d.insufficient && d.theta !== null) {
      thetaRef = thetaRef === null ? d.theta : Math.max(thetaRef, d.theta);
    }
  }

  const scored = dimensions
    .map((signal) => ({ signal, result: dimensionScore(signal, thetaRef, config) }))
    .sort((a, b) => {
      if (b.result.score !== a.result.score) return b.result.score - a.result.score;
      return (
        dimensionOrderIndex(a.signal.dimension) - dimensionOrderIndex(b.signal.dimension)
      );
    });

  const ranked: Recommendation[] = [];
  for (const { signal, result } of scored) {
    const pool = candidates[signal.dimension];
    if (pool === undefined || pool.length === 0) continue;

    const bStar = targetDifficulty(signal.insufficient ? null : signal.theta, config);
    const best = [...pool].sort((a, b) => {
      const scoreA = itemScore(a.b, bStar, config);
      const scoreB = itemScore(b.b, bStar, config);
      if (scoreB !== scoreA) return scoreB - scoreA;
      // Deterministic per (user, Seoul-day): the same md5 idiom as plan.ts's
      // SQL selection, applied to the item key; raw key as the total-order
      // backstop against the (astronomically unlikely) hash collision.
      const hashA = md5Key(userKey, dayKey, a.itemKey);
      const hashB = md5Key(userKey, dayKey, b.itemKey);
      if (hashA !== hashB) return hashA < hashB ? -1 : 1;
      return a.itemKey < b.itemKey ? -1 : 1;
    })[0]!;

    const reasonCode = reasonCodeFor(result);
    const { reasonEn, reasonKr } = composeReason(
      reasonCode,
      signal.dimension,
      signal.dueCount,
    );
    const { itemKey: _itemKey, b: _b, ...pub } = best;
    ranked.push({
      dimension: signal.dimension,
      exploratory: result.exploratory,
      reasonCode,
      reasonEn,
      reasonKr,
      ...pub,
    });
  }

  if (ranked.length === 0) return { recommendation: null, alternatives: [] };
  return { recommendation: ranked[0]!, alternatives: ranked.slice(1) };
}
