/**
 * Shared TOPIK reading-passage resolution.
 *
 * `topik_tests.passages` (migration 005) is a JSONB object keyed by
 * item-number RANGE ("19-20", "21-22", …) whose values are the reading
 * passages shared by the items in that range. Reading items that pose several
 * questions about one text (fill-the-blank ㉠, "윗글의 주제…" etc.) carry only
 * the question in their own `stem`/`prompt` — without the shared passage the
 * item is unanswerable.
 *
 * Both surfaces that serve TOPIK items resolve passages through this helper:
 * the Diagnostic item builder and the /topik routes (Study + Mock — B-008).
 */

/**
 * Resolve the shared passage covering `itemNumber` from a test's `passages`
 * JSONB. Keys are item-number RANGES ("19-20") or a single number ("21"); the
 * first key whose range includes `itemNumber` and whose value is a non-empty
 * string wins. Returns null when no key covers the item (e.g. listening/writing
 * tests leave `passages` as `{}`, or the item carries its own stem). Malformed
 * keys/values are skipped, never thrown on — a hostile corpus row degrades to
 * "no shared passage", not a 500.
 */
export function sharedPassageFor(
  passages: Record<string, unknown> | null,
  itemNumber: number,
): string | null {
  if (passages === null) return null;
  for (const [key, value] of Object.entries(passages)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    // "19-20" → [19, 20]; "21" → [21, 21]. Non-numeric keys are skipped.
    const parts = key.split('-');
    const lo = Number(parts[0]);
    const hi = parts.length > 1 ? Number(parts[parts.length - 1]) : lo;
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue;
    if (itemNumber >= Math.min(lo, hi) && itemNumber <= Math.max(lo, hi)) {
      return value;
    }
  }
  return null;
}
