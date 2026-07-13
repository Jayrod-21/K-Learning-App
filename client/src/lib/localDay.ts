/**
 * localDay — local-calendar-day comparison for "done today" signals (F-138).
 *
 * Extracted out of `pages/Today.tsx` into its own module (rather than a
 * named export alongside the page component) purely to keep
 * `react-refresh/only-export-components` happy — the same split this
 * codebase already uses for `ToastProvider`/`ReferenceRedirect`. No
 * behavior change: `Today.tsx` imports `isLocalToday` from here and calls
 * it exactly as before.
 *
 * No I/O — no threat model. Pure date-math over caller-supplied values.
 */

/** A calendar-day triplet, extracted from a `Date` by whatever "local"
 *  interpretation `dayParts` uses. */
export interface DayParts {
  y: number;
  m: number;
  day: number;
}

/**
 * The REAL local-timezone day extraction — `Date`'s local getters, i.e.
 * "what calendar day does this instant fall on for the person looking at
 * the screen." This is `isLocalToday`'s production default.
 *
 * Exported (alongside `isLocalToday`'s injectable third parameter below)
 * purely for testability (BLOCKER B1, `REVIEW_batch1-today.md`): CI always
 * runs at UTC (`ubuntu-latest`), where these local getters and their UTC
 * twins (`getUTCFullYear`/etc.) return byte-for-byte identical values for
 * every `Date` — so no test that only exercises the ambient clock/host TZ
 * can ever prove this function uses local getters rather than a regressed,
 * hardcoded UTC comparison. `localDay.test.ts` closes that gap two ways: a
 * `Date.prototype` spy proves the DEFAULT call path really invokes this
 * local trio (not the UTC one), and a simulated non-UTC extractor proves
 * the day-boundary COMPARISON itself picks whichever interpretation it is
 * given, using a real UTC-day-vs-local-day crossing.
 */
export function localDayParts(d: Date): DayParts {
  return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate() };
}

/**
 * True when the ISO timestamp `iso` falls on the same LOCAL calendar day as
 * `ref`. Attempt-history endpoints return newest-first history with no
 * "today only" filter, so F-138's per-tile daily counts are derived here —
 * in the viewer's local time (what "today" means to the person looking at
 * the screen), not the server's UTC day boundary. Malformed timestamps
 * resolve false rather than throwing.
 *
 * `dayParts` defaults to `localDayParts` (the real local getters) — every
 * production call site (`Today.tsx`) uses the default and behaves exactly
 * as before this parameter existed. It exists solely so `localDay.test.ts`
 * can inject a different, deterministic day-extraction strategy; see
 * `localDayParts`'s doc comment for why that is necessary at all.
 */
export function isLocalToday(
  iso: string,
  ref: Date,
  dayParts: (d: Date) => DayParts = localDayParts,
): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const a = dayParts(d);
  const b = dayParts(ref);
  return a.y === b.y && a.m === b.m && a.day === b.day;
}
