/**
 * irt — pure anchored-IRT EAP math (F-212 P2). No DB, no clock: every case
 * exercises the estimator's LOCKED contract — known-θ recovery, monotonicity,
 * SE behavior, boundedness at the all-right/all-wrong extremes, the
 * continuous-Bernoulli treatment of graded outcomes, recency weighting, the
 * min-evidence gate, and the Fisher-information cross-check.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESTIMATOR_CONFIG,
  ESTIMATOR_VERSION,
  eapEstimate,
  fisherInfo,
  irf,
  logLikelihood,
  meetsEvidenceGate,
  recencyWeight,
  seFromInfo,
  thetaGrid,
  type EstimatorConfig,
  type LikelihoodItem,
} from '../../../src/services/ability/irt.js';

const cfg = DEFAULT_ESTIMATOR_CONFIG;

/** Items whose outcomes MATCH the IRF at thetaTrue — the maximum-likelihood
 *  point of the continuous-Bernoulli likelihood sits exactly at thetaTrue. */
function matchedItems(
  thetaTrue: number,
  bs: readonly number[],
  weight = 1,
): LikelihoodItem[] {
  return bs.map((b) => ({
    b,
    outcome: irf(thetaTrue, b, cfg.a),
    weight,
    graded: true,
  }));
}

function spread(from: number, to: number, count: number): number[] {
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, i) => from + i * step);
}

describe('locked constants', () => {
  it('pins the Phase-2 configuration and version tag', () => {
    expect(ESTIMATOR_VERSION).toBe('eap-1pl-1.0');
    expect(cfg).toEqual({
      a: 1.0,
      priorMean: 3.5,
      priorSd: 1.5,
      gridMin: 1.0,
      gridMax: 6.0,
      gridStep: 0.1,
      halfLifeDays: 30,
      windowDays: 180,
      minNUsed: 5,
      minEffN: 3,
      gradedDiscount: 1.0,
    });
  });

  it('builds the 51-node grid {1.0, 1.1, …, 6.0}', () => {
    const grid = thetaGrid(cfg);
    expect(grid).toHaveLength(51);
    expect(grid[0]).toBe(1.0);
    expect(grid[50]).toBe(6.0);
    expect(grid[25]).toBeCloseTo(3.5, 9);
    // Uniform step everywhere (multiply-then-add, no drift).
    for (let k = 1; k < grid.length; k += 1) {
      expect(grid[k]! - grid[k - 1]!).toBeCloseTo(0.1, 9);
    }
  });

  it('rejects a degenerate grid', () => {
    expect(() => thetaGrid({ ...cfg, gridStep: 0 })).toThrow(RangeError);
    expect(() => thetaGrid({ ...cfg, gridMax: cfg.gridMin })).toThrow(RangeError);
  });
});

describe('irf', () => {
  it('is 0.5 at θ = b and monotone in θ', () => {
    expect(irf(3.5, 3.5, 1)).toBeCloseTo(0.5, 12);
    expect(irf(4.5, 3.5, 1)).toBeGreaterThan(irf(3.5, 3.5, 1));
    expect(irf(2.5, 3.5, 1)).toBeLessThan(0.5);
    // Symmetric: P(θ, b) + P(2b − θ, b) = 1.
    expect(irf(4.5, 3.5, 1) + irf(2.5, 3.5, 1)).toBeCloseTo(1, 12);
  });
});

describe('EAP — known-θ recovery', () => {
  it('recovers θ from matched evidence within tolerance', () => {
    for (const thetaTrue of [2.0, 3.0, 4.5]) {
      const items = matchedItems(thetaTrue, [
        ...spread(thetaTrue - 1.5, thetaTrue + 1.5, 13),
        ...spread(thetaTrue - 1.5, thetaTrue + 1.5, 13),
      ]);
      const { theta } = eapEstimate(items, cfg);
      // 26 items dominate the N(3.5, 1.5²) prior; small shrinkage remains.
      expect(Math.abs(theta - thetaTrue)).toBeLessThan(0.2);
    }
  });

  it('with no items, the posterior is the grid-truncated prior', () => {
    const { theta, se } = eapEstimate([], cfg);
    expect(theta).toBeCloseTo(cfg.priorMean, 1);
    expect(se).toBeGreaterThan(0);
    expect(se).toBeLessThanOrEqual(cfg.priorSd); // truncation only narrows
    expect(Number.isFinite(se)).toBe(true);
  });
});

