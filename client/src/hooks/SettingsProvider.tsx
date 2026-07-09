/**
 * SettingsProvider — owns the user-preferences state (profile, notif,
 * languageDisplay), persists to `localStorage["km.settings"]`, and projects
 * the language-display sub-text scale (`--lang-sub-scale`, P3a) as a CSS
 * custom property on `<html>`.
 *
 * Mounted alongside `<ThemeProvider/>` (light/dark) under the app shell.
 *
 * v2 flatten: the paper/correct/wrong palette feature — and with it the
 * whole inline CSS-variable projection (`applyPaletteVars` + its
 * ALLOWED_VARS allowlist) — was removed. Appearance is now theme
 * (`data-theme`, ThemeProvider) + accent (`data-accent`, AccentProvider)
 * only; `--moss` / `--danger` are fixed theme tokens in index.css. The one
 * remaining `<html>` projection is the self-owned `--lang-sub-scale` key.
 *
 * Threat model — storage I/O:
 *   - **Corrupt JSON** — `loadSettings` returns `DEFAULT_SETTINGS` on
 *     parse failure. The user sees defaults, can re-pick, and the next
 *     save heals the blob.
 *   - **Quota exhaustion** — `saveSettings` swallows DOMException with a
 *     `console.warn`. In-memory state remains correct for the session.
 *   - **Cross-tab race** — NOT addressed in Pass 2. Two tabs both editing
 *     settings can clobber each other. Pass 9 will add a `storage` event
 *     listener (and decide last-writer-wins vs deep-merge).
 *
 * Persist debouncing:
 *   200ms via setTimeout/clearTimeout. Rapid keyboard nav across the
 *   controls would otherwise hammer `localStorage`. The cleanup on unmount
 *   flushes any pending write so a navigation immediately after a change
 *   still persists.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  clampSubScale,
  DEFAULT_SETTINGS,
  LANG_SUB_SCALE_CSS_VAR,
  loadSettings,
  saveSettings,
  type Settings,
} from '../lib/settings';
import {
  SettingsContext,
  type SettingsContextValue,
  type SettingsPatch,
} from './settings-context';

const PERSIST_DEBOUNCE_MS = 200;

export function SettingsProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  // Debounced persistence. Each settings change reschedules a 200ms timer;
  // a flurry of keystrokes / rapid swatch keyboard nav collapses to one
  // write. The latest `settings` value is read via `settingsRef` so the
  // unmount flush below grabs whatever was current at the time, not the
  // value captured when the effect last ran.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<Settings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      saveSettings(settingsRef.current);
      persistTimerRef.current = null;
    }, PERSIST_DEBOUNCE_MS);
  }, [settings]);

  // Unmount flush — runs ONCE on tear-down. Uses an empty dep list so the
  // cleanup isn't re-armed on every settings change (that would write
  // synchronously and defeat the debounce). Reads via the ref so we
  // persist the freshest value.
  useEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        saveSettings(settingsRef.current);
      }
    };
  }, []);

  // Project the language-display sub-text scale into a CSS custom property on
  // `<html>` (P3a) — the Provider's ONE remaining inline projection (the
  // palette projection was removed in the v2 flatten). One fixed, self-owned
  // key needs no allowlist bookkeeping. `clampSubScale` re-clamps defensively
  // so a stale out-of-range localStorage value can never reach the cascade.
  useEffect(() => {
    document.documentElement.style.setProperty(
      LANG_SUB_SCALE_CSS_VAR,
      String(clampSubScale(settings.languageDisplay.subScale)),
    );
  }, [settings.languageDisplay.subScale]);

  const updateSettings = useCallback((patch: SettingsPatch): void => {
    setSettings((prev) => {
      if (typeof patch === 'function') return patch(prev);
      // Shallow merge at the top level — see `SettingsContextValue` doc.
      return { ...prev, ...patch };
    });
  }, []);

  const resetSettings = useCallback((): void => {
    setSettings(DEFAULT_SETTINGS);
    // Do NOT lean on the 200ms debounce here. A user who hits Reset and
    // immediately closes the tab would otherwise lose the reset (the
    // debounce timer is canceled by unmount-flush, but only if the
    // unmount fires inside the same React commit; a brutal browser
    // close races the queued setTimeout). Flush synchronously so the
    // reset reaches storage on the same tick the user pressed it.
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    saveSettings(DEFAULT_SETTINGS);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, updateSettings, resetSettings }),
    [settings, updateSettings, resetSettings],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}
