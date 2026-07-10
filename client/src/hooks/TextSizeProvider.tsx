/**
 * TextSizeProvider (F-025) — Medium by default, persists the user's choice in
 * `localStorage["km.textSize"]`.
 *
 * Writes `data-text-size` on `<html>` so the `:root[data-text-size="…"]`
 * blocks in `styles/index.css` re-point the ROOT font-size (sm=93.75%,
 * md=100%, lg=112.5%) without re-rendering React — the exact `data-accent`
 * pattern `AccentProvider` uses. Scaling the root instead of projecting a
 * CSS var means every rem-based length in the app follows for free.
 *
 * Coordination with the no-flash bootstrap in `index.html`:
 *   The inline `<script>` stamps `data-text-size` *before* React mounts. The
 *   mount effect therefore skips the redundant DOM write when the attribute
 *   already matches; subsequent `setTextSize` calls flow through the effect
 *   as normal.
 *
 * Persistence is two-tier (text-size cross-device sync):
 *   - localStorage["km.textSize"] is the same-device fast path (instant,
 *     no-flash) — this provider owns it and nothing else.
 *   - The server `/settings/prefs` `textSize` field is the cross-device
 *     source of truth. The WIRE is deliberately NOT owned here: the Settings
 *     screen (the sole `/settings/prefs` client) adopts the server's size on
 *     hydration via `setTextSize` and PUTs the user's picks back — this
 *     provider stays a pure local state + attribute layer, exactly like
 *     AccentProvider.
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
  DEFAULT_TEXT_SIZE,
  isTextSize,
  TEXT_SIZE_STORAGE_KEY,
  TextSizeContext,
  type TextSize,
  type TextSizeContextValue,
} from './text-size-context';

function readStored(): TextSize | null {
  // SSR guard mirrors accent-context's readStored — cheap insurance against
  // a future pre-render step.
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
    return isTextSize(raw) ? raw : null;
  } catch {
    // localStorage may throw in privacy mode; fall back to the default.
    return null;
  }
}

/** Persist the choice. Best-effort — privacy mode may throw. */
function storeTextSize(size: TextSize): void {
  try {
    window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, size);
  } catch {
    // Preference still applies for this session.
  }
}

export function TextSizeProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [textSize, setTextSizeState] = useState<TextSize>(
    () => readStored() ?? DEFAULT_TEXT_SIZE,
  );

  // Idempotent — one DOM attribute per change. Skips the write when the
  // no-flash IIFE in index.html already stamped the right value.
  useEffect(() => {
    if (document.documentElement.dataset.textSize !== textSize) {
      document.documentElement.dataset.textSize = textSize;
    }
  }, [textSize]);

  const setTextSize = useCallback((next: TextSize): void => {
    storeTextSize(next);
    setTextSizeState(next);
  }, []);

  const value = useMemo<TextSizeContextValue>(
    () => ({ textSize, setTextSize }),
    [textSize, setTextSize],
  );

  return (
    <TextSizeContext.Provider value={value}>
      {children}
    </TextSizeContext.Provider>
  );
}
