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
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { Shell } from './Shell';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderShellAt(initialPath = '/'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<Shell />}>
          <Route path="*" element={<LocationProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

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
