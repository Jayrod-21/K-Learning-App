/**
 * /vocab routes — corpus lookup + FSRS card queue + reviews.
 *
 * The SRS-engine math (FSRS state transitions) lives in the client; the
 * server stores the BEFORE/AFTER snapshots the client computed (per
 * ADR-003). This keeps the server stateless of FSRS-version drift.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

/* ---------- Corpus lookup (vocab_entries from migration 002) ---------- */

const VocabSearchQuerySchema = z.object({
  q: z.string().min(1).max(64).optional(),
  corpus: z
    .enum(['vocab_2000_beginner', 'vocab_2000_intermediate'])
    .optional(),
  proficiency: z.enum(['basic', 'L3', 'L4', 'L5+']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

router.get(
  '/entries',
  cheapLimiter(),
  validateQuery(VocabSearchQuerySchema),
  async (req, res, next) => {
    try {
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof VocabSearchQuerySchema>;
      }).validatedQuery;
      // Build a single parameterized query — no string concatenation of values.
      const { rows } = await query<{
        id: number;
        corpus: string;
        korean: string | null;
        english: string | null;
        proficiency: string | null;
        theme: string | null;
      }>(
        `SELECT id, corpus, korean, english, proficiency, theme
           FROM vocab_entries
          WHERE entry_type = 'word'
            AND ($1::text IS NULL OR korean = $1)
            AND ($2::corpus IS NULL OR corpus = $2::corpus)
            AND ($3::proficiency_level IS NULL OR proficiency = $3::proficiency_level)
          ORDER BY id
          LIMIT $4 OFFSET $5`,
        [
          q.q ?? null,
          q.corpus ?? null,
          q.proficiency ?? null,
          q.limit,
          q.offset,
        ],
      );
      res.status(200).json({ entries: rows, limit: q.limit, offset: q.offset });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- FSRS cards ---------- */

const DueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

router.get(
  '/cards/due',
  cheapLimiter(),
  validateQuery(DueQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof DueQuerySchema>;
      }).validatedQuery;
      const { rows } = await query<{
        id: number;
        face: string;
        due_at: Date;
        stability: string;
        difficulty: string;
        fsrs_state: string;
        vocab_entry_id: number | null;
        grammar_entry_id: number | null;
        source_sentence_id: number | null;
        topik_item_id: number | null;
      }>(
        `SELECT id, face, due_at, stability, difficulty, fsrs_state,
                vocab_entry_id, grammar_entry_id, source_sentence_id, topik_item_id
           FROM vocab_cards
          WHERE user_id = $1
            AND deleted_at IS NULL
            AND suspended_at IS NULL
            AND due_at <= now()
          ORDER BY due_at
          LIMIT $2`,
        [userId, q.limit],
      );
      res.status(200).json({ cards: rows });
    } catch (err) {
      next(err);
    }
  },
);

const ReviewParamsSchema = z.object({
  cardId: z.coerce.number().int().positive(),
});

const ReviewBodySchema = z.object({
  rating: z.enum(['again', 'hard', 'good', 'easy']),
  state_before: z.enum(['new', 'learning', 'review', 'relearning']),
  stability_before: z.number().nonnegative(),
  difficulty_before: z.number().min(1).max(10),
  elapsed_days_before: z.number().int().min(-1),
  state_after: z.enum(['new', 'learning', 'review', 'relearning']),
  stability_after: z.number().nonnegative(),
  difficulty_after: z.number().min(1).max(10),
  scheduled_days_after: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative().optional(),
  expected_version: z.number().int().positive(),
});

router.post(
  '/cards/:cardId/reviews',
  cheapLimiter(),
  validateParams(ReviewParamsSchema),
  validateBody(ReviewBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const cardId = (req as typeof req & {
        validatedParams: z.infer<typeof ReviewParamsSchema>;
      }).validatedParams.cardId;
      const body = req.body as z.infer<typeof ReviewBodySchema>;

      const dueAt = new Date(Date.now() + body.scheduled_days_after * 86_400_000);

      const out = await withTransaction(async (client) => {
        // FU-NF-8 (FOLLOW_UPS.md, 2026-05-29): the prior single-UPDATE
        // implementation conflated "card doesn't exist / not yours / soft-
        // deleted" with "your expected_version is stale" — both fell to a
        // 409. That's wrong: 404 vs 409 mean different things to clients
        // (retry-after-refetch vs. resolve-conflict). Split into a SELECT
        // for ownership/existence then a versioned UPDATE for the conflict
        // check.
        //
        // Both queries run inside the same transaction so we still have
        // optimistic concurrency: a row update between the SELECT and the
        // UPDATE will make the UPDATE's rowCount = 0 and surface a 409.
        // We also take ``FOR UPDATE`` on the SELECT to serialize concurrent
        // reviewers of the same card — the row lock is brief (we UPDATE
        // immediately after) and prevents two reviewers from both passing
        // the existence check.
        const existing = await client.query<{ version: number }>(
          `SELECT version
             FROM vocab_cards
            WHERE id = $1
              AND user_id = $2
              AND deleted_at IS NULL
            FOR UPDATE`,
          [cardId, userId],
        );
        if (existing.rowCount === 0) {
          throw new NotFoundError('vocab card not found');
        }

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
            body.state_after,
            body.stability_after,
            body.difficulty_after,
            body.scheduled_days_after,
            body.rating,
            dueAt,
            body.expected_version,
          ],
        );
        if (upd.rowCount === 0) {
          // Existence was just confirmed above (and we hold a row lock);
          // the only remaining reason for rowCount=0 is a version mismatch.
          throw new ConflictError('vocab card version is stale');
        }
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
            body.rating,
            body.state_before,
            body.stability_before,
            body.difficulty_before,
            body.elapsed_days_before,
            body.state_after,
            body.stability_after,
            body.difficulty_after,
            body.scheduled_days_after,
            body.duration_ms ?? null,
          ],
        );
        return upd.rows[0]!;
      });
      res.status(200).json({ version: out.version, due_at: dueAt });
    } catch (err) {
      next(err);
    }
  },
);

