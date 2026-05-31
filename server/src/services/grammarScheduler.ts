/**
 * grammarScheduler — server-derived FSRS-LITE scheduling for grammar PRODUCTION
 * drills (FU-NF-42).
 *
 * PURE module — no I/O, no clock, no DB. Every function is total and
 * deterministic so it is exhaustively unit-testable and the route can call it
 * inside the submit transaction without any side effects of its own. The route
 * owns the clock (it translates `scheduledDays` → a concrete `due_at`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (deliberate divergence from ADR-003)
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR-003 stores FSRS state on `vocab_cards` and keeps the *engine math* on the
 * CLIENT: the client computes the next state from a learner self-rating
 * (Again/Hard/Good/Easy) and the server persists the BEFORE/AFTER snapshot it is
 * handed. That model assumes a human grades themself.
 *
 * A grammar production drill has NO self-rating step — it is SERVER-scored by
 * Claude (verdict + score). So for THIS path the server must itself map the
 * verdict → an FSRS rating → a concrete interval, then write the production card
 * + review the same way the vocab path does. This module is that mapping. It is
 * a small, documented, MONOTONIC, BOUNDED interim scheduler — intentionally NOT
 * a full ts-fsrs port. Unifying both paths onto one real FSRS engine is filed as
 * FU-NF-45; until then this keeps grammar production cards on a sane, total,
 * test-pinned schedule.
 *
 * THREAT MODEL (the inputs are NOT user-controlled, but defend anyway):
 *   - `verdict`/`usesPattern` come from the server's own Claude scoring result,
 *     not from request body — but `schedule` clamps difficulty to [1,10] and
 *     floors stability/scheduledDays at 0 regardless of input, so even a garbage
 *     `current` (e.g. a corrupted row) can never produce an out-of-CHECK value
 *     that would fail the vocab_cards/card_reviews write constraints.
 *   - All transitions are monotonic and bounded: stability only grows on
 *     success and resets (never goes negative) on a lapse; difficulty is clamped;
 *     scheduledDays is a non-negative integer. No unbounded growth, no NaN.
 */
import type { DrillVerdict } from './claudeProxy.js';

/** FSRS canonical rating buckets — mirrors the `fsrs_rating` enum (migration 001). */
export type FsrsRating = 'again' | 'hard' | 'good' | 'easy';

/** FSRS card lifecycle states — mirrors the `fsrs_state` enum (migration 001). */
export type FsrsStateName = 'new' | 'learning' | 'review' | 'relearning';

/** The FSRS state of a card BEFORE applying a review. */
export interface CardFsrs {
  state: FsrsStateName;
  /** Memory stability in days (≥ 0). */
  stability: number;
  /** Difficulty on the canonical FSRS 1.0–10.0 scale. */
  difficulty: number;
  reps: number;
  lapses: number;
}

/** The FSRS state of a card AFTER applying a review, plus the derived interval. */
export interface NextFsrs {
  state: FsrsStateName;
  /** Memory stability in days (≥ 0). */
  stability: number;
  /** Difficulty on the canonical FSRS 1.0–10.0 scale (clamped to [1,10]). */
  difficulty: number;
  /** Whole-day interval until next review. 0 ⇒ the route schedules ~10 min out. */
  scheduledDays: number;
  /** The rating this transition was computed from (echoed for the review log). */
  rating: FsrsRating;
}

/** Canonical FSRS difficulty floor / ceiling (matches ck_vocab_cards_difficulty_range).
 *  A brand-new card starts at difficulty 5.0 via the vocab_cards column DEFAULT;
 *  this module only ever nudges + clamps that value, never seeds it. */
const DIFFICULTY_MIN = 1;
const DIFFICULTY_MAX = 10;

/**
 * Per-rating difficulty delta. A miss makes the card harder; an easy answer
 * makes it easier; `good` is neutral. Applied then clamped to [1,10].
 */
const DIFFICULTY_DELTA: Readonly<Record<FsrsRating, number>> = {
  again: +1,
  hard: +0.5,
  good: 0,
  easy: -0.5,
};

/**
 * Base stability (days) for a card with NO prior successful exposure (reps === 0
 * or coming back from a lapse). `again` parks at 0 so the route re-queues it in
 * ~10 minutes; the others seed the first real interval.
 */
const BASE_STABILITY: Readonly<Record<FsrsRating, number>> = {
  again: 0,
  hard: 1,
  good: 3,
  easy: 6,
};

