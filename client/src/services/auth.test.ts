/**
 * auth service — happy path + error normalisation.
 *
 * Mocking strategy: stub the `api` re-export from `./api`. We deliberately
 * don't touch axios internals; the api layer already has its own coverage
 * for AxiosError → ApiError. Here we only need to verify that the service
 * builds the right URL, passes the right body, and unwraps `{ user }`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMe,
  fetchMfaStatus,
  login,
  loginTotp,
  mfaConfirm,
  mfaEnroll,
  patchMe,
  regenerateRecoveryCodes,
} from './auth';
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

// ── TOTP 2FA login flow (PASS LOGIN — PART C1 / C7) ───────────────────────

describe('login (discriminated result)', () => {
  it('POSTs /auth/login and returns the authenticated shape', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'authenticated',
      user: { id: 1, email: 'jay@example.com' },
    });

    const result = await login('jay@example.com', 'pw');

    expect(spy).toHaveBeenCalledWith('/auth/login', {
      email: 'jay@example.com',
      password: 'pw',
    });
    expect(result).toEqual({
      status: 'authenticated',
      user: { id: 1, email: 'jay@example.com' },
    });
  });

  it('translates the mfa_required shape to camelCase', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'mfa_required',
      challenge_token: 'tok-abc',
      expires_in: 300,
    });

    const result = await login('jay@example.com', 'pw');

    expect(result).toEqual({
      status: 'mfa_required',
      challengeToken: 'tok-abc',
      expiresIn: 300,
    });
  });

  it('translates the enrollment_required shape to camelCase', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'enrollment_required',
      challenge_token: 'tok-enr',
      expires_in: 300,
    });

    const result = await login('jay@example.com', 'pw');

    expect(result).toEqual({
      status: 'enrollment_required',
      challengeToken: 'tok-enr',
      expiresIn: 300,
    });
  });

  it('rethrows ApiError unchanged (401 invalid credentials)', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('bad creds', { status: 401, code: 'invalid_credentials' }),
    );

    await expect(login('x@y.z', 'pw')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
  });
});

describe('loginTotp', () => {
  it('POSTs the challenge token + code and unwraps the user', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'authenticated',
      user: { id: 1, email: 'jay@example.com' },
    });

    const { user } = await loginTotp('tok-abc', '123456');

    expect(spy).toHaveBeenCalledWith('/auth/login/totp', {
      challenge_token: 'tok-abc',
      code: '123456',
    });
    expect(user).toEqual({ id: 1, email: 'jay@example.com' });
  });

  it('rethrows ApiError unchanged (invalid_code)', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('nope', { status: 401, code: 'invalid_code' }),
    );

    await expect(loginTotp('tok', '000000')).rejects.toMatchObject({
      code: 'invalid_code',
    });
  });
});

describe('mfaEnroll', () => {
  it('builds the challenge-token body and maps the URI/secret', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      otpauth_uri: 'otpauth://totp/x?secret=ABC',
      secret: 'ABC',
    });

    const result = await mfaEnroll({ challengeToken: 'tok-enr' });

    expect(spy).toHaveBeenCalledWith('/auth/mfa/enroll', {
      challenge_token: 'tok-enr',
    });
    expect(result).toEqual({
      otpauthUri: 'otpauth://totp/x?secret=ABC',
      secret: 'ABC',
    });
  });

  it('builds the password body for the Settings re-enroll leg', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      otpauth_uri: 'otpauth://totp/x?secret=DEF',
      secret: 'DEF',
    });

    await mfaEnroll({ password: 'hunter2hunter2' });

    expect(spy).toHaveBeenCalledWith('/auth/mfa/enroll', {
      password: 'hunter2hunter2',
    });
  });
});

describe('mfaConfirm', () => {
  it('challenge leg: sends challenge_token + code, returns user + codes', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'authenticated',
      user: { id: 1, email: 'jay@example.com' },
      recovery_codes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'],
    });

    const result = await mfaConfirm({ challengeToken: 'tok', code: '123456' });

    expect(spy).toHaveBeenCalledWith('/auth/mfa/confirm', {
      code: '123456',
      challenge_token: 'tok',
    });
    expect(result).toEqual({
      user: { id: 1, email: 'jay@example.com' },
      recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'],
    });
  });

  it('session leg: sends password + code, omits user when absent', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'updated',
      recovery_codes: ['EEEEE-FFFFF'],
    });

    const result = await mfaConfirm({ password: 'pw', code: '654321' });

    expect(spy).toHaveBeenCalledWith('/auth/mfa/confirm', {
      code: '654321',
      password: 'pw',
    });
    expect(result).toEqual({ recoveryCodes: ['EEEEE-FFFFF'] });
    expect(result.user).toBeUndefined();
  });

  it('rethrows ApiError unchanged on a bad confirm code', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('bad', { status: 400, code: 'invalid_code' }),
    );

    await expect(
      mfaConfirm({ challengeToken: 'tok', code: '000000' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_code' });
  });
});

describe('regenerateRecoveryCodes', () => {
  it('POSTs the password and unwraps the fresh codes', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      recovery_codes: ['GGGGG-HHHHH'],
    });

    const result = await regenerateRecoveryCodes('pw');

    expect(spy).toHaveBeenCalledWith('/auth/mfa/recovery-codes/regenerate', {
      password: 'pw',
    });
    expect(result).toEqual({ recoveryCodes: ['GGGGG-HHHHH'] });
  });
});

describe('fetchMfaStatus', () => {
  it('GETs /auth/mfa/status and maps to camelCase', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      enabled: true,
      recovery_codes_remaining: 7,
    });

    const status = await fetchMfaStatus();

    expect(spy).toHaveBeenCalledWith('/auth/mfa/status', undefined);
    expect(status).toEqual({ enabled: true, recoveryCodesRemaining: 7 });
  });

  it('rethrows ApiError unchanged (401)', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('no session', { status: 401, code: 'unauthenticated' }),
    );

    await expect(fetchMfaStatus()).rejects.toMatchObject({ status: 401 });
  });
});
