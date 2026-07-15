/**
 * `useDeviceClass` — the device-adaptive shell's breakpoint signal
 * (device-adaptive epic, Phase D0 foundation).
 *
 * Three buckets, matching the approved desktop/tablet nav model (Option A —
 * a persistent LEFT SIDEBAR rail replaces the bottom-bar at ≥768px, with
 * LEARN's sub-pages flattened into a visible "Learn" section):
 *   - 'mobile'  — narrower than `TABLET_MIN_WIDTH` (768px). Bottom-bar +
 *     LEARN hexagon launcher (today's chrome, unchanged).
 *   - 'tablet'  — `TABLET_MIN_WIDTH`–1023px. Persistent left sidebar rail.
 *   - 'desktop' — `DESKTOP_MIN_WIDTH` (1024px) and up. Same sidebar rail.
 *     NOTE (D0): 'tablet' and 'desktop' are NOT visually distinguished
 *     yet — the wider content-column max-width (`--shell-desktop-max-width`
 *     in styles/index.css) is applied by the SAME `@media (min-width: 768px)`
 *     rule that mounts the sidebar, i.e. starting at the tablet breakpoint,
 *     not gated on `DESKTOP_MIN_WIDTH`. The three-bucket split exists so a
 *     LATER phase can introduce a real 1024px-gated CSS rule (or a
 *     desktop-only render branch) without another hook change — D0 only
 *     consumes `'mobile'` vs. not-`'mobile'` (see `useIsSidebarLayout`
 *     below).
 *
 * Implementation mirrors the codebase's existing external-store hooks
 * (`useKeyboardOpen`'s `visualViewport` subscription, `ThemeProvider`'s
 * `matchMedia('(prefers-color-scheme: dark)')` subscription):
 *   - `useSyncExternalStore` keeps subscribe/snapshot tear-free and gives a
 *     server/first-paint snapshot for free.
 *   - `getServerSnapshot` returns `'mobile'` — the mobile-first default, so
 *     a pre-hydration first paint (or a test DOM with no `matchMedia`)
 *     never assumes desktop chrome is present.
 *   - Environments without `matchMedia` (older webviews, some test DOMs)
 *     degrade to `'mobile'` — same "never hide UI on a signal we can't
 *     read" contract `useKeyboardOpen` uses for a missing `visualViewport`.
 *   - Listeners are attached to the two `MediaQueryList`s created in
 *     `subscribe` and removed in its cleanup on unmount/re-subscribe.
 */
import { useSyncExternalStore } from 'react';

export type DeviceClass = 'mobile' | 'tablet' | 'desktop';

/** Sidebar rail replaces the bottom-bar at this width and above. */
export const TABLET_MIN_WIDTH = 768;
/** Desktop content gets its wider max-width cap at this width and above. */
export const DESKTOP_MIN_WIDTH = 1024;

const TABLET_QUERY = `(min-width: ${TABLET_MIN_WIDTH}px)`;
const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

function classFromMatches(tabletUp: boolean, desktopUp: boolean): DeviceClass {
  if (desktopUp) return 'desktop';
  if (tabletUp) return 'tablet';
  return 'mobile';
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') {
    // Nothing to observe — the snapshot is a constant 'mobile'.
    return () => {
      /* no listeners to remove */
    };
  }
  const tabletMql = window.matchMedia(TABLET_QUERY);
  const desktopMql = window.matchMedia(DESKTOP_QUERY);
  tabletMql.addEventListener('change', onStoreChange);
  desktopMql.addEventListener('change', onStoreChange);
  return () => {
    tabletMql.removeEventListener('change', onStoreChange);
    desktopMql.removeEventListener('change', onStoreChange);
  };
}

function getSnapshot(): DeviceClass {
  if (typeof window.matchMedia !== 'function') return 'mobile';
  return classFromMatches(
    window.matchMedia(TABLET_QUERY).matches,
    window.matchMedia(DESKTOP_QUERY).matches,
  );
}

function getServerSnapshot(): DeviceClass {
  return 'mobile';
}

export function useDeviceClass(): DeviceClass {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Convenience boolean: true at tablet width and up — the single breakpoint
 * where the persistent sidebar rail replaces the bottom-bar (Option A nav
 * model). Shell reads this to decide which chrome to mount; nothing else
 * about the two device classes differs for D0 (the desktop-only wider
 * content cap is a pure CSS concern, not a render-branch one).
 */
export function useIsSidebarLayout(): boolean {
  return useDeviceClass() !== 'mobile';
}
