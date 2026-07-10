/**
 * cardReview — the ONE transactional "apply a self-rating to a card" write
 * path (ADR-003 amendment, 2026-07-02), shared by every self-rated review
 * route:
 *
 *   - POST /vocab/cards/:cardId/reviews  (routes/vocab.ts)
 *   - POST /hanja/cards/:cardId/reviews  (routes/hanja.ts, F-075)
 *
 * Extracted VERBATIM from the vocab route's handler so the two routes cannot
 * drift — the same reason services/fsrs.ts exists: one schedule policy, one
 * storage shape, one concurrency protocol. The FSRS math itself stays in
 * services/fsrs.ts (this module is the DB write around it); grammar
 * production drills keep their own drill-transaction write in
 * routes/grammarDrill.ts (server-scored, no self-rating — ADR-003 FU-NF-42)
 * but call the same fsrs.ts engine.
 *
 * SECURITY (unchanged from the vocab route this was lifted from):
 *   - Server-authoritative scheduling: the caller supplies only the rating;
 *     every `*_before` snapshot comes from the FOR UPDATE-locked DB row and
 *     every `*_after` value from the shared engine — a tampered client can
 *     never dictate `due_at` or corrupt the re-tuning log (ADR-003 D2).
 *   - User-scoped: the SELECT and UPDATE both filter on user_id, so a caller
 *     can only ever advance their own card (cross-user probe → 404, no
 *     existence leak).
 *   - Optimistic concurrency: FOR UPDATE serializes concurrent raters; a
 *     stale expected_version surfaces as 409 (FU-NF-8: distinct from 404).
 */
import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';
import { dueDelayMs, schedule, type CardFsrs, type FsrsRating, type FsrsStateName } from './fsrs.js';

export interface ApplyCardReviewInput {
  cardId: number;
  userId: number;
  rating: FsrsRating;
  /** Time the user spent on the review (ms); logged, never scheduled from. */
  durationMs?: number | undefined;
  /** The card version the client last saw (optimistic concurrency). */
  expectedVersion: number;
  /**
   * When true, the card must be a hanja-target card (hanja_character_id set):
   * the hanja route must not become a side door for rating other families
   * under its own contract. A non-hanja card 404s exactly like a card the
   * user does not own — same no-existence-leak posture as the user filter.
   */
  requireHanjaTarget?: boolean;
  /** Error-message noun — 'vocab card' | 'hanja card'. Kept caller-supplied so
   *  the vocab route's wire-visible messages are byte-identical pre/post
   *  extraction ("vocab card not found" / "vocab card version is stale"). */
  cardNoun: string;
}

export interface ApplyCardReviewResult {
  /** The card's version AFTER this review (client echoes it next time). */
  version: number;
  /** Server-computed next due timestamp. */
  dueAt: Date;
  /** Whole-day interval (0 ⇒ the ~10-minute relearn re-queue). */
  scheduledDays: number;
}

/**
 * Apply one rating to one card: lock the row, derive the FSRS transition via
 * the shared engine, advance the card (version-checked), and append the
 * BEFORE/AFTER snapshot to card_reviews — all in a single transaction.
 *
 * Throws NotFoundError (missing / not yours / soft-deleted / wrong family
 * when requireHanjaTarget) or ConflictError (stale expectedVersion).
 */
