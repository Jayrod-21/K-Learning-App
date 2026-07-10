/**
 * ShowMore (F-031/F-051/F-072) — the expand affordance paired with
 * `usePagination`.
 *
 * Renders NOTHING when the window is exhausted (`canShowMore` false): a
 * disabled "Show more" at the end of a fully-revealed list is noise the
 * user can't act on, and hiding it is the pattern the ARIA
 * disabled-vs-hidden guidance prefers when the control can never become
 * actionable again without other state changing.
 *
 * The remaining count rides INSIDE the button label ("Show more (12)") so
 * screen readers announce how much is left in the same breath as the
 * action — no separate live region needed.
 *
 * No I/O — no threat model.
 */
import { type JSX } from 'react';
import { cn } from '../lib/cn';
import './ShowMore.css';

export interface ShowMoreProps {
  /** From `usePagination` — false hides the control entirely. */
  canShowMore: boolean;
  /** Reveal the next window (wire to `usePagination().showMore`). */
  onShowMore: () => void;
  /** Items left to reveal — appended to the label when provided. */
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
}: ShowMoreProps): JSX.Element | null {
  if (!canShowMore) return null;

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
