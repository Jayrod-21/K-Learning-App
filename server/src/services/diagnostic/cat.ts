/**
 * CAT-lite (Computerized Adaptive Testing) ability-tracking helpers.
 *
 * Pure functions — no I/O, no DB, no clock. They model the diagnostic's
 * adaptivity: a running ability estimate θ on the 0–6 TOPIK scale that rises
 * when the learner answers correctly and falls when they miss/skip, with a
 * decaying step size so early answers move θ more than late ones (a classic
 * staircase). The route layer persists the trajectory; this module owns only
 * the math, which makes it trivially unit-testable.
 *
 * Scale convention: θ ∈ [0, 6] aligns with the TOPIK level numbering the rest
 * of the diagnostic uses (estimates, snapshot columns). `band(θ)` collapses θ
 * to the discrete proficiency label used to pick/generate the next item.
 */

import type { ProficiencyLevel, DiagnosticTargetLevel } from '../claude/index.js';

/** Seed ability — L2 (start-easy ramp, diagnostic-upgrade Phase A). The first
 *  item is served at this band before any evidence exists.
 *
 *  Was 4.0 (L4 mid). At the old seed + step, the FIRST item of every
 *  dimension was served near the seed band, which dragged that dimension's
 *  mean-served-difficulty down for an advanced user (the per-dim estimate is
 *  mean(difficulty) + spread — see scoring.ts) even though θ itself climbed
 *  out of L4 within a few answers. Starting easier (L2) plus a steeper early
 *  `stepForAnswer` (below) reaches the ceiling just as fast for a strong
 *  learner while giving a genuine beginner a real, non-intimidating opener
 *  instead of a first item three bands above their level. */
export const SEED_THETA = 2.0;

/** θ is clamped to this closed interval after every update. The 0–6 column
 *  CHECK in migration 001/014 is the durable guard; this keeps the in-memory
 *  value honest so it never violates the constraint on write. Floor 1.0
 *  (F-002): θ can descend into L1 territory so a beginner gets a real
 *  placement instead of being floored at the old 2.0 / 'basic' collapse. */
export const THETA_MIN = 1.0;
export const THETA_MAX = 6.0;

/** The discrete proficiency bands the CAT can land on for item selection.
 *  F-002: 'basic' is no longer a diagnostic band — the below-L3 range splits
 *  into L1/L2. ('basic' survives only as a CONTENT tag on corpus rows.) */
export type DiagnosticBand = 'L1' | 'L2' | 'L3' | 'L4' | 'L5+';

/**
 * Map a proficiency label to its numeric position on the 0–6 θ scale.
 *
 * Used to (a) seed/interpret bands and (b) translate a topik_items row's
 * `proficiency` enum into a difficulty number for scoring. The values are the
 * locked product decision: L1=1, L2=2, basic=2, L3=3, L4=4, L5+=5.5.
 * ('basic' stays at 2 — it is a corpus content tag, not a diagnostic band,
 * and its rough difficulty sits at the L2 anchor.)
 */
export function proficiencyToNumber(level: ProficiencyLevel): number {
  switch (level) {
    case 'L1':
      return 1;
    case 'L2':
      return 2;
    case 'basic':
      return 2;
    case 'L3':
      return 3;
    case 'L4':
      return 4;
    case 'L5+':
      return 5.5;
    default: {
      // Exhaustiveness guard — a new enum member must be handled here.
      const _never: never = level;
      return _never;
    }
  }
}

/**
 * Collapse a continuous θ to the discrete band used to pick/generate the next
 * item. Five bands (F-002): the old `θ < 2.5 → 'basic'` collapse is replaced
 * by real L1/L2 placement so a beginner is not lumped into one bucket.
 *
 * Boundaries (using the numeric anchors L1=1, L2=2, L3=3, L4=4, L5+=5.5):
 *   θ < 1.5            → L1
 *   1.5 ≤ θ < 2.5      → L2
 *   2.5 ≤ θ < 3.5      → L3
 *   3.5 ≤ θ < 4.75     → L4   (4.75 = midpoint of 4 and 5.5)
 *   θ ≥ 4.75           → L5+
 */
export function bandForTheta(theta: number): DiagnosticBand {
  if (theta < 1.5) return 'L1';
  if (theta < 2.5) return 'L2';
  if (theta < 3.5) return 'L3';
  if (theta < 4.75) return 'L4';
  return 'L5+';
}

/**
 * The band a GENERATED (Claude) item is authored at. Since F-002 the
 * generator accepts the full L1–L5+ range (DiagnosticTargetLevel), so this is
 * the identity over `bandForTheta` — kept as a named seam because the
 * "band for selection" and "level for generation" are distinct concepts the
 * route wires to different sinks (topik row picks vs. Claude prompts).
 */
export function targetLevelForTheta(theta: number): DiagnosticTargetLevel {
  return bandForTheta(theta);
}

/**
 * Staircase step size for the n-th graded answer (1-based).
 *
 *   step_n = max(0.4, 1.5 − 0.15·(n − 1))
 *
 * So step decays 1.5, 1.35, 1.2, … and floors at 0.4 (from n=9 on). Early
 * answers move θ more (we know less), late answers fine-tune. The floor keeps
 * a long run from freezing θ entirely.
 *
 * Steepened from `max(0.4, 1.0 − 0.1·(n−1))` alongside the SEED_THETA 4.0→2.0
 * drop (start-easy ramp, diagnostic-upgrade Phase A): paired with the lower
 * seed, an all-correct run still reaches THETA_MAX (6.0) by the 3rd answer
 * (2.0 → 3.5 → 4.85 → 6.0, clamped) — as fast as the old seed/step reached it
 * from L4 — while a struggling learner descends to THETA_MIN just as quickly
 * on the other side. See cat.test.ts for the exact re-simulation.
 */
export function stepForAnswer(answerNumber: number): number {
  if (!Number.isFinite(answerNumber) || answerNumber < 1) {
    throw new RangeError(`answerNumber must be an integer ≥ 1, got ${answerNumber}`);
  }
  return Math.max(0.4, 1.5 - 0.15 * (answerNumber - 1));
}

/** Clamp a θ to [THETA_MIN, THETA_MAX]. */
export function clampTheta(theta: number): number {
  if (theta < THETA_MIN) return THETA_MIN;
  if (theta > THETA_MAX) return THETA_MAX;
  return theta;
}

/**
 * Next ability estimate after grading the n-th answer.
 *
 *   correct      → θ += step_n
 *   wrong / skip → θ −= step_n
 *   then clamp to [THETA_MIN, THETA_MAX].
 *
 * @param currentTheta θ before this answer.
 * @param wasCorrect   the graded result (a skip is `false`).
 * @param answerNumber 1-based index of this answer within the run.
 */
export function nextTheta(
  currentTheta: number,
  wasCorrect: boolean,
  answerNumber: number,
): number {
  const step = stepForAnswer(answerNumber);
  const moved = wasCorrect ? currentTheta + step : currentTheta - step;
  return clampTheta(moved);
}

/** Round a θ to 2 decimals so it fits the NUMERIC(3,2) column exactly. */
export function thetaToNumeric(theta: number): number {
  return Math.round(clampTheta(theta) * 100) / 100;
}
