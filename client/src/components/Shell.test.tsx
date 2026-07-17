/**
 * Shell — LearnMenu open/close phase machine (honeycomb motion polish).
 *
 * The menu no longer unmounts on a close request: Shell moves
 * 'open' → 'closing' (menu stays mounted, exit cascade plays, hexagon
 * un-spins) and only unmounts on the LAST tile's animationend — or on a
 * safety timeout if that never fires. Under prefers-reduced-motion the
 * 'closing' phase is bypassed entirely (a 0-duration exit may fire
 * animationend immediately or never — gating on it would race or hang).
 *
 * ChatFab and the Outlet page render for real (no heavy providers are
 * required — Shell's subtree hooks all have null-safe defaults).
 *
 * FeedbackFab (F-127, global "!" button) tests live in their own describe
 * block below — it's rendered as a Shell-level sibling of ChatFab/Outlet,
 * same as ChatFab itself, so it's exercised the same way: render the real
 * Shell + a routed probe, no mocks.
 *
 * Device-adaptive epic (Phase D0) coupling: `Shell` now calls
 * `useDeviceClass()` to decide BottomNav-vs-Sidebar, so every `hexButton()`
 * assertion below implicitly depends on `src/test/setup.ts`'s global
 * `matchMedia` default (`matches: false`) resolving `deviceClass` to
 * `'mobile'` — before D0 this file had no dependency on `matchMedia` at
 * all. `mockReducedMotion()` (below) overrides `matchMedia` for its own
 * tests but still returns `matches: false` for the two `(min-width: …)`
 * device-class queries (only `prefers-reduced-motion` matches), so it stays
 * 'mobile' too. See `Shell.deviceAdaptive.test.tsx` for the Sidebar-chrome
 * coverage this file intentionally does not duplicate.
 *
 * F-006 + guided-tour coupling: `Shell` now renders `<UnverifiedBanner/>`
 * (which calls `useAuth()` — it THROWS outside a provider) and mounts
 * `TourProvider` (which boot-fetches `GET /settings/prefs` and can auto-fire
 * a coach-mark tour over the chrome). The harness therefore:
 *   - supplies `AuthContext` directly with a VERIFIED authenticated user —
 *     the lightest correct posture: `useAuth()` resolves, the banner renders
 *     null, and no `/auth/me` probe ever leaves the process (wrapping the
 *     real `AuthProvider` would fire one per render);
 *   - mocks `services/settings` with a never-settling `fetchPrefs`, so
 *     `TourProvider` never hydrates and (per its own contract) never
 *     auto-fires — no network attempt, no async setState outside act;
 *   - seeds `localStorage["km.toursSeen"]` with every tour id as a second
 *     line of defence, so even a future TourProvider that fired before
 *     hydration would find nothing unseen to fire.
 * The Shell assertions themselves are untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { Shell } from './Shell';
import { LEARN_MENU_EXIT_MS } from './LearnMenu';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { TOURS_SEEN_STORAGE_KEY } from '../hooks/tour-context';
import { TOUR_IDS } from '../lib/tours';

// TourProvider (mounted by Shell) boot-fetches `GET /settings/prefs`. A
// never-settling promise keeps it permanently un-hydrated: its auto-fire
// gate waits on hydration, so no tour can ever fire under these tests, no
// real network request is attempted, and no late async setState can leak
// act() warnings into unrelated assertions. `putPrefs` is only reachable
// after a tour finishes, which can't happen here — stubbed for the import.
vi.mock('../services/settings', () => ({
  fetchPrefs: (): Promise<never> =>
    new Promise<never>(() => {
      /* never settles — TourProvider stays inert */
    }),
  putPrefs: (): Promise<never> =>
    new Promise<never>(() => {
      /* unreachable in these tests */
    }),
}));

