/**
 * LearnMenu (P1.1) — upward study menu: lists all 7 LEARN sub-pages,
 * navigates + closes on row tap, closes on scrim tap and Esc.
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

function renderMenu(onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  render(
    <MemoryRouter initialEntries={['/']}>
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

describe('LearnMenu (P1.1)', () => {
  it('renders a dialog listing all 7 LEARN sub-pages (label + kr)', () => {
    renderMenu();
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });
    expect(dialog).toHaveAttribute('id', 'learn-menu-test');
    const rows = Array.from(dialog.querySelectorAll('button'));
    expect(rows).toHaveLength(7);
    for (const id of LEARN_SUBPAGE_IDS) {
      const it_ = navItem(id);
      expect(screen.getByText(it_.label)).toBeInTheDocument();
      // kr sublabels can repeat across the app but must be inside the menu.
      // (P3a: rows render through <Bilingual/> — the Korean half carries
      // .km-bilingual__kr; in the default 'both' Korean-first mode it is
      // the MAIN segment.)
      expect(
        Array.from(dialog.querySelectorAll('.km-bilingual__kr')).map(
          (el) => el.textContent,
        ),
      ).toContain(it_.kr);
    }
  });

  it('navigates to the row target and closes on activation', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();

    await user.click(screen.getByRole('button', { name: /Vocab flashcards/ }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/learn/vocab');
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it('moves initial focus into the menu (first row)', () => {
    renderMenu();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /TOPIK/ }),
    );
  });

  it('gives the initially-focused row a zero entrance delay (visible on focus)', () => {
    renderMenu();
    const focused = document.activeElement as HTMLElement;
    // The focused row must not sit invisible behind a stagger delay…
    expect(focused.style.animationDelay).toBe('0ms');
    // …while the bottom-up stagger stays intact for the other rows
    // (second row from the top carries a real delay).
    const dialog = screen.getByRole('dialog', { name: '배움 · Learn' });
    const rows = Array.from(
      dialog.querySelectorAll<HTMLElement>('.km-learnmenu__row'),
    );
    expect(rows[1]?.style.animationDelay).not.toBe('0ms');
  });
});
