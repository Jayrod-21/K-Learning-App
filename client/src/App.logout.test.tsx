/**
 * App-mount integration — the logout → /login redirect chain (REVIEW_logout
 * SF-1).
 *
 * The "Log out" button's visible effect is a THREE-layer contract:
 * Settings' `onLogout` calls `useAuth().logout`, the real AuthProvider
 * clears state to `guest`, and App.tsx's `RequireAuth` gate replaces the
 * whole authenticated tree with `<Navigate to="/login">`. The unit suites
 * cover the first two layers in isolation (Settings.test.tsx mocks
 * `useAuth`; AuthProvider.test.tsx asserts the guest flip) — this file
 * mounts the real `<App/>` so a regression in `RequireAuth` itself, or in
 * the wiring of Settings underneath it, fails a test instead of silently
 * leaving the button clearing state with no visible effect.
 *
 * Hermetic by construction (Shell.test.tsx's approach, one layer lower):
 * the whole `services/api` transport is replaced with an in-memory fake, so
 * no request can ever leave the process:
 *   - `GET /auth/me` answers from a mutable `serverSessionLive` flag —
 *     authenticated (verified) user while true, `ApiError` 401 after the
 *     logout POST lands. One flag drives BOTH the AuthProvider probe and
 *     Settings' own `fetchMe`, so the fake server can never disagree with
 *     itself the way independent per-call mocks could.
 *   - `POST /auth/logout` flips the flag (the "server revoked the row"
 *     half of the contract) and counts calls, so the test also proves the
 *     click went through the real provider exactly once.
 *   - Every other endpoint (TourProvider's + Settings' `/settings/prefs`,
 *     notification schedules, MFA status, …) never settles: pages idle in
 *     their loading states, TourProvider never hydrates so no tour can
 *     auto-fire, and no late async setState leaks act() warnings — the
 *     same posture as Shell.test.tsx's never-settling `fetchPrefs`.
 *   - `localStorage["km.toursSeen"]` is seeded with every tour id — the
 *     same second line of defence Shell.test.tsx keeps.
 *   - `virtual:pwa-register/react` is stubbed (no service worker under
 *     Vitest — same as PwaUpdatePrompt.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { TOURS_SEEN_STORAGE_KEY } from './hooks/tour-context';
import { TOUR_IDS } from './lib/tours';

/**
 * Mutable fake-server state. `vi.hoisted` so the `vi.mock` factory below
 * (which is hoisted above all imports) can close over it.
 */
const harness = vi.hoisted(() => ({
  serverSessionLive: true,
  logoutPosts: 0,
}));

// No service worker under Vitest (VitePWA's virtual module doesn't resolve
// here) — stub the hook to the "nothing pending" shape so PwaUpdatePrompt
// and its host render null.
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (): {
    needRefresh: [boolean, (v: boolean) => void];
    offlineReady: [boolean, (v: boolean) => void];
    updateServiceWorker: (reload?: boolean) => Promise<void>;
  } => ({
    needRefresh: [false, () => undefined],
    offlineReady: [false, () => undefined],
    updateServiceWorker: async () => undefined,
  }),
}));

vi.mock('./services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/api')>();

  /** Never settles — endpoints irrelevant to the chain stay inert. */
  const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

  // Email-VERIFIED so UnverifiedBanner renders null (mirrors Shell.test.tsx)
  // and the Profile group hydrates without a resend-verification limb.
  const fakeUser = {
    id: 1,
    email: 'tester@example.com',
    display_name: 'Tester',
    phone: '',
    version: 1,
    email_verified: true,
  };

  return {
    ...actual,
    api: {
      get: <T,>(url: string): Promise<T> => {
        if (url === '/auth/me') {
          if (harness.serverSessionLive) {
            return Promise.resolve({ user: fakeUser } as T);
          }
          // 401 (not a network error) so AuthProvider's probe resolves
          // `guest` immediately instead of detouring through its 500 ms
          // 5xx-retry backoff.
          return Promise.reject(
            new actual.ApiError('no session', {
              status: 401,
              code: 'unauthenticated',
            }),
          );
        }
        return never<T>();
      },
      post: <T,>(url: string): Promise<T> => {
        if (url === '/auth/logout') {
          harness.logoutPosts += 1;
          harness.serverSessionLive = false;
          return Promise.resolve(undefined as T);
        }
        return never<T>();
      },
      put: <T,>(): Promise<T> => never<T>(),
      patch: <T,>(): Promise<T> => never<T>(),
      delete: <T,>(): Promise<T> => never<T>(),
    },
  };
});

beforeEach(() => {
  harness.serverSessionLive = true;
  harness.logoutPosts = 0;
  // Defence in depth against tour auto-fire (see the module doc comment).
  window.localStorage.setItem(
    TOURS_SEEN_STORAGE_KEY,
    JSON.stringify([...TOUR_IDS]),
  );
  // App mounts a real BrowserRouter, which reads the environment URL —
  // start the "session" on the Settings page, where the button lives.
  window.history.replaceState(null, '', '/settings');
});

afterEach(() => {
  window.localStorage.removeItem(TOURS_SEEN_STORAGE_KEY);
  window.history.replaceState(null, '', '/');
});

describe('App — logout lands on the login screen (RequireAuth redirect)', () => {
  it('authenticated user clicks "Log out" → guest flip → RequireAuth navigates to /login', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Authenticated boot: the probe resolved and RequireAuth admitted the
    // gated tree — the real Settings page is on screen at /settings.
    const profileHeader = await screen.findByRole('button', {
      name: /Profile/,
    });
    expect(window.location.pathname).toBe('/settings');

    // Open the (default-collapsed) Profile tile the way a user does.
    if (profileHeader.getAttribute('aria-expanded') === 'false') {
      await user.click(profileHeader);
    }
    const logoutButton = await screen.findByRole('button', {
      name: /Log out/,
    });

    await user.click(logoutButton);

    // The ONLY navigation driver is the auth-state flip: the real provider
    // clears to `guest` and RequireAuth's `<Navigate to="/login">` replaces
    // the tree with the Login screen. If RequireAuth stops redirecting
    // guests (or Settings is ever wired outside the gate), the login
    // heading never appears and this findBy times out — the regression
    // SF-1 exists to catch.
    expect(
      await screen.findByRole('heading', { name: /Welcome/ }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');

    // The gated tree is gone with it…
    expect(
      screen.queryByRole('button', { name: /Log out/, hidden: true }),
    ).not.toBeInTheDocument();
    // …and the click went through the real AuthProvider → real auth
    // service → transport exactly once (single-flight held end-to-end).
    expect(harness.logoutPosts).toBe(1);
  });
});