/**
 * A signed-in, email-VERIFIED user: `UnverifiedBanner` renders null, so the
 * LearnMenu/FeedbackFab assertions below see exactly the pre-F-006 chrome.
 * Plain async no-op stubs (not vi.fn()) — nothing in this file asserts on
 * them, and the suite-level `vi.restoreAllMocks` can't wipe an
 * implementation that was never a mock.
 */
const VERIFIED_AUTH: AuthContextValue = {
  status: 'authenticated',
  user: { id: 1, email: 'tester@example.com', email_verified: true },
  loading: false,
  pending: null,
  login: async () => undefined,
  submitTotp: async () => undefined,
  enroll: async () => ({ otpauthUri: 'otpauth://x', secret: 'S' }),
  confirmEnroll: async () => ({ recoveryCodes: [] }),
  completeEnrollment: async () => undefined,
  register: async () => 'authenticated' as const,
  logout: async () => undefined,
  refresh: async () => undefined,
};

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return (
    <>
      <div data-testid="pathname">{loc.pathname}</div>
      {/* F-127: exposes the router state a navigation carried, so the
       *  FeedbackFab tests can assert on the exact { compose, sourcePage }
       *  payload without re-implementing Tickets.tsx's own state reading. */}
      <div data-testid="state">{JSON.stringify(loc.state)}</div>
    </>
  );
}

const FEEDBACK_FAB_NAME = 'Report feedback · 피드백 보내기';

function renderShell(initialPath = '/'): void {
  render(
    <AuthContext.Provider value={VERIFIED_AUTH}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="*" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

/** The LEARN hexagon toggle in the BottomNav. */
function hexButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Learn · 배움' });
}

/** The menu dialog, or null when unmounted. */
function menuDialog(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: '배움 · Learn' });
}

/** All 7 tile wrappers in DOM order; [6] is the exit sentinel. */
function wraps(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.km-learnmenu__hexwrap'),
  );
}

/** Finish the exit cascade by firing the sentinel tile's animationend. */
function finishExit(): void {
  fireEvent.animationEnd(wraps()[6] as HTMLElement);
}

/**
 * Force `prefers-reduced-motion: reduce` for one test. Restored via the
 * suite-level `vi.restoreAllMocks` afterEach.
 */
function mockReducedMotion(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  // Defence in depth against tour auto-fire (see the module doc comment):
  // every registered tour reads as already seen on this "device".
  window.localStorage.setItem(
    TOURS_SEEN_STORAGE_KEY,
    JSON.stringify([...TOUR_IDS]),
  );
});

