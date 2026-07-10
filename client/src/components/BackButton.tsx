/**
 * BackButton (F-024) — in-app back control for nested/sub-pages.
 *
 * Why an explicit control instead of leaning on browser/OS back: inside the
 * PWA shell a sub-page is often the FIRST entry in the tab's history (deep
 * link, notification tap, redirect after auth), so `history.back()` would
 * exit the app or land somewhere surprising. Pages that have one canonical
 * parent pass `to` — the button then navigates to that route
 * deterministically no matter how the user arrived. Flows that genuinely
 * mean "wherever I just was" (multi-entry wizards, cross-linked detail
 * views) omit `to` and get `navigate(-1)`.
 *
 * Anatomy: a real `<button>` (not a styled `<a>` — this is an action, and
 * with the `navigate(-1)` fallback there is no stable href to expose) with
 * a decorative chevron-left `Icon` and an optional visible label. The
 * accessible name is always present: "Back" bare, or "Back to {label}" so
 * screen-reader users hear the destination, not just the direction.
 *
 * Styling is chrome-sized and fully tokenized (`--paper-dim` rest,
 * `--paper` + `--ink-2` wash on hover) so both themes and every accent
 * preset come free. Small by design — it sits above page titles, it is not
 * a page-level CTA.
 *
 * No I/O — no threat model. Route strings are caller-controlled constants.
 */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { cn } from '../lib/cn';
import './BackButton.css';

export interface BackButtonProps {
  /**
   * Explicit parent route. When present the button navigates there;
   * when omitted it falls back to `navigate(-1)` (history back).
   */
  to?: string;
  /** Visible label text; also folded into the accessible name. */
  label?: string;
  /** Extra class(es) on the button. */
  className?: string;
}

export function BackButton({
  to,
  label,
  className,
}: BackButtonProps): JSX.Element {
  const navigate = useNavigate();

  const onClick = (): void => {
    if (to !== undefined) {
      // `void` — react-router v7's navigate returns a promise in data-router
      // setups; we never await chrome navigation.
      void navigate(to);
    } else {
      void navigate(-1);
    }
  };

  return (
    <button
      type="button"
      className={cn('km-backbtn focusring', className)}
      aria-label={label === undefined ? 'Back' : `Back to ${label}`}
      onClick={onClick}
    >
      {/* Decorative — the button's aria-label carries the meaning. */}
      <Icon name="chevron-left" size={16} />
      {label !== undefined ? (
        <span className="km-backbtn__label">{label}</span>
      ) : null}
    </button>
  );
}
