/**
 * Shell — device-adaptive chrome swap (device-adaptive epic, Phase D0).
 *
 * `useDeviceClass` decides which primary-nav chrome Shell mounts:
 *   - the default test `matchMedia` (a `matches: false` stub installed for
 *     every test in `src/test/setup.ts` — see that file's header for why:
 *     happy-dom's OWN width-query implementation reads a desktop-ish
 *     1024×768 default that test code cannot reach from outside) →
 *     'mobile' → BottomNav + hexagon, Sidebar absent — i.e. today's
 *     chrome, byte-for-byte.
 *   - `matchMedia` mocked to report ≥768px → Sidebar mounted, BottomNav
 *     (and the LearnMenu it launches) never rendered.
 *
 * `useDeviceClass.test.tsx` separately covers the hook's OWN degrade
 * contract for a missing `matchMedia` entirely (older webviews); this file
 * only covers Shell's render branch. `Shell.test.tsx` covers the
 * (untouched) LearnMenu phase machine in detail.
 *
 * F-006 + guided-tour coupling: same harness posture as `Shell.test.tsx`
 * (see its module doc comment for the full rationale) — `AuthContext` is
 * supplied directly with a VERIFIED user so `<UnverifiedBanner/>`'s
 * `useAuth()` resolves and the banner renders null, and `TourProvider` is
 * kept inert (never-settling prefs fetch + an all-seen localStorage seed)
 * so no coach-mark tour can fire over the chrome assertions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { Shell } from './Shell';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { TOURS_SEEN_STORAGE_KEY } from '../hooks/tour-context';
import { TOUR_IDS } from '../lib/tours';

// Keep TourProvider un-hydrated (its auto-fire gate waits on this fetch
// settling), with no real network attempt — see Shell.test.tsx.
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

/** Signed-in + email-VERIFIED → UnverifiedBanner renders null. */
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
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderShellAt(initialPath = '/'): RenderResult {
  return render(
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

beforeEach(() => {
  // Defence in depth against tour auto-fire: every tour reads as seen.
  window.localStorage.setItem(
    TOURS_SEEN_STORAGE_KEY,
    JSON.stringify([...TOUR_IDS]),
  );
});

/** Stub `window.matchMedia` to report a fixed viewport width, mirroring
 *  `useDeviceClass`'s two `(min-width: Npx)` queries. */
function mockViewportWidth(width: number): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const m = /min-width:\s*(\d+)px/.exec(query);
      const threshold = m ? Number(m[1]) : 0;
      return {
        matches: width >= threshold,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  );
}

afterEach(() => {
  window.localStorage.removeItem(TOURS_SEEN_STORAGE_KEY);
  vi.unstubAllGlobals();
});

describe('Shell — mobile chrome (<768px, unchanged)', () => {
  it('renders BottomNav with the LEARN hexagon and no Sidebar at the default test matchMedia (setup.ts\'s mobile-safe stub)', () => {
    renderShellAt('/');

    expect(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Learn · 배움' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Korean Master')).not.toBeInTheDocument();
  });

  it('renders BottomNav (not Sidebar) when matchMedia explicitly reports a narrow viewport', () => {
    mockViewportWidth(375);
    renderShellAt('/');

    expect(
      screen.getByRole('button', { name: 'Learn · 배움' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Korean Master')).not.toBeInTheDocument();
  });
});

describe('Shell — sidebar chrome (≥768px)', () => {
  it('mounts Sidebar and does NOT mount BottomNav/the LEARN hexagon at tablet width', () => {
    mockViewportWidth(768);
    renderShellAt('/');

    expect(screen.getByText('Korean Master')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Learn · 배움' }),
    ).not.toBeInTheDocument();
  });

  it('mounts Sidebar at desktop width too', () => {
    mockViewportWidth(1280);
    renderShellAt('/progress');

    expect(screen.getByText('Korean Master')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Progress · 성장' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('the routed page still renders through the Outlet, same as mobile', () => {
    mockViewportWidth(1280);
    renderShellAt('/progress');

    expect(screen.getByTestId('pathname')).toHaveTextContent('/progress');
  });
});

describe('Shell — LearnMenu DOM position (fix-pass: restored pre-D0 sibling relationship)', () => {
  it('mounts .km-learnmenu as a sibling of .km-shell, not nested inside it', async () => {
    const user = userEvent.setup();
    const { container } = renderShellAt('/');

    await user.click(screen.getByRole('button', { name: 'Learn · 배움' }));

    const shell = container.querySelector('.km-shell');
    const learnMenu = container.querySelector('.km-learnmenu');
    expect(shell).not.toBeNull();
    expect(learnMenu).not.toBeNull();
    // Sibling, not descendant: `.km-shell` must not contain `.km-learnmenu`
    // (pre-D0 shape — see Shell.tsx's header comment on why this matters:
    // `.km-learnmenu` is `position: fixed; inset: 0` and must never risk
    // being trapped inside a future transformed/filtered `.km-shell`).
    expect(shell?.contains(learnMenu)).toBe(false);
    expect(learnMenu?.parentElement).toBe(shell?.parentElement);
  });
});

describe('.km-appframe / .km-shell flex layout (fix-pass: BLOCKER-1)', () => {
  it('`.km-shell` claims the row\'s remaining space at ≥768px via flex-grow, clamped by its max-width cap', () => {
    const css = readFileSync(join(cwd(), 'src/styles/index.css'), 'utf8');
    // Without this, `.km-shell` (a flex item with no flex-grow) sizes to
    // its own content instead of stretching to the raised desktop cap —
    // the exact BLOCKER this fix-pass addresses.
    expect(css).toMatch(
      /\.km-shell\s*\{\s*max-width:\s*var\(--shell-desktop-max-width\);\s*flex:\s*1 1 auto;\s*min-width:\s*0;/,
    );
  });

  it('`.km-appframe` does not center the [Sidebar, .km-shell] row as one unit at ≥768px', () => {
    const css = readFileSync(join(cwd(), 'src/styles/index.css'), 'utf8');
    // `justify-content: center` on the row would center Sidebar+shell
    // together, floating the persistent left rail away from the true
    // viewport edge — Sidebar must stay pinned left, with `.km-shell`'s own
    // margin centering its content within the remaining track instead.
    expect(css).toMatch(
      /\.km-appframe\s*\{\s*display:\s*flex;\s*justify-content:\s*flex-start;/,
    );
  });
});