afterEach(() => {
  window.localStorage.removeItem(TOURS_SEEN_STORAGE_KEY);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Shell — LearnMenu phase machine', () => {
  it('hexagon toggle opens the menu (aria-expanded true, dialog mounted)', async () => {
    const user = userEvent.setup();
    renderShell();
    expect(menuDialog()).toBeNull();

    await user.click(hexButton());

    expect(menuDialog()).toBeInTheDocument();
    expect(hexButton()).toHaveAttribute('aria-expanded', 'true');
    expect(hexButton().className).toContain('km-bottomnav__hex--open');
  });

  it('Esc requests an ANIMATED close: menu stays mounted in the closing phase, then unmounts on the last tile animationend', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(hexButton());

    await user.keyboard('{Escape}');

    // Close REQUESTED, not yet unmounted: the exit cascade is playing.
    expect(menuDialog()).toBeInTheDocument();
    expect(document.querySelector('.km-learnmenu--closing')).not.toBeNull();
    // aria-expanded reads closed from the request; the hex un-spins
    // (--open dropped) with the float held off (--closing).
    expect(hexButton()).toHaveAttribute('aria-expanded', 'false');
    expect(hexButton().className).not.toContain('km-bottomnav__hex--open');
    expect(hexButton().className).toContain('km-bottomnav__hex--closing');

    finishExit();

    expect(menuDialog()).toBeNull();
    expect(hexButton().className).not.toContain('km-bottomnav__hex--closing');
  });

  it('scrim tap routes through the same animated close', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(hexButton());

    await user.click(screen.getByRole('button', { name: 'Close Learn menu' }));

    expect(menuDialog()).toBeInTheDocument();
    expect(document.querySelector('.km-learnmenu--closing')).not.toBeNull();
    finishExit();
    expect(menuDialog()).toBeNull();
  });

  it('tile activation navigates immediately and the close-out plays over the new page', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(hexButton());

    await user.click(screen.getByRole('button', { name: /Vocab flashcards/ }));

    // Navigation lands first (the menu is an overlay)…
    expect(screen.getByTestId('pathname')).toHaveTextContent('/learn/vocab');
    // …while the exit cascade plays out before the unmount.
    expect(menuDialog()).toBeInTheDocument();
    expect(document.querySelector('.km-learnmenu--closing')).not.toBeNull();
    finishExit();
    expect(menuDialog()).toBeNull();
  });

  it('restores focus to the hexagon only after the animated close fully unmounts', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(hexButton());
    // Initial focus moved into the menu (first tile).
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Vocab flashcards/ }),
    );

    await user.keyboard('{Escape}');
    // Mid-close-out: still mounted, no focus restore yet.
    expect(menuDialog()).toBeInTheDocument();

    finishExit();
    // useModalA11y restores focus on the REAL unmount (microtask-deferred).
    await waitFor(() => {
      expect(hexButton()).toHaveFocus();
    });
  });

  it('re-tapping the hexagon mid-close re-opens (closing → open)', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(hexButton());
    await user.keyboard('{Escape}');
    expect(document.querySelector('.km-learnmenu--closing')).not.toBeNull();

    await user.click(hexButton());

    expect(menuDialog()).toBeInTheDocument();
    expect(document.querySelector('.km-learnmenu--closing')).toBeNull();
    expect(hexButton()).toHaveAttribute('aria-expanded', 'true');
    // A stale exit animationend from the aborted close must not yank the
    // reopened menu down (Shell guards onExited on the closing phase).
    finishExit();
    expect(menuDialog()).toBeInTheDocument();
  });

  it('safety timeout force-unmounts if the exit animationend never fires', () => {
    vi.useFakeTimers();
    renderShell();
    fireEvent.click(hexButton());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(menuDialog()).toBeInTheDocument();

    // Just before the deadline the menu is still (correctly) mounted…
    act(() => {
      vi.advanceTimersByTime(LEARN_MENU_EXIT_MS);
    });
    expect(menuDialog()).toBeInTheDocument();

    // …and past exit-length + margin it can never stay wedged.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(menuDialog()).toBeNull();
  });

  it('prefers-reduced-motion: close is IMMEDIATE — no closing phase, no animationend dependency', async () => {
    mockReducedMotion();
    const user = userEvent.setup();
    renderShell();
    await user.click(hexButton());
    expect(menuDialog()).toBeInTheDocument();

    await user.keyboard('{Escape}');

    // Unmounted synchronously: nothing waits on an animationend that a
    // zero-duration animation might never deliver.
    expect(menuDialog()).toBeNull();
    expect(document.querySelector('.km-learnmenu--closing')).toBeNull();
    // Focus restore still happens (plain unmount path).
    await waitFor(() => {
      expect(hexButton()).toHaveFocus();
    });
  });

  it('route change (browser back/forward) closes via the same animated path', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(hexButton());

    // Navigate from under the menu via a bottom tab (the scrim stops above
    // the nav so the bar stays tappable while the menu is open).
    await user.click(screen.getByRole('button', { name: 'Progress · 성장' }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/progress');
    expect(menuDialog()).toBeInTheDocument();
    expect(document.querySelector('.km-learnmenu--closing')).not.toBeNull();
    finishExit();
    expect(menuDialog()).toBeNull();
  });
});

