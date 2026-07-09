/**
 * LearnMenu (P1.1 + Modern Seoul honeycomb) — upward study launcher: renders
 * all 7 LEARN sub-pages as hex-tile buttons in a 2-3-2 honeycomb, navigates
 * + closes on tile tap, closes on scrim tap and Esc.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { LEARN_SUBPAGE_IDS, navItem } from '../lib/nav';
import { LearnMenu } from './LearnMenu';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderMenu(
  onClose = vi.fn(),
  initialPath = '/',
): { onClose: ReturnType<typeof vi.fn> } {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <LearnMenu id="learn-menu-test" onClose={onClose} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
}

describe('LearnMenu (P1.1, honeycomb)', () => {
  it('renders a dialog listing all 7 LEARN sub-pages (label + kr)', () => {
    renderMenu();
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });
    expect(dialog).toHaveAttribute('id', 'learn-menu-test');
    const tiles = Array.from(dialog.querySelectorAll('button'));
    expect(tiles).toHaveLength(7);
    for (const id of LEARN_SUBPAGE_IDS) {
      const it_ = navItem(id);
      expect(screen.getByText(it_.label)).toBeInTheDocument();
      // kr sublabels can repeat across the app but must be inside the menu.
      // (P3a: tiles render through <Bilingual/> — the Korean half carries
      // .km-bilingual__kr; in the default 'both' Korean-first mode it is
      // the MAIN segment.)
      expect(
        Array.from(dialog.querySelectorAll('.km-bilingual__kr')).map(
          (el) => el.textContent,
        ),
      ).toContain(it_.kr);
    }
  });

  it('arranges the comb 2-3-2 with a category hue on every tile', () => {
    renderMenu();
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });
    const rows = Array.from(dialog.querySelectorAll('.km-learnmenu__combrow'));
    expect(rows.map((r) => r.querySelectorAll('button').length)).toEqual([
      2, 3, 2,
    ]);
    // Every tile wrapper carries a `--<hue>` modifier (the CSS keys the
    // soft bg / ink text / bright icon triplet off it).
    const wraps = Array.from(
      dialog.querySelectorAll<HTMLElement>('.km-learnmenu__hexwrap'),
    );
    expect(wraps).toHaveLength(7);
    for (const wrap of wraps) {
      expect(
        Array.from(wrap.classList).some((c) =>
          /^km-learnmenu__hexwrap--(indigo|violet|ochre|cyan|moss|vermilion)$/.test(
            c,
          ),
        ),
      ).toBe(true);
    }
  });

  it('navigates to the tile target and closes on activation', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();

    await user.click(screen.getByRole('button', { name: /Vocab flashcards/ }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/learn/vocab');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks the tile for the current route with aria-current="page"', () => {
    renderMenu(vi.fn(), '/learn/vocab');
    expect(
      screen.getByRole('button', { name: /Vocab flashcards/ }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Grammar practice/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('closes on scrim tap', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Close Learn menu' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    // A scrim tap must not navigate anywhere.
    expect(screen.getByTestId('pathname')).toHaveTextContent('/');
  });

  it('closes on Escape (useModalA11y)', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves initial focus into the menu (first tile, top-left of the comb)', () => {
    renderMenu();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Reading/ }),
    );
  });

  it('gives the initially-focused tile a zero entrance delay (visible on focus)', () => {
    renderMenu();
    const focused = document.activeElement as HTMLElement;
    // The stagger animation lives on the tile's wrapper (the clip-path-free
    // element that also carries the drop-shadow focus ring). The focused
    // tile must not sit invisible behind a stagger delay…
    const focusedWrap = focused.closest<HTMLElement>('.km-learnmenu__hexwrap');
    expect(focusedWrap?.style.animationDelay).toBe('0ms');
    // …while the bottom-up row stagger stays intact for the rest of the top
    // row (second tile in DOM order carries the largest delay).
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });
    const wraps = Array.from(
      dialog.querySelectorAll<HTMLElement>('.km-learnmenu__hexwrap'),
    );
    expect(wraps[1]?.style.animationDelay).not.toBe('0ms');
  });
});
