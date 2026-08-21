/**
 * Webtoon-scroll interleave — where a done illustration lands among a
 * story's text blocks (paragraphs, or read-along sentence lines) so the
 * Story Reader reads "text → picture → text → picture" at even narrative
 * beats, instead of one gallery block sitting above all the prose. Pure and
 * framework-free (the `lib/readAlong.ts` precedent): the caller owns the
 * actual `<figure>` rendering, this only computes placement.
 */

/**
 * For `blockCount` text blocks and `imageCount` done images, return one slot
 * array per block (`result[i]` = 0-based image indices to render right
 * after block `i`, in ascending order).
 *
 * Image `k` (0-based) targets 1-based block position
 * `round((k + 1) * blockCount / (imageCount + 1))` — spreading images across
 * the narrative at even beats — then clamps into `[1, blockCount]` before
 * converting back to a 0-based slot index. The clamp does two jobs:
 *   - never lets an image land before block 0, so the first block is always
 *     text-first;
 *   - when there are more images than blocks (`blockCount < imageCount`),
 *     piles any excess into the LAST block's slot rather than computing an
 *     out-of-range position — the "one per block, extras at the end"
 *     behavior falls out of the same formula, no special case needed.
 *
 * `blockCount === 0` (no text at all) or `imageCount === 0` (nothing to
 * interleave) both yield an all-empty slot list — the caller renders pure
 * text (or, with zero blocks, owns its own fallback for the images).
 */
export function computePanelSlots(
  blockCount: number,
  imageCount: number,
): number[][] {
  const slots: number[][] = Array.from({ length: blockCount }, () => []);
  if (blockCount === 0 || imageCount === 0) return slots;
  for (let k = 0; k < imageCount; k += 1) {
    const oneBased = Math.round(((k + 1) * blockCount) / (imageCount + 1));
    const clamped = Math.min(Math.max(oneBased, 1), blockCount);
    const slot = slots[clamped - 1];
    if (slot !== undefined) slot.push(k);
  }
  return slots;
}
