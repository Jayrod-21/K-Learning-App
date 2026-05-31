/**
 * AuthProvider — initial probe + `refresh()` re-probe behaviour.
 *
 * Mocks `services/api`'s `api.get` so we control the `/auth/me` response.
 * The Pass 3 addition under test is `refresh()` on the context value:
 * calling it must rerun the probe and update the cached `user`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { api, ApiError } from '../services/api';

// AuthProvider now drives the 2FA flow through the `services/auth` wrappers.
// Stub them so the tests control each leg without hitting the api layer; the
// `/auth/me` probe still goes through `api.get` (mocked per test).
const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
  loginTotp: vi.fn(),
  mfaEnroll: vi.fn(),
  mfaConfirm: vi.fn(),
}));

vi.mock('../services/auth', () => ({
  login: authMocks.login,
  loginTotp: authMocks.loginTotp,
  mfaEnroll: authMocks.mfaEnroll,
  mfaConfirm: authMocks.mfaConfirm,
}));

import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';

beforeEach(() => {
  vi.restoreAllMocks();
  authMocks.login.mockReset();
  authMocks.loginTotp.mockReset();
  authMocks.mfaEnroll.mockReset();
  authMocks.mfaConfirm.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Read auth state into the DOM so RTL assertions can observe it.
 * Exposes a button that calls `refresh()` so tests can drive the new
 * Pass-3 API surface.
 */
function Probe(): JSX.Element {
  const auth = useAuth();
  return (
    <div>
      <div data-testid="status">{auth.status}</div>
      <div data-testid="email">{auth.user?.email ?? ''}</div>
      <div data-testid="display_name">{auth.user?.display_name ?? ''}</div>
      <button
        type="button"
        onClick={() => {
          void auth.refresh();
        }}
      >
        refresh
      </button>
    </div>
  );
}

describe('AuthProvider — initial probe', () => {
  it('hydrates from GET /auth/me on mount', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      user: { id: 1, email: 'jay@example.com', display_name: 'Jay' },
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
    expect(screen.getByTestId('email')).toHaveTextContent('jay@example.com');
    expect(screen.getByTestId('display_name')).toHaveTextContent('Jay');
  });

  it('lands as guest on 401', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('no session', { status: 401, code: 'unauthenticated' }),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });
  });
});

describe('AuthProvider.refresh()', () => {
  it('re-runs the probe and reflects the new user', async () => {
    const getSpy = vi
      .spyOn(api, 'get')
      // Initial mount probe.
      .mockResolvedValueOnce({
        user: { id: 1, email: 'jay@example.com', display_name: 'Jay' },
      })
      // refresh() call.
      .mockResolvedValueOnce({
        user: {
          id: 1,
          email: 'jay@example.com',
          display_name: 'Jared',
          phone: '+15555550100',
        },
      });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('display_name')).toHaveTextContent('Jay');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'refresh' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('display_name')).toHaveTextContent('Jared');
    });
    // Initial probe + the refresh call.
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      '/auth/me',
      expect.objectContaining({ signal: expect.any(AbortSignal) }) as unknown,
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      '/auth/me',
      expect.objectContaining({ signal: expect.any(AbortSignal) }) as unknown,
    );
  });

  it('refresh() after a 401 promotes back to authenticated when the next probe wins', async () => {
    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(
        new ApiError('no session', { status: 401, code: 'unauthenticated' }),
      )
      .mockResolvedValueOnce({
        user: { id: 7, email: 'late@example.com' },
      });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'refresh' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
    expect(screen.getByTestId('email')).toHaveTextContent('late@example.com');
  });
});

// ── TOTP 2FA flow (PASS LOGIN — PART C2 / C7) ─────────────────────────────

/**
 * Harness exposing the 2FA surface: `pending`, plus buttons that drive each
 * method. The methods stash any returned value into a `data-testid` node so
 * tests can assert on recovery codes etc.
 */
