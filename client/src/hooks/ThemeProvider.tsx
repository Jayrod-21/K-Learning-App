/**
 * ThemeProvider — light by default, honours `prefers-color-scheme`,
 * persists the user's manual choice in `localStorage["km.theme"]`.
 *
 * Writes `data-theme` on `<html>` so the CSS token block can flip the
 * whole palette without re-rendering React. Subscribes to the OS pref so a
 * user who hasn't chosen explicitly still gets dark when the system
 * switches. Also supports `'auto'` mode (F-132): resolves Day/Night Seoul
 * from the local wall-clock time and re-checks on a timer so it flips
 * live while the app stays open, no reload needed.
 *
 * Coordination with the no-flash bootstrap in `index.html`:
 *   The inline `<script>` in index.html sets `data-theme` *before* React
 *   mounts — including for `'auto'` (it duplicates the 06:00–18:00 hour
 *   check, see the comment there). We therefore avoid redundantly writing
 *   it from the first effect — the attribute is already correct.
 *   Subsequent theme changes (user toggle, OS-pref change, auto's clock
 *   tick) still flow through the effect.
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
  resolveAutoTheme,
  ThemeContext,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemeContextValue,
  type ThemeMode,
} from './theme-context';

/** The subset of `ThemeMode` that is ever persisted verbatim in storage —
 *  `'system'` is represented by the KEY BEING ABSENT, never a stored value. */
type StoredMode = Exclude<ThemeMode, 'system'>;

function readStoredMode(): StoredMode | null {
  // Mirror systemPref()'s SSR guard. Today the project is Vite-SPA-only and
  // never SSRs, but keeping the two read helpers symmetric is cheap insurance
  // against a future pre-render step (likely if the PWA shell ever moves to
  // static generation).
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'auto' ? raw : null;
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

/** Resolve the RESOLVED theme for a given mode, at mount. `'system'` and
 *  `'auto'` both read a live source (matchMedia / the clock) rather than a
 *  frozen value, matching what their respective effects keep in sync. */
function resolveThemeForMode(mode: ThemeMode): Theme {
  if (mode === 'light' || mode === 'dark') return mode;
  if (mode === 'auto') return resolveAutoTheme(new Date());
  return systemPref();
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Persist an explicit choice. Best-effort — privacy mode may throw. */
function storeMode(mode: StoredMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Preference still applies for this session.
  }
}

/** How often `'auto'` mode re-checks the wall clock while the app is open
 *  (F-132). A periodic poll — rather than computing the exact ms until the
 *  next 06:00/18:00 boundary and scheduling a single precise `setTimeout` —
 *  is the more ROBUST choice: it self-corrects after the tab is backgrounded,
 *  the laptop sleeps, or the system clock/timezone changes, since every tick
 *  just re-reads `new Date()` fresh instead of trusting elapsed timer
 *  duration to have tracked elapsed wall-clock time. One minute keeps the
 *  worst-case latency to reflect a boundary crossing imperceptible for a
 *  cosmetic day/night palette swap, at negligible cost.  */
const AUTO_POLL_MS = 60_000;

/**
 * Clear the explicit choice → revert to "follow system". Best-effort; a
 * throwing localStorage just means the next reload re-derives from the OS
 * pref anyway, which is the same outcome.
 */
function clearStoredTheme(): void {
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // No-op — see storeMode.
  }
}

export function ThemeProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  // Two pieces of state:
  //   - `mode`  — the user's INTENT: 'light' | 'dark' | 'system' | 'auto'.
  //               Derived at mount from storage (a stored value ⇒ that mode,
  //               absent ⇒ 'system'). This is what the Settings control
  //               binds to.
  //   - `theme` — the RESOLVED light/dark actually applied. For an explicit
  //               mode it equals the mode; for 'system' it tracks the OS
  //               pref; for 'auto' it tracks the local time-of-day boundary
  //               (F-132).
  const [mode, setModeState] = useState<ThemeMode>(
    () => readStoredMode() ?? 'system',
  );
  const [theme, setThemeState] = useState<Theme>(() =>
    resolveThemeForMode(readStoredMode() ?? 'system'),
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

  // Re-check the local clock — only when the user is in 'auto' mode (F-132).
  // Same subscription-only shape as the 'system' effect above: the initial
  // 'auto' resolution happens eagerly in `setMode` (or the `useState`
  // initializer, for a mode restored from storage), so this effect only
  // needs to keep it live afterwards — it never calls setState synchronously
  // in the effect body, only from the interval callback. Keying on `mode`
  // starts/stops the poll as the user enters/leaves 'auto'.
  useEffect(() => {
    if (mode !== 'auto') return;
    const id = window.setInterval(() => {
      setThemeState(resolveAutoTheme(new Date()));
    }, AUTO_POLL_MS);
    return () => {
      window.clearInterval(id);
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
    if (next === 'auto') {
      // Store 'auto' (unlike 'system' it IS an explicit stored choice — it
      // just resolves dynamically) and resolve the clock NOW, for the same
      // immediate-apply reason 'system' resolves matchMedia now: the polling
      // effect above only keeps it live going forward, it doesn't do the
      // first resolution.
      storeMode('auto');
      setModeState('auto');
      setThemeState(resolveAutoTheme(new Date()));
      return;
    }
    storeMode(next);
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
    // user toggling out of 'system'/'auto' lands on a deliberate light/dark —
    // a manual override always wins over both dynamic modes (F-132).
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
