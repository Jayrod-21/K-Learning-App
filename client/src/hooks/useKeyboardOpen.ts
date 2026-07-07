/**
 * `useKeyboardOpen` — best-effort "is the on-screen keyboard up?" signal
 * (Overhaul P1.1). Used by ChatFab to get out of the way while typing.
 *
 * Heuristic: on mobile, opening the soft keyboard shrinks
 * `window.visualViewport.height` well below the layout viewport
 * (`window.innerHeight`) without firing a window resize. We call the
 * keyboard "open" when the visual viewport has lost more than 25% of the
 * layout height (`KEYBOARD_HEIGHT_RATIO`). Split-screen and browser-chrome
 * changes stay under that; every mainstream soft keyboard is well over it.
 *
 * Pinch-zoom guard: `visualViewport.height` is measured in *visual*
 * viewport CSS px, so it also shrinks when the user pinch-zooms IN — at
 * zoom ≳1.33× a bare height compare would report "keyboard open" with no
 * keyboard. Multiplying by `visualViewport.scale` normalizes back to
 * layout px: a zoomed-but-keyboard-less viewport keeps
 * `height * scale ≈ innerHeight` and stays "closed", while a real
 * keyboard still drops the product well below the threshold.
 *
 * Implementation notes:
 *   - `useSyncExternalStore` keeps subscribe/snapshot tear-free and gives a
 *     server snapshot for free — SSR-safe (`false`: no keyboard concept).
 *   - Browsers without `visualViewport` (very old engines, some webviews,
 *     and the happy-dom test env unless stubbed) report `false` — the FAB
 *     stays visible, which is the correct degradation (never hide UI on a
 *     signal we can't read).
 *   - Listeners bind to the `visualViewport` object itself (`resize` +
 *     `scroll` — iOS fires only `scroll` for some keyboard transitions) and
 *     are removed in the unsubscribe cleanup on unmount.
 */
import { useSyncExternalStore } from 'react';

/** Visual/layout height ratio below which the keyboard counts as open. */
const KEYBOARD_HEIGHT_RATIO = 0.75;

function subscribe(onStoreChange: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) {
    // Nothing to observe — the snapshot is a constant `false`.
    return () => {
      /* no listeners to remove */
    };
  }
  vv.addEventListener('resize', onStoreChange);
  vv.addEventListener('scroll', onStoreChange);
  return () => {
    vv.removeEventListener('resize', onStoreChange);
    vv.removeEventListener('scroll', onStoreChange);
  };
}

function getSnapshot(): boolean {
  const vv = window.visualViewport;
  if (!vv || window.innerHeight <= 0) return false;
  // Normalize the visual height to layout px so pinch-zoom (which shrinks
  // `height` but raises `scale` proportionally) doesn't read as a
  // keyboard. Defensive: treat a non-finite / non-positive scale (seen
  // transiently on some engines) as 1 — a plain height compare.
  const scale = Number.isFinite(vv.scale) && vv.scale > 0 ? vv.scale : 1;
  return vv.height * scale < window.innerHeight * KEYBOARD_HEIGHT_RATIO;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