function MfaProbe(): JSX.Element {
  const auth = useAuth();
  const [out, setOut] = useState('');
  return (
    <div>
      <div data-testid="status">{auth.status}</div>
      <div data-testid="pending-kind">{auth.pending?.kind ?? 'none'}</div>
      <div data-testid="pending-token">
        {auth.pending?.challengeToken ?? ''}
      </div>
      <div data-testid="out">{out}</div>
      <button
        type="button"
        onClick={() => {
          // Swallow rejections in the harness the way the real screen does
          // (its submit handler catches and renders a fixed error string).
          auth.login('jay@example.com', 'pw').catch(() => undefined);
        }}
      >
        do-login
      </button>
      <button
        type="button"
        onClick={() => {
          auth.submitTotp('123456').catch(() => undefined);
        }}
      >
        do-totp
      </button>
      <button
        type="button"
        onClick={() => {
          auth
            .enroll()
            .then((r) => {
              setOut(`${r.otpauthUri}|${r.secret}`);
            })
            .catch(() => undefined);
        }}
      >
        do-enroll
      </button>
      <button
        type="button"
        onClick={() => {
          auth
            .confirmEnroll('654321')
            .then((r) => {
              setOut(r.recoveryCodes.join(','));
            })
            .catch(() => undefined);
        }}
      >
        do-confirm
      </button>
      <button
        type="button"
        onClick={() => {
          auth.completeEnrollment().catch(() => undefined);
        }}
      >
        do-complete
      </button>
    </div>
  );
}

