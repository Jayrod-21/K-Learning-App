/**
 * reading service — URL + query construction + envelope unwrap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSentences, fetchUnits, fetchUnitsPage } from './reading';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchUnitsPage', () => {
  it('GETs /reading/units with corpus and pagination, returning the page', async () => {
    const page = {
      corpus: 'ttmik' as const,
      total: 137,
      units: [{ id: 1, title: 'L1U1', lesson_level: 1, lesson_number: 1 }],
    };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(page);

    const got = await fetchUnitsPage({ corpus: 'ttmik', limit: 5, offset: 10 });

    expect(spy).toHaveBeenCalledWith('/reading/units', {
      params: { corpus: 'ttmik', limit: 5, offset: 10 },
    });
    expect(got).toBe(page);
    expect(got.total).toBe(137);
    expect(got.units).toHaveLength(1);
  });

  it('omits limit/offset when undefined', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ corpus: 'iyagi', total: 0, units: [] });

    await fetchUnitsPage({ corpus: 'iyagi' });

    expect(spy).toHaveBeenCalledWith('/reading/units', {
      params: { corpus: 'iyagi' },
    });
  });

  it('rethrows ApiError on a failed request', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    await expect(fetchUnitsPage({ corpus: 'ttmik' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('fetchUnits', () => {
  it('unwraps the page envelope to just the unit rows', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      corpus: 'ttmik',
      total: 1,
      units: [{ id: 1, title: 'L1U1', lesson_level: 1, lesson_number: 1 }],
    });

    const units = await fetchUnits({ corpus: 'ttmik', limit: 5, offset: 10 });

    expect(spy).toHaveBeenCalledWith('/reading/units', {
      params: { corpus: 'ttmik', limit: 5, offset: 10 },
    });
    expect(units).toHaveLength(1);
    expect(units[0]?.title).toBe('L1U1');
  });

  it('surfaces ApiError(404) when the request fails', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    await expect(fetchUnits({ corpus: 'ttmik' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('fetchSentences', () => {
  it('constructs /reading/units/:corpus/:unitId/sentences correctly', async () => {
    const payload = { corpus: 'ttmik' as const, unit_id: 42, sentences: [] };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(payload);

    const got = await fetchSentences('ttmik', 42);

    expect(spy).toHaveBeenCalledWith('/reading/units/ttmik/42/sentences');
    expect(got).toBe(payload);
  });

  it('rethrows ApiError on network failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(fetchSentences('iyagi', 1)).rejects.toMatchObject({
      code: 'network',
    });
  });
});
