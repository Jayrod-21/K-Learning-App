/**
 * fsrs — pure shared FSRS-LITE engine unit tests (FU-NF-45, first step).
 *
 * No DB, no clock: every function under test is total and deterministic, so we
 * assert the stability bands, the multiplicative progression, the difficulty
 * clamps, the again→relearning lapse path, and the dueDelayMs clock policy
 * exhaustively. This is the ONE engine both grammar production drills and
 * vocab self-rated reviews schedule through — these tests pin the contract
 * for both routes at once.
 */
import { describe, expect, it } from 'vitest';
import {
  dueDelayMs,
  HARD_STEP_DELAY_MS,
  MS_PER_DAY,
  RELEARN_DELAY_MS,
  schedule,
  STABILITY_MAX,
  type CardFsrs,
  type FsrsRating,
} from '../../src/services/fsrs';

/** A fresh, never-reviewed card (mirrors vocab_cards defaults). */
function newCard(): CardFsrs {
  return { state: 'new', stability: 0, difficulty: 5, reps: 0, lapses: 0 };
}

// B-021: the fresh-card bands are the TRUE Anki intervals the client's rating
// labels advertise (`<1m / 6m / 1d / 4d`). The pre-retune engine (10m/1d/3d/6d)
// FAILS these assertions by design.
describe('schedule — new-card stability bands (true Anki intervals, B-021)', () => {
  it('seeds again → stability 0, relearning, scheduledDays 0 (<1-minute re-queue)', () => {
    const next = schedule(newCard(), 'again');
    expect(next.stability).toBe(0);
    expect(next.state).toBe('relearning');
    expect(next.scheduledDays).toBe(0);
    expect(next.rating).toBe('again');
  });

  it('seeds hard → stability 0, learning, scheduledDays 0 (~6-minute learning step, NOT 1 day)', () => {
    const next = schedule(newCard(), 'hard');
    expect(next.stability).toBe(0); // hard does not graduate — still stepping
    expect(next.scheduledDays).toBe(0);
    expect(next.state).toBe('learning');
  });

  it('seeds good → stability 1 day, learning (Anki graduating interval, NOT 3 days)', () => {
    const next = schedule(newCard(), 'good');
    expect(next.stability).toBe(1);
    expect(next.scheduledDays).toBe(1);
    expect(next.state).toBe('learning');
  });

  it('seeds easy → stability 4 days, learning (Anki easy interval, NOT 6 days)', () => {
    const next = schedule(newCard(), 'easy');
    expect(next.stability).toBe(4);
    expect(next.scheduledDays).toBe(4);
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
    expect(next.stability).toBe(1);
    expect(next.state).toBe('review');
  });

  it('hard on a recovering card (reps > 0, stability 0) repeats the step in relearning, not review', () => {
    // Anki relearning-step semantics: hard does not graduate a lapsed card —
    // it stays minute-scale (scheduledDays 0) and remains in relearning.
    const recovering: CardFsrs = { state: 'relearning', stability: 0, difficulty: 6, reps: 4, lapses: 1 };
    const next = schedule(recovering, 'hard');
    expect(next.stability).toBe(0);
    expect(next.scheduledDays).toBe(0);
    expect(next.state).toBe('relearning');
    expect(dueDelayMs(next)).toBe(HARD_STEP_DELAY_MS);
  });
});

describe('schedule — stability is clamped to STABILITY_MAX (NUMERIC(10,4) overflow guard)', () => {
  it('clamps a near-max stability × easy to STABILITY_MAX instead of overflowing NUMERIC(10,4)', () => {
    // The stability column is NUMERIC(10,4) — ceiling 999,999.9999. A corrupted
    // or extreme row near that ceiling × the easy multiplier (×3.0) is 2,999,970
    // on the PRE-FIX code, which Postgres rejects on write with 22003
    // numeric_field_overflow → 500. The clamp keeps it representable.
    const nearMax: CardFsrs = {
      state: 'review',
      stability: 999_990,
      difficulty: 5,
      reps: 50,
      lapses: 0,
    };
    const next = schedule(nearMax, 'easy');
    expect(next.stability).toBe(STABILITY_MAX);
    // Comfortably inside NUMERIC(10,4) precision (< 1,000,000) — no overflow.
    expect(next.stability).toBeLessThan(1_000_000);
    expect(next.scheduledDays).toBe(Math.ceil(STABILITY_MAX));
  });

  it('holds at the cap under repeated easy presses (monotone, never overflowing)', () => {
    let card: CardFsrs = {
      state: 'review',
      stability: STABILITY_MAX,
      difficulty: 3,
      reps: 20,
      lapses: 0,
    };
    for (let i = 0; i < 5; i += 1) {
      const next = schedule(card, 'easy');
      expect(next.stability).toBe(STABILITY_MAX);
      expect(next.stability).toBeLessThan(1_000_000);
      card = {
        ...card,
        stability: next.stability,
        difficulty: next.difficulty,
        reps: card.reps + 1,
      };
    }
  });
});

