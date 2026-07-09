/**
 * BottomNav (P1.1) — 5 slots (4 tabs + the LEARN hexagon), active-tab
 * longest-prefix matching on the new paths, hexagon toggle semantics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { SettingsProvider } from '../hooks/SettingsProvider';
import { SETTINGS_STORAGE_KEY } from '../lib/settings';
import type { LanguageDisplayPrefs } from '../types/domain';

function renderNavAt(
  path: string,
  {
    learnOpen = false,
    learnClosing = false,
    onToggleLearn = vi.fn(),
  } = {},
): { onToggleLearn: ReturnType<typeof vi.fn> } {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <BottomNav
              learnOpen={learnOpen}
              learnClosing={learnClosing}
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

  it('closing phase: aria-expanded already false, spin class dropped, float held off, controls still wired', () => {
    renderNavAt('/', { learnClosing: true });
    const hex = screen.getByRole('button', { name: 'Learn · 배움' });
    // AT hears the menu as closed the moment the close is REQUESTED…
    expect(hex).toHaveAttribute('aria-expanded', 'false');
    // …the un-spin plays (no --open), with --closing pausing the idle
    // float so it can't bob mid-rotation…
    expect(hex.className).not.toContain('km-bottomnav__hex--open');
    expect(hex.className).toContain('km-bottomnav__hex--closing');
    // …and aria-controls stays wired: the panel is still MOUNTED while the
    // exit cascade plays.
    expect(hex).toHaveAttribute('aria-controls', 'learn-menu-test');
  });

  it('there is no "More" opener any more (retired with MoreSheet)', () => {
    renderNavAt('/');
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });
});

// ─── P3a: labels follow the language-display setting ───────────────────

/** Render the nav under a SettingsProvider seeded with a language setting. */
function renderNavWithLang(languageDisplay: LanguageDisplayPrefs): void {
  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ languageDisplay }),
  );
  render(
    <SettingsProvider>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="*"
            element={
              <BottomNav
                learnOpen={false}
                learnClosing={false}
                onToggleLearn={vi.fn()}
                learnMenuId="learn-menu-test"
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </SettingsProvider>,
  );
}

/** Visible text of an element, excluding sr-only duplicates. */
function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.km-sr-only').forEach((n) => {
    n.remove();
  });
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('BottomNav — language display (P3a)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("'en' mode: tab labels show English only; aria-labels keep both", () => {
    renderNavWithLang({ mode: 'en', primary: 'ko', subScale: 0.7 });
    const today = screen.getByRole('button', { name: 'Today · 오늘' });
    const label = today.querySelector('.km-bottomnav__label');
    expect(label).not.toBeNull();
    expect(visibleText(label as Element)).toBe('Today');
  });

  it("'ko' mode: tab labels show Korean only", () => {
    renderNavWithLang({ mode: 'ko', primary: 'ko', subScale: 0.7 });
    const today = screen.getByRole('button', { name: 'Today · 오늘' });
    expect(
      visibleText(today.querySelector('.km-bottomnav__label') as Element),
    ).toBe('오늘');
  });

  it("'both' Korean-first: tab shows the PRIMARY only (compact — tabs are too small for two scripts); aria-label keeps both", () => {
    renderNavWithLang({ mode: 'both', primary: 'ko', subScale: 0.7 });
    // getByRole by accessible name proves the aria-label still carries both
    // languages even though only one is visible.
    const today = screen.getByRole('button', { name: 'Today · 오늘' });
    expect(today).toHaveAttribute('aria-label', 'Today · 오늘');
    expect(
      visibleText(today.querySelector('.km-bottomnav__label') as Element),
    ).toBe('오늘');
  });

  it("'both' English-first: tab shows English only; aria-label keeps both", () => {
    renderNavWithLang({ mode: 'both', primary: 'en', subScale: 0.7 });
    const today = screen.getByRole('button', { name: 'Today · 오늘' });
    expect(today).toHaveAttribute('aria-label', 'Today · 오늘');
    expect(
      visibleText(today.querySelector('.km-bottomnav__label') as Element),
    ).toBe('Today');
  });

  it("hexagon (compact): 'both' shows only the primary; 'en'/'ko' follow the mode", () => {
    renderNavWithLang({ mode: 'both', primary: 'ko', subScale: 0.7 });
    const hex = screen.getByRole('button', { name: 'Learn · 배움' });
    expect(
      visibleText(hex.querySelector('.km-bottomnav__hexlabel') as Element),
    ).toBe('배움');
  });

  it("hexagon in 'en' mode shows LEARN", () => {
    renderNavWithLang({ mode: 'en', primary: 'ko', subScale: 0.7 });
    const hex = screen.getByRole('button', { name: 'Learn · 배움' });
    expect(
      visibleText(hex.querySelector('.km-bottomnav__hexlabel') as Element),
    ).toBe('LEARN');
  });
});
