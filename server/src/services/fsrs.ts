/**
 * fsrs — the shared, server-authoritative FSRS-LITE engine (FU-NF-45, first
 * step). ONE implementation of the state-transition math, called by BOTH
 * schedulers:
 *
 *   - grammar production drills (routes/grammarDrill.ts, via
 *     services/grammarScheduler.ts's verdict→rating mapping), and
 *   - vocab self-rated reviews (routes/vocab.ts POST /cards/:cardId/reviews).
 *
 * Extracted verbatim from services/grammarScheduler.ts so the two paths cannot
 * drift (DRY): the algorithm, constants, and invariants are exactly the
 * test-pinned FSRS-lite that grammar production cards have been scheduled with
 * since FU-NF-42. grammarScheduler.ts now only owns the drill-specific
 * verdict→rating mapping and delegates here.
 *
 * PURE module — no I/O, no clock, no DB. Every function is total and
 * deterministic so it is exhaustively unit-testable and routes can call it
 * inside a transaction without side effects. Routes own the clock: they turn
 * `dueDelayMs()` into a concrete `due_at`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY SERVER-SIDE (threat model)
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR-003 originally kept the vocab engine math on the CLIENT; the server
 * persisted whatever BEFORE/AFTER snapshot it was handed. That made the review
 * schedule client-dictated: a stubbed or tampered client sending
 * `scheduled_days_after: 0` (exactly what the Pass-3 client did) pins every
 * card due-immediately — and a hostile client could park a card years out or
 * corrupt the FSRS history the optimizer re-tunes from. The server is now
 * authoritative: it reads the card's CURRENT state from the DB, applies the
 * user's rating here, and writes the transition itself. The client sends only
 * the rating. (ADR-003 amendment, 2026-07-02.)
 *
 * Defends against:
 *   - Schedule tampering — client cannot choose `due_at` / `scheduled_days`.
 *   - Snapshot forgery — `card_reviews.*_before` comes from the DB row, never
 *     from the request, so the re-tuning log stays trustworthy (ADR-003 D2).
 *   - Garbage state — `schedule` clamps difficulty to [1,10] and stability to
 *     [0, STABILITY_MAX] regardless of input, so even a corrupted or near-max
 *     row can never produce a value that fails the vocab_cards/card_reviews
 *     CHECK constraints OR overflows the `NUMERIC(10,4)` stability column
 *     (Postgres 22003). All transitions are monotonic and bounded: stability
 *     grows on success but is capped at ~100 years, and resets (never negative)
 *     on a lapse. No unbounded growth, and the NaN-safe clamp means no NaN.
 *
 * This is still deliberately NOT a full ts-fsrs port — it is the small,
 * documented, MONOTONIC, BOUNDED interim scheduler from FU-NF-42. Upgrading
 * this one module to real ts-fsrs upgrades both paths at once (FU-NF-45).
 */

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
  /** Whole-day interval until next review. 0 ⇒ a minute-scale step: the route
   *  schedules RELEARN_DELAY_MS (<1 min, again) or HARD_STEP_DELAY_MS (~6 min,
   *  hard) out via dueDelayMs. */
  scheduledDays: number;
  /** The rating this transition was computed from (echoed for the review log). */
  rating: FsrsRating;
}

/** One day in milliseconds — the unit `scheduledDays` converts through. */
export const MS_PER_DAY = 86_400_000;

/**
 * Milliseconds added to now() when a lapse (rating 'again') re-queues a card.
 * scheduledDays 0 + relearning ⇒ "see it again very soon" rather than now+0d.
 *
 * B-021: tuned to just under a minute so the client's Anki-convention `<1m`
 * rating label is literally true (Anki's default again step renders as "<1m").
 * Was 10 minutes, which contradicted the advertised label.
 */
export const RELEARN_DELAY_MS = 50 * 1000;

/**
 * Milliseconds added to now() for a `hard` LEARNING STEP — a hard answer on a
 * card with no accumulated stability (brand-new, or relearning after a lapse).
 * Anki convention: hard on a new card repeats the learning step ~6 minutes out
 * rather than seeding a day-scale interval (B-021 — matches the client's `6m`
 * label). Like RELEARN_DELAY_MS, this is clock policy, NOT memory stability:
 * learning steps are minute-scale delays outside the stability-days model
 * (ADR-003 storage is unchanged — the card simply persists stability 0 /
 * scheduled_days 0 while it is still inside its learning steps).
 */
export const HARD_STEP_DELAY_MS = 6 * 60 * 1000;

/** Canonical FSRS difficulty floor / ceiling (matches ck_vocab_cards_difficulty_range).
 *  A brand-new card starts at difficulty 5.0 via the vocab_cards column DEFAULT;
 *  this module only ever nudges + clamps that value, never seeds it. */
const DIFFICULTY_MIN = 1;
const DIFFICULTY_MAX = 10;

/**
 * Upper bound on stability (days). `stability` persists to `NUMERIC(10, 4)`
 * (migration 001), whose ceiling is 999,999.9999; without a cap, a near-max or
 * corrupted row × the `easy` multiplier (up to ×3.0) overflows the column →
 * Postgres 22003 `numeric_field_overflow` → 500. We cap at 36,500 days (~100
 * years): an interval past a human lifetime carries no scheduling value, and
 * the cap keeps `stability × MULTIPLIER` (≤ 36,500 × 3 = 109,500) an order of
 * magnitude under the NUMERIC precision ceiling, so no reachable transition can
 * ever fail the constraint. This is what makes the module header's "even a
 * corrupted row can never produce a value that fails the … CHECK constraints"
 * true for precision overflow, not just the `>= 0` floor.
 */
