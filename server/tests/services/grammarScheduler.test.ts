/**
 * grammarScheduler — pure FSRS-LITE unit tests (FU-NF-42, contract A5).
 *
 * No DB, no clock: every function under test is total and deterministic, so we
 * assert the verdict→rating mapping (including the usesPattern=false override),
 * the stability bands, the multiplicative progression, the difficulty clamps,
 * and the again→relearning lapse path exhaustively.
 */
import { describe, expect, it } from 'vitest';
import {
  ratingFromVerdict,
  schedule,
  type CardFsrs,
  type FsrsRating,
} from '../../src/services/grammarScheduler';

/** A fresh, never-reviewed card (mirrors vocab_cards defaults). */
function newCard(): CardFsrs {
  return { state: 'new', stability: 0, difficulty: 5, reps: 0, lapses: 0 };
}

describe('ratingFromVerdict', () => {
  it('maps each verdict to its rating when the pattern is used', () => {
    expect(ratingFromVerdict('incorrect', true)).toBe('again');
    expect(ratingFromVerdict('needs_work', true)).toBe('hard');
    expect(ratingFromVerdict('good', true)).toBe('good');
    expect(ratingFromVerdict('excellent', true)).toBe('easy');
  });

  it('forces "again" when the target pattern was NOT used, regardless of verdict', () => {
    // The headline override: fluency does not count if the drilled pattern is absent.
    expect(ratingFromVerdict('excellent', false)).toBe('again');
    expect(ratingFromVerdict('good', false)).toBe('again');
    expect(ratingFromVerdict('needs_work', false)).toBe('again');
    expect(ratingFromVerdict('incorrect', false)).toBe('again');
  });
});

describe('schedule — new-card stability bands', () => {
  it('seeds again → stability 0, relearning, scheduledDays 0', () => {
    const next = schedule(newCard(), 'again');
    expect(next.stability).toBe(0);
    expect(next.state).toBe('relearning');
    expect(next.scheduledDays).toBe(0);
    expect(next.rating).toBe('again');
  });

  it('seeds hard → stability 1 day, learning', () => {
    const next = schedule(newCard(), 'hard');
    expect(next.stability).toBe(1);
    expect(next.scheduledDays).toBe(1);
    expect(next.state).toBe('learning');
  });

  it('seeds good → stability 3 days, learning', () => {
    const next = schedule(newCard(), 'good');
    expect(next.stability).toBe(3);
    expect(next.scheduledDays).toBe(3);
    expect(next.state).toBe('learning');
  });

  it('seeds easy → stability 6 days, learning', () => {
    const next = schedule(newCard(), 'easy');
    expect(next.stability).toBe(6);
    expect(next.scheduledDays).toBe(6);
    expect(next.state).toBe('learning');
  });
});

describe('schedule — multiplicative progression on subsequent reps', () => {
  it('multiplies prior stability by 1.2 on hard', () => {
    const current: CardFsrs = { state: 'review', stability: 10, difficulty: 5, reps: 3, lapses: 0 };
    const next = schedule(current, 'hard');
    expect(next.stability).toBeCloseTo(12, 10);
    expect(next.scheduledDays).toBe(12);
    expect(next.state).toBe('review');
  });

  it('multiplies prior stability by 2.0 on good', () => {
    const current: CardFsrs = { state: 'review', stability: 10, difficulty: 5, reps: 3, lapses: 0 };
    const next = schedule(current, 'good');
    expect(next.stability).toBeCloseTo(20, 10);
    expect(next.scheduledDays).toBe(20);
  });

  it('multiplies prior stability by 3.0 on easy', () => {
    const current: CardFsrs = { state: 'review', stability: 10, difficulty: 5, reps: 3, lapses: 0 };
    const next = schedule(current, 'easy');
    expect(next.stability).toBeCloseTo(30, 10);
    expect(next.scheduledDays).toBe(30);
  });

  it('rounds scheduledDays UP from fractional stability (ceil)', () => {
    // 2.5 × 1.2 = 3.0 exactly; use a non-integer prior to force a ceil.
    const current: CardFsrs = { state: 'review', stability: 2.5, difficulty: 5, reps: 2, lapses: 0 };
    const next = schedule(current, 'good'); // 2.5 × 2.0 = 5.0
    expect(next.stability).toBeCloseTo(5, 10);
    const odd: CardFsrs = { state: 'review', stability: 2.1, difficulty: 5, reps: 2, lapses: 0 };
    const oddNext = schedule(odd, 'hard'); // 2.1 × 1.2 = 2.52 → ceil 3
    expect(oddNext.stability).toBeCloseTo(2.52, 10);
    expect(oddNext.scheduledDays).toBe(3);
  });

  it('re-seeds (does not multiply 0) when reps > 0 but stability is 0', () => {
    // A card that lapsed back to stability 0 still has reps > 0; multiplying 0
    // would never recover, so we re-seed from the base band and graduate to review.
    const recovering: CardFsrs = { state: 'relearning', stability: 0, difficulty: 6, reps: 4, lapses: 1 };
    const next = schedule(recovering, 'good');
    expect(next.stability).toBe(3);
    expect(next.state).toBe('review');
  });
});

