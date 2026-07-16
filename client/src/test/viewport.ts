/**
 * Shared viewport-width matchMedia stub for tests (device-adaptive epic).
 *
 * One canonical copy of the `mockViewportWidth` idiom that grew per-file
 * copies in Today.test.tsx (D1), then ReviewLibrary.test.tsx and
 * Settings.test.tsx (D2). Extracted per the D2 fix-pass (NIT-1), with two
 * corrections over the per-file copies:
 *
 *   1. NON-width queries answer `false`. The per-file copies fell through
 *      to `threshold = 0`, so `(prefers-color-scheme: dark)` and
 *      `(prefers-reduced-motion: reduce)` reported `true` under the stub —
 *      the inverse of `setup.ts`'s deliberate all-false baseline. Only
 *      `(min-width: …px)` queries consult the width here.
 *
 *   2. The stub is LIVE: it returns a controller whose `set(width)` moves
 *      the viewport and fires every registered `change` listener, the way
 *      a real `MediaQueryList` does on a resize/rotation. This is what
 *      lets a test drive a breakpoint CROSSING (e.g. the Settings
 *      no-remount-on-rotation test) instead of only static widths.
 *
 * Usage (unchanged for static-width tests):
 *
 *   mockViewportWidth(1024);            // stub a desktop viewport
 *   // …render, assert…
 *   // afterEach: vi.unstubAllGlobals() — reverts to setup.ts's baseline.
 *
 * For a live crossing:
 *
 *   const viewport = mockViewportWidth(1024);
 *   // …render, interact…
 *   act(() => { viewport.set(768); });  // fires the change listeners
 */
import { vi } from 'vitest';

export interface ViewportController {
  /** Move the stubbed viewport and fire all registered change listeners. */
  set(width: number): void;
}

type ChangeListener = (e: Pick<MediaQueryListEvent, 'matches' | 'media'>) => void;

export function mockViewportWidth(initialWidth: number): ViewportController {
  let width = initialWidth;
  // Listeners keep their owning query so `set` can hand each one a real
  // event payload — consumers like ThemeProvider read `e.matches`, not the
  // MediaQueryList, so firing with no argument would throw.
  const listeners = new Map<ChangeListener, string>();

  const matchesFor = (query: string): boolean => {
    const m = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
    // Non-width queries (color-scheme, reduced-motion, …) stay false —
    // consistent with setup.ts's mobile-first, everything-off baseline.
    return m !== null && width >= Number(m[1]);
  };

  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const track = (cb: unknown): void => {
        if (typeof cb === 'function') {
          listeners.set(cb as ChangeListener, query);
        }
      };
      const untrack = (cb: unknown): void => {
        if (typeof cb === 'function') listeners.delete(cb as ChangeListener);
      };
      return {
        // Getter, not a snapshot: `useSyncExternalStore` re-reads
        // `.matches` on every store change, so the value must track the
        // controller's current width.
        get matches() {
          return matchesFor(query);
        },
        media: query,
        onchange: null,
        addEventListener: (type: string, cb: unknown) => {
          if (type === 'change') track(cb);
        },
        removeEventListener: (type: string, cb: unknown) => {
          if (type === 'change') untrack(cb);
        },
        addListener: track,
        removeListener: untrack,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }),
  );

  return {
    set(next: number): void {
      width = next;
      // Fire listeners the way a real MediaQueryList does on a resize,
      // each with an event payload for ITS query. Callers wrap this in
      // act() when a React subscriber is attached.
      for (const [cb, query] of listeners) {
        cb({ matches: matchesFor(query), media: query });
      }
    },
  };
}