const InitBodySchema = z.object({
  corpus: z.enum(['vocab_2000_beginner', 'vocab_2000_intermediate']),
  proficiency: z.enum(['basic', 'L3', 'L4', 'L5+']).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

/**
 * POST /vocab/cards/init — seed recognition cards from a corpus slice. Idempotent:
 * existing (user_id, vocab_entry_id, face) tuples are skipped.
 */
router.post(
  '/cards/init',
  cheapLimiter(),
  validateBody(InitBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof InitBodySchema>;
      // Idempotency: we exclude vocab entries that already have a recognition
      // card for this user. There's no UNIQUE constraint on
      // (user_id, vocab_entry_id, face) — a future schema change could add
      // one — so we filter at INSERT time via NOT EXISTS instead.
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ inserted: number }>(
          `WITH candidates AS (
              SELECT v.id AS vocab_entry_id, v.proficiency
                FROM vocab_entries v
               WHERE v.entry_type = 'word'
                 AND v.corpus = $2::corpus
                 AND ($3::proficiency_level IS NULL OR v.proficiency = $3)
                 AND NOT EXISTS (
                       SELECT 1 FROM vocab_cards c
                        WHERE c.user_id = $1
                          AND c.vocab_entry_id = v.id
                          AND c.face = 'recognition'
                          AND c.deleted_at IS NULL
                     )
               ORDER BY v.id
               LIMIT $4
           ),
           ins AS (
              INSERT INTO vocab_cards (
                  user_id, face, vocab_entry_id, proficiency, due_at)
              SELECT $1, 'recognition'::card_face, c.vocab_entry_id,
                     COALESCE(c.proficiency, 'L3'::proficiency_level), now()
                FROM candidates c
              RETURNING 1
           )
           SELECT COUNT(*)::int AS inserted FROM ins`,
          [userId, body.corpus, body.proficiency ?? null, body.limit],
        );
        return rows[0]!.inserted;
      });
      res.status(201).json({ inserted: result });
    } catch (err) {
      next(err);
    }
  },
);

const VocabIdParamsSchema = z.object({
  entryId: z.coerce.number().int().positive(),
});

router.get(
  '/entries/:entryId',
  cheapLimiter(),
  validateParams(VocabIdParamsSchema),
  async (req, res, next) => {
    try {
      const id = (req as typeof req & {
        validatedParams: z.infer<typeof VocabIdParamsSchema>;
      }).validatedParams.entryId;
      const { rows } = await query(
        `SELECT id, corpus, source_id, korean, english, pronunciation, hanja,
                part_of_speech, theme, subsection, proficiency,
                example_korean, example_english, tips, cross_refs, notes
           FROM vocab_entries
          WHERE id = $1
          LIMIT 1`,
        [id],
      );
      if (rows.length === 0) throw new NotFoundError('vocab entry not found');
      res.status(200).json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /vocab/entries/:entryId/bank — bank a single vocab entry as a
 * recognition card. Idempotent: re-banking the same entry returns the
 * existing card row.
 *
 * Closes the Pass-3 wiring mismatch where the Reading screen's tap-and-bank
 * gesture fired `cards/init` with a corpus slice instead of the actual
 * entry the learner tapped. The handler:
 *   1. Validates the entry exists (404 on miss).
 *   2. Looks up an existing recognition card for (user, entry) — returns
 *      it as-is if present (idempotency).
 *   3. Otherwise INSERTs a new card with the entry's proficiency (defaults
 *      to L3) and `due_at = now()` so it shows up immediately.
 *
 * Returns `{ card: { id, version } }`. The version is what the client must
 * thread into `submitReview.expected_version` on the first rating.
 */
router.post(
  '/entries/:entryId/bank',
  cheapLimiter(),
  validateParams(VocabIdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const entryId = (req as typeof req & {
        validatedParams: z.infer<typeof VocabIdParamsSchema>;
      }).validatedParams.entryId;
      const out = await withTransaction(async (client) => {
        // Existence check — a missing entry is a 404, not a silent no-op.
        const entry = await client.query<{ proficiency: string | null }>(
          `SELECT proficiency
             FROM vocab_entries
            WHERE id = $1
            LIMIT 1`,
          [entryId],
        );
        if (entry.rowCount === 0) {
          throw new NotFoundError('vocab entry not found');
        }
        // Idempotency — re-banking returns the existing card.
        const existing = await client.query<{ id: number; version: number }>(
          `SELECT id, version
             FROM vocab_cards
            WHERE user_id = $1
              AND vocab_entry_id = $2
              AND face = 'recognition'
              AND deleted_at IS NULL
            LIMIT 1`,
          [userId, entryId],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          return existing.rows[0]!;
        }
        const prof = entry.rows[0]!.proficiency ?? 'L3';
        const ins = await client.query<{ id: number; version: number }>(
          `INSERT INTO vocab_cards (
              user_id, face, vocab_entry_id, proficiency, due_at)
            VALUES ($1, 'recognition'::card_face, $2,
                    $3::proficiency_level, now())
            RETURNING id, version`,
          [userId, entryId, prof],
        );
        return ins.rows[0]!;
      });
      res.status(201).json({ card: out });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
