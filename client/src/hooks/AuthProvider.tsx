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
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
  type User,
} from './auth-context';

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
      // makes the probe's catch a no-op via `ctrl.signal.aborted`.
      probeRef.current?.abort();
      const data = await api.post<AuthResponse>('/auth/login', {
        email,
        password,
      });
      setState({ status: 'authenticated', user: data.user });
    },
    [],
  );

  const register = useCallback(
    async (
      email: string,
      password: string,
      displayName?: string,
    ): Promise<void> => {
      // See `login` — same race, same defence.
      probeRef.current?.abort();
      // Trim explicitly so a whitespace-only `displayName` is dropped
      // (server schema is `z.string().min(1).optional()`, so sending
      // `display_name: '   '` would 400 even though it's "empty" to the
      // user). The `|| undefined` collapses '' (after trim) to omission.
      const trimmedDisplayName: string | undefined =
        displayName?.trim() || undefined;
      const data = await api.post<AuthResponse>('/auth/register', {
        email,
        password,
        ...(trimmedDisplayName ? { display_name: trimmedDisplayName } : {}),
      });
      setState({ status: 'authenticated', user: data.user });
    },
    [],
  );

  /**
   * Best-effort logout: POST the server, then unconditionally clear local
   * state, then re-probe. The re-probe is defence in depth — if the server
   * revoked the session, the probe returns 401 and confirms `guest`.
   *
   * Known edge (acceptable for Pass 1, documented for Pass 3):
   *   - **Server-side 5xx during logout**: the POST throws, we clear local
   *     state, then `probe()` re-runs and the *cookie is still valid* on the
   *     server. The probe succeeds → state flips back to `authenticated`,
   *     which is correct (the session genuinely still exists) but the UI
   *     flashes "logged out" for the duration of the POST→probe window. The
   *     user is effectively *not* logged out. Pass 3 will add a retry +
   *     surfaced warning ("we couldn't reach the server to end your
   *     session — try again or close all tabs").
   *   - **Network down during logout**: same shape — local clear, probe
   *     also fails, state stays `guest` (a previously-network-down session
   *     can't be reached anyway). Acceptable.
   */
  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post<void>('/auth/logout');
    } catch {
      // Best-effort — if the server can't reach us we still drop local
      // state so the UI redirects to login. Next probe will reconcile.
    }
    setState({ status: 'guest', user: null });
    await probe();
  }, [probe]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      user: state.user,
      loading: state.status === 'loading',
      login,
      register,
      logout,
      // `refresh` is just `probe` re-exposed under a name screens can
      // call after they mutate the user (Settings → PATCH /auth/me). The
      // shared abort/coalescing logic in `probe` means a refresh during
      // an in-flight initial probe is safe — the older controller aborts.
      refresh: probe,
    }),
    [state.status, state.user, login, register, logout, probe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
