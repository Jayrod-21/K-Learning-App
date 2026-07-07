/**
 * useLanguageDisplay (Overhaul P3a) — the language-display selector + the
 * provider's `--lang-sub-scale` CSS-var projection.
 *
 * Coverage:
 *   - resolves each stored mode/primary/subScale from the (localStorage-
 *     seeded) SettingsProvider;
 *   - returns the defaults when the stored blob predates the field;
 *   - re-clamps an out-of-range subScale;
 *   - SettingsProvider projects subScale onto `<html>` as --lang-sub-scale
 *     (and keeps it live across updates);
 *   - a palette-only update can never erase --lang-sub-scale (the
 *     ALLOWED_VARS / applyPaletteVars separation invariant);
 *   - degrades to the defaults WITHOUT a provider (deliberate — see the
 *     hook's doc-comment: display primitives must never crash the tree).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { SettingsProvider } from './SettingsProvider';
import { useLanguageDisplay } from './useLanguageDisplay';
import { useSettings } from './useSettings';
import {
  LANG_SUB_SCALE_CSS_VAR,
  SETTINGS_STORAGE_KEY,
} from '../lib/settings';
import type { LanguageDisplayPrefs } from '../types/domain';

function seed(languageDisplay: Partial<LanguageDisplayPrefs>): void {
  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ languageDisplay }),
  );
}

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <SettingsProvider>{children}</SettingsProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  document.documentElement.removeAttribute('style');
});

describe('useLanguageDisplay', () => {
  it('defaults to both / Korean-first / 0.7 when the stored blob lacks the field', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ name: 'Jared' }), // pre-P3a snapshot
    );
    const { result } = renderHook(() => useLanguageDisplay(), { wrapper });
    expect(result.current).toEqual({ mode: 'both', primary: 'ko', subScale: 0.7 });
  });

  it.each([
    ['en', 'en', 0.5],
    ['ko', 'ko', 0.4],
    ['both', 'en', 1.0],
  ] as const)('resolves stored mode=%s primary=%s subScale=%s', (mode, primary, subScale) => {
    seed({ mode, primary, subScale });
    const { result } = renderHook(() => useLanguageDisplay(), { wrapper });
    expect(result.current).toEqual({ mode, primary, subScale });
  });

  it('clamps an out-of-range stored subScale', () => {
    seed({ mode: 'both', primary: 'ko', subScale: 9 });
    const { result } = renderHook(() => useLanguageDisplay(), { wrapper });
    expect(result.current.subScale).toBe(1.0);
  });

  it('returns the defaults without a provider instead of throwing', () => {
    const { result } = renderHook(() => useLanguageDisplay());
    expect(result.current).toEqual({ mode: 'both', primary: 'ko', subScale: 0.7 });
  });
});

describe('SettingsProvider — --lang-sub-scale projection', () => {
  it('projects the stored subScale onto <html> on mount', () => {
    seed({ mode: 'both', primary: 'ko', subScale: 0.55 });
    renderHook(() => useLanguageDisplay(), { wrapper });
    expect(
      document.documentElement.style.getPropertyValue(LANG_SUB_SCALE_CSS_VAR),
    ).toBe('0.55');
  });

  it('projects the default 0.7 when the field is absent', () => {
    renderHook(() => useLanguageDisplay(), { wrapper });
    expect(
      document.documentElement.style.getPropertyValue(LANG_SUB_SCALE_CSS_VAR),
    ).toBe('0.7');
  });

  it('a palette-only settings update leaves --lang-sub-scale intact', () => {
    // Regression pin for the ALLOWED_VARS invariant: `applyPaletteVars`
    // clears every var it previously wrote that the new preset doesn't
    // declare, so if --lang-sub-scale ever entered the palette path (e.g.
    // someone adds it to ALLOWED_VARS or routes it through paletteVars), a
    // palette swap would erase it. This test fails the moment that happens.
    seed({ mode: 'both', primary: 'ko', subScale: 0.55 });
    const { result } = renderHook(() => useSettings(), { wrapper });
    expect(
      document.documentElement.style.getPropertyValue(LANG_SUB_SCALE_CSS_VAR),
    ).toBe('0.55');

    act(() => {
      result.current.updateSettings((prev) => ({
        ...prev,
        palette: { ...prev.palette, accent: 'indigo' },
      }));
    });

    // The palette projection ran (accent vars rewritten)…
    expect(
      document.documentElement.style.getPropertyValue('--vermilion'),
    ).toBe('#2E4F70');
    // …and the language-display scale survived untouched.
    expect(
      document.documentElement.style.getPropertyValue(LANG_SUB_SCALE_CSS_VAR),
    ).toBe('0.55');
  });

  it('tracks a live subScale change through updateSettings', () => {
    const { result } = renderHook(
      () => ({ display: useLanguageDisplay(), settings: useSettings() }),
      { wrapper },
    );
    act(() => {
      result.current.settings.updateSettings((prev) => ({
        ...prev,
        languageDisplay: { ...prev.languageDisplay, subScale: 0.9 },
      }));
    });
    expect(result.current.display.subScale).toBe(0.9);
    expect(
      document.documentElement.style.getPropertyValue(LANG_SUB_SCALE_CSS_VAR),
    ).toBe('0.9');
  });
});