describe('EAP — monotonicity', () => {
  it('raising any single outcome never lowers θ̂', () => {
    const bs = spread(2.0, 5.0, 7);
    const base: LikelihoodItem[] = bs.map((b, i) => ({
      b,
      outcome: i % 2 === 0 ? 1 : 0,
      weight: 1,
    }));
    const { theta: thetaBase } = eapEstimate(base, cfg);
    for (let i = 0; i < base.length; i += 1) {
      if (base[i]!.outcome === 1) continue;
      const raised = base.map((item, j) =>
        j === i ? { ...item, outcome: 1 } : item,
      );
      expect(eapEstimate(raised, cfg).theta).toBeGreaterThan(thetaBase);
    }
  });

  it('a graded raise (0.33 → 0.67) also moves θ̂ up', () => {
    const items: LikelihoodItem[] = spread(2.5, 4.5, 6).map((b) => ({
      b,
      outcome: 0.33,
      weight: 1,
      graded: true,
    }));
    const raised = items.map((item) => ({ ...item, outcome: 0.67 }));
    expect(eapEstimate(raised, cfg).theta).toBeGreaterThan(
      eapEstimate(items, cfg).theta,
    );
  });
});

describe('EAP — SE behavior', () => {
  it('SE shrinks as n grows', () => {
    const few = matchedItems(3.5, spread(2.5, 4.5, 5));
    const many = matchedItems(3.5, [
      ...spread(2.5, 4.5, 5),
      ...spread(2.5, 4.5, 5),
      ...spread(2.5, 4.5, 5),
      ...spread(2.5, 4.5, 5),
      ...spread(2.5, 4.5, 5),
    ]);
    const seFew = eapEstimate(few, cfg).se;
    const seMany = eapEstimate(many, cfg).se;
    expect(seMany).toBeLessThan(seFew);
    expect(seFew).toBeLessThan(cfg.priorSd); // any evidence beats the prior alone
  });

  it('down-weighted (aged) evidence widens SE and pulls θ̂ toward the prior', () => {
    const bs = spread(1.5, 2.5, 8);
    const fresh: LikelihoodItem[] = bs.map((b) => ({ b, outcome: 1, weight: 1 }));
    const aged: LikelihoodItem[] = bs.map((b) => ({
      b,
      outcome: 1,
      weight: recencyWeight(120, cfg.halfLifeDays), // 0.5^4 = 0.0625
    }));
    const freshResult = eapEstimate(fresh, cfg);
    const agedResult = eapEstimate(aged, cfg);
    expect(agedResult.se).toBeGreaterThan(freshResult.se);
    expect(Math.abs(agedResult.theta - cfg.priorMean)).toBeLessThan(
      Math.abs(freshResult.theta - cfg.priorMean),
    );
  });
});

describe('EAP — boundedness at the extremes', () => {
  it('all-right stays finite and inside [1, 6]', () => {
    const items: LikelihoodItem[] = spread(2.5, 4.5, 10).map((b) => ({
      b,
      outcome: 1,
      weight: 1,
    }));
    const { theta, se } = eapEstimate(items, cfg);
    expect(Number.isFinite(theta)).toBe(true);
    expect(Number.isFinite(se)).toBe(true);
    expect(theta).toBeGreaterThan(cfg.priorMean); // pulled up, not exploded
    expect(theta).toBeGreaterThanOrEqual(cfg.gridMin);
    expect(theta).toBeLessThanOrEqual(cfg.gridMax);
    expect(se).toBeGreaterThan(0);
  });

  it('all-wrong stays finite and inside [1, 6]', () => {
    const items: LikelihoodItem[] = spread(2.5, 4.5, 10).map((b) => ({
      b,
      outcome: 0,
      weight: 1,
    }));
    const { theta, se } = eapEstimate(items, cfg);
    expect(Number.isFinite(theta)).toBe(true);
    expect(Number.isFinite(se)).toBe(true);
    expect(theta).toBeLessThan(cfg.priorMean);
    expect(theta).toBeGreaterThanOrEqual(cfg.gridMin);
    expect(theta).toBeLessThanOrEqual(cfg.gridMax);
    expect(se).toBeGreaterThan(0);
  });
});

describe('continuous-Bernoulli outcomes', () => {
  it('all-0.67 lands between all-0 and all-1, near b + logit(0.67)/a', () => {
    const bs = Array.from({ length: 30 }, () => 3.5);
    const at = (outcome: number): number =>
      eapEstimate(
        bs.map((b) => ({ b, outcome, weight: 1, graded: outcome % 1 !== 0 })),
        cfg,
      ).theta;
    const low = at(0);
    const mid = at(0.67);
    const high = at(1);
    expect(mid).toBeGreaterThan(low);
    expect(mid).toBeLessThan(high);
    // ML point = b + logit(0.67)/a = 3.5 + ln(0.67/0.33) ≈ 4.208; 30 items
    // leave only mild prior shrinkage toward 3.5.
    const expected = 3.5 + Math.log(0.67 / 0.33) / cfg.a;
    expect(Math.abs(mid - expected)).toBeLessThan(0.15);
  });

  it('binary outcomes reduce to the exact Rasch log-likelihood', () => {
    const item: LikelihoodItem = { b: 3.0, outcome: 1, weight: 0.8 };
    const theta = 4.0;
    const p = irf(theta, item.b, cfg.a);
    expect(logLikelihood(theta, [item], cfg)).toBeCloseTo(0.8 * Math.log(p), 12);
    const miss: LikelihoodItem = { ...item, outcome: 0 };
    expect(logLikelihood(theta, [miss], cfg)).toBeCloseTo(
      0.8 * Math.log(1 - p),
      12,
    );
  });

  it('ℓ is linear in the outcome (partial credit interpolates, never dichotomizes)', () => {
    const base = { b: 3.0, weight: 1 };
    const theta = 3.7;
    const llAt = (outcome: number): number =>
      logLikelihood(theta, [{ ...base, outcome }], cfg);
    expect(llAt(0.5)).toBeCloseTo((llAt(0) + llAt(1)) / 2, 12);
  });

  it('clamps P before ln so extreme θ−b gaps never produce NaN/−∞ weights', () => {
    // b far outside the grid with a huge |θ−b| would hit ln(0) unclamped.
    const items: LikelihoodItem[] = [{ b: 100, outcome: 1, weight: 1 }];
    const { theta, se } = eapEstimate(items, cfg);
    expect(Number.isFinite(theta)).toBe(true);
    expect(Number.isFinite(se)).toBe(true);
  });
});

