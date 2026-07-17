/**
 * AuthProvider — single source of truth for the cookie session.
 *
 * Mounts under `<BrowserRouter>` so the initial probe runs once per page
 * load. Exposes `login`, `register`, and `logout` mutators that the rest of
 * the app calls. See `auth-context.ts` for shared types.
 *
 * Threat model — what this defends against, and what it delegates:
 *   - Race between two `<useAuth/>` consumers: state lifted to context so
 *     the `GET /auth/me` probe runs exactly once.
 *   - StrictMode double-mount: the effect uses an `AbortController`, so the
 *     dev double-render cancels the first request instead of double-counting.
 *   - Login/register vs in-flight probe race: a slow initial `/auth/me`
 *     probe (sent before the cookie was set) returns 401 *after* `login`
 *     resolves and `setState('authenticated')` runs. Without intervention,
 *     the probe's catch path clobbers the post-login state back to `guest`
 *     — the user is bounced to the login screen with no error. Defence:
 *     `login` and `register` abort `probeRef.current` *before* posting
 *     credentials. The in-flight probe's catch then sees
 *     `ctrl.signal.aborted === true` and bails silently. The post-login
 *     `setState('authenticated')` is now the last writer.
 *   - Stale state after logout: `logout` clears local state AND re-probes
 *     the server (defence in depth — if the cookie failed to clear, the
 *     next probe still shows guest because the server revoked the row).
 *   - Token leakage: the cookie is `HttpOnly`; we never see or echo it.
 *   - Session fixation: handled server-side (each login mints a new row).
 *     We trust the server and just re-probe on success.
 *   - Pending-challenge leakage (PASS LOGIN — PART C2): the two-step 2FA
 *     `pending` state (the challenge token between the password step and the
 *     real session) lives in React state ONLY. It is NEVER written to
 *     `localStorage`/`sessionStorage`/a cookie — a persisted bearer token
 *     would outlive its purpose and widen the theft surface. The app gate
 *     stays `guest` for the whole pending window; a pending challenge confers
 *     no session powers. A page reload drops it by design (the user restarts
 *     at the credentials step). `login` only sets `pending` on the
 *     `mfa_required`/`enrollment_required` branches; it authenticates directly
 *     only on the legacy `authenticated` branch.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { ApiError, api } from '../services/api';
import {
  login as loginRequest,
  loginTotp,
  logout as logoutRequest,
  mfaConfirm,
  mfaEnroll,
} from '../services/auth';
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
  type PendingChallenge,
  type User,
} from './auth-context';
import type { RegisterOutcome, RegisterResponse } from '../types/domain';

interface AuthState {
  status: AuthStatus;
  user: User | null;
}

interface AuthResponse {
  user: User;
}

const INITIAL_STATE: AuthState = { status: 'loading', user: null };

export function AuthProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);
  // The interstitial 2FA challenge (PART C2). Memory-only — see the
  // threat-model header. `null` outside a pending login. The challenge token
  // it carries is read by the new MFA methods below and NEVER persisted.
  const [pending, setPending] = useState<PendingChallenge | null>(null);
  // Coalesce concurrent probes — the initial mount and any post-logout
  // refresh can race; only the latest controller's response applies.
  const probeRef = useRef<AbortController | null>(null);

  const probe = useCallback(async (): Promise<void> => {
    probeRef.current?.abort();
    const ctrl = new AbortController();
    probeRef.current = ctrl;

    // One retry on 5xx / network with 500 ms backoff. 401 (the common case
    // for a guest visit) bails immediately — no retry, no flicker. The
    // retry covers a transient backend glitch on page load; without it, a
    // single brittle response puts the user at the login screen even
    // though their cookie is fine.
    const attempt = async (): Promise<AuthResponse> =>
      api.get<AuthResponse>('/auth/me', { signal: ctrl.signal });

    const attemptWithRetry = async (): Promise<AuthResponse> => {
      try {
        return await attempt();
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
        if (err instanceof ApiError && err.status === 401) throw err;
        // Retry once on 5xx or network — but only for the initial probe.
        // 4xx (other than 401) is a bug; don't paper over it with a retry.
        const retryable =
          err instanceof ApiError &&
          (err.status >= 500 || err.code === 'network' || err.code === 'timeout');
        if (!retryable) throw err;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          ctrl.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (ctrl.signal.aborted) throw err;
        return attempt();
      }
    };

    try {
      const data = await attemptWithRetry();
      if (!ctrl.signal.aborted) {
        setState({ status: 'authenticated', user: data.user });
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (err instanceof ApiError && err.status === 401) {
        setState({ status: 'guest', user: null });
        return;
      }
      // Any other failure (network, 5xx after retry) leaves the user as
      // guest. The login screen is safe to show; a successful login will
      // re-probe.
      setState({ status: 'guest', user: null });
    }
  }, []);

  useEffect(() => {
    // The initial-mount session probe is the textbook "synchronize React
    // state with an external system" case the React docs sanction — there's
    // no way to know whether a session cookie is valid without asking the
    // server. We accept the set-state-in-effect rule warning here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void probe();
    return () => {
      probeRef.current?.abort();
    };
  }, [probe]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      // Abort any in-flight probe *before* the POST. See threat-model
      // header: a slow `/auth/me` that resolves after `setState` below
      // would clobber `authenticated` back to `guest`. Aborting first
      // makes the probe's catch a no-op via `ctrl.signal.aborted`. The same
      // defence covers the 2FA branches: even though they don't authenticate
      // yet, a late probe resolving as 401 must not race the `pending` UI.
      probeRef.current?.abort();
      const result = await loginRequest(email, password);
      if (result.status === 'authenticated') {
        // Legacy / `MFA_REQUIRED=false` branch — cookie already set.
        setPending(null);
        setState({ status: 'authenticated', user: result.user });
        return;
      }
      // `mfa_required` | `enrollment_required` — hold the challenge in memory
      // and stay `guest`. The Login screen renders the next step off `pending`.
      setPending({
        kind: result.status === 'mfa_required' ? 'mfa' : 'enroll',
        challengeToken: result.challengeToken,
        expiresIn: result.expiresIn,
      });
    },
    [],
  );

  const submitTotp = useCallback(
    async (code: string): Promise<void> => {
      if (!pending || pending.kind !== 'mfa') {
        // A submit with no live `mfa` challenge is a programming error — the
        // screen should only render the code step when `pending.kind==='mfa'`.
        throw new ApiError('no pending challenge', {
          status: 0,
          code: 'no_pending',
        });
      }
      // Same probe-race defence as `login`: the about-to-be-set session must
      // win against any straggling 401 probe.
      probeRef.current?.abort();
      const { user } = await loginTotp(pending.challengeToken, code);
      // Only clear `pending` AFTER the call resolves — a thrown ApiError (bad
      // or expired code) leaves the screen on the code step to retry.
      setPending(null);
      setState({ status: 'authenticated', user });
    },
    [pending],
  );

  const enroll = useCallback(async (): Promise<{
    otpauthUri: string;
    secret: string;
  }> => {
    if (!pending || pending.kind !== 'enroll') {
      throw new ApiError('no pending enrollment', {
        status: 0,
        code: 'no_pending',
      });
    }
    // Mint the pending secret. Does NOT consume the challenge or authenticate
    // — `confirmEnroll` does both — so `pending` is intentionally untouched.
    return mfaEnroll({ challengeToken: pending.challengeToken });
  }, [pending]);

  const confirmEnroll = useCallback(
    async (code: string): Promise<{ recoveryCodes: string[] }> => {
      if (!pending || pending.kind !== 'enroll') {
        throw new ApiError('no pending enrollment', {
          status: 0,
          code: 'no_pending',
        });
      }
      const { recoveryCodes } = await mfaConfirm({
        challengeToken: pending.challengeToken,
        code,
      });
      // Clear `pending` (the challenge is spent) but do NOT authenticate yet —
      // the screen must display the one-time recovery codes and gate app entry
      // behind the user's acknowledgement. `completeEnrollment` finishes the
      // flip once they confirm they've saved the codes. The session cookie is
      // already set server-side, so a reload mid-acknowledgement still lands
      // the user signed in (the probe picks it up) — they'd just miss the
      // codes, which is the correct fail-safe (codes are unrecoverable, the
      // session is not).
      setPending(null);
      return { recoveryCodes };
    },
    [pending],
  );

  const completeEnrollment = useCallback(async (): Promise<void> => {
    // Idempotent: if we're already authenticated, nothing to do.
    if (state.status === 'authenticated') return;
    // The session cookie is already set (confirm minted it); re-probe to
    // hydrate the user and flip the gate. Reuses the shared abort/coalesce
    // logic so a racing initial probe can't clobber the result.
    await probe();
  }, [state.status, probe]);

  const register = useCallback(
    async (
      email: string,
      password: string,
      displayName?: string,
    ): Promise<RegisterOutcome> => {
      // See `login` — same race, same defence.
      probeRef.current?.abort();
      // Trim explicitly so a whitespace-only `displayName` is dropped
      // (server schema is `z.string().min(1).optional()`, so sending
      // `display_name: '   '` would 400 even though it's "empty" to the
      // user). The `|| undefined` collapses '' (after trim) to omission.
      const trimmedDisplayName: string | undefined =
        displayName?.trim() || undefined;
      const data = await api.post<RegisterResponse>('/auth/register', {
        email,
        password,
        ...(trimmedDisplayName ? { display_name: trimmedDisplayName } : {}),
      });
      if (data.status === 'verification_required') {
        // F-006 gate-on posture: the server minted NO session. Stay `guest`;
        // the Login screen renders the "check your email" step off this
        // outcome. (Nothing to persist — the verification token only ever
        // exists inside the email.)
        return 'verification_required';
      }
      setState({ status: 'authenticated', user: data.user });
      return 'authenticated';
    },
    [],
  );

  /**
   * Best-effort logout: POST the server, then unconditionally clear local
   * state, then re-probe. The re-probe is defence in depth — if the server
   * revoked the session, the probe returns 401 and confirms `guest`.
   *
   * Known edge (accepted here; tracked as **F-201** in BUGS_AND_FEATURES.md):
   *   - **Server-side 5xx during logout**: the POST throws, we clear local
   *     state, then `probe()` re-runs and the *cookie is still valid* on the
   *     server. The probe succeeds → state flips back to `authenticated`,
   *     which is correct (the session genuinely still exists) but the UI
   *     flashes "logged out" for the duration of the POST→probe window. The
   *     user is effectively *not* logged out, with no feedback beyond the
   *     `console.warn` in the catch below. A real fix needs server work
   *     (idempotent revoke so a client retry always lands, and/or a
   *     short-lived rolling cookie so an un-revoked session dies on its
   *     own) plus a surfaced client warning ("we couldn't reach the server
   *     to end your session — try again or close all tabs") — that bundle
   *     is F-201, deliberately out of scope for this client-only branch.
   *   - **Network down during logout**: same shape — local clear, probe
   *     also fails, state stays `guest` (a previously-network-down session
   *     can't be reached anyway). Acceptable.
   */
  const logout = useCallback(async (): Promise<void> => {
    try {
      await logoutRequest();
    } catch (err) {
      // Best-effort — if the server can't reach us we still drop local
      // state so the UI redirects to login. Next probe will reconcile.
      // Surfaced as a warning (never a throw — the local clear below MUST
      // run): on a 5xx the server session is still live and the re-probe
      // will bounce the user back in with zero visible feedback. Tracked
      // as F-201 (user-facing warning + idempotent server revoke).
      console.warn(
        'logout: POST /auth/logout failed — server session may still be live (F-201)',
        err,
      );
    }
    // Drop any half-finished 2FA challenge too — a stale `pending` would
    // otherwise stick the Login screen on the code/enroll step after a logout.
    setPending(null);
    setState({ status: 'guest', user: null });
    await probe();
  }, [probe]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      user: state.user,
      loading: state.status === 'loading',
      pending,
      login,
      submitTotp,
      enroll,
      confirmEnroll,
      completeEnrollment,
      register,
      logout,
      // `refresh` is just `probe` re-exposed under a name screens can
      // call after they mutate the user (Settings → PATCH /auth/me). The
      // shared abort/coalescing logic in `probe` means a refresh during
      // an in-flight initial probe is safe — the older controller aborts.
      refresh: probe,
    }),
    [
      state.status,
      state.user,
      pending,
      login,
      submitTotp,
      enroll,
      confirmEnroll,
      completeEnrollment,
      register,
      logout,
      probe,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
