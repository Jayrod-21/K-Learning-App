/**
 * clozePresentation — the F-208 flashcard-vs-cloze coin flip.
 *
 * A due vocab card whose entry carries a `cloze` object is randomly presented
 * as EITHER the normal flashcard OR the typed cloze drill — a 50/50 flip per
 * appearance, decided client-side (the server just serves both presentations
 * on the same card). Cards without a `cloze` object are always flashcards.
 *
 * Lives in lib/ (not pages/Review.tsx) for the same reason as
 * `reviewSubmission.ts`: it keeps the decision directly unit-testable AND
 * mockable (tests stub this module to force each branch deterministically)
 * without violating react-refresh/only-export-components.
 *
 * No I/O — no threat model. `Math.random` is fine here: this is presentation
 * variety, not security randomness.
 */
import type { DueCard } from '../types/domain';

/** Which face the session shows for this appearance of the card. */
export type ClozePresentation = 'flashcard' | 'cloze';

/**
 * Decide the presentation for ONE appearance of a due card. Callers must
 * invoke this once per appearance and cache the result (re-rolling on every
 * render would flicker the face mid-card).
 */
export function pickPresentation(card: DueCard): ClozePresentation {
  if (card.cloze === undefined) return 'flashcard';
  return Math.random() < 0.5 ? 'cloze' : 'flashcard';
}
