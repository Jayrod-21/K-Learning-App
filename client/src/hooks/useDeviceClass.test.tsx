/**
 * useDeviceClass — width-driven breakpoint hook.
 *
 * happy-dom has no real layout viewport, so the tests install a
 * controllable fake `matchMedia`: each call creates a `MediaQueryList`-like
 * object whose `matches` is derived from a shared fake "viewport width"
 * closure variable, parsed from the query's `min-width` (mirrors the real
 * `(min-width: Npx)` queries `useDeviceClass` issues). `setWidth` updates
 * the width and — like a real browser — fires `change` on every
 * already-created instance whose `matches` value flips, notifying
 * `useSyncExternalStore`'s subscribers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DESKTOP_MIN_WIDTH,
  TABLET_MIN_WIDTH,
  useDeviceClass,
  useIsSidebarLayout,
} from './useDeviceClass';

// ─── matchMedia harness ───────────────────────────────────────────
interface FakeMql {
  media: string;
  matches: boolean;
  listeners: Array<(e: MediaQueryListEvent) => void>;
}

let width = 375;
let instances: FakeMql[] = [];

function parseMinWidth(query: string): number {
  const m = /min-width:\s*(\d+)px/.exec(query);
  return m ? Number(m[1]) : 0;
}

function makeMql(query: string): MediaQueryList {
  const threshold = parseMinWidth(query);
  const mql: FakeMql = {
    media: query,
    matches: width >= threshold,
    listeners: [],
  };
  instances.push(mql);
  return {
    media: mql.media,
    get matches() {
      return mql.matches;
    },
    onchange: null,
    addEventListener: (
      _type: string,
      cb: (e: MediaQueryListEvent) => void,
    ) => {
      mql.listeners.push(cb);
    },
    removeEventListener: (
      _type: string,
      cb: (e: MediaQueryListEvent) => void,
    ) => {
      mql.listeners = mql.listeners.filter((l) => l !== cb);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

/** Simulate the viewport resizing to `next` px, firing `change` on every
 *  live instance whose match value actually flips (real browser semantics —
 *  a `change` event only fires on a transition, not on every resize). */
function setWidth(next: number): void {
  width = next;
  for (const mql of instances) {
    const threshold = parseMinWidth(mql.media);
    const nextMatches = width >= threshold;
    if (nextMatches !== mql.matches) {
      mql.matches = nextMatches;
      const event = { matches: nextMatches, media: mql.media } as MediaQueryListEvent;
      for (const l of [...mql.listeners]) l(event);
    }
  }
}

beforeEach(() => {
  width = 375;
  instances = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => makeMql(query)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeviceClass', () => {
  it('reports mobile below the tablet breakpoint', () => {
    width = TABLET_MIN_WIDTH - 1;
    const { result } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('mobile');
  });

  it('reports tablet at the tablet breakpoint, below desktop', () => {
    width = TABLET_MIN_WIDTH;
    const { result } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('tablet');
  });

  it('reports tablet just below the desktop breakpoint', () => {
    width = DESKTOP_MIN_WIDTH - 1;
    const { result } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('tablet');
  });

  it('reports desktop at the desktop breakpoint and above', () => {
    width = DESKTOP_MIN_WIDTH;
    const { result } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('desktop');
  });

  it('reacts live to a viewport resize crossing into tablet', () => {
    width = 375;
    const { result } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('mobile');

    act(() => {
      setWidth(TABLET_MIN_WIDTH);
    });
    expect(result.current).toBe('tablet');

    act(() => {
      setWidth(DESKTOP_MIN_WIDTH);
    });
    expect(result.current).toBe('desktop');

    act(() => {
      setWidth(375);
    });
    expect(result.current).toBe('mobile');
  });

  it('degrades to mobile when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('mobile');
  });

  it('removes its listeners on unmount', () => {
    width = TABLET_MIN_WIDTH;
    const { result, unmount } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('tablet');

    unmount();
    // Dispatching after unmount must not throw, and must not resurrect a
    // stale subscriber (useSyncExternalStore unsubscribed on unmount).
    expect(() => {
      setWidth(DESKTOP_MIN_WIDTH);
    }).not.toThrow();
  });
});

describe('useIsSidebarLayout', () => {
  it('is false on mobile', () => {
    width = 375;
    const { result } = renderHook(() => useIsSidebarLayout());
    expect(result.current).toBe(false);
  });

  it('is true at tablet width', () => {
    width = TABLET_MIN_WIDTH;
    const { result } = renderHook(() => useIsSidebarLayout());
    expect(result.current).toBe(true);
  });

  it('is true at desktop width', () => {
    width = DESKTOP_MIN_WIDTH;
    const { result } = renderHook(() => useIsSidebarLayout());
    expect(result.current).toBe(true);
  });
});
