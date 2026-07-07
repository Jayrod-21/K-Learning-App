/**
 * Topbar (Overhaul P3a) — bilingual title wiring.
 *
 * Coverage:
 *   - string krTitle + title render through <Bilingual/> and follow the
 *     language-display setting (both / en / ko);
 *   - the accessible heading name keeps both languages in single-language
 *     visual modes;
 *   - titleId lands on the h1 (aria-labelledby target);
 *   - a legacy ReactNode krTitle renders verbatim (P3b migration path).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Topbar } from './Topbar';
import { SettingsProvider } from '../hooks/SettingsProvider';
import { SETTINGS_STORAGE_KEY } from '../lib/settings';
import type { LanguageDisplayPrefs } from '../types/domain';

function renderTopbar(
  ui: ReactNode,
  languageDisplay?: LanguageDisplayPrefs,
): void {
  if (languageDisplay) {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ languageDisplay }),
    );
  }
  render(<SettingsProvider>{ui}</SettingsProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Topbar — bilingual title', () => {
  it("default ('both', Korean-first): kr main + en sub in the h1", () => {
    renderTopbar(<Topbar krTitle="설정" title="Settings" titleId="t" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.id).toBe('t');
    expect(h1.textContent?.replace(/\s+/g, ' ').trim()).toBe('설정 · Settings');
    expect(h1.querySelector('.km-bilingual__sub')?.textContent).toBe(
      'Settings',
    );
  });

  it("'en' mode: only English visible, heading NAME still carries both", () => {
    renderTopbar(<Topbar krTitle="설정" title="Settings" />, {
      mode: 'en',
      primary: 'ko',
      subScale: 0.7,
    });
    // Accessible name = sr-only reading (aria-hidden visible half excluded).
    const h1 = screen.getByRole('heading', {
      level: 1,
      name: 'Settings · 설정',
    });
    expect(h1.querySelector('.km-sr-only')?.textContent).toBe(
      'Settings · 설정',
    );
    expect(h1.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'Settings',
    );
  });

  it("'ko' mode: only Korean visible", () => {
    renderTopbar(<Topbar krTitle="설정" title="Settings" />, {
      mode: 'ko',
      primary: 'ko',
      subScale: 0.7,
    });
    const h1 = screen.getByRole('heading', { level: 1, name: '설정 · Settings' });
    expect(h1.querySelector('[aria-hidden="true"]')?.textContent).toBe('설정');
  });

  it("'both' English-first flips the order", () => {
    renderTopbar(<Topbar krTitle="설정" title="Settings" />, {
      mode: 'both',
      primary: 'en',
      subScale: 0.7,
    });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent?.replace(/\s+/g, ' ').trim()).toBe('Settings · 설정');
  });

  it('legacy ReactNode krTitle renders verbatim (no Bilingual)', () => {
    renderTopbar(
      <Topbar krTitle={<span id="legacy">복습 · Review</span>} />,
      { mode: 'en', primary: 'ko', subScale: 0.7 },
    );
    // The setting does NOT apply to un-migrated pre-composed titles.
    expect(screen.getByText('복습 · Review')).toBeInTheDocument();
  });

  it('renders eyebrow and right slot around the title', () => {
    renderTopbar(
      <Topbar krTitle="오늘" title="Today" eyebrow="Daily plan" right={<button type="button">Act</button>} />,
    );
    expect(screen.getByText('Daily plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
  });
});
