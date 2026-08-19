/**
 * Ability-evidence normalization (F-212 Phase 1) — turns a raw
 * `ability_evidence` view row (per-source raw signals) into the normalized
 * `{ outcome ∈ [0,1], b: 0–6 | null }` shape the Phase-2 IRT estimator reads.
 *
 * Pure functions — no I/O, no DB, no clock. evidence.ts fetches raw rows and
 * maps each through `normalizeRow`; keeping the math here makes every lossy
 * mapping unit-testable and revisitable without touching the view.
 *
 * OUTCOME precedence (richest signal wins):
 *   1. outcome_raw_rating   → FSRS_RATING_OUTCOME (fsrs + hanja legs; hanja's
 *      `correct` boolean is DERIVED from this same rating at write time, so
 *      the 4-way rating is strictly more informative than the boolean)
 *   2. outcome_raw_correct  → 1 / 0 (topik + diagnostic legs)
 *   3. outcome_raw_score/max → score ÷ max (grammar_drill + writing legs;
 *      max > 0 guarded — the DB CHECKs guarantee it, but a guard beats NaN)
 *   The view guarantees every leg emits at least one of these; a row with
 *   none is a contract violation and throws loudly rather than scoring junk.
 *
 * DIFFICULTY-b precedence (most specific signal wins):
 *   1. diff_served        → passthrough (diagnostic leg; already 0–6 θ)
 *   2. diff_proficiency   → proficiencyToNumber (the locked CAT anchors)
 *   3. diff_topik_paper   → TOPIK_PAPER_ANCHORS (topik leg fallback)
 *      item_key rubric    → WRITING_RUBRIC_ANCHORS (writing leg fallback)
 *   4. none               → null (e.g. grammar_drill — genuinely untagged)
 */

import type { FsrsRating } from '../fsrs.js';
import {
  FSRS_RATING_OUTCOME,
  TOPIK_PAPER_ANCHORS,
  WRITING_RUBRIC_ANCHORS,
  proficiencyToNumber,
  type AbilityDimension,
  type EvidenceSource,
  type ProficiencyLevel,
} from './anchors.js';

/**
 * A raw `ability_evidence` row as node-postgres returns it. BIGINTs
 * (`user_id`, `source_id`) arrive as NUMBERS via the int8 parser (db/pool) —
 * typed `number | string` because normalizeRow is a pure function whose unit
 * tests feed literal-string rows (the pre-parser shape) and it passes both
 * ids through untouched. NUMERIC (`diff_served`) is a string, enums are
 * their label strings, TIMESTAMPTZ is a Date.
 */
export interface RawAbilityEvidenceRow {
  user_id: number | string;
  dimension: AbilityDimension;
  source: EvidenceSource;
  source_id: number | string;
  item_key: string | null;
  occurred_at: Date;
  outcome_raw_correct: boolean | null;
  outcome_raw_rating: FsrsRating | null;
  outcome_raw_score: number | null;
  outcome_raw_max: number | null;
  diff_served: string | null;
  diff_topik_paper: string | null;
  diff_proficiency: ProficiencyLevel | null;
}

/** The normalized evidence shape — one graded response, estimator-ready.
 *  `userId`/`sourceId` pass through from the raw row untouched (number from
 *  the int8 parser in production; string in the literal-row unit tests) —
 *  no consumer serializes them, the estimator reads only outcome/b/time. */
export interface AbilityEvidenceRow {
  userId: number | string;
  dimension: AbilityDimension;
  source: EvidenceSource;
  sourceId: number | string;
  itemKey: string | null;
  /** Graded outcome ∈ [0, 1]. */
  outcome: number;
  /** Item difficulty on the 0–6 θ scale; null when no signal exists. */
  b: number | null;
  /** ISO-8601 timestamp of the response. */
  occurredAt: string;
}

/**
 * Normalize one raw view row. Throws on a row that carries NO raw outcome
 * signal — the view's legs make that impossible, so reaching it means the
 * view contract drifted and silent mis-scoring must not paper over it.
 */
export function normalizeRow(raw: RawAbilityEvidenceRow): AbilityEvidenceRow {
  return {
    userId: raw.user_id,
    dimension: raw.dimension,
    source: raw.source,
    sourceId: raw.source_id,
    itemKey: raw.item_key,
    outcome: normalizeOutcome(raw),
    b: normalizeDifficulty(raw),
    occurredAt: raw.occurred_at.toISOString(),
  };
}

function normalizeOutcome(raw: RawAbilityEvidenceRow): number {
  if (raw.outcome_raw_rating !== null) {
    return FSRS_RATING_OUTCOME[raw.outcome_raw_rating];
  }
  if (raw.outcome_raw_correct !== null) {
    return raw.outcome_raw_correct ? 1 : 0;
  }
  if (
    raw.outcome_raw_score !== null &&
    raw.outcome_raw_max !== null &&
    raw.outcome_raw_max > 0
  ) {
    // Clamp: the DB CHECKs already bound score to [0, max], but a derived
    // ratio must never leave [0, 1] even if a future leg's bounds differ.
    return Math.min(1, Math.max(0, raw.outcome_raw_score / raw.outcome_raw_max));
  }
  throw new Error(
    `ability_evidence row ${raw.source}:${raw.source_id} carries no raw outcome signal`,
  );
}

function normalizeDifficulty(raw: RawAbilityEvidenceRow): number | null {
  if (raw.diff_served !== null) {
    const served = Number(raw.diff_served);
    return Number.isFinite(served) ? served : null;
  }
  if (raw.diff_proficiency !== null) {
    return proficiencyToNumber(raw.diff_proficiency);
  }
  if (raw.diff_topik_paper !== null) {
    return TOPIK_PAPER_ANCHORS[raw.diff_topik_paper] ?? null;
  }
  if (raw.source === 'writing' && raw.item_key !== null) {
    return WRITING_RUBRIC_ANCHORS[raw.item_key] ?? null;
  }
  return null;
}
