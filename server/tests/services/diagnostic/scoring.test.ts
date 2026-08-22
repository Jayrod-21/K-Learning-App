/**
 * Unit tests for the diagnostic scoring helpers (pure math).
 *
 * Rubric v1.1.0 (F-011): per-dimension estimate is a smooth proportion-correct
 * adjustment (every item counts), and each dimension carries an Agresti-Coull
 * confidence band via `dimensionResult`.
 */
import { describe, expect, it } from 'vitest';
import {
  CORE_DIMENSION_ORDER,
  DIMENSION_ORDER,
  RUBRIC_VERSION,
  dimensionResult,
  dimensionResultForEstimate,
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
  it('is bumped to v1.5.0 for the diagnostic-upgrade Phase C per-category ladders', () => {
    expect(RUBRIC_VERSION).toBe('v1.5.0');
  });
});

describe('DIMENSION_ORDER / CORE_DIMENSION_ORDER (diagnostic-upgrade Phase B)', () => {
  it('DIMENSION_ORDER gained writing as its 6th, trailing member (hanja is still 5th)', () => {
    expect(DIMENSION_ORDER).toEqual([
      'reading',
      'listening',
      'vocab',
      'grammar',
      'hanja',
      'writing',
    ]);
  });
  it('CORE_DIMENSION_ORDER stays the original 4 — the F-212 ability/IRT surface', () => {
    // services/ability/{evidence,estimate,recommend}.ts import THIS, not
    // DIMENSION_ORDER — hanja has no IRT calibration and must never reach the
    // ability estimator via this constant; writing is opt-in there
    // (includeWriting) and must ALSO never leak in via this constant (see its
    // doc in scoring.ts).
    expect(CORE_DIMENSION_ORDER).toEqual(['reading', 'listening', 'vocab', 'grammar']);
    expect(CORE_DIMENSION_ORDER).toEqual(DIMENSION_ORDER.slice(0, 4));
    expect(CORE_DIMENSION_ORDER).not.toContain('hanja');
    expect(CORE_DIMENSION_ORDER).not.toContain('writing');
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

  it('behaves at the F-002 floor: an all-wrong L1-difficulty run keeps a sane band', () => {
    // difficulty 1.5 (an L1/L2 mix), all wrong: estimate clamps at 1 → score 10
    // (the new low anchor). The Agresti-Coull band is generic — at the floor it
    // collapses downward onto the clamp edge but keeps its upward tail, the
    // exact mirror of the ceiling case, and never leaves [0, 100].
    const r = dimensionResult(responsesOf(4, 0, 1.5))!;
    expect(r.estimate).toBe(1);
    expect(r.score).toBe(10);
    expect(r.scoreLow).toBe(r.score); // clamp edge — cannot dip below estimate 1
    expect(r.scoreHigh).toBeGreaterThan(r.score); // the uncertainty shows above
    expect(r.scoreLow).toBeGreaterThanOrEqual(0);
    expect(r.scoreHigh).toBeLessThanOrEqual(100);
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

describe('dimensionResultForEstimate (diagnostic-upgrade Phase C / v1.5.0)', () => {
  it('returns null for a zero-item dimension (same contract as dimensionResult)', () => {
    expect(dimensionResultForEstimate([], 3)).toBeNull();
  });

  it('uses the SUPPLIED estimate, not one derived from difficulty/p', () => {
    // responsesOf(4, 4) at difficulty 4 would derive estimateForDimension →
    // 4.75 — pass a totally different ladder θ (2.3) and confirm THAT wins.
    const r = dimensionResultForEstimate(responsesOf(4, 4), 2.3)!;
    expect(r.estimate).toBe(2.3);
    expect(r.score).toBe(estimateToScore(2.3));
  });

  it('clamps the supplied estimate to [1, 6]', () => {
    expect(dimensionResultForEstimate(responsesOf(2, 1), 8)!.estimate).toBe(6);
    expect(dimensionResultForEstimate(responsesOf(2, 1), 0)!.estimate).toBe(1);
  });

  it('band WIDTH matches dimensionResult exactly (same n/k math, different anchor)', () => {
    // Same n/k as a dimensionResult case, but centered on a different
    // estimate — the margin (scoreHigh − score, score − scoreLow in θ terms)
    // should be identical; only the anchor point moves.
    const viaEstimateForDimension = dimensionResult(responsesOf(4, 4))!;
    const viaSuppliedEstimate = dimensionResultForEstimate(
      responsesOf(4, 4),
      viaEstimateForDimension.estimate,
    )!;
    expect(viaSuppliedEstimate.scoreLow).toBe(viaEstimateForDimension.scoreLow);
    expect(viaSuppliedEstimate.scoreHigh).toBe(viaEstimateForDimension.scoreHigh);
    expect(viaSuppliedEstimate.score).toBe(viaEstimateForDimension.score);
    expect(viaSuppliedEstimate.n).toBe(viaEstimateForDimension.n);
  });

  it('keeps scoreLow ≤ score ≤ scoreHigh, all within [0, 100], across a range of supplied estimates', () => {
    for (const n of [1, 2, 4]) {
      for (let k = 0; k <= n; k += 1) {
        for (const estimate of [1, 2.4, 3.7, 5, 6]) {
          const r = dimensionResultForEstimate(responsesOf(n, k), estimate)!;
          expect(r.scoreLow).toBeLessThanOrEqual(r.score);
          expect(r.score).toBeLessThanOrEqual(r.scoreHigh);
          expect(r.scoreLow).toBeGreaterThanOrEqual(0);
          expect(r.scoreHigh).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe('estimateToScore', () => {
  it('hits the anchor points, including the F-002 low anchors', () => {
    expect(estimateToScore(1)).toBe(10); // L1 — ANCHORED, not extrapolated
    expect(estimateToScore(2)).toBe(25); // L2 — ANCHORED, not extrapolated
    expect(estimateToScore(3)).toBe(40);
    expect(estimateToScore(4)).toBe(55);
    expect(estimateToScore(5)).toBe(70);
    expect(estimateToScore(6)).toBe(85);
  });
  it('interpolates between anchors', () => {
    expect(estimateToScore(1.5)).toBe(18); // midpoint of 10 and 25 → 17.5 → 18
    expect(estimateToScore(3.5)).toBe(48); // midpoint of 40 and 55 → 47.5 → 48
    expect(estimateToScore(4.5)).toBe(63); // midpoint of 55 and 70 → 62.5 → 63
  });
  it('extrapolates below the first anchor and clamps at 0', () => {
    expect(estimateToScore(0.5)).toBe(3); // 10 − 7.5 → 2.5 → round 3
    expect(estimateToScore(0)).toBe(0); // 10 − 15 = −5 → clamp 0
  });
  it('clamps at 100 above the last anchor', () => {
    expect(estimateToScore(7)).toBe(100);
    expect(estimateToScore(8)).toBe(100);
  });
  it('is monotonic non-decreasing and within [0, 100] across the whole range', () => {
    // All segment slopes are positive and Math.round is monotone, so the
    // rounded curve must never decrease anywhere — including across the new
    // low-anchor joins at 1 and 2.
    let prev = estimateToScore(0);
    for (let est = 0.05; est <= 7.5; est += 0.05) {
      const score = estimateToScore(est);
      expect(score).toBeGreaterThanOrEqual(prev);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      prev = score;
    }
    // Strict increase across the anchor points themselves.
    const anchorScores = [1, 2, 3, 4, 5, 6, 7].map(estimateToScore);
    for (let i = 1; i < anchorScores.length; i += 1) {
      expect(anchorScores[i]!).toBeGreaterThan(anchorScores[i - 1]!);
    }
  });
});
