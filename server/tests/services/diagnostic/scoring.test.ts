/**
 * Unit tests for the diagnostic scoring helpers (pure math).
 *
 * Rubric v1.1.0 (F-011): per-dimension estimate is a smooth proportion-correct
 * adjustment (every item counts), and each dimension carries an Agresti-Coull
 * confidence band via `dimensionResult`.
 */
import { describe, expect, it } from 'vitest';
import {
  RUBRIC_VERSION,
  dimensionResult,
  estimateForDimension,
  estimateToScore,
  estimatesByDimension,
  resultsByDimension,
  type ScoredResponse,
} from '../../../src/services/diagnostic/scoring.js';

/** n responses at one difficulty, the first k of them correct. */
function responsesOf(n: number, k: number, difficulty = 4): ScoredResponse[] {
  return Array.from({ length: n }, (_, i) => ({
    section: 'reading' as const,
    difficulty,
    isCorrect: i < k,
  }));
}

describe('RUBRIC_VERSION', () => {
  it('matches the diagnostic_snapshots semver CHECK', () => {
    expect(RUBRIC_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });
  it('is bumped to v1.1.0 for the F-011 proportion + band rubric', () => {
    expect(RUBRIC_VERSION).toBe('v1.1.0');
  });
});

describe('estimateForDimension (proportion-correct, v1.1.0)', () => {
  it('returns null for an empty pool (no items served)', () => {
    expect(estimateForDimension([])).toBeNull();
  });
  it('all correct → base + ESTIMATE_SPREAD/2 (+0.75)', () => {
    expect(estimateForDimension(responsesOf(2, 2))).toBeCloseTo(4.75);
    expect(estimateForDimension(responsesOf(4, 4))).toBeCloseTo(4.75);
  });
  it('half correct → base (p=0.5 delta is 0)', () => {
    const resp: ScoredResponse[] = [
      { section: 'vocab', difficulty: 4, isCorrect: true },
      { section: 'vocab', difficulty: 5, isCorrect: false },
    ];
    expect(estimateForDimension(resp)).toBeCloseTo(4.5);
  });
  it('none correct → base − ESTIMATE_SPREAD/2 (−0.75)', () => {
    expect(estimateForDimension(responsesOf(2, 0))).toBeCloseTo(3.25);
    expect(estimateForDimension(responsesOf(4, 0))).toBeCloseTo(3.25);
  });
  it('1/4, 2/4 and 3/4 give DISTINCT, monotonic results (every item counts)', () => {
    // The old all/none/mixed rubric collapsed all three to base — the whole
    // point of v1.1.0 is that they differ.
    const oneOfFour = estimateForDimension(responsesOf(4, 1))!;
    const twoOfFour = estimateForDimension(responsesOf(4, 2))!;
    const threeOfFour = estimateForDimension(responsesOf(4, 3))!;
    expect(oneOfFour).toBeCloseTo(3.63); // 4 − 0.375, round2
    expect(twoOfFour).toBeCloseTo(4.0);
    expect(threeOfFour).toBeCloseTo(4.38); // 4 + 0.375, round2
    expect(oneOfFour).not.toBe(twoOfFour);
    expect(twoOfFour).not.toBe(threeOfFour);
    expect(oneOfFour).toBeLessThan(twoOfFour);
    expect(twoOfFour).toBeLessThan(threeOfFour);
  });
  it('clamps to [1, 6]', () => {
    const high: ScoredResponse[] = [{ section: 'reading', difficulty: 6, isCorrect: true }];
    expect(estimateForDimension(high)).toBe(6); // 6 + 0.75 → clamp 6
    const low: ScoredResponse[] = [{ section: 'reading', difficulty: 1.5, isCorrect: false }];
    expect(estimateForDimension(low)).toBe(1); // 1.5 − 0.75 = 0.75 → clamp 1
  });
});

describe('estimatesByDimension', () => {
  it('groups by dimension and null-fills the unexercised ones', () => {
    const resp: ScoredResponse[] = [
      { section: 'reading', difficulty: 4, isCorrect: true },
      { section: 'reading', difficulty: 4, isCorrect: true },
      { section: 'vocab', difficulty: 3, isCorrect: false },
    ];
    const out = estimatesByDimension(resp);
    expect(out.reading).toBeCloseTo(4.75); // 4 + 0.75 (all correct)
    expect(out.vocab).toBeCloseTo(2.25); // single none-correct: 3 − 0.75
    expect(out.listening).toBeNull();
    expect(out.grammar).toBeNull();
  });
});

describe('dimensionResult (confidence band)', () => {
  const width = (n: number, k: number, difficulty = 4): number => {
    const r = dimensionResult(responsesOf(n, k, difficulty))!;
    return r.scoreHigh - r.scoreLow;
  };

  it('returns null for a zero-item dimension (same contract as the estimate)', () => {
    expect(dimensionResult([])).toBeNull();
  });

  it('carries the estimate, score and item count through', () => {
    const r = dimensionResult(responsesOf(4, 4))!;
    expect(r.estimate).toBeCloseTo(4.75);
    expect(r.score).toBe(estimateToScore(4.75)); // 66
    expect(r.n).toBe(4);
  });

  it('is NON-zero-width at p=1 (4/4 must not read as certainty)', () => {
    const r = dimensionResult(responsesOf(4, 4))!;
    expect(r.scoreLow).toBeLessThan(r.score);
    expect(r.scoreHigh).toBeGreaterThan(r.score);
  });

  it('is NON-zero-width at p=0 (0/4 must not read as certainty)', () => {
    const r = dimensionResult(responsesOf(4, 0))!;
    expect(r.scoreLow).toBeLessThan(r.score);
    expect(r.scoreHigh).toBeGreaterThan(r.score);
  });

  it('narrows as n grows at the same p (n=2 wider than n=4)', () => {
    expect(width(2, 2)).toBeGreaterThan(width(4, 4)); // p=1
    expect(width(2, 0)).toBeGreaterThan(width(4, 0)); // p=0
    expect(width(2, 1)).toBeGreaterThan(width(4, 2)); // p=0.5
  });

  it('is widest near p=0.5 (inconsistent answers) for a fixed n', () => {
    expect(width(4, 2)).toBeGreaterThan(width(4, 4));
    expect(width(4, 2)).toBeGreaterThan(width(4, 0));
  });

  it('keeps scoreLow ≤ score ≤ scoreHigh, all within [0, 100], everywhere', () => {
    for (const n of [1, 2, 3, 4]) {
      for (let k = 0; k <= n; k += 1) {
        for (const difficulty of [1.5, 2, 4, 5.5, 6]) {
          const r = dimensionResult(responsesOf(n, k, difficulty))!;
          expect(r.scoreLow).toBeLessThanOrEqual(r.score);
          expect(r.score).toBeLessThanOrEqual(r.scoreHigh);
          expect(r.scoreLow).toBeGreaterThanOrEqual(0);
          expect(r.scoreHigh).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('at the estimate ceiling the band collapses upward but keeps its lower tail', () => {
    // difficulty 6, all correct: estimate clamps at 6 → scoreHigh = score (85),
    // but the band is still not a point — the uncertainty shows below.
    const r = dimensionResult(responsesOf(4, 4, 6))!;
    expect(r.estimate).toBe(6);
    expect(r.scoreHigh).toBe(r.score);
    expect(r.scoreLow).toBeLessThan(r.score);
  });
});

describe('resultsByDimension', () => {
  it('groups by dimension, mirrors the estimates, and null-fills the rest', () => {
    const resp: ScoredResponse[] = [
      { section: 'reading', difficulty: 4, isCorrect: true },
      { section: 'reading', difficulty: 4, isCorrect: true },
      { section: 'vocab', difficulty: 3, isCorrect: false },
    ];
    const out = resultsByDimension(resp);
    expect(out.reading?.estimate).toBeCloseTo(4.75);
    expect(out.reading?.n).toBe(2);
    expect(out.vocab?.estimate).toBeCloseTo(2.25);
    expect(out.vocab?.n).toBe(1);
    expect(out.listening).toBeNull();
    expect(out.grammar).toBeNull();
    // Consistency with the scalar helper the snapshot columns are written from.
    const estimates = estimatesByDimension(resp);
    expect(out.reading?.estimate).toBe(estimates.reading);
    expect(out.vocab?.estimate).toBe(estimates.vocab);
  });
});

describe('estimateToScore', () => {
  it('hits the anchor points', () => {
    expect(estimateToScore(3)).toBe(40);
    expect(estimateToScore(4)).toBe(55);
    expect(estimateToScore(5)).toBe(70);
    expect(estimateToScore(6)).toBe(85);
  });
  it('interpolates between anchors', () => {
    expect(estimateToScore(3.5)).toBe(48); // midpoint of 40 and 55 → 47.5 → 48
    expect(estimateToScore(4.5)).toBe(63); // midpoint of 55 and 70 → 62.5 → 63
  });
  it('extrapolates below the first anchor and clamps at 0', () => {
    expect(estimateToScore(2)).toBe(25); // 40 − 15
    expect(estimateToScore(1)).toBe(10);
    expect(estimateToScore(0)).toBe(0); // 40 − 60 = −20 → clamp 0
  });
  it('clamps at 100 above the last anchor', () => {
    expect(estimateToScore(7)).toBe(100);
    expect(estimateToScore(8)).toBe(100);
  });
});
