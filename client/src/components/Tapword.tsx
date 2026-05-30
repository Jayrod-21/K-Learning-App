/**
 * Tapword — the gesture that defines the app.
 *
 * Renders as an inline `<span>` styled with the `.km-tapword` class. The
 * underline-on-hover is part of the reading affordance; once a learner has
 * mined the word into their bank, the dotted vermilion underline marks it
 * as "seen — tap again for the definition".
 *
 * Reads like a `<span>`, behaves like a `<button>`. We deliberately avoid a
 * real `<button>` element so the token can sit mid-sentence without the
 * default block / inline-block layout fights that arise from nested
 * `<button>`-in-`<p>` markup in some browsers. Instead we keep `<span>` and
 * promote it to a control via `role="button"`, `tabIndex`, and a key
 * handler — the canonical pattern for inline interactive text.
 *
 * No I/O — no threat model needed. The `children` prop is whatever Korean
 * token text the caller chose to display; KoreanPassage (the only caller)
 * passes `tk.w` from the fixture, which is author-controlled.
 *
 * @example
 *   <Tapword onTap={() => openWord(gloss)}>재택근무</Tapword>
 */
import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

export interface TapwordProps {
  /** Visible Korean text. */
  children: ReactNode;
  /** True once the word is in the learner's bank — dotted vermilion underline. */
  mined?: boolean;
  /** True while the popover for this word is open — pinned vermilion bg. */
  active?: boolean;
  /** Fires on click, Enter, or Space. */
  onTap: () => void;
  /** Override accessible name (defaults to the children text). */
  ariaLabel?: string;
}

export function Tapword({
  children,
  mined = false,
  active = false,
  onTap,
  ariaLabel,
}: TapwordProps): JSX.Element {
  // Keyboard parity with the click handler — Enter and Space both fire onTap.
  // Space is preventDefault'd to stop the page from scrolling when the focused
  // tapword sits inside a scrollable container.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onTap();
    }
  };

  return (
    <span
      className={cn(
        'km-tapword focusring',
        mined && 'km-tapword--mined',
        active && 'km-tapword--active',
      )}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={(e) => {
        // Stop bubbling so an ancestor sentence-level click (e.g. EN toggle)
        // doesn't also fire when the user taps a token.
        e.stopPropagation();
        onTap();
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </span>
  );
}