describe('recencyWeight', () => {
  it('halves every half-life and is 1 at age 0', () => {
    expect(recencyWeight(0, 30)).toBe(1);
    expect(recencyWeight(30, 30)).toBeCloseTo(0.5, 12);
    expect(recencyWeight(60, 30)).toBeCloseTo(0.25, 12);
    expect(recencyWeight(90, 30)).toBeCloseTo(0.125, 12);
  });

  it('clamps future (negative-age) evidence at weight 1', () => {
    expect(recencyWeight(-5, 30)).toBe(1);
  });

  it('rejects a non-finite age', () => {
    expect(() => recencyWeight(Number.NaN, 30)).toThrow(RangeError);
    expect(() => recencyWeight(Infinity, 30)).toThrow(RangeError);
  });
});

describe('min-evidence gate', () => {
  it('requires BOTH nUsed ≥ 5 and effN ≥ 3', () => {
    expect(meetsEvidenceGate(5, 3, cfg)).toBe(true);
    expect(meetsEvidenceGate(10, 8.2, cfg)).toBe(true);
    expect(meetsEvidenceGate(4, 10, cfg)).toBe(false); // nUsed short
    expect(meetsEvidenceGate(5, 2.99, cfg)).toBe(false); // effN short
    expect(meetsEvidenceGate(0, 0, cfg)).toBe(false);
  });
});

describe('Fisher-information cross-check', () => {
  it('EAP posterior SD ≈ 1/√(I + I₀) in the well-identified regime', () => {
    // θtrue at the prior mean, informative items straddling it: the posterior
    // is near-Gaussian, where the closed form is exact.
    const items = matchedItems(3.5, [
      ...spread(2.5, 4.5, 20),
      ...spread(2.5, 4.5, 20),
    ]);
    const eap = eapEstimate(items, cfg);
    const approx = seFromInfo(fisherInfo(eap.theta, items, cfg), cfg.priorSd);
    expect(Math.abs(eap.se - approx) / approx).toBeLessThan(0.15);
  });

  it('info sums w·a²·P(1−P) over items', () => {
    const items: LikelihoodItem[] = [
      { b: 3.0, outcome: 1, weight: 0.5 },
      { b: 4.0, outcome: 0, weight: 1 },
    ];
    const theta = 3.5;
    const expected = items.reduce((sum, item) => {
      const p = irf(theta, item.b, cfg.a);
      return sum + item.weight * cfg.a * cfg.a * p * (1 - p);
    }, 0);
    expect(fisherInfo(theta, items, cfg)).toBeCloseTo(expected, 12);
  });
});

describe('graded-discount seam (κ)', () => {
  it('κ = 1 (locked) leaves graded items at full weight', () => {
    const graded: LikelihoodItem[] = [{ b: 3.0, outcome: 0.67, weight: 1, graded: true }];
    const plain: LikelihoodItem[] = [{ b: 3.0, outcome: 0.67, weight: 1 }];
    expect(logLikelihood(3.5, graded, cfg)).toBeCloseTo(
      logLikelihood(3.5, plain, cfg),
      12,
    );
  });

  it('κ < 1 discounts ONLY graded items in likelihood and info', () => {
    const discounted: EstimatorConfig = { ...cfg, gradedDiscount: 0.5 };
    const graded: LikelihoodItem[] = [{ b: 3.0, outcome: 0.67, weight: 1, graded: true }];
    const binary: LikelihoodItem[] = [{ b: 3.0, outcome: 1, weight: 1 }];
    expect(logLikelihood(3.5, graded, discounted)).toBeCloseTo(
      0.5 * logLikelihood(3.5, graded, cfg),
      12,
    );
    expect(fisherInfo(3.5, graded, discounted)).toBeCloseTo(
      0.5 * fisherInfo(3.5, graded, cfg),
      12,
    );
    // Binary evidence is untouched by κ.
    expect(logLikelihood(3.5, binary, discounted)).toBeCloseTo(
      logLikelihood(3.5, binary, cfg),
      12,
    );
  });
});
