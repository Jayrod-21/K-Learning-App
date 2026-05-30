/**
 * define service — query-param wiring + 503 surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineEntry } from './define';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defineEntry', () => {
  it('GETs /define/ with ?word=…', async () => {
    const payload = { word: '학교', entries: [] };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(payload);

    const got = await defineEntry('학교');

    expect(spy).toHaveBeenCalledWith('/define/', { params: { word: '학교' } });
    expect(got).toBe(payload);
  });

  it('surfaces 503 krdict_unavailable as a structured ApiError', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('KRDICT tables are not present.', {
        status: 503,
        code: 'krdict_unavailable',
      }),
    );

    await expect(defineEntry('학교')).rejects.toMatchObject({
      status: 503,
      code: 'krdict_unavailable',
    });
  });

  it('rethrows network ApiError', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(defineEntry('hi')).rejects.toMatchObject({ code: 'network' });
  });
});
