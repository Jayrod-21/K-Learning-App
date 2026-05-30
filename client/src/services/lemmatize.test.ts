/**
 * lemmatize service — POST body shape + tokens unwrap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lemmatize } from './lemmatize';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lemmatize', () => {
  it('POSTs /lemmatize with { text } and returns the tokens array', async () => {
    const tokens = [
      { form: '안녕', lemma: '안녕', tag: 'NNG', start: 0, length: 2 },
    ];
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ tokens });

    const got = await lemmatize('안녕하세요');

    expect(spy).toHaveBeenCalledWith('/lemmatize', { text: '안녕하세요' }, undefined);
    expect(got).toBe(tokens);
  });

  it('rethrows ApiError(400) when the server rejects the input', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('text required', { status: 400, code: 'validation' }),
    );

    await expect(lemmatize('')).rejects.toMatchObject({
      status: 400,
      code: 'validation',
    });
  });

  it('rethrows ApiError(0, network) when the server is unreachable', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(lemmatize('hi')).rejects.toMatchObject({
      code: 'network',
    });
  });
});
