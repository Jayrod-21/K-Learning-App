/**
 * Theme context object + types. Kept separate from the Provider so the
 * React Refresh rule (`react-refresh/only-export-components`) stays clean
 * across both `ThemeProvider.tsx` and `useTheme.ts`.
 */
import { createContext } from 'react';

export type Theme = 'light' | 'dark';

/**
 * The user's explicit preference. `'system'` means "no stored choice — follow
 * the OS `prefers-color-scheme`", which is the absence of `km.theme`. `'auto'`
 * (F-132) means "resolve Day/Night Seoul from the local wall-clock time" —
 * see `resolveAutoTheme` below. `theme` is always the RESOLVED light/dark
 * currently applied; `mode` is the user's intent (which may be `'system'` or
 * `'auto'`).
 */
export type ThemeMode = 'light' | 'dark' | 'system' | 'auto';

/**
 * `'auto'` mode's local-time boundaries (F-132): Day Seoul (light) from
 * {@link AUTO_DAY_START_HOUR}:00 (inclusive) to {@link AUTO_DAY_END_HOUR}:00
 * (exclusive) local time; Night Seoul (dark) the rest of the day. A fixed
 * 06:00–18:00 window is a deliberate simplification over a real sunrise/
 * sunset calculation (which would need geolocation or a solar-position
 * library) — it's a close-enough, zero-dependency default that matches the
 * "office hours are day, evening is night" mental model most users have.
 * Kept in sync by hand with the no-flash bootstrap in `client/index.html`
 * (that inline `<script>` can't import this module).
 */
export const AUTO_DAY_START_HOUR = 6;
export const AUTO_DAY_END_HOUR = 18;

/**
 * Resolve `'auto'` mode's theme from an instant. `getHours` defaults to the
 * REAL local-timezone hour (`Date.prototype.getHours`) — every production
 * call site uses this default. It exists as a parameter purely so tests can
 * pick a deterministic hour without depending on the host clock/timezone or
 * faking the global `Date` — the same injectable-extractor shape
 * `lib/localDay.ts`'s `dayParts` parameter uses, for the same reason.
 */
export function resolveAutoTheme(
  now: Date,
  getHours: (d: Date) => number = (d) => d.getHours(),
): Theme {
  const hour = getHours(now);
  return hour >= AUTO_DAY_START_HOUR && hour < AUTO_DAY_END_HOUR
    ? 'light'
    : 'dark';
}

export interface ThemeContextValue {
  /** The resolved theme currently applied to `<html data-theme>`. */
  theme: Theme;
  /** The user's chosen mode — `'system'` when no explicit choice is stored. */
  mode: ThemeMode;
  /** Toggle light↔dark (sets an explicit stored choice; overrides `'auto'`/`'system'`). */
  toggleTheme: () => void;
  /** Set an explicit light/dark choice (stores it in `km.theme`). */
  setTheme: (theme: Theme) => void;
  /**
   * Set the mode explicitly.
   *   - `'light'`/`'dark'` → store in `km.theme` + apply.
   *   - `'system'`         → CLEAR `km.theme` + follow `matchMedia` live.
   *   - `'auto'`           → store `'auto'` in `km.theme` + follow the local
   *                          time-of-day boundary live (F-132).
   */
  setMode: (mode: ThemeMode) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);
export const THEME_STORAGE_KEY = 'km.theme';
