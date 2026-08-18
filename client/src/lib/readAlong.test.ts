/**
 * activeSegmentNumberAt — the shared read-along playhead resolver (binary
 * search over ordered [startMs, endMs) windows): inside-a-span hits, gap /
 * before-first / after-last misses, exact boundary inclusivity, and the
 * pre-sorted-input contract both call sites uphold.
 */
import { describe, it, expect } from 'vitest';
import { activeSegmentNumberAt, type TimedSegment } from './readAlong';

/** Three ordered sentences with a 500ms gap between #2 and #3 — the shape
 *  Whisper/TTS alignment actually produces (contiguous, then a breath). */
const SEGMENTS: readonly TimedSegment[] = [
  { segmentNumber: 1, startMs: 1000, endMs: 4000 },
  { segmentNumber: 2, startMs: 4000, endMs: 8000 },
  { segmentNumber: 3, startMs: 8500, endMs: 12_000 },
];

describe('activeSegmentNumberAt', () => {
  it('resolves a playhead inside a window to that segment', () => {
    expect(activeSegmentNumberAt(SEGMENTS, 2500)).toBe(1);
    expect(activeSegmentNumberAt(SEGMENTS, 5000)).toBe(2);
    expect(activeSegmentNumberAt(SEGMENTS, 11_999)).toBe(3);
  });

  it('returns null in an inter-sentence gap', () => {
    // 8000–8500 sits between #2's end and #3's start.
    expect(activeSegmentNumberAt(SEGMENTS, 8200)).toBeNull();
  });

  it('returns null before the first window and after the last', () => {
    expect(activeSegmentNumberAt(SEGMENTS, 0)).toBeNull();
    expect(activeSegmentNumberAt(SEGMENTS, 999)).toBeNull();
    expect(activeSegmentNumberAt(SEGMENTS, 12_000)).toBeNull();
    expect(activeSegmentNumberAt(SEGMENTS, 99_999)).toBeNull();
  });

  it('treats startMs as inclusive and endMs as exclusive', () => {
    // Exactly on a start → that segment…
    expect(activeSegmentNumberAt(SEGMENTS, 1000)).toBe(1);
    expect(activeSegmentNumberAt(SEGMENTS, 8500)).toBe(3);
    // …and on a shared boundary the NEXT segment wins (4000 is #1's
    // exclusive end and #2's inclusive start — never both).
    expect(activeSegmentNumberAt(SEGMENTS, 4000)).toBe(2);
    // An end with no adjoining start is a miss.
    expect(activeSegmentNumberAt(SEGMENTS, 8000)).toBeNull();
  });

  it('returns null for an empty segment list', () => {
    expect(activeSegmentNumberAt([], 1000)).toBeNull();
  });

  it('resolves a single-segment list at every position', () => {
    const one: readonly TimedSegment[] = [
      { segmentNumber: 7, startMs: 200, endMs: 900 },
    ];
    expect(activeSegmentNumberAt(one, 199)).toBeNull();
    expect(activeSegmentNumberAt(one, 200)).toBe(7);
    expect(activeSegmentNumberAt(one, 899)).toBe(7);
    expect(activeSegmentNumberAt(one, 900)).toBeNull();
  });

  it('honors the ordering contract: callers pass segments pre-sorted (the defensive segmentNumber sort at both call sites)', () => {
    // The wire could arrive shuffled; both callers sort by segmentNumber
    // before calling — after that sort the resolver must be exact. (The
    // resolver itself assumes ascending startMs and does NOT detect
    // unordered input — that is the documented contract, not a fallback.)
    const shuffled: TimedSegment[] = [
      { segmentNumber: 3, startMs: 8500, endMs: 12_000 },
      { segmentNumber: 1, startMs: 1000, endMs: 4000 },
      { segmentNumber: 2, startMs: 4000, endMs: 8000 },
    ];
    const ordered = [...shuffled].sort(
      (a, b) => a.segmentNumber - b.segmentNumber,
    );
    expect(activeSegmentNumberAt(ordered, 2500)).toBe(1);
    expect(activeSegmentNumberAt(ordered, 5000)).toBe(2);
    expect(activeSegmentNumberAt(ordered, 9000)).toBe(3);
    expect(activeSegmentNumberAt(ordered, 8200)).toBeNull();
  });

  it('never highlights on all-zero (degenerate) windows — every ms is outside [0, 0)', () => {
    const untimed: readonly TimedSegment[] = [
      { segmentNumber: 1, startMs: 0, endMs: 0 },
      { segmentNumber: 2, startMs: 0, endMs: 0 },
    ];
    expect(activeSegmentNumberAt(untimed, 0)).toBeNull();
    expect(activeSegmentNumberAt(untimed, 1500)).toBeNull();
  });
});
