/**
 * F-011 confidence-band helpers shared by `SkillBar` (which draws the band)
 * and `SkillsCompare` (which keys its legend entry off the same visibility
 * rule). Lives outside the component files so fast refresh keeps working —
 * component modules must only export components.
 */

/** Score scale ceiling — scores and band edges are 0–100. */
export const SKILL_MAX = 100;

/**
 * Clamp a score/band edge to 0–100 — defends against malformed fixture or
 * server data drifting on-screen. NaN collapses to 0.
 */
export function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > SKILL_MAX) return SKILL_MAX;
  return value;
}

/**
 * Whether a `scoreLow`/`scoreHigh` pair renders a visible confidence band —
 * both edges present and still distinct after the 0–100 clamp. A degenerate
 * pair (low == high — the server's "confidence unknown" fallback) or a
 * missing pair renders no band.
 */
export function hasVisibleBand(
  scoreLow: number | undefined,
  scoreHigh: number | undefined,
): boolean {
  if (scoreLow === undefined || scoreHigh === undefined) return false;
  return clampScore(scoreLow) !== clampScore(scoreHigh);
}