describe('AuthProvider — 2FA login (mfa_required → totp)', () => {
  it('login sets pending(mfa); submitTotp authenticates and clears it', async () => {
    // Initial probe → guest (no session yet).
    vi.spyOn(api, 'get').mockRejectedValue(
      new ApiError('no session', { status: 401, code: 'unauthenticated' }),
    );
    authMocks.login.mockResolvedValueOnce({
      status: 'mfa_required',
      challengeToken: 'tok-mfa',
      expiresIn: 300,
    });
    authMocks.loginTotp.mockResolvedValueOnce({
      user: { id: 1, email: 'jay@example.com' },
    });

    render(
      <AuthProvider>
        <MfaProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'do-login' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pending-kind')).toHaveTextContent('mfa');
    });
    // Still guest while pending — a pending challenge confers no session.
    expect(screen.getByTestId('status')).toHaveTextContent('guest');

    await act(async () => {
      screen.getByRole('button', { name: 'do-totp' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
    expect(authMocks.loginTotp).toHaveBeenCalledWith('tok-mfa', '123456');
    expect(screen.getByTestId('pending-kind')).toHaveTextContent('none');
  });

  it('a bad totp code leaves pending intact (screen can retry)', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(
      new ApiError('no session', { status: 401, code: 'unauthenticated' }),
    );
    authMocks.login.mockResolvedValueOnce({
      status: 'mfa_required',
      challengeToken: 'tok-mfa',
      expiresIn: 300,
    });
    authMocks.loginTotp.mockRejectedValueOnce(
      new ApiError('nope', { status: 401, code: 'invalid_code' }),
    );

    render(
      <AuthProvider>
        <MfaProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });
    await act(async () => {
      screen.getByRole('button', { name: 'do-login' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pending-kind')).toHaveTextContent('mfa');
    });
    await act(async () => {
      screen.getByRole('button', { name: 'do-totp' }).click();
    });
    // Pending still present; still guest.
    await waitFor(() => {
      expect(screen.getByTestId('pending-kind')).toHaveTextContent('mfa');
    });
    expect(screen.getByTestId('status')).toHaveTextContent('guest');
  });
});

describe('AuthProvider — 2FA enrollment (enrollment_required → confirm)', () => {
  it('login → enroll → confirmEnroll → completeEnrollment authenticates', async () => {
    // Probe: first 401 (guest), then after completeEnrollment re-probe → user.
    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(
        new ApiError('no session', { status: 401, code: 'unauthenticated' }),
      )
      .mockResolvedValueOnce({ user: { id: 9, email: 'new@example.com' } });
    authMocks.login.mockResolvedValueOnce({
      status: 'enrollment_required',
      challengeToken: 'tok-enr',
      expiresIn: 300,
    });
    authMocks.mfaEnroll.mockResolvedValueOnce({
      otpauthUri: 'otpauth://totp/x?secret=SEED',
      secret: 'SEED',
    });
    authMocks.mfaConfirm.mockResolvedValueOnce({
      user: { id: 9, email: 'new@example.com' },
      recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'],
    });

    render(
      <AuthProvider>
        <MfaProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'do-login' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pending-kind')).toHaveTextContent('enroll');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'do-enroll' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('out')).toHaveTextContent(
        'otpauth://totp/x?secret=SEED|SEED',
      );
    });
    // enroll does NOT consume the challenge.
    expect(screen.getByTestId('pending-kind')).toHaveTextContent('enroll');

    await act(async () => {
      screen.getByRole('button', { name: 'do-confirm' }).click();
    });
    // Recovery codes surfaced ONCE; pending cleared; NOT yet authenticated
    // (entry is gated on completeEnrollment / the recovery-code ack).
    await waitFor(() => {
      expect(screen.getByTestId('out')).toHaveTextContent(
        'AAAAA-BBBBB,CCCCC-DDDDD',
      );
    });
    expect(screen.getByTestId('pending-kind')).toHaveTextContent('none');
    expect(screen.getByTestId('status')).toHaveTextContent('guest');

    await act(async () => {
      screen.getByRole('button', { name: 'do-complete' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
  });
});

describe('AuthProvider — security invariants', () => {
  it('NEVER writes the challenge token to localStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(api, 'get').mockRejectedValue(
      new ApiError('no session', { status: 401, code: 'unauthenticated' }),
    );
    authMocks.login.mockResolvedValueOnce({
      status: 'mfa_required',
      challengeToken: 'super-secret-token',
      expiresIn: 300,
    });

    render(
      <AuthProvider>
        <MfaProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });
    await act(async () => {
      screen.getByRole('button', { name: 'do-login' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pending-kind')).toHaveTextContent('mfa');
    });
    // The token is in memory (rendered) but must never be persisted.
    expect(screen.getByTestId('pending-token')).toHaveTextContent(
      'super-secret-token',
    );
    const persistedToken = setItem.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === 'string' && arg.includes('super-secret-token'),
      ),
    );
    expect(persistedToken).toBe(false);
    // Belt-and-braces: scan the whole localStorage for the token.
    const dump = JSON.stringify({ ...window.localStorage });
    expect(dump).not.toContain('super-secret-token');
  });

  it('NEVER writes recovery codes to localStorage/sessionStorage (SF2)', async () => {
    // Recovery codes are a shown-once secret (Security Property #4) — equally
    // sensitive as the challenge token. Drive login → enroll → confirm so the
    // codes flow through AuthProvider state, then prove no Storage write and no
    // dump (local OR session) ever contains them.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const RECOVERY = ['ZZZZZ-99999', 'WWWWW-88888'];

    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(
        new ApiError('no session', { status: 401, code: 'unauthenticated' }),
      )
      .mockResolvedValueOnce({ user: { id: 9, email: 'new@example.com' } });
    authMocks.login.mockResolvedValueOnce({
      status: 'enrollment_required',
      challengeToken: 'tok-enr',
      expiresIn: 300,
    });
    authMocks.mfaEnroll.mockResolvedValueOnce({
      otpauthUri: 'otpauth://totp/x?secret=SEED',
      secret: 'SEED',
    });
    authMocks.mfaConfirm.mockResolvedValueOnce({
      user: { id: 9, email: 'new@example.com' },
      recoveryCodes: RECOVERY,
    });

    render(
      <AuthProvider>
        <MfaProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });
    await act(async () => {
      screen.getByRole('button', { name: 'do-login' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pending-kind')).toHaveTextContent('enroll');
    });
    await act(async () => {
      screen.getByRole('button', { name: 'do-enroll' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'do-confirm' }).click();
    });
    // Codes are surfaced in memory (rendered) ...
    await waitFor(() => {
      expect(screen.getByTestId('out')).toHaveTextContent(RECOVERY.join(','));
    });

    // ... but must NEVER be persisted. No setItem call carries any code string.
    const persistedCode = setItem.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' && RECOVERY.some((code) => arg.includes(code)),
      ),
    );
    expect(persistedCode).toBe(false);
    // Belt-and-braces: scan both storages.
    const localDump = JSON.stringify({ ...window.localStorage });
    const sessionDump = JSON.stringify({ ...window.sessionStorage });
    for (const code of RECOVERY) {
      expect(localDump).not.toContain(code);
      expect(sessionDump).not.toContain(code);
    }
  });
});
