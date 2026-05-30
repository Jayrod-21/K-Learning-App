/**
 * grammarDrill service — generate/submit URL/body wiring + error surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateDrill,
  submitDrill,
  type DrillScore,
  type GeneratedDrill,
} from './grammarDrill';
import { api, ApiError } from './api';
import type { DrillItemPublic } from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

const ITEM: DrillItemPublic = {
  type: 'transformation',
  patternKey: 'KGIU-INT-007',
  patternDisplay: '-더라도',
  instruction: 'Rewrite using -더라도.',
  sourceKr: '비가 와요.',
  sourceEn: "It's raining.",
};

const GENERATED: GeneratedDrill = { attemptId: 12, item: ITEM };

const SCORE: DrillScore = {
  score: 82,
  verdict: 'good',
  usesPattern: true,
  summary: 'Reads natural.',
  corrections: [],
  referenceModelKr: '비가 오더라도 갈 거예요.',
  referenceModelEn: "Even if it rains, we'll go.",
};

describe('generateDrill', () => {
  it('POSTs /grammar-drill with the body and returns the envelope', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(GENERATED);
    const body = {
      patternKey: 'KGIU-INT-007',
      patternDisplay: '-더라도',
      meaning: 'even if',
    };

    const out = await generateDrill(body);

    // The generate leg wraps Claude, so it MUST override the 10s axios default
    // (api.ts) — a cold start otherwise mis-fires as `code: 'timeout'` and drops
    // the screen into a mock fallback. Pin the override on the no-signal path.
    expect(spy).toHaveBeenCalledWith('/grammar-drill', body, {
      timeout: 30_000,
    });
    expect(out.attemptId).toBe(12);
    expect(out.item.type).toBe('transformation');
  });

  it('forwards the abort signal alongside the Claude timeout override', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(GENERATED);
    const ctrl = new AbortController();
    const body = { patternKey: 'k', patternDisplay: 'p' };

    await generateDrill(body, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/grammar-drill', body, {
      timeout: 30_000,
      signal: ctrl.signal,
    });
  });

  it('surfaces a 502 Claude failure as ApiError', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('upstream', { status: 502, code: 'upstream' }),
    );

    await expect(
      generateDrill({ patternKey: 'k', patternDisplay: 'p' }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('submitDrill', () => {
  it('POSTs /grammar-drill/:id/submit with the answer', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(SCORE);

    const out = await submitDrill(12, '비가 오더라도 갈 거예요.');

    // Submit also wraps Claude (scoring) — same timeout override as generate so
    // a >10s in-flight score never surfaces a phantom "scoring failed" whose
    // Retry would then 409 an already-scored attempt.
    expect(spy).toHaveBeenCalledWith(
      '/grammar-drill/12/submit',
      { answer: '비가 오더라도 갈 거예요.' },
      { timeout: 30_000 },
    );
    expect(out.score).toBe(82);
    expect(out.referenceModelKr).toContain('더라도');
  });

  it('forwards the abort signal alongside the Claude timeout override', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(SCORE);
    const ctrl = new AbortController();

    await submitDrill(7, 'x', ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/grammar-drill/7/submit',
      { answer: 'x' },
      { timeout: 30_000, signal: ctrl.signal },
    );
  });

  it('surfaces a 404 (wrong owner / not found) as ApiError', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    await expect(submitDrill(99, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('surfaces a 409 (already scored) as ApiError', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('already scored', { status: 409, code: 'conflict' }),
    );

    await expect(submitDrill(12, 'x')).rejects.toMatchObject({ status: 409 });
  });
});