describe('Shell — FeedbackFab (F-127 global "!" button)', () => {
  it.each(['/', '/progress', '/review', '/learn/vocab', '/review/mistakes'])(
    'is visible on %s',
    (path) => {
      renderShell(path);
      expect(
        screen.getByRole('button', { name: FEEDBACK_FAB_NAME }),
      ).toBeInTheDocument();
    },
  );

  // Case-insensitive, same convention as ChatFab's hide check (React Router
  // matches routes case-insensitively).
  it.each(['/tickets', '/tickets/5', '/Tickets'])(
    'is hidden on %s (reporting feedback FROM the feedback page is noise)',
    (path) => {
      renderShell(path);
      expect(
        screen.queryByRole('button', { name: FEEDBACK_FAB_NAME }),
      ).not.toBeInTheDocument();
    },
  );

  it('does NOT hide on a sibling path that merely shares the /tickets prefix', () => {
    renderShell('/ticketsomething');
    expect(
      screen.getByRole('button', { name: FEEDBACK_FAB_NAME }),
    ).toBeInTheDocument();
  });

  it('co-exists with ChatFab — both render, neither replaces the other', () => {
    renderShell('/progress');
    expect(
      screen.getByRole('button', { name: FEEDBACK_FAB_NAME }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open chat · 대화' }),
    ).toBeInTheDocument();
  });

  it('tapping it navigates to /tickets with { compose: true, sourcePage } derived from the CURRENT route via nav.ts', async () => {
    const user = userEvent.setup();
    renderShell('/progress');

    await user.click(screen.getByRole('button', { name: FEEDBACK_FAB_NAME }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/tickets');
    const state: unknown = JSON.parse(
      screen.getByTestId('state').textContent ?? 'null',
    );
    expect(state).toEqual({
      compose: true,
      sourcePage: { path: '/progress', name: 'Progress' },
    });
  });

  it('falls back to the raw path as `name` for a route with no nav.ts manifest entry', async () => {
    const user = userEvent.setup();
    renderShell('/some/unmapped-route');

    await user.click(screen.getByRole('button', { name: FEEDBACK_FAB_NAME }));

    const state: unknown = JSON.parse(
      screen.getByTestId('state').textContent ?? 'null',
    );
    expect(state).toEqual({
      compose: true,
      sourcePage: { path: '/some/unmapped-route', name: '/some/unmapped-route' },
    });
  });
});

describe('Shell — status-bar spacer (no decorative gap above the skyline)', () => {
  // happy-dom does no layout, so the on-screen "is it flush" question can't
  // be driven here — pin the stylesheet instead. Regression coverage for
  // the blank-gap bug: `.km-shell__statusbar` used to be
  // `max(54px, env(safe-area-inset-top))`, which forced a permanent ~54px
  // bar above every page's header (SkylineHeader, via PageHubHeader) on any
  // device/browser reporting `env(safe-area-inset-top)` as 0 — virtually
  // all Android phones, notch-less iPhones, and every desktop browser,
  // since `max()` always keeps the fixed floor once it's the larger value.
  // The rule must size to ONLY the real safe-area inset (0 there, flush;
  // the actual inset on notched devices, clearing the notch without a
  // decorative gap) and must never reintroduce a fixed-px floor via `max(`.
  it('sizes to the safe-area inset only — no fixed-px floor', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'styles', 'index.css'),
      'utf8',
    );
    const rule = /\.km-shell__statusbar\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(rule).not.toBe('');
    // Strip block comments before asserting — the rule's own doc comment
    // explains (and mentions) the old `max(54px, ...)` regression it fixed,
    // which would otherwise false-positive the negative check below.
    const declarations = rule.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).toMatch(/height:\s*env\(safe-area-inset-top(?:,\s*0px)?\)\s*;/);
    // The regression this test exists to catch: a `max(` reintroducing a
    // fixed-px minimum would defeat the flush-at-top fix even though the
    // rule still mentions `env(safe-area-inset-top)`.
    expect(declarations).not.toMatch(/\bmax\(/);
  });
});
