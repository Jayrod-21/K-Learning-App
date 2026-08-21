/**
 * computePanelSlots — the webtoon-scroll interleave math: which done
 * illustration lands after which paragraph/sentence block. Covers the exact
 * P<N fixture the reader tests exercise (2 paragraphs, 3 images), the
 * P===0/N===0 edge cases, and the "never before the first block" /
 * "excess piles at the end" guarantees the placement depends on.
 */
import { describe, it, expect } from 'vitest';
import { computePanelSlots } from './storyPanels';

describe('computePanelSlots', () => {
  it('P<N: the Reading.test.tsx fixture (2 paragraphs, 3 images) — text-first, spread, extras at the end', () => {
    // image 0 → round(1*2/4)=1, image 1 → round(2*2/4)=1, image 2 →
    // round(3*2/4)=2 — both early images share paragraph 0's slot, the
    // third (excess) piles onto the LAST paragraph's slot.
    expect(computePanelSlots(2, 3)).toEqual([[0, 1], [2]]);
  });

  it('one block, several images: every image clamps into the ONLY block\'s slot (never before it)', () => {
    expect(computePanelSlots(1, 4)).toEqual([[0, 1, 2, 3]]);
  });

  it('spreads images across many blocks rather than clumping — first block stays text-first', () => {
    // image 0 → round(5/3)=2 → slot 1; image 1 → round(10/3)=3 → slot 2.
    expect(computePanelSlots(5, 2)).toEqual([[], [0], [1], [], []]);
  });

  it('a single image with several blocks lands near the middle, not at block 0', () => {
    // round(3/2) = 2 (1-based) → slot index 1.
    expect(computePanelSlots(3, 1)).toEqual([[], [0], []]);
  });

  it('blockCount === 0 yields no slots at all (nothing to attach an image to)', () => {
    expect(computePanelSlots(0, 3)).toEqual([]);
  });

  it('imageCount === 0 yields one empty slot per block (pure text, no panels)', () => {
    expect(computePanelSlots(4, 0)).toEqual([[], [], [], []]);
  });

  it('both zero yields an empty slot list', () => {
    expect(computePanelSlots(0, 0)).toEqual([]);
  });

  it('every image index appears in exactly one slot, in ascending 0-based order', () => {
    const slots = computePanelSlots(4, 3);
    const flat = slots.flat();
    expect(flat).toEqual([...flat].sort((a, b) => a - b));
    expect(flat).toEqual([0, 1, 2]);
  });
});
