/**
 * ThemeProvider — light by default, honours `prefers-color-scheme`,
 * persists the user's manual choice in `localStorage["km.theme"]`.
 *
 * Writes `data-theme` on `<html>` so the CSS token block can flip the
 * whole palette without re-rendering React. Subscribes to the OS pref so a
 * user who hasn't chosen explicitly still gets dark when the system
 * switches.
 *
 * Coordination with the no-flash bootstrap in `index.html`:
 *   The inline `<script>` in index.html sets `data-theme` *before* React
 *   mounts. We therefore avoid redundantly writing it from the first
 *   effect — the attribute is already correct. Subsequent theme changes
 *   (user toggle, OS-pref change) still flow through the effect.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  ThemeContext,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemeContextValue,
} from './theme-context';

function readStored(): Theme | null {
  // Mirror systemPref()'s SSR guard. Today the project is Vite-SPA-only and
  // never SSRs, but keeping the two read helpers symmetric is cheap insurance
  // against a future pre-render step (likely if the PWA shell ever moves to
  // static generation).
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    // localStorage may throw in privacy mode; fall back to system pref.
    return null;
  }
}

function systemPref(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function ThemeProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(
    () => readStored() ?? systemPref(),
  );

  // Idempotent — touches one DOM attribute on every change. Reads the
  // current `data-theme` first and skips the write if it already matches
  // (the no-flash IIFE in index.html sets it pre-mount). This collapses
  // the first effect-run to a no-op on the common path and keeps the
  // subsequent toggle/OS-pref updates working as before.
  useEffect(() => {
    if (document.documentElement.dataset.theme !== theme) {
      applyTheme(theme);
    }
  }, [theme]);

  // Track OS preference — only when the user hasn't chosen manually.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => {
      if (readStored() === null) {
        setThemeState(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, []);

  const setTheme = useCallback((next: Theme): void => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Best-effort — preference still applies for this session.
    }
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback((): void => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Best-effort.
      }
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, toggleTheme, setTheme }),
    [theme, toggleTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
