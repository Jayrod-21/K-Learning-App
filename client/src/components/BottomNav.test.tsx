/**
 * BottomNav (P1.1) — 5 slots (4 tabs + the LEARN hexagon), active-tab
 * longest-prefix matching on the new paths, hexagon toggle semantics.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BottomNav } from './BottomNav';

function renderNavAt(
  path: string,
  { learnOpen = false, onToggleLearn = vi.fn() } = {},
): { onToggleLearn: ReturnType<typeof vi.fn> } {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <BottomNav
              learnOpen={learnOpen}
              onToggleLearn={onToggleLearn}
              learnMenuId="learn-menu-test"
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onToggleLearn };
}

describe('BottomNav (P1.1)', () => {
  it('renders 5 slots: 4 primary tabs + the LEARN hexagon in the center', () => {
    renderNavAt('/');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const buttons = Array.from(nav.querySelectorAll('button'));
    expect(buttons).toHaveLength(5);
    // Order: today · progress · LEARN · review · settings.
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Today · 오늘',
      'Progress · 성장',
      'Learn · 배움',
      'Review · 복습',
      'Settings · 설정',
    ]);
  });

  it('marks the matching tab active (aria-current) and no other', () => {
    renderNavAt('/progress');
    expect(screen.getByRole('button', { name: 'Progress · 성장' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
  });

  it('lights Review for library sub-pages (/review/mistakes) via longest-prefix', () => {
    renderNavAt('/review/mistakes');
    expect(screen.getByRole('button', { name: 'Review · 복습' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('lights NO primary tab on a /learn/* page — the hexagon carries the state', () => {
    renderNavAt('/learn/vocab');
    expect(
      screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Learn · 배움' }).className).toContain(
      'km-bottomnav__hex--current',
    );
  });

  it('hexagon is a toggle button, not a link: aria-expanded + onToggleLearn', async () => {
    const user = userEvent.setup();
    const { onToggleLearn } = renderNavAt('/');
    const hex = screen.getByRole('button', { name: 'Learn · 배움' });
    expect(hex).toHaveAttribute('aria-haspopup', 'dialog');
    expect(hex).toHaveAttribute('aria-expanded', 'false');
    expect(hex).not.toHaveAttribute('aria-current');
    await user.click(hex);
    expect(onToggleLearn).toHaveBeenCalledTimes(1);
  });

  it('reflects the open menu: aria-expanded=true, aria-controls wired, tabs unlit', () => {
    renderNavAt('/progress', { learnOpen: true });
    const hex = screen.getByRole('button', { name: 'Learn · 배움' });
    expect(hex).toHaveAttribute('aria-expanded', 'true');
    expect(hex).toHaveAttribute('aria-controls', 'learn-menu-test');
    // While the menu is open only the hexagon reads active.
    expect(
      screen.getByRole('button', { name: 'Progress · 성장' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('there is no "More" opener any more (retired with MoreSheet)', () => {
    renderNavAt('/');
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });
});
