import { describe, it, expect } from 'vitest';

import { shuffleGeneratedChoices } from '../../src/routes/diagnostic.js';

/**
 * Generated (vocab/grammar) diagnostic items came back with the correct choice
 * parked at index 0 almost every time — the Claude proxy's position bias, never
 * randomized. That makes the test gameable ("always pick the first choice").
 * shuffleGeneratedChoices permutes server-side; these lock in that it (a) never
 * loses/relabels a choice, (b) keeps correctAnswer pointing at the right text,
 * and (c) actually distributes the correct position instead of leaving it at 'a'.
 */
describe('shuffleGeneratedChoices — diagnostic answer-position bias fix', () => {
  const src = [{ kr: '가' }, { kr: '나' }, { kr: '다' }, { kr: '라' }] as const;
  const letterToIdx: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };

  it('keeps correctAnswer on the originally-correct choice, for every source position', () => {
    for (const correctIdx of [0, 1, 2, 3]) {
      for (let trial = 0; trial < 50; trial += 1) {
        const { choices, correctAnswer } = shuffleGeneratedChoices(src, correctIdx);
        expect(choices.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
        expect(choices[letterToIdx[correctAnswer]]!.kr).toBe(src[correctIdx]!.kr);
        // no choice text dropped or duplicated
        expect(new Set(choices.map((c) => c.kr))).toEqual(
          new Set(['가', '나', '다', '라']),
        );
      }
    }
  });

  it('does NOT always leave the correct answer at "a"', () => {
    const N = 400;
    let aCount = 0;
    for (let i = 0; i < N; i += 1) {
      // correct starts at index 0 (the model's biased position); after shuffling
      // it should land across all four positions, not stay at 'a'.
      const { correctAnswer } = shuffleGeneratedChoices(src, 0);
      if (correctAnswer === 'a') aCount += 1;
    }
    // Fair ≈ 25%. Generous bounds catch "always a" (100% — the bug) and "never
    // shuffled"; P(outside 10–45% over 400 draws) is negligible.
    expect(aCount).toBeGreaterThan(N * 0.1);
    expect(aCount).toBeLessThan(N * 0.45);
  });

  it('respects an injected RNG deterministically', () => {
    // rng()=0 → every Fisher–Yates swap picks j=0. order [0,1,2,3] →
    // i=3 swap(3,0)=[3,1,2,0] → i=2 swap(2,0)=[2,1,3,0] → i=1 swap(1,0)=[1,2,3,0].
    const { choices, correctAnswer } = shuffleGeneratedChoices(src, 0, () => 0);
    expect(choices.map((c) => c.kr)).toEqual(['나', '다', '라', '가']);
    // original correct (index 0 = '가') landed at new position 3 → 'd'.
    expect(correctAnswer).toBe('d');
  });
});
