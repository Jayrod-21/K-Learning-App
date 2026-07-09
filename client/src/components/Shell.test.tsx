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
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { Shell } from './Shell';
import { LEARN_MENU_EXIT_MS } from './LearnMenu';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderShell(initialPath = '/'): void {
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

afterEach(() => {
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
