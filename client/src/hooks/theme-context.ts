/**
 * Theme context object + types. Kept separate from the Provider so the
 * React Refresh rule (`react-refresh/only-export-components`) stays clean
 * across both `ThemeProvider.tsx` and `useTheme.ts`.
 */
import { createContext } from 'react';

export type Theme = 'light' | 'dark';

/**
 * The user's explicit preference. `'system'` means "no stored choice — follow
 * the OS `prefers-color-scheme`", which is the absence of `km.theme`. `theme`
 * is always the RESOLVED light/dark currently applied; `mode` is the user's
 * intent (which may be `'system'`).
 */
export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeContextValue {
  /** The resolved theme currently applied to `<html data-theme>`. */
  theme: Theme;
  /** The user's chosen mode — `'system'` when no explicit choice is stored. */
  mode: ThemeMode;
  /** Toggle light↔dark (sets an explicit stored choice). */
  toggleTheme: () => void;
  /** Set an explicit light/dark choice (stores it in `km.theme`). */
  setTheme: (theme: Theme) => void;
  /**
   * Set the mode explicitly.
   *   - `'light'`/`'dark'` → store in `km.theme` + apply.
   *   - `'system'`         → CLEAR `km.theme` + follow `matchMedia` live.
   */
  setMode: (mode: ThemeMode) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);
export const THEME_STORAGE_KEY = 'km.theme';
