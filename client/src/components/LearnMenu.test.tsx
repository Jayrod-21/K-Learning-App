/**
 * LearnMenu (P1.1 + Modern Seoul honeycomb) — upward study launcher: renders
 * all 7 LEARN sub-pages as hex-tile buttons in a 2-3-2 honeycomb, navigates
 * + closes on tile tap, closes on scrim tap and Esc. Close-out (motion
 * polish): a `closing` prop swaps the entrance cascade for a reverse-
 * staggered exit and the LAST tile's animationend reports `onExited`
 * (Shell's cue to actually unmount — see Shell.test.tsx for the full
 * phase-machine behaviour).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  { closing = false, onExited = vi.fn() } = {},
): {
  onClose: ReturnType<typeof vi.fn>;
  onExited: ReturnType<typeof vi.fn>;
} {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <LearnMenu
                id="learn-menu-test"
                onClose={onClose}
                closing={closing}
                onExited={onExited}
              />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose, onExited };
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

  it('F-189: wires the canonical per-skill hue map — the SAME six skill→hue tokens Today\'s tile carousels consume — with Writing no longer colliding with TOPIK', () => {
    // Regression pin for the F-189 fix: before this batch, `writing` and
    // `topik` both carried `--hexwrap--vermilion`, the exact bug this
    // ticket fixes (a "Register drill" tile and the "Recommended" tile
    // reading as the same color). Grammar now takes over the vermilion/
    // accent family from Writing (an accepted, non-adjacent tradeoff with
    // TOPIK — see the module header comment), freeing Writing onto violet.
    renderMenu();

    function hueOf(name: string): string {
      const btn = screen.getByRole('button', { name: new RegExp(name) });
      const wrap = btn.closest<HTMLElement>('.km-learnmenu__hexwrap');
      expect(wrap).not.toBeNull();
      const hueClass = Array.from(wrap?.classList ?? []).find((c) =>
        c.startsWith('km-learnmenu__hexwrap--'),
      );
      return hueClass?.replace('km-learnmenu__hexwrap--', '') ?? '';
    }

    expect(hueOf('Vocab flashcards')).toBe('indigo');
    expect(hueOf('Grammar practice')).toBe('vermilion');
    expect(hueOf('Hanja')).toBe('ochre');
    expect(hueOf('Reading')).toBe('cyan');
    expect(hueOf('Writing')).toBe('violet');
    expect(hueOf('TOPIK')).toBe('vermilion');

    // Writing must NOT share a hue with TOPIK anymore (the bug F-189 fixes)…
    expect(hueOf('Writing')).not.toBe(hueOf('TOPIK'));
    // …and every one of the SIX canonical skills (excluding TOPIK, which is
    // deliberately kept on the accent/vermilion family, not one of the 6)
    // is pairwise distinct from every other one.
    const sixSkillHues = [
      hueOf('Vocab flashcards'),
      hueOf('Grammar practice'),
      hueOf('Hanja'),
      hueOf('Reading'),
      // Listening's accessible name (nav.ts) — matched loosely below.
      hueOf('Listen'),
      hueOf('Writing'),
    ];
    expect(new Set(sixSkillHues).size).toBe(sixSkillHues.length);
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
      screen.getByRole('button', { name: /Vocab flashcards/ }),
    );
  });

  it('carries the Seoul Day & Night reskin surfaces (F-128/F-131) without adding to the tab/button count', () => {
    renderMenu();
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });

    // Decorative backdrop: hanji/signboard grain + Night rain-sheen + an
    // accent-tracking glow (F-131 — this glow is keyed to --vermilion, the
    // accent picker's token, never a skill hue). Out of the a11y tree and
    // not a `<button>`, so it must not perturb the "7 tiles" contract.
    const backdrop = dialog.querySelector('.km-learnmenu__backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(backdrop).toHaveClass('km-giwa', 'km-rain-sheen', 'km-neon-box');
    expect(dialog.querySelectorAll('button')).toHaveLength(7);

    // Title glow tracks the accent (km-neon-text), not a skill hue.
    const title = screen.getByText('Learn').closest('.km-learnmenu__title');
    expect(title).toHaveClass('km-neon-text');

    // Every hex tile carries the same per-tile grain as the backdrop.
    const tiles = Array.from(
      dialog.querySelectorAll<HTMLElement>('.km-learnmenu__hex'),
    );
    expect(tiles).toHaveLength(7);
    for (const tile of tiles) {
      expect(tile).toHaveClass('km-giwa');
    }

    // Fix-pass batch-4 (REVIEW_batch4-launcher.md S1): the one-time Night
    // mount flicker now lives on the STATIC title, not the panel — the panel
    // is the parent of every tile's own opacity entrance stagger, and
    // stacking the flicker there compounded multiplicatively with it. The
    // title has no competing opacity animation, so this is the single
    // intentional power-on effect.
    expect(title).toHaveClass('km-neon-flicker');
    expect(dialog).not.toHaveClass('km-neon-flicker');
  });

  it('keeps the reskin backdrop mounted through the close-out cascade', () => {
    renderMenu(vi.fn(), '/', { closing: true });
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });
    expect(dialog.querySelector('.km-learnmenu__backdrop')).not.toBeNull();
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

describe('LearnMenu — close-out (honeycomb motion polish)', () => {
  /** All 7 tile wrappers in DOM order (row-by-row, left-to-right). */
  function getWraps(): HTMLElement[] {
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });
    return Array.from(
      dialog.querySelectorAll<HTMLElement>('.km-learnmenu__hexwrap'),
    );
  }

  it('closing swaps to the exit cascade: --closing modifier + reverse row stagger (top row first)', () => {
    renderMenu(vi.fn(), '/', { closing: true });
    // Root carries the modifier that switches every tile to the exit
    // animation and turns pointer-events off (display-only exit).
    expect(document.querySelector('.km-learnmenu--closing')).not.toBeNull();
    // Reverse stagger: the top row (which appeared LAST) leaves first;
    // 2-3-2 rows → delays 0/0, mid/mid/mid, max/max in DOM order, strictly
    // increasing row by row with the bottom row last.
    const delays = getWraps().map((w) =>
      Number.parseInt(w.style.animationDelay, 10),
    );
    expect(delays).toHaveLength(7);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBe(0);
    expect(new Set(delays.slice(2, 5)).size).toBe(1);
    expect(delays[2]).toBeGreaterThan(0);
    expect(delays[5]).toBeGreaterThan(delays[2] ?? 0);
    expect(delays[6]).toBe(delays[5]);
  });

  it("reports onExited when the LAST tile's exit animation ends — and only then", () => {
    const { onExited } = renderMenu(vi.fn(), '/', { closing: true });
    const wraps = getWraps();
    // Other tiles finishing must not unmount the menu early…
    fireEvent.animationEnd(wraps[0] as HTMLElement);
    fireEvent.animationEnd(wraps[3] as HTMLElement);
    expect(onExited).not.toHaveBeenCalled();
    // …the sentinel is the final tile of the bottom row (largest delay —
    // it finishes last).
    fireEvent.animationEnd(wraps[6] as HTMLElement);
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it('ignores the sentinel animationend while NOT closing (entrance must not unmount)', () => {
    const { onExited } = renderMenu(vi.fn(), '/', { closing: false });
    const wraps = getWraps();
    fireEvent.animationEnd(wraps[6] as HTMLElement);
    expect(onExited).not.toHaveBeenCalled();
  });

  it('ignores bubbled child animationend on the sentinel (target guard)', () => {
    const { onExited } = renderMenu(vi.fn(), '/', { closing: true });
    const wraps = getWraps();
    const childButton = (wraps[6] as HTMLElement).querySelector('button');
    fireEvent.animationEnd(childButton as HTMLElement);
    expect(onExited).not.toHaveBeenCalled();
  });

  it('keeps the dialog + Esc wiring live while closing (focus restore waits for the real unmount)', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu(vi.fn(), '/', { closing: true });
    // The dialog is still mounted mid-exit…
    expect(
      screen.getByRole('dialog', { name: '배움 · Learn' }),
    ).toBeInTheDocument();
    // …and a repeat Esc still routes to onClose (Shell no-ops it there).
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