export const STABILITY_MAX = 36_500;

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
 * or coming back from a lapse). Tuned to true Anki graduation intervals (B-021,
 * matching the client's `<1m / 6m / 1d / 4d` rating labels):
 *
 *   - `again` parks at 0 → relearning step, re-queued RELEARN_DELAY_MS (<1 min) out;
 *   - `hard` ALSO stays at 0 → the card repeats its learning step ~6 minutes out
 *     (HARD_STEP_DELAY_MS) instead of graduating — hard on unlearned material is
 *     a learning step, not a day-scale interval;
 *   - `good` graduates at 1 day (Anki's default graduating interval);
 *   - `easy` graduates at 4 days (Anki's default easy interval).
 */
const BASE_STABILITY: Readonly<Record<FsrsRating, number>> = {
  again: 0,
  hard: 0,
  good: 1,
  easy: 4,
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

/**
 * Clamp a number into [lo, hi]. Total AND NaN-safe: a non-finite input (NaN /
 * ±Infinity from a corrupted row or a bad cast) resolves to the lower bound —
 * the fail-to-safe choice, since every caller's `lo` (0 for stability, 1 for
 * difficulty) is a valid, constraint-satisfying value. This makes the module
 * header's "no NaN" guarantee hold by construction rather than by assuming the
 * inputs are already clean.
 */
function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Apply a rating to a card's current FSRS state → next state + interval.
 *
 * DIFFICULTY: starts at 5 for a new card; nudged by DIFFICULTY_DELTA per rating;
 * clamped to [1,10].
 *
 * STABILITY (days):
 *   - First successful exposure (reps === 0, or any time the prior stability is
 *     0): seed from BASE_STABILITY[rating] — good graduates at 1 day, easy at
 *     4 days; hard stays at 0 (still inside its minute-scale learning steps).
 *   - Subsequent successful exposure: multiply the PRIOR stability by
 *     STABILITY_MULTIPLIER[rating] (hard ×1.2, good ×2.0, easy ×3.0) — monotone
 *     growth on success.
 *   - `again` (a lapse): reset stability to 0 and enter `relearning`.
 *
 * STATE:
 *   - again                  → relearning  (the card lapsed; re-queue shortly)
 *   - hard, no prior stability → learning (reps==0) / relearning (reps>0)
 *                                          (still stepping; not graduated)
 *   - else reps==0           → learning    (first pass through the material)
 *   - else                   → review      (graduated; normal review schedule)
 *
 * INTERVAL: scheduledDays = (rating === 'again') ? 0 : ceil(stability). 0 signals
 * a minute-scale step: dueDelayMs maps it to RELEARN_DELAY_MS (<1 min) on
 * `again` or HARD_STEP_DELAY_MS (~6 min) on `hard`, never "now+0 days".
 *
 * COUNTERS: reps += 1 always; lapses += 1 only on `again` (applied by the
 * route's UPDATE, mirroring these semantics).
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
    // No accumulated memory yet: seed from the base band. `hard` seeds 0 — the
    // card repeats its learning step (~6 min via dueDelayMs) without
    // graduating, so it stays in learning/relearning; `good`/`easy` graduate
    // it onto a day-scale interval. A brand-new card (reps 0) is `learning`;
    // a card with prior reps is recovering from a lapse, so a non-graduating
    // hard keeps it `relearning` while good/easy move it on to `review`.
    stability = BASE_STABILITY[rating];
    if (stability === 0) {
      state = current.reps === 0 ? 'learning' : 'relearning';
    } else {
      state = current.reps === 0 ? 'learning' : 'review';
    }
  } else {
    // Subsequent success: grow stability and keep it on the review schedule.
    stability = current.stability * STABILITY_MULTIPLIER[rating];
    state = 'review';
  }

  // Clamp into [0, STABILITY_MAX]: floor at 0 (never negative), cap at the
  // ~100-year ceiling so the value always fits NUMERIC(10,4) (no 22003 overflow
  // on write), and — via the NaN-safe clamp — collapse any non-finite input to
  // 0. again → 0 by construction (dueDelayMs maps 0 to a minute-scale step).
  const safeStability = clamp(stability, 0, STABILITY_MAX);
  const scheduledDays = rating === 'again' ? 0 : Math.max(0, Math.ceil(safeStability));

  return {
    state,
    stability: safeStability,
    difficulty,
    scheduledDays,
    rating,
  };
}

/**
 * Milliseconds from "now" until the transition's `due_at` — the ONE place the
 * scheduledDays→clock policy lives, shared by both review-writing routes:
 *
 *   - a lapse (`again`, scheduledDays 0) re-queues RELEARN_DELAY_MS (<1 min)
 *     out, never "now + 0 days" (which would make the card immediately due
 *     again — the exact stub bug this engine replaces);
 *   - any other scheduledDays-0 transition is a `hard` learning step (the only
 *     rating that seeds stability 0 — see BASE_STABILITY) → HARD_STEP_DELAY_MS
 *     (~6 min). This branch also fail-safes the degenerate non-finite-stability
 *     row (clamped to 0) to a minute-scale re-queue instead of due-now;
 *   - every other rating schedules scheduledDays whole days out.
 *
 * Pure: the caller applies it to its own clock (`new Date(Date.now() + …)`).
 */
export function dueDelayMs(next: NextFsrs): number {
  if (next.rating === 'again') return RELEARN_DELAY_MS;
  if (next.scheduledDays === 0) return HARD_STEP_DELAY_MS;
  return next.scheduledDays * MS_PER_DAY;
}