describe('schedule — lapse (again) resets memory', () => {
  it('resets a strong card to stability 0 / relearning / due-now-ish on again', () => {
    const strong: CardFsrs = { state: 'review', stability: 40, difficulty: 4, reps: 8, lapses: 0 };
    const next = schedule(strong, 'again');
    expect(next.stability).toBe(0);
    expect(next.scheduledDays).toBe(0);
    expect(next.state).toBe('relearning');
  });
});

describe('schedule — difficulty deltas + clamp to [1,10]', () => {
  it('nudges difficulty per rating: again +1, hard +0.5, good +0, easy -0.5', () => {
    const base: CardFsrs = { state: 'review', stability: 5, difficulty: 5, reps: 2, lapses: 0 };
    expect(schedule(base, 'again').difficulty).toBeCloseTo(6, 10);
    expect(schedule(base, 'hard').difficulty).toBeCloseTo(5.5, 10);
    expect(schedule(base, 'good').difficulty).toBeCloseTo(5, 10);
    expect(schedule(base, 'easy').difficulty).toBeCloseTo(4.5, 10);
  });

  it('clamps difficulty at the ceiling of 10 on repeated misses', () => {
    const hardCard: CardFsrs = { state: 'review', stability: 5, difficulty: 9.8, reps: 2, lapses: 3 };
    expect(schedule(hardCard, 'again').difficulty).toBe(10);
  });

  it('clamps difficulty at the floor of 1 on repeated easy answers', () => {
    const easyCard: CardFsrs = { state: 'review', stability: 5, difficulty: 1.2, reps: 9, lapses: 0 };
    expect(schedule(easyCard, 'easy').difficulty).toBe(1);
  });
});

describe('schedule — invariants hold across the rating space', () => {
  const ratings: FsrsRating[] = ['again', 'hard', 'good', 'easy'];

  it('never produces negative stability, out-of-range difficulty, or negative scheduledDays', () => {
    const states: CardFsrs[] = [
      newCard(),
      { state: 'learning', stability: 1, difficulty: 1, reps: 1, lapses: 0 },
      { state: 'review', stability: 100, difficulty: 10, reps: 20, lapses: 5 },
      { state: 'relearning', stability: 0, difficulty: 7.3, reps: 6, lapses: 4 },
    ];
    for (const s of states) {
      for (const r of ratings) {
        const next = schedule(s, r);
        expect(next.stability).toBeGreaterThanOrEqual(0);
        expect(next.difficulty).toBeGreaterThanOrEqual(1);
        expect(next.difficulty).toBeLessThanOrEqual(10);
        expect(next.scheduledDays).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(next.scheduledDays)).toBe(true);
        expect(next.rating).toBe(r);
      }
    }
  });

  it('scheduledDays is 0 if and only if the rating is again', () => {
    const current: CardFsrs = { state: 'review', stability: 10, difficulty: 5, reps: 3, lapses: 0 };
    for (const r of ratings) {
      const next = schedule(current, r);
      expect(next.scheduledDays === 0).toBe(r === 'again');
    }
  });
});
