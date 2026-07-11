/**
 * topikStudyDraw — B-029 request-option builder for the Study draw size.
 *
 * Split out of `pages/Topik.tsx` (rather than exported there) so
 * `buildStudyDrawOptions` can be unit-tested directly without tripping
 * `react-refresh/only-export-components` — a page component file may only
 * export its component.
 */

/** The set sizes the FilterSelect can emit ('' = server default of 10). */
export type SetSize = '' | '20' | '30' | '50';

/**
 * The actual `fetchStudyDraw` request options for a chosen draw size. `''`
 * (the FilterSelect placeholder) omits `limit` entirely so the server
 * default (10) applies; any other size forwards it verbatim as a number.
 */
export function buildStudyDrawOptions(setSize: SetSize): { limit?: number } {
  return setSize === '' ? {} : { limit: Number(setSize) };
}
