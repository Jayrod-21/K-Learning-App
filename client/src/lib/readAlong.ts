/**
 * Read-along playhead resolution — shared by the story reader's F-210
 * narration (pages/Reading.tsx) and the Listen track player
 * (pages/Ttmik.tsx `MyAudioDetail`). Pure and framework-free: callers own
 * the `<audio>` ref, the `timeupdate`/`seeked`/`ended` listeners, and the
 * active-segment state this feeds.
 */

/**
 * The minimal timed-segment shape the resolver needs — structurally
 * satisfied by both `StoryAudioSegment` (services/reading.ts) and
 * `AudioSegment` (types/domain.ts). `[startMs, endMs)` is the segment's
 * window in the track; `segmentNumber` its 1-based ordinal.
 */
export interface TimedSegment {
  segmentNumber: number;
  startMs: number;
  endMs: number;
}

/**
 * Binary-search the ordered segments for the one whose `[startMs, endMs)`
 * window contains `ms` — O(log n) per `timeupdate` tick (~4 Hz). Returns
 * that segment's `segmentNumber`, or null when the playhead sits in no
 * window (before the first sentence, inside an inter-sentence gap, or past
 * the end).
 *
 * CONTRACT: `segments` must already be ordered by ascending `startMs` —
 * both call sites sort defensively by `segmentNumber`, whose windows ascend
 * with the ordinal on both wires. Unordered input is NOT detected here.
 */
export function activeSegmentNumberAt(
  segments: readonly TimedSegment[],
  ms: number,
): number | null {
  let lo = 0;
  let hi = segments.length - 1;
  let candidate: TimedSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (seg === undefined) return null; // unreachable — bounds are checked
    if (seg.startMs <= ms) {
      candidate = seg;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === null) return null;
  return ms < candidate.endMs ? candidate.segmentNumber : null;
}
