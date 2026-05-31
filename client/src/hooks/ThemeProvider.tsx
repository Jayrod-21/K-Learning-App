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
  type ThemeMode,
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

/** Persist an explicit choice. Best-effort — privacy mode may throw. */
function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Preference still applies for this session.
  }
}

/**
 * Clear the explicit choice → revert to "follow system". Best-effort; a
 * throwing localStorage just means the next reload re-derives from the OS
 * pref anyway, which is the same outcome.
 */
function clearStoredTheme(): void {
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // No-op — see storeTheme.
  }
}

export function ThemeProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  // Two pieces of state:
  //   - `mode`  — the user's INTENT: 'light' | 'dark' | 'system'. Derived at
  //               mount from storage (a stored value ⇒ that mode, absent ⇒
  //               'system'). This is what the Settings control binds to.
  //   - `theme` — the RESOLVED light/dark actually applied. For an explicit
  //               mode it equals the mode; for 'system' it tracks the OS pref.
  const [mode, setModeState] = useState<ThemeMode>(
    () => readStored() ?? 'system',
  );
  const [theme, setThemeState] = useState<Theme>(
    () => readStored() ?? systemPref(),
  );

  // Idempotent — touches one DOM attribute on every change. Reads the
  // current `data-theme` first and skips the write if it already matches
  // (the no-flash IIFE in index.html sets it pre-mount). This collapses
  // the first effect-run to a no-op on the common path and keeps the
  // subsequent toggle/OS-pref/mode updates working as before.
  useEffect(() => {
    if (document.documentElement.dataset.theme !== theme) {
      applyTheme(theme);
    }
  }, [theme]);

  // Subscribe to OS preference — only when the user is in 'system' mode (no
  // stored choice). This effect is a pure SUBSCRIPTION to an external system
  // (matchMedia): it calls setState only from the `change` callback, never
  // synchronously in the effect body. The initial 'system' resolution is done
  // eagerly in `setMode` instead, so there's no synchronous set-state-in-effect
  // cascade. Keying on `mode` re-subscribes when the user flips into/out of
  // 'system'.
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => {
      setThemeState(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, [mode]);

  const setMode = useCallback((next: ThemeMode): void => {
    if (next === 'system') {
      // Clear the explicit choice and resolve the live OS pref NOW (in the
      // event handler, not an effect) so switching to 'system' applies the
      // system theme immediately even if no `change` event ever fires. The
      // subscription effect (re-armed by the mode change) keeps it live after.
      clearStoredTheme();
      setModeState('system');
      setThemeState(systemPref());
      return;
    }
    storeTheme(next);
    setModeState(next);
    setThemeState(next);
  }, []);

  const setTheme = useCallback(
    (next: Theme): void => {
      setMode(next);
    },
    [setMode],
  );

  const toggleTheme = useCallback((): void => {
    // Toggle flips the RESOLVED theme and pins it as an explicit choice, so a
    // user toggling out of 'system' lands on a deliberate light/dark.
    setMode(theme === 'dark' ? 'light' : 'dark');
  }, [setMode, theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, mode, toggleTheme, setTheme, setMode }),
    [theme, mode, toggleTheme, setTheme, setMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
