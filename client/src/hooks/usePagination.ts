/**
 * usePagination (F-031/F-051/F-072) — client-side "show N, expand by N,
 * capped at M" windowing for already-loaded lists.
 *
 * Deliberately NOT server pagination: the lists this serves (library
 * filters, mistake logs, vocab lists) are already fully in memory — the
 * problem is render/scroll cost and visual overwhelm, not transfer size.
 * A count-based window (not page cursors) keeps "Show more" additive: the
 * user never loses what they were looking at.
 *
 * The window is CLAMPED at render time rather than synced via effects, so a
 * shrinking `items` array (a filter change) can never strand an
 * out-of-range count — callers that want the window to also COLLAPSE on a
 * filter change call `reset()` in their filter handler.
 */
import { useCallback, useMemo, useState } from 'react';

export interface UsePaginationOptions {
  /** Items visible before any "Show more" (default 15). */
  initial?: number;
  /** How many each "Show more" adds (default 15). */
  step?: number;
  /** Hard ceiling on visible items regardless of expansion (default 30). */
  max?: number;
}

export interface UsePaginationResult<T> {
  /** The currently-visible window — `items` truncated, never reordered. */
  visible: T[];
  /** True while another `showMore()` would reveal more items. */
  canShowMore: boolean;
  /** Reveal the next `step` items (capped at `max` / the list end). */
  showMore: () => void;
  /** Collapse back to `initial` (e.g. after a filter change). */
  reset: () => void;
  /** Total items in the source list (NOT the visible count). */
  total: number;
}

const DEFAULT_INITIAL = 15;
const DEFAULT_STEP = 15;
const DEFAULT_MAX = 30;

export function usePagination<T>(
  items: readonly T[],
  opts?: UsePaginationOptions,
): UsePaginationResult<T> {
  // Floor at 1 so a caller typo (0 / negative) degrades to a tiny window
  // instead of an empty list with a dead "Show more" button.
  const initial = Math.max(1, opts?.initial ?? DEFAULT_INITIAL);
  const step = Math.max(1, opts?.step ?? DEFAULT_STEP);
  const max = Math.max(1, opts?.max ?? DEFAULT_MAX);

  const [count, setCount] = useState<number>(initial);

  // The effective ceiling: the cap, but never more than the list itself.
  // `max < initial` (a caller bug) resolves to max — the cap always wins.
  const limit = Math.min(max, items.length);
  const visibleCount = Math.min(count, limit);

  const visible = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  );

  const canShowMore = visibleCount < limit;

  const showMore = useCallback((): void => {
    setCount((prev) => Math.min(prev + step, max));
  }, [step, max]);

  const reset = useCallback((): void => {
    setCount(initial);
  }, [initial]);

  return { visible, canShowMore, showMore, reset, total: items.length };
}
