/**
 * Continuous ability estimation (F-212 Phase 2) — the I/O layer around the
 * pure anchored-IRT math in irt.ts.
 *
 * Per dimension (DIMENSION_ORDER, + 'writing' iff opted-in): fetch the user's
 * evidence inside the hard window via `getAbilityEvidence`, weight it by
 * recency, run the pure EAP over the PLACED (b ≠ null) items, apply the
 * min-evidence gate, and map θ̂ to band/score through the SAME locked helpers
 * the diagnostic uses (clampTheta/thetaToNumeric/bandForTheta from
 * diagnostic/cat.ts, estimateToScore/RUBRIC_VERSION from scoring.ts) — reused,
 * never duplicated, so the two surfaces can never drift on scale semantics.
 *
 * COEXISTENCE (hard F-212 constraint): this is a SEPARATE, continuous
 * estimate. The F-011 diagnostic snapshot pipeline (routes/diagnostic.ts,
 * diagnostic_snapshots) stays untouched and authoritative; the two numbers
 * are never merged.
 *
 * SECURITY (tenant isolation): `userId` is SERVER-BOUND — the route passes the
 * session user (middleware getUserId), never a client-supplied id, and both
 * the evidence read and the user_progress writes are WHERE user_id-scoped.
 *
 * Sampled persist: each successful (non-insufficient) DIMENSION_ORDER
 * estimate appends ONE `user_progress` row per dimension AT MOST once per UTC
 * day (metric `ability_theta_<dimension>`), matching routes/progress.ts's
 * append-only insert + DISTINCT ON current-value read. Writing is estimated
 * on request but never sampled — its metric set is a Phase-3 decision.
 * Persistence is best-effort: a failed sample write is logged and never fails
 * the read that produced a perfectly good estimate. Callers that must stay
 * pure reads (F-212 P4: /plan/today) pass `persist: false` to skip the sample
 * entirely; the default (true) keeps /ability/estimate behavior unchanged.
 */

import { query } from '../../db/pool.js';
import { getLogger } from '../../logging.js';
import {
  bandForTheta,
  clampTheta,
  thetaToNumeric,
  type DiagnosticBand,
} from '../diagnostic/cat.js';
import {
  DIMENSION_ORDER,
  RUBRIC_VERSION,
  estimateToScore,
} from '../diagnostic/scoring.js';
import type { AbilityDimension } from './anchors.js';
import { getAbilityEvidence } from './evidence.js';
import type { AbilityEvidenceRow } from './normalize.js';
import {
  DEFAULT_ESTIMATOR_CONFIG,
  ESTIMATOR_VERSION,
  eapEstimate,
  meetsEvidenceGate,
  recencyWeight,
  type EstimatorConfig,
  type LikelihoodItem,
} from './irt.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** metric_type prefix for the sampled persist. `ability_theta_<dimension>`
 *  satisfies the user_progress `^[a-z][a-z0-9_]{0,63}$` CHECK for every
 *  DIMENSION_ORDER dimension. */
const METRIC_PREFIX = 'ability_theta_';

/** One dimension's continuous ability estimate (the wire + persist shape). */
export interface AbilityEstimate {
  dimension: AbilityDimension;
  /** θ̂ on the 0–6 scale (2 dp), or null when insufficient. */
  theta: number | null;
  /** Posterior SD (2 dp), or null when insufficient. */
  se: number | null;
  band: DiagnosticBand | null;
  /** 0–100 score via the diagnostic's estimateToScore curve. */
  score: number | null;
  /** All evidence rows for the dimension inside the window. */
  n: number;
  /** Placed (b ≠ null) rows that entered the likelihood. */
  nUsed: number;
  /** Σ recency weights over placed rows. */
  effN: number;
  lastEvidenceAt: string | null;
  insufficient: boolean;
  estimatorVersion: string;
  rubricVersion: string;
}

export interface EstimateOptions {
  /** Append a 'writing' estimate (never sampled to user_progress). */
  includeWriting?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: Date;
  /** Config override (tests / Phase-3 tuning); defaults to the locked set. */
  config?: EstimatorConfig;
  /**
   * Write the daily user_progress sample (default TRUE — GET /ability/estimate
   * behavior unchanged). F-212 P4: /plan/today estimates with persist:false so
   * the plan endpoint stays the pure read its contract documents — the sampled
   * θ history is only ever appended by the explicit /ability/estimate surface.
   */
  persist?: boolean;
}

/**
 * Estimate the user's ability per dimension. Always returns one entry per
 * DIMENSION_ORDER dimension (in order), + 'writing' appended iff opted-in.
 */
