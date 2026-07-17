/**
 * Tour context object + seen-store helpers. Kept separate from the Provider
 * so the React Refresh rule (`react-refresh/only-export-components`) stays
 * clean across `TourProvider.tsx` and `useTour.ts` — the same split the
 * text-size layer uses (`text-size-context.ts`).
 *
 * Seen-state is two-tier (the accent/textSize posture):
 *   - `localStorage["km.toursSeen"]` — the same-device fast path, written
 *     synchronously the moment a tour finishes/skips. Load/store helpers
 *     live HERE (pure, no React) so the Settings screen can read the
 *     current set at PUT-compose time without needing the context.
 *   - The `toursSeen` array in `/settings/prefs` — the cross-device truth,
 *     synced by `TourProvider` (boot union-merge + read-merge-write on
 *     change).
 *
 * The stored array deliberately preserves UNKNOWN ids: a newer client may
 * have persisted tours this build doesn't know about, and dropping them on
 * write would re-fire those tours after a rollback. Decision logic narrows
 * to known ids at read time instead.
 */
import { createContext } from 'react';
import type { TourId } from '../lib/tours';

export const TOURS_SEEN_STORAGE_KEY = 'km.toursSeen';

export interface TourContextValue {
  /** Ids of tours already finished or skipped (raw persisted strings). */
  seen: ReadonlySet<string>;
  /** True once the boot prefs fetch has settled (success OR failure) —
   *  auto-fire decisions wait on this so a seen-elsewhere tour never
   *  flashes before the server answers. */
  hydrated: boolean;
  /** The tour currently on screen, or null. */
  activeTourId: TourId | null;
  /** Mark a tour seen: state + localStorage now, server sync best-effort. */
  markSeen: (id: TourId) => void;
  /** "Skip all tours" — marks every registered tour seen in one write. */
  markAllSeen: () => void;
  /** Run a tour NOW regardless of seen state (Settings replay control). */
  replay: (id: TourId) => void;
}

export const TourContext = createContext<TourContextValue | null>(null);

/**
 * Read the locally cached seen set. Returns an empty set when the key is
 * missing, the JSON is corrupt, or storage is unavailable — never throws
 * (same contract as `lib/settings.loadSettings`).
 */
export function loadSeenTours(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(TOURS_SEEN_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    // Corrupt JSON or storage disabled (private mode) — worst case a tour
    // re-fires once and is Esc-dismissable.
    return new Set();
  }
}

/** Persist the seen set. Best-effort — quota/privacy-mode failures are
 *  swallowed (the in-memory state still suppresses re-fires this session,
 *  and the server copy is the durable cross-device record). */
export function storeSeenTours(seen: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      TOURS_SEEN_STORAGE_KEY,
      JSON.stringify([...seen].sort()),
    );
  } catch (err) {
    console.warn('km.toursSeen: failed to persist tour state', err);
  }
}
