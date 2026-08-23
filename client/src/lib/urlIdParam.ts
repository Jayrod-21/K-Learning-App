/**
 * parseIdParam — shared URL-query-param → positive integer id parser.
 * Extracted from Review.tsx's `parseListIdParam` and Tickets.tsx's
 * `parseTicketIdParam` (byte-identical bodies, one per page).
 *
 * `?list=`/`?ticket=`-style params must be a short positive integer;
 * anything else (missing, non-numeric, negative, zero) → null (landing).
 * Length-capped before `parseInt` so a hostile mile-long digit string can't
 * reach `Number` territory where precision loss lies.
 */
export function parseIdParam(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
