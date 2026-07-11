/**
 * ShowMore (F-031/F-051/F-072) — the expand affordance paired with
 * `usePagination`.
 *
 * Renders NOTHING VISIBLE when the window is exhausted (`canShowMore`
 * false): a disabled "Show more" at the end of a fully-revealed list is
 * noise the user can't act on, and hiding it is the pattern the ARIA
 * disabled-vs-hidden guidance prefers when the control can never become
 * actionable again without other state changing.
 *
 * The remaining count rides INSIDE the button label ("Show more (12)") so
 * screen readers announce how much is left in the same breath as the
 * action — no separate live region needed.
 *
 * Focus handoff on the final reveal (WCAG 2.4.3 Focus Order): the button
 * this component renders unmounts the instant `canShowMore` flips false.
 * Left alone, the browser drops keyboard focus to `<body>` when a focused
 * element is removed from the DOM, forcing a keyboard user to re-traverse
 * the whole document to reach what they just revealed. Instead of
 * rendering `null`, the exhausted state renders a visually-hidden,
 * non-tab-stop stand-in (`tabIndex={-1}`) in the button's place, and an
 * effect moves focus onto it exactly when the transition happens with the
 * button focused. A list that starts already-exhausted (mouse user, or a
 * page that never had a "more" state) never had a button to lose focus
 * from, so the effect leaves focus alone in that case. This fixes the
 * primitive once for every consumer (Progress, ReviewVocab, Listen) —
 * do not re-solve this per-page.
 *
 * No I/O — no threat model.
 */
import { useEffect, useRef, type JSX } from 'react';
import { cn } from '../lib/cn';
import './ShowMore.css';

export interface ShowMoreProps {
  /** From `usePagination` — false hides the control entirely. */
  canShowMore: boolean;
  /** Reveal the next window (wire to `usePagination().showMore`). */
  onShowMore: () => void;
  /**
   * How many items the next click reveals — appended to the label when
   * provided. Wire to `usePagination().remaining`; do NOT derive it as
   * `total - visible.length`, which over-promises items the capped window
   * will never reach.
   */
  remaining?: number;
  /** Button copy (default "Show more"). */
  label?: string;
  className?: string;
}

export function ShowMore({
  canShowMore,
  onShowMore,
  remaining,
  label = 'Show more',
  className,
}: ShowMoreProps): JSX.Element {
  const wasVisibleRef = useRef(canShowMore);
  const focusCatchRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = canShowMore;
    if (wasVisible && !canShowMore) {
      focusCatchRef.current?.focus();
    }
  }, [canShowMore]);

  if (!canShowMore) {
    return (
      <span ref={focusCatchRef} tabIndex={-1} className="km-sr-only">
        All items shown
      </span>
    );
  }

  const text =
    typeof remaining === 'number' && remaining > 0
      ? `${label} (${String(remaining)})`
      : label;

  return (
    <button
      type="button"
      className={cn('km-showmore focusring', className)}
      onClick={onShowMore}
    >
      {text}
    </button>
  );
}
