/**
 * `useLanguageDisplay` — the resolved language-display setting for UI chrome
 * (Overhaul P3a): `{ mode, primary, subScale }`.
 *
 * Reads the server-synced prefs through the existing `SettingsContext` (the
 * palette pattern — NO separate localStorage store). `subScale` comes back
 * re-clamped so consumers never see an out-of-range value even if a stale
 * blob slipped past a merge.
 *
 * Unlike `useSettings`, this deliberately does NOT throw outside
 * `<SettingsProvider/>` — it returns the defaults ('both', Korean-first,
 * 0.7). Rationale: this selector feeds pure display primitives (`<Bilingual/>`,
 * Topbar, BottomNav) that render in dozens of isolated component tests and
 * must degrade to today's baked "kr · en" look rather than crash the tree.
 * A missing provider means "no user preference available", and the correct
 * rendering for that is the default — the same value the provider itself
 * would supply on first run.
 */
import { useContext, useMemo } from 'react';
import { SettingsContext } from './settings-context';
import { clampSubScale, DEFAULT_SETTINGS } from '../lib/settings';
import type { LanguageDisplayPrefs } from '../types/domain';

export function useLanguageDisplay(): LanguageDisplayPrefs {
  const ctx = useContext(SettingsContext);
  const raw = ctx?.settings.languageDisplay ?? DEFAULT_SETTINGS.languageDisplay;
  return useMemo(
    () => ({
      mode: raw.mode,
      primary: raw.primary,
      subScale: clampSubScale(raw.subScale),
    }),
    [raw.mode, raw.primary, raw.subScale],
  );
}
