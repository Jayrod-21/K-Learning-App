/**
 * ability service — URL construction, envelope unwrap, signal threading,
 * error re-throw (mirrors the diagnostic/stats service test style), plus the
 * θ→score anchor mirror and the θ±se band-edge derivation.
 *
 * The anchor pins below are load-bearing: `thetaToScore` mirrors the
 * server's `estimateToScore` table (scoring.ts), and these tests fail loudly
 * if either side drifts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateBandEdges,
  fetchAbilityEstimate,
  thetaToScore,
  type AbilityEstimate,
} from './ability';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const READY: AbilityEstimate = {
  dimension: 'reading',
  theta: 3.5,
  se: 0.5,
  band: 'L3',
  score: 48, // server-realistic: estimateToScore rounds to an integer
  n: 12,
  nUsed: 10,
  effN: 8.2,
  lastEvidenceAt: '2026-08-10T09:00:00.000Z',
  insufficient: false,
  estimatorVersion: 'eap-1pl-1.0',
  rubricVersion: 'r1',
};

const INSUFFICIENT: AbilityEstimate = {
  dimension: 'listening',
  theta: null,
  se: null,
  band: null,
  score: null,
  n: 2,
  nUsed: 1,
  effN: 0.8,
  lastEvidenceAt: null,
  insufficient: true,
  estimatorVersion: 'eap-1pl-1.0',
  rubricVersion: 'r1',
};

describe('fetchAbilityEstimate', () => {
  it('GETs /ability/estimate and unwraps the estimates envelope', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ estimates: [READY, INSUFFICIENT] });

    const res = await fetchAbilityEstimate();

    expect(spy).toHaveBeenCalledWith('/ability/estimate', undefined);
    expect(res).toHaveLength(2);
    expect(res[0].dimension).toBe('reading');
    expect(res[0].theta).toBe(3.5);
  });

  it('passes an insufficient estimate through unchanged (all-null numerics)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ estimates: [INSUFFICIENT] });

    const res = await fetchAbilityEstimate();

    expect(res[0].insufficient).toBe(true);
    expect(res[0].theta).toBeNull();
    expect(res[0].se).toBeNull();
    expect(res[0].band).toBeNull();
    expect(res[0].score).toBeNull();
    expect(res[0].lastEvidenceAt).toBeNull();
  });

  it('passes through an empty estimates list', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ estimates: [] });

    await expect(fetchAbilityEstimate()).resolves.toEqual([]);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ estimates: [READY] });
    const ctrl = new AbortController();

    await fetchAbilityEstimate(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/ability/estimate', {
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchAbilityEstimate()).rejects.toMatchObject({
      status: 500,
      code: 'server_error',
    });
  });
});

describe('thetaToScore (server anchor-table mirror)', () => {
  it('pins every anchor of the server scoring table', () => {
    // [θ, score] pairs from server/src/services/diagnostic/scoring.ts —
    // drift on either side fails here.
    expect(thetaToScore(1)).toBe(10);
    expect(thetaToScore(2)).toBe(25);
    expect(thetaToScore(3)).toBe(40);
    expect(thetaToScore(4)).toBe(55);
    expect(thetaToScore(5)).toBe(70);
    expect(thetaToScore(6)).toBe(85);
    expect(thetaToScore(7)).toBe(100);
  });

  it('interpolates linearly between anchors, rounded to an INTEGER like the server', () => {
    // 47.5 → 48: the server's clampScore Math.rounds, and the mirror must
    // agree so a client-derived edge never disagrees with a wire score.
    expect(thetaToScore(3.5)).toBe(48);
    expect(thetaToScore(4.2)).toBe(58);
  });

  it('extrapolates below the first anchor on the first segment slope, clamped at 0', () => {
    // 10 + 15·(−0.5) = 2.5 → Math.round → 3 (server parity).
    expect(thetaToScore(0.5)).toBe(3);
    // 10 + 15·(−1) = −5 → clamps to 0.
    expect(thetaToScore(0)).toBe(0);
  });

  it('clamps above the table at 100', () => {
    expect(thetaToScore(8)).toBe(100);
  });

  it('is monotone non-decreasing and integer-valued across the whole grid', () => {
    let prev = -Infinity;
    for (let theta = 0; theta <= 8; theta += 0.1) {
      const score = thetaToScore(theta);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });
});

describe('estimateBandEdges', () => {
  it('derives the band from θ±se through the anchor map (low < score < high)', () => {
    const edges = estimateBandEdges(3.5, 0.5);
    expect(edges).toEqual({ scoreLow: 40, scoreHigh: 55 });
    // The point score sits inside its own band.
    expect(thetaToScore(3.5)).toBeGreaterThan(edges?.scoreLow ?? Infinity);
    expect(thetaToScore(3.5)).toBeLessThan(edges?.scoreHigh ?? -Infinity);
  });

  it('collapses to a degenerate (invisible) band when se is 0', () => {
    // SkillBar treats low === high as "no band" — the honest zero-width case.
    expect(estimateBandEdges(4, 0)).toEqual({ scoreLow: 55, scoreHigh: 55 });
  });

  it('clamps θ±se into [1, 6] before mapping, so extremes cap at the measurable 10–85', () => {
    // θ+se = 9 clamps to θ=6 → 85, NOT 100: the estimator cannot measure
    // "Native", so the band-high must not paint it (server clampEstimate
    // parity).
    const edges = estimateBandEdges(6, 3);
    expect(edges?.scoreLow).toBe(40);
    expect(edges?.scoreHigh).toBe(85);
    // θ−se = −1 clamps to θ=1 → 10, the scale floor's anchor.
    const low = estimateBandEdges(1, 2);
    expect(low?.scoreLow).toBe(10);
  });

  it('returns null when theta or se is null (insufficient estimate)', () => {
    expect(estimateBandEdges(null, 0.5)).toBeNull();
    expect(estimateBandEdges(3.5, null)).toBeNull();
    expect(estimateBandEdges(null, null)).toBeNull();
  });
});
