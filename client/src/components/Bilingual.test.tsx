/**
 * <Bilingual/> (Overhaul P3a) — the bilingual-chrome primitive.
 *
 * Coverage:
 *   - 'en' / 'ko' modes render exactly one language visually while the
 *     accessible text keeps BOTH (sr-only span; visible half aria-hidden);
 *   - 'both' renders main + "·" + sub in `primary` order, the sub carrying
 *     `.km-bilingual__sub` (sized by --lang-sub-scale via CSS);
 *   - `compact` collapses 'both' to the primary language visually, sr keeps
 *     both;
 *   - missing-language fallback: whatever exists renders, never a blank;
 *   - Korean segments carry lang="ko" + the `kr` font class.
 *
 * The setting is seeded through localStorage + SettingsProvider (the real
 * read path); no provider at all falls back to 'both' (hook contract).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Bilingual, type BilingualProps } from './Bilingual';
import { SettingsProvider } from '../hooks/SettingsProvider';
import { SETTINGS_STORAGE_KEY } from '../lib/settings';
import type { LanguageDisplayPrefs } from '../types/domain';

function renderBilingual(
  props: BilingualProps,
  languageDisplay?: Partial<LanguageDisplayPrefs>,
): HTMLElement {
  if (languageDisplay) {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ languageDisplay }),
    );
  }
  const { container } = render(
    <SettingsProvider>
      <Bilingual {...props} />
    </SettingsProvider>,
  );
  const root = container.querySelector('.km-bilingual');
  if (!(root instanceof HTMLElement)) throw new Error('no .km-bilingual root');
  return root;
}

/** The text a sighted user sees (excludes the .km-sr-only duplicate). */
function visibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.km-sr-only').forEach((el) => {
    el.remove();
  });
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Bilingual — modes', () => {
  it("mode 'en': English visible, Korean only in the sr-only reading", () => {
    const root = renderBilingual(
      { en: 'Settings', kr: '설정' },
      { mode: 'en', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('Settings');
    // The visible half is hidden from AT; the sr-only span carries both.
    expect(root.querySelector('[aria-hidden="true"]')?.textContent).toContain(
      'Settings',
    );
    expect(root.querySelector('.km-sr-only')?.textContent).toBe(
      'Settings · 설정',
    );
  });

  it("mode 'ko': Korean visible, English only in the sr-only reading", () => {
    const root = renderBilingual(
      { en: 'Settings', kr: '설정' },
      { mode: 'ko', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('설정');
    expect(root.querySelector('.km-sr-only')?.textContent).toBe(
      '설정 · Settings',
    );
  });

  it("mode 'both' + Korean-first: kr main, en sub, separator between", () => {
    const root = renderBilingual(
      { en: 'Settings', kr: '설정' },
      { mode: 'both', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('설정 · Settings');
    const main = root.querySelector('.km-bilingual__main');
    const sub = root.querySelector('.km-bilingual__sub');
    expect(main?.textContent).toBe('설정');
    expect(sub?.textContent).toBe('Settings');
    // No sr duplicate needed — both languages are already visible.
    expect(root.querySelector('.km-sr-only')).toBeNull();
  });

  it("mode 'both' + English-first: en main, kr sub", () => {
    const root = renderBilingual(
      { en: 'Settings', kr: '설정' },
      { mode: 'both', primary: 'en', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('Settings · 설정');
    expect(root.querySelector('.km-bilingual__main')?.textContent).toBe(
      'Settings',
    );
    expect(root.querySelector('.km-bilingual__sub')?.textContent).toBe('설정');
  });

  it('defaults to both/Korean-first when nothing is stored', () => {
    const root = renderBilingual({ en: 'Learn', kr: '배움' });
    expect(visibleText(root)).toBe('배움 · Learn');
  });

  it("compact: 'both' shows only the primary visually, sr keeps both", () => {
    const root = renderBilingual(
      { en: 'LEARN', kr: '배움', compact: true },
      { mode: 'both', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('배움');
    expect(root.querySelector('.km-sr-only')?.textContent).toBe(
      '배움 · LEARN',
    );
  });
});

describe('Bilingual — missing-language fallback', () => {
  it("mode 'en' with no English falls back to Korean (never blank)", () => {
    const root = renderBilingual(
      { kr: '설정' },
      { mode: 'en', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('설정');
    expect(root.querySelector('.km-sr-only')).toBeNull();
  });

  it("mode 'ko' with no Korean falls back to English", () => {
    const root = renderBilingual(
      { en: 'Settings' },
      { mode: 'ko', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('Settings');
  });

  it("mode 'both' with one language renders it plainly (no separator)", () => {
    const root = renderBilingual(
      { en: 'Settings' },
      { mode: 'both', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('Settings');
    expect(root.querySelector('.km-bilingual__sep')).toBeNull();
  });

  it('whitespace-only counts as absent', () => {
    const root = renderBilingual(
      { en: '   ', kr: '설정' },
      { mode: 'both', primary: 'ko', subScale: 0.7 },
    );
    expect(visibleText(root)).toBe('설정');
  });

  it('renders an empty wrapper (no crash) when both are absent', () => {
    const root = renderBilingual({}, { mode: 'both', primary: 'ko', subScale: 0.7 });
    expect(visibleText(root)).toBe('');
  });
});

describe('Bilingual — language tagging', () => {
  it('Korean segments carry lang="ko" and the kr font class', () => {
    const root = renderBilingual(
      { en: 'Settings', kr: '설정' },
      { mode: 'both', primary: 'ko', subScale: 0.7 },
    );
    const kr = root.querySelector('.km-bilingual__kr');
    expect(kr?.getAttribute('lang')).toBe('ko');
    expect(kr?.classList.contains('kr')).toBe(true);
    const en = root.querySelector('.km-bilingual__en');
    expect(en?.getAttribute('lang')).toBe('en');
  });

  it("sr-only reading lang-tags each half — Korean keeps its SR voice switch (mode 'en')", () => {
    const root = renderBilingual(
      { en: 'Settings', kr: '설정' },
      { mode: 'en', primary: 'ko', subScale: 0.7 },
    );
    const sr = root.querySelector('.km-sr-only');
    // Computed name content is unchanged — both languages, once each…
    expect(sr?.textContent).toBe('Settings · 설정');
    // …but the Korean half is now inside a lang="ko" span so AT switches voice.
    expect(sr?.querySelector('span[lang="ko"]')?.textContent).toBe('설정');
    expect(sr?.querySelector('span[lang="en"]')?.textContent).toBe('Settings');
  });

  it("sr-only lang tags follow the visible-first ordering (compact 'both', Korean-first)", () => {
    const root = renderBilingual(
      { en: 'LEARN', kr: '배움', compact: true },
      { mode: 'both', primary: 'ko', subScale: 0.7 },
    );
    const sr = root.querySelector('.km-sr-only');
    expect(sr?.textContent).toBe('배움 · LEARN');
    expect(sr?.querySelector('span[lang="ko"]')?.textContent).toBe('배움');
    expect(sr?.querySelector('span[lang="en"]')?.textContent).toBe('LEARN');
  });

  it('the separator stays in the text flow (accessible name = visible "kr · en")', () => {
    const root = renderBilingual(
      { en: 'Settings', kr: '설정' },
      { mode: 'both', primary: 'ko', subScale: 0.7 },
    );
    expect(root.querySelector('.km-bilingual__sep')?.textContent).toBe(' · ');
  });
});