export async function applyCardReview(input: ApplyCardReviewInput): Promise<ApplyCardReviewResult> {
  const { cardId, userId, rating, expectedVersion, cardNoun } = input;

  return withTransaction(async (client) => {
    // FU-NF-8 (FOLLOW_UPS.md, 2026-05-29): "card doesn't exist / not yours /
    // soft-deleted" (404) is split from "your expected_version is stale"
    // (409) — clients branch on the code (retry-after-refetch vs.
    // resolve-conflict). Both queries run inside one transaction and the
    // SELECT takes FOR UPDATE, so concurrent reviewers of the same card are
    // serialized and cannot both pass the existence check. The SELECT is
    // also the AUTHORITATIVE source of the `*_before` snapshot: the FSRS
    // input state comes from the locked DB row, never from the request
    // (ADR-003 D2 stays trustworthy for re-tuning against a hostile client).
    const existing = await client.query<{
      fsrs_state: FsrsStateName;
      stability: string;
      difficulty: string;
      reps: number;
      lapses: number;
      version: number;
      hanja_character_id: string | null;
    }>(
      `SELECT fsrs_state, stability, difficulty, reps, lapses, version,
              hanja_character_id
         FROM vocab_cards
        WHERE id = $1
          AND user_id = $2
          AND deleted_at IS NULL
        FOR UPDATE`,
      [cardId, userId],
    );
    if (existing.rowCount === 0) {
      throw new NotFoundError(`${cardNoun} not found`);
    }
    const card = existing.rows[0]!;
    if (input.requireHanjaTarget === true && card.hanja_character_id === null) {
      // Same 404 as "not yours": the hanja route neither confirms nor rates
      // cards of other families (no existence/family leak, no side door).
      throw new NotFoundError(`${cardNoun} not found`);
    }

    // Derive the next FSRS state from the card's CURRENT state + the user's
    // rating — the same shared engine grammar production drills use, so
    // every card family follows one schedule policy.
    const current: CardFsrs = {
      state: card.fsrs_state,
      stability: Number(card.stability),
      difficulty: Number(card.difficulty),
      reps: card.reps,
      lapses: card.lapses,
    };
    const next = schedule(current, rating);

    // due_at: scheduled_days out, except a lapse (again ⇒ scheduledDays 0)
    // re-queues ~10 min from now (relearning) rather than immediately —
    // never "due now" again (the pre-cutover stub bug).
    const dueAt = new Date(Date.now() + dueDelayMs(next));

    // Optimistic concurrency: bump only if version matches.
    const upd = await client.query<{ version: number }>(
      `UPDATE vocab_cards
          SET fsrs_state     = $3::fsrs_state,
              stability      = $4,
              difficulty     = $5,
              elapsed_days   = 0,
              scheduled_days = $6,
              reps           = reps + 1,
              lapses         = lapses + CASE WHEN $7::fsrs_rating = 'again' THEN 1 ELSE 0 END,
              last_reviewed_at = now(),
              due_at         = $8,
              version        = version + 1
        WHERE id = $1
          AND user_id = $2
          AND version = $9
          AND deleted_at IS NULL
      RETURNING version`,
      [
        cardId,
        userId,
        next.state,
        next.stability,
        next.difficulty,
        next.scheduledDays,
        rating,
        dueAt,
        expectedVersion,
      ],
    );
    if (upd.rowCount === 0) {
      // Existence was just confirmed above (and we hold a row lock); the
      // only remaining reason for rowCount=0 is a version mismatch.
      throw new ConflictError(`${cardNoun} version is stale`);
    }
    // Append-only review log: BEFORE from the locked row, AFTER from the
    // engine (mirrors the grammar drill write). elapsed_days_before uses
    // -1 as the never-reviewed sentinel (ck_card_reviews_elapsed_before_min
    // allows >= -1), matching the grammar path.
    await client.query(
      `INSERT INTO card_reviews (
            card_id, user_id, rating,
            state_before, stability_before, difficulty_before, elapsed_days_before,
            state_after, stability_after, difficulty_after, scheduled_days_after,
            duration_ms)
          VALUES ($1,$2,$3::fsrs_rating,
                  $4::fsrs_state,$5,$6,$7,
                  $8::fsrs_state,$9,$10,$11,
                  $12)`,
      [
        cardId,
        userId,
        rating,
        current.state,
        current.stability,
        current.difficulty,
        current.reps === 0 ? -1 : 0,
        next.state,
        next.stability,
        next.difficulty,
        next.scheduledDays,
        input.durationMs ?? null,
      ],
    );
    return { version: upd.rows[0]!.version, dueAt, scheduledDays: next.scheduledDays };
  });
}
