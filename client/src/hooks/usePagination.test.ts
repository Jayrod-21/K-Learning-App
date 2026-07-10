/**
 * usePagination — verifies the count-window contract (F-031/F-051/F-072):
 *   - slices to `initial` (default 15) and reports the full total,
 *   - showMore grows by `step` and hard-caps at `max` (default 15→30),
 *   - canShowMore turns false at the cap AND at the list end,
 *   - reset collapses back to `initial`,
 *   - short lists never over-report (visible ≤ items, no phantom button),
 *   - a shrinking items array re-clamps without an effect (filter change),
 *   - degenerate opts (0/negative) floor to a 1-item window, never empty.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePagination } from './usePagination';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('usePagination', () => {
  it('slices to the default initial 15 and reports total', () => {
    const items = range(50);
    const { result } = renderHook(() => usePagination(items));
    expect(result.current.visible).toEqual(range(15));
    expect(result.current.total).toBe(50);
    expect(result.current.canShowMore).toBe(true);
  });

  it('showMore grows by step and caps at max (15 → 30, default cap 30)', () => {
    const items = range(50);
    const { result } = renderHook(() => usePagination(items));

    act(() => {
      result.current.showMore();
    });
    expect(result.current.visible).toHaveLength(30);
    // At the cap: no further expansion is offered even though total is 50.
    expect(result.current.canShowMore).toBe(false);

    // A stray extra call must not blow past the cap.
    act(() => {
      result.current.showMore();
    });
    expect(result.current.visible).toHaveLength(30);
  });

  it('honours custom initial/step/max', () => {
    const items = range(100);
    const { result } = renderHook(() =>
      usePagination(items, { initial: 10, step: 20, max: 40 }),
    );
    expect(result.current.visible).toHaveLength(10);

    act(() => {
      result.current.showMore();
    });
    expect(result.current.visible).toHaveLength(30);

    act(() => {
      result.current.showMore();
    });
    // 30 + 20 caps at 40.
    expect(result.current.visible).toHaveLength(40);
    expect(result.current.canShowMore).toBe(false);
  });

  it('canShowMore is false when the list already fits the window', () => {
    const items = range(8);
    const { result } = renderHook(() => usePagination(items));
    expect(result.current.visible).toEqual(range(8));
    expect(result.current.canShowMore).toBe(false);
    expect(result.current.total).toBe(8);
  });

  it('the list end wins over max when the list is shorter than the cap', () => {
    const items = range(20);
    const { result } = renderHook(() => usePagination(items));
    act(() => {
      result.current.showMore();
    });
    // 15 + 15 = 30 window, but only 20 items exist.
    expect(result.current.visible).toHaveLength(20);
    expect(result.current.canShowMore).toBe(false);
  });

  it('reset collapses back to initial', () => {
    const items = range(50);
    const { result } = renderHook(() => usePagination(items));
    act(() => {
      result.current.showMore();
    });
    expect(result.current.visible).toHaveLength(30);

    act(() => {
      result.current.reset();
    });
    expect(result.current.visible).toHaveLength(15);
    expect(result.current.canShowMore).toBe(true);
  });

  it('re-clamps when the items array shrinks (filter change), then re-expands', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: number[] }) => usePagination(items),
      { initialProps: { items: range(50) } },
    );
    act(() => {
      result.current.showMore();
    });
    expect(result.current.visible).toHaveLength(30);

    // The source list shrinks below the expanded window — the render-time
    // clamp must shrink the slice without any effect tick.
    rerender({ items: range(5) });
    expect(result.current.visible).toEqual(range(5));
    expect(result.current.canShowMore).toBe(false);
    expect(result.current.total).toBe(5);

    // Growing again re-opens the window up to the retained count (30).
    rerender({ items: range(50) });
    expect(result.current.visible).toHaveLength(30);
  });

  it('floors degenerate opts to a 1-item window instead of an empty list', () => {
    const items = range(10);
    const { result } = renderHook(() =>
      usePagination(items, { initial: 0, step: -5, max: 0 }),
    );
    expect(result.current.visible).toHaveLength(1);
    // max floored to 1 == initial floored to 1 → nothing more to show.
    expect(result.current.canShowMore).toBe(false);
  });
});
