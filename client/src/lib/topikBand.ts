/**
 * topikBand — percentage → readiness-band headline, shared by `PastExams`
 * (server-graded past sittings) and `Topik.tsx`'s Study-mode client tally
 * (F-008). Presentation-only copy, not a shared grading contract: the two
 * screens' scoring paths stay independent (DB-graded vs client-tallied
 * reveals), and the server has its own separate `bandForPercentage`
 * (`server/src/routes/topik.ts`, Mock mode) that this does NOT mirror by
 * import — client and server are different bundles. This module only
 * de-duplicates the wording between the two CLIENT screens that had grown a
 * byte-identical copy each.
 */
export function bandForPercentage(percentage: number): string {
  if (percentage >= 80) return 'On track for L5+';
  if (percentage >= 60) return 'L4 range';
  if (percentage >= 40) return 'L3 range';
  return 'Below L3';
}
