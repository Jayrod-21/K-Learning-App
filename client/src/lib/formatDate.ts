/**
 * formatDate — shared short-date display formatter ("Jan 5, 2026").
 * Extracted from Tickets.tsx and Uploads.tsx (byte-identical bodies, one
 * per page). Not related to `formatDateTime`/`formatDateEyebrow` (longer
 * datetime formats) or `localDay.ts`'s `isLocalToday` (calendar-day
 * comparison, not display formatting) — those stay where they are.
 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
