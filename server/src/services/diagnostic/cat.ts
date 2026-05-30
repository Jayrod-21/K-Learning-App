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

/** Seed ability — L4 mid. The first item is served at this band before any
 *  evidence exists. */
export const SEED_THETA = 4.0;

/** θ is clamped to this closed interval after every update. The 0–6 column
 *  CHECK in migration 001/014 is the durable guard; this keeps the in-memory
 *  value honest so it never violates the constraint on write. */
export const THETA_MIN = 2.0;
export const THETA_MAX = 6.0;

/** The discrete proficiency bands the CAT can land on for item selection. */
export type DiagnosticBand = 'basic' | 'L3' | 'L4' | 'L5+';

/**
 * Map a proficiency label to its numeric position on the 0–6 θ scale.
 *
 * Used to (a) seed/interpret bands and (b) translate a topik_items row's
 * `proficiency` enum into a difficulty number for scoring. The values are the
 * locked product decision: basic=2, L3=3, L4=4, L5+=5.5.
 */
export function proficiencyToNumber(level: ProficiencyLevel): number {
  switch (level) {
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
 * item. Nearest of {L3, L4, L5+}, with 'basic' reserved for genuinely low θ
 * (< 2.5) so a struggling learner gets easier items rather than being floored
 * at L3.
 *
 * Boundaries (using the numeric anchors L3=3, L4=4, L5+=5.5):
 *   θ < 2.5            → basic
 *   2.5 ≤ θ < 3.5      → L3
 *   3.5 ≤ θ < 4.75     → L4   (4.75 = midpoint of 4 and 5.5)
 *   θ ≥ 4.75           → L5+
 */
export function bandForTheta(theta: number): DiagnosticBand {
  if (theta < 2.5) return 'basic';
  if (theta < 3.5) return 'L3';
  if (theta < 4.75) return 'L4';
  return 'L5+';
}

/**
 * The band a GENERATED (Claude) item is authored at. Claude's diagnostic-item
 * route only accepts L3/L4/L5+ (DiagnosticTargetLevel) — a 'basic' θ floors to
 * L3 for generation because the corpus/generator has no sub-L3 target.
 */
export function targetLevelForTheta(theta: number): DiagnosticTargetLevel {
  const band = bandForTheta(theta);
  return band === 'basic' ? 'L3' : band;
}

/**
 * Staircase step size for the n-th graded answer (1-based).
 *
 *   step_n = max(0.4, 1.0 − 0.1·(n − 1))
 *
 * So step decays 1.0, 0.9, 0.8, … and floors at 0.4. Early answers move θ
 * more (we know less), late answers fine-tune. The floor keeps a long run from
 * freezing θ entirely.
 */
export function stepForAnswer(answerNumber: number): number {
  if (!Number.isFinite(answerNumber) || answerNumber < 1) {
    throw new RangeError(`answerNumber must be an integer ≥ 1, got ${answerNumber}`);
  }
  return Math.max(0.4, 1.0 - 0.1 * (answerNumber - 1));
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
