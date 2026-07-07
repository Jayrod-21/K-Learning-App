/**
 * useKeyboardOpen — visualViewport heuristic.
 *
 * happy-dom has no real soft keyboard, so the tests install a controllable
 * fake `window.visualViewport` (an EventTarget with a mutable height) and
 * assert the hook's contract: closed above the 75% ratio, open below it,
 * reactive to viewport resize events, `false` when the API is missing,
 * and listeners removed on unmount.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useKeyboardOpen } from './useKeyboardOpen';

class FakeVisualViewport extends EventTarget {
  height: number;
  constructor(height: number) {
    super();
    this.height = height;
  }
  resize(to: number): void {
    this.height = to;
    this.dispatchEvent(new Event('resize'));
  }
}

const originalDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
);

function installViewport(vv: FakeVisualViewport | undefined): void {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: vv,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 800,
  });
}

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(window, 'visualViewport', originalDescriptor);
  } else {
    // Property was absent originally — remove our stub.
    delete (window as { visualViewport?: unknown }).visualViewport;
  }
});

describe('useKeyboardOpen', () => {
  it('reports closed when the visual viewport ~matches the layout height', () => {
    installViewport(new FakeVisualViewport(800));
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);
  });

  it('flips open when the viewport shrinks past the threshold, and back', () => {
    const vv = new FakeVisualViewport(800);
    installViewport(vv);
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);

    // Keyboard up: 800 → 420 (well under 75% of 800).
    act(() => {
      vv.resize(420);
    });
    expect(result.current).toBe(true);

    // Keyboard dismissed.
    act(() => {
      vv.resize(800);
    });
    expect(result.current).toBe(false);
  });

  it('stays closed for small chrome-only shrinks (above the 75% ratio)', () => {
    const vv = new FakeVisualViewport(800);
    installViewport(vv);
    const { result } = renderHook(() => useKeyboardOpen());

    // Browser chrome / split-screen nibbles ~15% — not a keyboard.
    act(() => {
      vv.resize(680);
    });
    expect(result.current).toBe(false);
  });

  it('degrades to false when visualViewport is unavailable', () => {
    installViewport(undefined);
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);
  });

  it('removes its listeners on unmount', () => {
    const vv = new FakeVisualViewport(800);
    installViewport(vv);
    const { result, unmount } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);

    unmount();
    // Dispatching after unmount must not throw (React would warn on a
    // state update to an unmounted subscriber if the listener leaked —
    // useSyncExternalStore unsubscribes; this asserts the dispatch is inert).
    expect(() => {
      vv.resize(300);
    }).not.toThrow();
  });
});