export async function estimateAbility(
  userId: number,
  opts: EstimateOptions = {},
): Promise<AbilityEstimate[]> {
  const config = opts.config ?? DEFAULT_ESTIMATOR_CONFIG;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - config.windowDays * DAY_MS);
  const dimensions: AbilityDimension[] =
    opts.includeWriting === true ? [...DIMENSION_ORDER, 'writing'] : [...DIMENSION_ORDER];

  const estimates: AbilityEstimate[] = [];
  for (const dimension of dimensions) {
    // An explicit dimension filter also admits 'writing' (evidence.ts's
    // explicit-ask-wins rule), so one code path serves all five.
    const rows = await getAbilityEvidence(userId, { dimension, since });
    const estimate = estimateDimension(dimension, rows, now, config);
    if (
      opts.persist !== false &&
      !estimate.insufficient &&
      (DIMENSION_ORDER as readonly string[]).includes(dimension)
    ) {
      await persistDailySample(userId, estimate, now);
    }
    estimates.push(estimate);
  }
  return estimates;
}

/** Pure per-dimension step: weight → EAP → gate → band/score mapping. */
function estimateDimension(
  dimension: AbilityDimension,
  rows: readonly AbilityEvidenceRow[],
  now: Date,
  config: EstimatorConfig,
): AbilityEstimate {
  // Rows arrive newest-first, so the first row is the most recent evidence.
  const lastEvidenceAt = rows.length > 0 ? rows[0]!.occurredAt : null;

  const items: LikelihoodItem[] = [];
  for (const row of rows) {
    if (row.b === null) continue; // unplaced — counts toward n, never nUsed
    items.push({
      b: row.b,
      outcome: row.outcome,
      weight: recencyWeight(
        (now.getTime() - Date.parse(row.occurredAt)) / DAY_MS,
        config.halfLifeDays,
      ),
      // κ seam: a fractional outcome came from a graded source (FSRS rating,
      // score ratio); exact 0/1 outcomes are binary evidence.
      graded: row.outcome > 0 && row.outcome < 1,
    });
  }
  const nUsed = items.length;
  const effN = items.reduce((sum, item) => sum + item.weight, 0);

  const base = {
    dimension,
    n: rows.length,
    nUsed,
    effN,
    lastEvidenceAt,
    estimatorVersion: ESTIMATOR_VERSION,
    rubricVersion: RUBRIC_VERSION,
  };

  if (!meetsEvidenceGate(nUsed, effN, config)) {
    return {
      ...base,
      theta: null,
      se: null,
      band: null,
      score: null,
      insufficient: true,
    };
  }

  const eap = eapEstimate(items, config);
  // Same scale plumbing as the diagnostic: clamp to [1, 6], round to the
  // NUMERIC(3,2) precision, then band + 0–100 score off the ROUNDED θ so the
  // reported triple is internally consistent.
  const theta = thetaToNumeric(clampTheta(eap.theta));
  return {
    ...base,
    theta,
    se: round2(eap.se),
    band: bandForTheta(theta),
    score: estimateToScore(theta),
    insufficient: false,
  };
}

/** Presentation rounding to 2 dp (matches thetaToNumeric's precision). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Append the day's sample for one dimension, AT MOST once per UTC day:
 * skipped when the metric's latest row was already captured today (UTC).
 * Mirrors routes/progress.ts — append-only INSERT, value as `$3::jsonb`, the
 * DISTINCT ON read picks the newest row as the current value. The rare race
 * (two concurrent requests both sampling) produces a harmless extra row; the
 * newest-wins read semantics absorb it, so no lock is taken. Best-effort:
 * failures are logged (no PII beyond ids) and never fail the caller's read.
 */
async function persistDailySample(
  userId: number,
  estimate: AbilityEstimate,
  now: Date,
): Promise<void> {
  const metricType = `${METRIC_PREFIX}${estimate.dimension}`;
  try {
    const { rows } = await query<{ captured_at: Date }>(
      `SELECT captured_at
         FROM user_progress
        WHERE user_id = $1 AND metric_type = $2
        ORDER BY captured_at DESC
        LIMIT 1`,
      [userId, metricType],
    );
    const latest = rows[0]?.captured_at;
    if (latest !== undefined && utcDay(latest) === utcDay(now)) return;

    // JSONB object value — satisfies ck_user_progress_value_object.
    const value = {
      theta: estimate.theta,
      se: estimate.se,
      band: estimate.band,
      score: estimate.score,
      n: estimate.n,
      nUsed: estimate.nUsed,
      effN: estimate.effN,
      lastEvidenceAt: estimate.lastEvidenceAt,
      rubricVersion: estimate.rubricVersion,
      estimatorVersion: estimate.estimatorVersion,
    };
    // Same append-only INSERT as routes/progress.ts, with captured_at bound
    // to THIS estimate's clock (normally "now"; injectable in tests) so the
    // once-per-UTC-day comparison above and the row it guards against can
    // never disagree about what day it is.
    await query(
      `INSERT INTO user_progress (user_id, metric_type, value, captured_at)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [userId, metricType, JSON.stringify(value), now],
    );
  } catch (err) {
    getLogger().warn(
      {
        userId,
        metricType,
        err: { name: (err as Error).name, message: (err as Error).message },
      },
      'ability estimate: daily user_progress sample failed (estimate still served)',
    );
  }
}

/** The UTC calendar day of an instant, as YYYY-MM-DD. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
