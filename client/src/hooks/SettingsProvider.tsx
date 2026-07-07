/**
 * SettingsProvider — owns the user-preferences state (profile, notif,
 * palette, languageDisplay), persists to `localStorage["km.settings"]`, and
 * projects the selected palette presets + the language-display sub-text
 * scale (`--lang-sub-scale`, P3a) into CSS custom properties on `<html>`.
 *
 * Mounted alongside `<ThemeProvider/>` (light/dark) under the app shell.
 * The two are independent: theme flips `data-theme` (which the CSS token
 * block reads), settings injects per-preset overrides as inline custom
 * properties on `<html>`. Cascade order ensures the inline style wins
 * over the dark/light defaults, so the user's choice always renders.
 *
 * Threat model — storage I/O:
 *   - **Corrupt JSON** — `loadSettings` returns `DEFAULT_SETTINGS` on
 *     parse failure. The user sees defaults, can re-pick, and the next
 *     save heals the blob.
 *   - **Quota exhaustion** — `saveSettings` swallows DOMException with a
 *     `console.warn`. In-memory state remains correct for the session.
 *   - **Cross-tab race** — NOT addressed in Pass 2. Two tabs both editing
 *     palette can clobber each other. Pass 9 will add a `storage` event
 *     listener (and decide last-writer-wins vs deep-merge).
 *   - **DOM property pollution** — the set of properties we touch is
 *     bounded by the preset `vars` maps (no untrusted keys, ever — we
 *     only ever apply our own constants).
 *
 * Persist debouncing:
 *   200ms via setTimeout/clearTimeout. Rapid drags across the SwatchPicker
 *   keyboard navigation would otherwise hammer `localStorage`. The cleanup
 *   on unmount flushes any pending write so a navigation immediately after
 *   a change still persists.
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
  paletteVars,
  saveSettings,
  type Settings,
} from '../lib/settings';
import {
  SettingsContext,
  type SettingsContextValue,
  type SettingsPatch,
} from './settings-context';

/**
 * Closed set of CSS variable names this Provider may touch on the document
 * element. Anything not in here is left alone — this is what guarantees
 * Pass 1 theme tokens are never accidentally clobbered when a preset map
 * grows.
 *
 * If a new preset key is added, extend this list AND update the threat
 * model in the header.
 */
const ALLOWED_VARS = new Set<string>([
  // Paper category
  '--ink',
  '--ink-1',
  '--ink-2',
  '--ink-3',
  '--paper',
  '--paper-dim',
  '--paper-mute',
  '--paper-faint',
  '--line',
  '--line-strong',
  // Accent category
  '--vermilion',
  '--vermilion-soft',
  '--gold',
  '--gold-light',
  '--gold-soft',
  // Correct category
  '--moss',
  '--moss-soft',
  '--green',
  '--green-light',
  // Wrong category
  '--danger',
  '--danger-soft',
]);

const PERSIST_DEBOUNCE_MS = 200;

/**
 * Tracks the set of CSS custom-property keys this Provider has previously
 * written to `<html>` inline style. On every preset switch we clear the
 * keys we wrote last time but the new preset doesn't declare, so a stale
 * `--gold-soft` from a previous accent can't leak into the new accent's
 * cascade.
 *
 * Module-level rather than a ref because there's only ever one
 * `documentElement` and one Provider tree per page; the trade-off (no
 * isolation across multiple SSR contexts) doesn't apply to a CSR-only
 * SPA. If we ever ship SSR, hoist this into a ref keyed by the Provider.
 */
const writtenVars = new Set<string>();

/**
 * Apply the resolved palette vars to `<html>` inline style. Clears any
 * previously-written keys the new preset doesn't declare so the cascade
 * doesn't keep stale values around.
 *
 * Keeps the cascade predictable — `documentElement.style.setProperty`
 * sets an inline style, which beats both the `:root` and `[data-theme]`
 * blocks in `index.css`.
 */
function applyPaletteVars(vars: Record<string, string>): void {
  const el = document.documentElement;
  const nextKeys = new Set<string>();
  for (const [k, v] of Object.entries(vars)) {
    if (!ALLOWED_VARS.has(k)) continue; // defence-in-depth allowlist
    el.style.setProperty(k, v);
    nextKeys.add(k);
  }
  // Clear keys we wrote last call that this call did not — prevents
  // stale tokens sticking when the user picks a preset with fewer
  // overrides than the previous one.
  for (const k of writtenVars) {
    if (!nextKeys.has(k)) el.style.removeProperty(k);
  }
  writtenVars.clear();
  for (const k of nextKeys) writtenVars.add(k);
}

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

  // Project palette into CSS custom properties whenever palette changes.
  // We rerun on the palette object identity — `updateSettings` creates a
  // fresh `palette` ref on changes that touch it (and only then), so this
  // does not fire on profile-only edits.
  useEffect(() => {
    applyPaletteVars(paletteVars(settings.palette));
  }, [settings.palette]);

  // Project the language-display sub-text scale into a CSS custom property on
  // `<html>` (P3a) — the same inline-style projection the palette uses, but
  // kept OUT of `applyPaletteVars`: that function clears any key the current
  // call doesn't declare, so routing this var through it would let a
  // palette-only update erase the scale. One fixed, self-owned key needs no
  // allowlist bookkeeping. `clampSubScale` re-clamps defensively so a stale
  // out-of-range localStorage value can never reach the cascade.
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
