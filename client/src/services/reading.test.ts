/**
 * reading service — URL + query construction + envelope unwrap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSentences, fetchUnits } from './reading';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchUnits', () => {
  it('GETs /reading/units with corpus and pagination', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      units: [{ id: 1, title: 'L1U1', lesson_level: 1, lesson_number: 1 }],
    });

    const units = await fetchUnits({ corpus: 'ttmik', limit: 5, offset: 10 });

    expect(spy).toHaveBeenCalledWith('/reading/units', {
      params: { corpus: 'ttmik', limit: 5, offset: 10 },
    });
    expect(units).toHaveLength(1);
    expect(units[0]?.title).toBe('L1U1');
  });

  it('omits limit/offset when undefined', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ units: [] });

    await fetchUnits({ corpus: 'iyagi' });

    expect(spy).toHaveBeenCalledWith('/reading/units', {
      params: { corpus: 'iyagi' },
    });
  });

  it('surfaces ApiError(404) when corpus is empty', async () => {
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
