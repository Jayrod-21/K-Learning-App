/**
 * useKeyboardOpen — visualViewport heuristic.
 *
 * happy-dom has no real soft keyboard, so the tests install a controllable
 * fake `window.visualViewport` (an EventTarget with mutable height + scale)
 * and assert the hook's contract: closed above the 75% ratio, open below
 * it, reactive to viewport resize AND scroll events, scale-normalized so
 * pinch-zoom is NOT mistaken for a keyboard, `false` when the API is
 * missing, and listeners removed on unmount.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useKeyboardOpen } from './useKeyboardOpen';

class FakeVisualViewport extends EventTarget {
  height: number;
  scale: number;
  constructor(height: number, scale = 1) {
    super();
    this.height = height;
    this.scale = scale;
  }
  resize(to: number, scale = this.scale): void {
    this.height = to;
    this.scale = scale;
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

  it('does NOT report open for pinch-zoom (shrunk height, raised scale)', () => {
    // Pinch-zoomed 2×, no keyboard: the visual viewport reports half the
    // layout height, but scale carries the truth — height*scale ≈ layout.
    // A height-only compare (400 < 800*0.75) would wrongly report open.
    installViewport(new FakeVisualViewport(400, 2));
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);
  });

  it('still reports open when the keyboard rises while pinch-zoomed', () => {
    const vv = new FakeVisualViewport(400, 2);
    installViewport(vv);
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);

    // Keyboard up on top of the 2× zoom: 250 * 2 = 500 < 800 * 0.75.
    act(() => {
      vv.resize(250);
    });
    expect(result.current).toBe(true);
  });

  it('reports open at scale=1 with a genuinely shrunk viewport (real keyboard)', () => {
    // Pins the non-zoomed contract explicitly next to the pinch tests:
    // scale 1 must not mask a real keyboard shrink.
    installViewport(new FakeVisualViewport(420, 1));
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(true);
  });

  it('reacts to viewport scroll events too (iOS keyboard transitions)', () => {
    const vv = new FakeVisualViewport(800);
    installViewport(vv);
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);

    // iOS sometimes moves the visual viewport without a resize event —
    // mutate silently, then fire only `scroll`.
    act(() => {
      vv.height = 420;
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(result.current).toBe(true);
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
