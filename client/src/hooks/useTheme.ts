/**
 * `useTheme` — read the theme context. Throws if used outside
 * `<ThemeProvider/>`.
 */
import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from './theme-context';

export type { Theme, ThemeMode, ThemeContextValue } from './theme-context';

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