describe('schedule — clamp is NaN-safe (no non-finite value can escape)', () => {
  it('resolves a NaN difficulty to the floor (1) rather than propagating NaN', () => {
    const bad: CardFsrs = {
      state: 'review',
      stability: 5,
      difficulty: Number.NaN,
      reps: 3,
      lapses: 0,
    };
    const next = schedule(bad, 'good');
    expect(Number.isNaN(next.difficulty)).toBe(false);
    expect(next.difficulty).toBe(1);
    expect(Number.isFinite(next.stability)).toBe(true);
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

  it('on a GRADUATED card (prior stability > 0) scheduledDays is 0 iff the rating is again', () => {
    const current: CardFsrs = { state: 'review', stability: 10, difficulty: 5, reps: 3, lapses: 0 };
    for (const r of ratings) {
      const next = schedule(current, r);
      expect(next.scheduledDays === 0).toBe(r === 'again');
    }
  });

  it('scheduledDays is 0 exactly for the minute-scale steps: again anywhere, hard without prior stability', () => {
    // Fresh card: again AND hard are learning steps (0); good/easy graduate (>0).
    for (const r of ratings) {
      const next = schedule(newCard(), r);
      expect(next.scheduledDays === 0).toBe(r === 'again' || r === 'hard');
    }
  });
});

describe('dueDelayMs — the shared scheduledDays→clock policy', () => {
  const current: CardFsrs = { state: 'review', stability: 10, difficulty: 5, reps: 3, lapses: 0 };

  it('a lapse (again) re-queues RELEARN_DELAY_MS (<1 min) out, never now+0d', () => {
    const next = schedule(current, 'again');
    expect(dueDelayMs(next)).toBe(RELEARN_DELAY_MS);
    // The label contract (B-021): "Again" genuinely means under a minute…
    expect(RELEARN_DELAY_MS).toBeLessThan(60_000);
    // …but the whole point of the policy still holds: strictly in the future.
    expect(dueDelayMs(next)).toBeGreaterThan(0);
  });

  it('non-lapse ratings on a graduated card schedule scheduledDays whole days out', () => {
    expect(dueDelayMs(schedule(current, 'hard'))).toBe(12 * MS_PER_DAY);
    expect(dueDelayMs(schedule(current, 'good'))).toBe(20 * MS_PER_DAY);
    expect(dueDelayMs(schedule(current, 'easy'))).toBe(30 * MS_PER_DAY);
  });

  it('a FRESH card yields the advertised Anki intervals: again <1m, hard ~6m, good 1d, easy 4d (B-021)', () => {
    const again = dueDelayMs(schedule(newCard(), 'again'));
    const hard = dueDelayMs(schedule(newCard(), 'hard'));
    const good = dueDelayMs(schedule(newCard(), 'good'));
    const easy = dueDelayMs(schedule(newCard(), 'easy'));
    expect(again).toBeLessThan(60_000); // `<1m` label is literally true
    expect(hard).toBe(HARD_STEP_DELAY_MS);
    expect(hard).toBe(6 * 60_000); // `6m`
    expect(good).toBe(1 * MS_PER_DAY); // `1d`
    expect(easy).toBe(4 * MS_PER_DAY); // `4d`
    // Strictly ordered: again < hard < good < easy.
    expect(again).toBeLessThan(hard);
    expect(hard).toBeLessThan(good);
    expect(good).toBeLessThan(easy);
  });

  it('is strictly positive for every rating on a fresh card (no card is ever re-due immediately)', () => {
    const ratings: FsrsRating[] = ['again', 'hard', 'good', 'easy'];
    for (const r of ratings) {
      expect(dueDelayMs(schedule(newCard(), r))).toBeGreaterThan(0);
    }
  });
});
