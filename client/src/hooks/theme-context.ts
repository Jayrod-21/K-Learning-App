/**
 * Theme context object + types. Kept separate from the Provider so the
 * React Refresh rule (`react-refresh/only-export-components`) stays clean
 * across both `ThemeProvider.tsx` and `useTheme.ts`.
 */
import { createContext } from 'react';

export type Theme = 'light' | 'dark';

export interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);
export const THEME_STORAGE_KEY = 'km.theme';
