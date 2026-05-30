/**
 * Flashcard — perspective:1400 flip card, 480ms cubic-bezier(.4,.2,.2,1).
 *
 * Controlled component. The parent owns `flipped` (so it can also bind
 * Spacebar in the Review screen to flip-on-press) and provides the front
 * and back faces as render slots. We don't dictate face content — the
 * Review screen's front and back are quite different shapes (huge serif
 * word vs. dense gloss + example), so any default styling here would just
 * get overridden.
 *
 * The flip is delivered by `.km-flashcard.km-flashcard--flipped` toggling
 * a 180° rotateY on the inner element. Backface visibility is hidden on
 * each face so the back face's pre-rotation render doesn't bleed through.
 *
 * A11y:
 *   - Outer container is `role="button"` with `aria-expanded` reflecting
 *     `flipped`. Clicking anywhere on the card (front or back) calls
 *     `onFlip` so the user doesn't have to find a small button.
 *   - Reduced-motion: honoured by the global media query (animation
 *     duration drops to ~0). The rotateY transform still applies so the
 *     correct face is shown — only the in-between animation disappears.
 *
 * Reduced-motion fast-path note: even with animation duration ~0, the
 * `transform` value still applies instantly, which is what we want.
 *
 * No I/O — no threat model.
 */
import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

export interface FlashcardProps {
  /** Front face — shown when `flipped === false`. */
  front: ReactNode;
  /** Back face — shown when `flipped === true`. */
  back: ReactNode;
  /** Current side. */
  flipped: boolean;
  /** Fires on click + Enter/Space — parent decides whether to toggle. */
  onFlip: () => void;
  /** Accessible label. Defaults to "Flip card". */
  ariaLabel?: string;
}

export function Flashcard({
  front,
  back,
  flipped,
  onFlip,
  ariaLabel = 'Flip card',
}: FlashcardProps): JSX.Element {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onFlip();
    }
  };

  return (
    <div
      className={cn('km-flashcard focusring', flipped && 'km-flashcard--flipped')}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-expanded={flipped}
      onClick={onFlip}
      onKeyDown={onKeyDown}
    >
      <div className="km-flashcard__inner">
        <div className="km-flashcard__face km-flashcard__face--front">
          {front}
        </div>
        <div className="km-flashcard__face km-flashcard__face--back">
          {back}
        </div>
      </div>
    </div>
  );
}
