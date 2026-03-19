/**
 * SM-2 Spaced Repetition Algorithm
 * Based on SuperMemo SM-2 specification
 * Quality: 0-5 (0-1 = fail, 2 = hard, 3 = ok, 4 = good, 5 = perfect)
 */

export interface SM2Card {
  /** Days until next review */
  interval: number;
  /** Easiness factor (minimum 1.3) */
  easiness: number;
  /** Successful review streak count */
  repetitions: number;
  /** Date of next scheduled review */
  nextReview: Date;
  /** Number of consecutive correct answers */
  consecutiveCorrect: number;
  /** Whether the card has reached mastery (5+ consecutive correct) */
  isMastered: boolean;
}

/** Minimum allowed easiness factor */
const MIN_EASINESS = 1.3;
/** Number of consecutive correct answers required for mastery */
const MASTERY_THRESHOLD = 5;

/**
 * Calculate new SM-2 card state after a review
 * @param card - Current card state
 * @param quality - Review quality rating (0-5)
 * @returns Updated card state with new interval, easiness, and review date
 */
export function calculateSM2(card: SM2Card, quality: number): SM2Card {
  let { interval, easiness, repetitions, consecutiveCorrect } = card;

  if (quality >= 3) {
    // Correct response — increase interval
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easiness);

    repetitions += 1;
    consecutiveCorrect += 1;
  } else {
    // Incorrect — reset to beginning
    repetitions = 0;
    interval = 1;
    consecutiveCorrect = 0;
  }

  // Update easiness factor using SM-2 formula
  easiness = Math.max(
    MIN_EASINESS,
    easiness + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)
  );

  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + interval);

  return {
    interval,
    easiness,
    repetitions,
    nextReview,
    consecutiveCorrect,
    isMastered: consecutiveCorrect >= MASTERY_THRESHOLD,
  };
}

/**
 * Check if a card is due for review
 * @param card - Card to check
 * @returns true if the card's next review date is in the past
 */
export function isDueForReview(card: SM2Card): boolean {
  return new Date() >= new Date(card.nextReview);
}

/**
 * Create a new SM-2 card with default values
 * @returns Fresh SM2Card ready for first review
 */
export function createNewCard(): SM2Card {
  return {
    interval: 1,
    easiness: 2.5,
    repetitions: 0,
    nextReview: new Date(),
    consecutiveCorrect: 0,
    isMastered: false,
  };
}
