/**
 * Ability-evidence anchors (F-212 Phase 1) — the LOCKED constants that turn
 * the `ability_evidence` view's raw per-source signals into the normalized
 * outcome ∈ [0, 1] / difficulty-b (0–6 θ scale) pair the Phase-2 IRT
 * estimator consumes.
 *
 * Pure constants + type aliases — no I/O. The mappings live HERE (not in the
 * view) so they stay revisitable in Phase 2 without a migration; the view
 * emits only raw signals (see db/migrations/084_ability_evidence_view.up.sql).
 *
 * `proficiencyToNumber` is deliberately RE-EXPORTED from the diagnostic CAT
 * module, not re-implemented: the L1=1 … L5+=5.5 anchors are a locked product
 * decision with exactly one home (services/diagnostic/cat.ts), and the
 * ability layer must move in lockstep with the diagnostic if they ever
 * change. The parity test in tests/services/ability pins this identity.
 */

export { proficiencyToNumber } from '../diagnostic/cat.js';
export type { ProficiencyLevel } from '../claude/index.js';

/**
 * The five ability dimensions evidence can score. The first four are the
 * diagnostic's CORE_DIMENSION_ORDER (services/diagnostic/scoring.ts — the
 * strict subset of the diagnostic's own DIMENSION_ORDER that has IRT
 * calibration; `hanja`, added in diagnostic-upgrade Phase A, is
 * diagnostic-only and deliberately excluded, see that constant's doc);
 * 'writing' is evidence-only — sparse and expensive to produce, so read APIs
 * exclude it unless asked (includeWriting).
 */
export type AbilityDimension = 'reading' | 'listening' | 'vocab' | 'grammar' | 'writing';

/** The six producing logs the `ability_evidence` view UNION ALLs. */
export type EvidenceSource =
  | 'topik'
  | 'fsrs'
  | 'grammar_drill'
  | 'writing'
  | 'hanja'
  | 'diagnostic';

/** Every evidence source, in the view's leg order (iteration/rollup seed). */
export const EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  'topik',
  'fsrs',
  'grammar_drill',
  'writing',
  'hanja',
  'diagnostic',
] as const;

/**
 * Difficulty anchor for a TOPIK paper when the item itself carries no
 * `proficiency` tag: the paper's level is the only signal left, and its
 * center of mass on the 0–6 θ scale is the anchor. LOCKED: TOPIK I ≈ L2,
 * TOPIK II ≈ L4.
 */
export const TOPIK_PAPER_ANCHORS: Readonly<Record<string, number>> = {
  'TOPIK I': 2.0,
  'TOPIK II': 4.0,
};

/**
 * Difficulty anchor per writing rubric (the writing leg's item_key) when the
 * attempt has no prompt-level tag: Q53 (200–300자 chart paragraph) sits at
 * mid-L3/L4, Q54 (the long essay) at L5. LOCKED. 'free_write' (056) has no
 * anchor — its difficulty is genuinely unknown (b = null).
 */
export const WRITING_RUBRIC_ANCHORS: Readonly<Record<string, number>> = {
  topik_ii_53: 3.5,
  topik_ii_54: 5.0,
};

/**
 * FSRS self-rating → outcome ∈ [0, 1]. LOCKED: the 4-way rating is a graded
 * response, not a boolean — 'hard' is a weak pass, 'good' a solid one. Used
 * for BOTH the fsrs and hanja legs (a hanja attempt's `correct` boolean is
 * derived from this same rating at write time; the rating is the richer
 * signal, so it wins — see normalize.ts).
 */
export const FSRS_RATING_OUTCOME: Readonly<Record<'again' | 'hard' | 'good' | 'easy', number>> = {
  again: 0,
  hard: 0.33,
  good: 0.67,
  easy: 1.0,
};
