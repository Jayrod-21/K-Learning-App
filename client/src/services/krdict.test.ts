/**
 * krdict service — search param wiring + pagination + 503 surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchKrdict } from './krdict';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchKrdict', () => {
  it('GETs /krdict/search with q + pagination params', async () => {
    const payload = { entries: [], total: 0 };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(payload);

    const got = await searchKrdict({ q: '학교', limit: 30, offset: 30 });

    expect(spy).toHaveBeenCalledWith('/krdict/search', {
      params: { q: '학교', limit: 30, offset: 30 },
    });
    expect(got).toBe(payload);
  });

  it('omits undefined limit/offset', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ entries: [], total: 0 });

    await searchKrdict({ q: '밥' });

    expect(spy).toHaveBeenCalledWith('/krdict/search', { params: { q: '밥' } });
  });

  it('forwards an abort signal', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ entries: [], total: 0 });
    const ctrl = new AbortController();

    await searchKrdict({ q: '물' }, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/krdict/search', {
      params: { q: '물' },
      signal: ctrl.signal,
    });
  });

  it('surfaces a 503 krdict_unavailable ApiError', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('KRDICT tables are not present.', {
        status: 503,
        code: 'krdict_unavailable',
      }),
    );

    await expect(searchKrdict({ q: '학교' })).rejects.toMatchObject({
      status: 503,
    });
  });
});
