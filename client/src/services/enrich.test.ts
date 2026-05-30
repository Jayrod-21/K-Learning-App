/**
 * enrich service — body shape passed through verbatim.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrich } from './enrich';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enrich', () => {
  it('POSTs /enrich with the full body', async () => {
    const body = {
      lemma: '먹다',
      sourceSentence: '저는 밥을 먹어요.',
      context: 'eating breakfast',
    };
    const payload = { result: { gloss: 'to eat' } };
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(payload);

    const got = await enrich(body);

    expect(spy).toHaveBeenCalledWith('/enrich', body, undefined);
    expect(got).toBe(payload);
  });

  it('surfaces upstream 502 as ApiError', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('claude error', { status: 502, code: 'upstream_error' }),
    );

    await expect(
      enrich({ lemma: 'x', sourceSentence: 'y' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('surfaces timeout', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('request timed out', { status: 0, code: 'timeout' }),
    );

    await expect(
      enrich({ lemma: 'x', sourceSentence: 'y' }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
