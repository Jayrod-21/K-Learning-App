/**
 * Ability-evidence read API (F-212 Phase 1) — the ONLY consumer of the
 * `ability_evidence` view (migration 084). Fetches a user's normalized
 * response history and a per-dimension rollup; the Phase-2 θ-estimator
 * builds on these reads.
 *
 * SECURITY (tenant isolation): `userId` is SERVER-BOUND — callers pass the
 * session user (middleware getUserId), never a client-supplied id, and every
 * query filters `WHERE user_id = $1`. This mirrors the isolation posture of
 * every producing log's own routes.
 *
 * Writing evidence is EXCLUDED by default (`includeWriting: false`): writing
 * rows are sparse, expensive to produce, and score on a different rubric
 * scale, so the 4-dimension surfaces must not silently absorb them. An
 * explicit `dimension: 'writing'` filter wins over the default (an explicit
 * ask is never contradicted by a default).
 */

import { query } from '../../db/pool.js';
import { CORE_DIMENSION_ORDER } from '../diagnostic/scoring.js';
import { EVIDENCE_SOURCES, type AbilityDimension, type EvidenceSource } from './anchors.js';
import {
  normalizeRow,
  type AbilityEvidenceRow,
  type RawAbilityEvidenceRow,
} from './normalize.js';

/** Hard cap on one evidence read — a full IRT fit re-reads in pages, not in
 *  one unbounded scan. */
const MAX_LIMIT = 10_000;

export interface EvidenceQuery {
  /** Restrict to one dimension. An explicit 'writing' overrides the default
   *  writing exclusion. */
  dimension?: AbilityDimension;
  /** Only evidence at or after this instant. */
  since?: Date;
  /** Max rows (newest-first). Positive integer, capped at MAX_LIMIT. */
  limit?: number;
  /** Include writing-dimension rows (default false). */
  includeWriting?: boolean;
}

export interface RollupQuery {
  since?: Date;
  includeWriting?: boolean;
}

/** Per-dimension evidence summary — the Phase-1 "is there enough signal
 *  here" read (row counts, difficulty coverage, recency), NOT an ability
 *  estimate (that is Phase 2). */
export interface DimensionRollup {
  dimension: AbilityDimension;
  nTotal: number;
  nWithDifficulty: number;
  /** Mean normalized outcome over the dimension's rows; 0 when nTotal = 0. */
  meanOutcome: number;
  /** Mean difficulty over rows that HAVE one; null when none do. */
  meanDifficulty: number | null;
  lastOccurredAt: string | null;
  bySource: Record<EvidenceSource, number>;
}

const RAW_COLUMNS = `user_id, dimension, source, source_id, item_key, occurred_at,
       outcome_raw_correct, outcome_raw_rating, outcome_raw_score, outcome_raw_max,
       diff_served, diff_topik_paper, diff_proficiency`;

/**
 * A user's normalized evidence rows, newest-first.
 */
export async function getAbilityEvidence(
  userId: number,
  q: EvidenceQuery = {},
): Promise<AbilityEvidenceRow[]> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];

  if (q.dimension !== undefined) {
    params.push(q.dimension);
    where.push(`dimension = $${params.length}`);
  } else if (q.includeWriting !== true) {
    // Default: the 4 diagnostic dimensions only (see module note).
    where.push(`dimension <> 'writing'`);
  }

  if (q.since !== undefined) {
    params.push(q.since);
    where.push(`occurred_at >= $${params.length}`);
  }

  let limitClause = '';
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1) {
      throw new RangeError(`limit must be a positive integer, got ${q.limit}`);
    }
    params.push(Math.min(q.limit, MAX_LIMIT));
    limitClause = ` LIMIT $${params.length}`;
  }

  const { rows } = await query<RawAbilityEvidenceRow>(
    `SELECT ${RAW_COLUMNS}
       FROM ability_evidence
      WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC, source_id DESC${limitClause}`,
    params,
  );
  return rows.map(normalizeRow);
}

/**
 * Per-dimension rollup over a user's evidence: one entry per diagnostic
 * dimension (reading/listening/vocab/grammar, in CORE_DIMENSION_ORDER), plus
 * 'writing' appended iff `includeWriting`. `hanja` (diagnostic-upgrade
 * Phase A) never appears here — it is coverage-only and outside the
 * ability/IRT surface (see CORE_DIMENSION_ORDER's doc in scoring.ts).
 */
export async function getAbilityRollup(
  userId: number,
  q: RollupQuery = {},
): Promise<DimensionRollup[]> {
  const includeWriting = q.includeWriting === true;
  const rows = await getAbilityEvidence(userId, {
    since: q.since,
    includeWriting,
  });

  const dimensions: AbilityDimension[] = includeWriting
    ? [...CORE_DIMENSION_ORDER, 'writing']
    : [...CORE_DIMENSION_ORDER];

  // One accumulator per requested dimension, in emission order. The running
  // sums live beside (not on) the public rollup shape; means finalize below.
  const accumulators = dimensions.map((dimension) => ({
    rollup: emptyRollup(dimension),
    sum: { outcome: 0, difficulty: 0 },
  }));
  const byDimension = new Map(
    accumulators.map((entry) => [entry.rollup.dimension, entry]),
  );

  for (const row of rows) {
    const entry = byDimension.get(row.dimension);
    if (entry === undefined) continue; // outside the requested dimension set
    const { rollup, sum } = entry;
    rollup.nTotal += 1;
    sum.outcome += row.outcome;
    if (row.b !== null) {
      rollup.nWithDifficulty += 1;
      sum.difficulty += row.b;
    }
    rollup.bySource[row.source] += 1;
    // Rows arrive newest-first, so the first row seen per dimension is the
    // most recent.
    if (rollup.lastOccurredAt === null) {
      rollup.lastOccurredAt = row.occurredAt;
    }
  }

  for (const { rollup, sum } of accumulators) {
    rollup.meanOutcome = rollup.nTotal > 0 ? sum.outcome / rollup.nTotal : 0;
    rollup.meanDifficulty =
      rollup.nWithDifficulty > 0 ? sum.difficulty / rollup.nWithDifficulty : null;
  }

  return accumulators.map((entry) => entry.rollup);
}

function emptyRollup(dimension: AbilityDimension): DimensionRollup {
  const bySource = Object.fromEntries(
    EVIDENCE_SOURCES.map((source) => [source, 0]),
  ) as Record<EvidenceSource, number>;
  return {
    dimension,
    nTotal: 0,
    nWithDifficulty: 0,
    meanOutcome: 0,
    meanDifficulty: null,
    lastOccurredAt: null,
    bySource,
  };
}