/**
 * Growth multiplier applied to PRIOR stability on a subsequent successful review.
 * `again` is handled separately (reset to 0 → relearning), so it carries no
 * multiplier here.
 */
const STABILITY_MULTIPLIER: Readonly<Record<Exclude<FsrsRating, 'again'>, number>> = {
  hard: 1.2,
  good: 2.0,
  easy: 3.0,
};

/** Clamp a number into [lo, hi]. Total — NaN-in would propagate, but inputs are bounded numerics. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Map a drill verdict (+ whether the answer actually used the target pattern) to
 * an FSRS rating.
 *
 *   incorrect  → again
 *   needs_work → hard
 *   good       → good
 *   excellent  → easy
 *
 * OVERRIDE: `usesPattern === false` forces `again` regardless of the verdict.
 * If the learner produced a fluent, correct Korean sentence that DOESN'T use the
 * pattern being drilled, they have not demonstrated the target skill — the
 * production card must not advance. This is the one place fluency is deliberately
 * subordinated to pattern usage.
 */
export function ratingFromVerdict(verdict: DrillVerdict, usesPattern: boolean): FsrsRating {
  if (!usesPattern) return 'again';
  switch (verdict) {
    case 'incorrect':
      return 'again';
    case 'needs_work':
      return 'hard';
    case 'good':
      return 'good';
    case 'excellent':
      return 'easy';
    default: {
      // Exhaustiveness guard: DrillVerdict is a closed union. If a new variant is
      // added without updating this map, fail loudly rather than silently
      // mis-scheduling — the verdict is server-sourced so this is an invariant.
      const _exhaustive: never = verdict;
      throw new Error(`unhandled drill verdict: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Apply a rating to a card's current FSRS state → next state + interval.
 *
 * DIFFICULTY: starts at 5 for a new card; nudged by DIFFICULTY_DELTA per rating;
 * clamped to [1,10].
 *
 * STABILITY (days):
 *   - First successful exposure (reps === 0, or any time the prior stability is
 *     0): seed from BASE_STABILITY[rating].
 *   - Subsequent successful exposure: multiply the PRIOR stability by
 *     STABILITY_MULTIPLIER[rating] (hard ×1.2, good ×2.0, easy ×3.0) — monotone
 *     growth on success.
 *   - `again` (a lapse): reset stability to 0 and enter `relearning`.
 *
 * STATE:
 *   - again        → relearning   (the card lapsed; re-queue shortly)
 *   - else reps==0 → learning     (first pass through the material)
 *   - else         → review       (graduated; on the normal review schedule)
 *
 * INTERVAL: scheduledDays = (rating === 'again') ? 0 : ceil(stability). 0 signals
 * the route to schedule the card ~10 minutes out (relearning), not "now+0 days".
 *
 * COUNTERS: reps += 1 always; lapses += 1 only on `again`.
 */
export function schedule(current: CardFsrs, rating: FsrsRating): NextFsrs {
  const difficulty = clamp(current.difficulty + DIFFICULTY_DELTA[rating], DIFFICULTY_MIN, DIFFICULTY_MAX);

  // A card with no accumulated stability (new card, or one that just lapsed back
  // to 0) seeds from the per-rating base; otherwise it grows multiplicatively.
  // Guard reps too: a row could carry reps>0 with stability 0 after a lapse, in
  // which case we still re-seed rather than multiply 0 (which would never grow).
  const hasPriorStability = current.reps > 0 && current.stability > 0;

  let stability: number;
  let state: FsrsStateName;

  if (rating === 'again') {
    // Lapse: reset memory, drop into relearning, re-queue almost immediately.
    stability = 0;
    state = 'relearning';
  } else if (!hasPriorStability) {
    // First real success: seed the initial interval. A brand-new card graduates
    // to `learning`; a card with prior reps (e.g. recovering after relearning)
    // moves on to `review`.
    stability = BASE_STABILITY[rating];
    state = current.reps === 0 ? 'learning' : 'review';
  } else {
    // Subsequent success: grow stability and keep it on the review schedule.
    stability = current.stability * STABILITY_MULTIPLIER[rating];
    state = 'review';
  }

  // Floor at 0 defensively (never negative) and round up to a whole-day interval.
  // again → 0 by construction (route maps 0 → ~10 min).
  const safeStability = Math.max(0, stability);
  const scheduledDays = rating === 'again' ? 0 : Math.max(0, Math.ceil(safeStability));

  return {
    state,
    stability: safeStability,
    difficulty,
    scheduledDays,
    rating,
  };
}
