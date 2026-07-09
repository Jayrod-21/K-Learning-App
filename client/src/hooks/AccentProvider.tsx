/**
 * AccentProvider — Neon Coral by default, persists the user's choice in
 * `localStorage["km.accent"]`.
 *
 * Writes `data-accent` on `<html>` so the `[data-accent="…"]` CSS token
 * blocks can re-point the whole `--vermilion` accent family without
 * re-rendering React — the exact `data-theme` pattern `ThemeProvider`
 * uses, minus the OS-preference leg (there is no `prefers-accent` media
 * query to follow, so the model is a plain explicit choice with a coral
 * default).
 *
 * Coordination with the no-flash bootstrap in `index.html`:
 *   The inline `<script>` stamps `data-accent` *before* React mounts. The
 *   mount effect therefore skips the redundant DOM write when the
 *   attribute already matches; subsequent `setAccent` calls flow through
 *   the effect as normal.
 *
 * Persistence is deliberately localStorage-only, matching the theme
 * choice's posture: the server `/settings/prefs` palette blob keeps its
 * own (legacy) accent field for schema parity, but the runtime accent —
 * like light/dark — is a per-device preference.
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
  AccentContext,
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT,
  isAccent,
  type Accent,
  type AccentContextValue,
} from './accent-context';

function readStored(): Accent | null {
  // SSR guard mirrors theme-context's readStored — cheap insurance against
  // a future pre-render step.
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return isAccent(raw) ? raw : null;
  } catch {
    // localStorage may throw in privacy mode; fall back to the default.
    return null;
  }
}

/** Persist the choice. Best-effort — privacy mode may throw. */
function storeAccent(accent: Accent): void {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // Preference still applies for this session.
  }
}

export function AccentProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [accent, setAccentState] = useState<Accent>(
    () => readStored() ?? DEFAULT_ACCENT,
  );

  // Idempotent — one DOM attribute per change. Skips the write when the
  // no-flash IIFE in index.html already stamped the right value.
  useEffect(() => {
    if (document.documentElement.dataset.accent !== accent) {
      document.documentElement.dataset.accent = accent;
    }
  }, [accent]);

  const setAccent = useCallback((next: Accent): void => {
    storeAccent(next);
    setAccentState(next);
  }, []);

  const value = useMemo<AccentContextValue>(
    () => ({ accent, setAccent }),
    [accent, setAccent],
  );

  return (
    <AccentContext.Provider value={value}>{children}</AccentContext.Provider>
  );
}
