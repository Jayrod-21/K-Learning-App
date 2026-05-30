/**
 * auth service — happy path + error normalisation.
 *
 * Mocking strategy: stub the `api` re-export from `./api`. We deliberately
 * don't touch axios internals; the api layer already has its own coverage
 * for AxiosError → ApiError. Here we only need to verify that the service
 * builds the right URL, passes the right body, and unwraps `{ user }`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMe, patchMe } from './auth';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchMe', () => {
  it('GETs /auth/me and unwraps `user`', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({
        user: { id: 1, email: 'jay@example.com' },
      });

    const user = await fetchMe();

    expect(spy).toHaveBeenCalledWith('/auth/me', undefined);
    expect(user).toEqual({ id: 1, email: 'jay@example.com' });
  });

  it('rethrows ApiError unchanged (401 -> caller branches)', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('not signed in', { status: 401, code: 'unauthenticated' }),
    );

    await expect(fetchMe()).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });
});

describe('patchMe', () => {
  it('PATCHes /auth/me with the partial body and returns the user', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValueOnce({
      user: {
        id: 1,
        email: 'jay@example.com',
        display_name: 'Jay',
        phone: '+15555550100',
      },
    });

    const updated = await patchMe({ display_name: 'Jay', expected_version: 1 });

    expect(patchSpy).toHaveBeenCalledWith(
      '/auth/me',
      { display_name: 'Jay', expected_version: 1 },
      undefined,
    );
    expect(updated.display_name).toBe('Jay');
  });

  it('propagates a network ApiError', async () => {
    vi.spyOn(api, 'patch').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(patchMe({ expected_version: 1 })).rejects.toMatchObject({
      status: 0,
      code: 'network',
    });
  });
});
