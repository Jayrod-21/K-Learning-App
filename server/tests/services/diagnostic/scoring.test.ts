/**
 * Unit tests for the diagnostic scoring helpers (pure math).
 */
import { describe, expect, it } from 'vitest';
import {
  RUBRIC_VERSION,
  estimateForDimension,
  estimateToScore,
  estimatesByDimension,
  type ScoredResponse,
} from '../../../src/services/diagnostic/scoring.js';

describe('RUBRIC_VERSION', () => {
  it('matches the diagnostic_snapshots semver CHECK', () => {
    expect(RUBRIC_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});

describe('estimateForDimension', () => {
  it('returns null for an empty pool (no items served)', () => {
    expect(estimateForDimension([])).toBeNull();
  });
  it('both correct → base + 0.5', () => {
    const resp: ScoredResponse[] = [
      { section: 'reading', difficulty: 4, isCorrect: true },
      { section: 'reading', difficulty: 4, isCorrect: true },
    ];
    expect(estimateForDimension(resp)).toBeCloseTo(4.5);
  });
  it('one correct → base (mean difficulty)', () => {
    const resp: ScoredResponse[] = [
      { section: 'vocab', difficulty: 4, isCorrect: true },
      { section: 'vocab', difficulty: 5, isCorrect: false },
    ];
    expect(estimateForDimension(resp)).toBeCloseTo(4.5);
  });
  it('none correct → base − 1.0', () => {
    const resp: ScoredResponse[] = [
      { section: 'grammar', difficulty: 4, isCorrect: false },
      { section: 'grammar', difficulty: 4, isCorrect: false },
    ];
    expect(estimateForDimension(resp)).toBeCloseTo(3.0);
  });
  it('clamps to [1, 6]', () => {
    const high: ScoredResponse[] = [{ section: 'reading', difficulty: 6, isCorrect: true }];
    expect(estimateForDimension(high)).toBe(6); // 6 + 0.5 → clamp 6
    const low: ScoredResponse[] = [{ section: 'reading', difficulty: 1.5, isCorrect: false }];
    expect(estimateForDimension(low)).toBe(1); // 1.5 − 1.0 = 0.5 → clamp 1
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
    expect(out.reading).toBeCloseTo(4.5);
    expect(out.vocab).toBeCloseTo(2.0); // single none-correct: 3 − 1
    expect(out.listening).toBeNull();
    expect(out.grammar).toBeNull();
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
