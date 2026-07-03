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
import { escapeLikePattern } from '../db/like.js';

const router = Router();
router.use(requireAuth);

/**
 * The week-rollover boundary expression for the weekly-suggestion hash. Pinned
 * to the app's target locale ('Asia/Seoul') and ISO-week numbering so the same
 * 15 picks are returned all week and rotate at local Monday-00:00 regardless of
 * the DB session timezone. `IYYY-IW` is ISO-year + ISO-week (e.g. `2026-23`);
 * we use it — not `current_date` — for the same reason plan.ts uses
 * `(now() AT TIME ZONE 'Asia/Seoul')::date`: a bare date evaluates in the
 * session TimeZone GUC (UTC on a stock container) and would roll the week over
 * at 09:00 KST for a Korea-resident learner. The zone + format are server-side
 * SQL literals, never client input — no injection surface.
 */
const ISO_WEEK_SQL = `to_char((now() AT TIME ZONE 'Asia/Seoul'), 'IYYY-IW')`;

/** How many vocab picks the weekly-suggestion endpoint returns. */
const WEEKLY_SUGGESTION_LIMIT = 15;

/** Non-empty, trimmed text — mirrors the convention in services/claude/models.ts. */
const NonEmptyText = z.string().trim().min(1);

/* ---------- Corpus lookup (vocab_entries from migration 002) ---------- */

const VocabSearchQuerySchema = z.object({
  // Free-text search. ILIKE substring over korean + english so the Resources
  // "Vocabulary" tab search box finds a word by either its Hangul headword or
  // its English gloss. Metacharacters are escaped (see escapeLikePattern) so a
  // term like "100%" matches literally and an all-wildcard term can't scan the
  // whole table.
  q: z.string().trim().min(1).max(64).optional(),
  corpus: z
    .enum(['vocab_2000_beginner', 'vocab_2000_intermediate'])
    .optional(),
  proficiency: z.enum(['basic', 'L3', 'L4', 'L5+']).optional(),
  // Browse needs a higher ceiling than the original tap-lookup default — the
  // Resources tab pages the full 3,131-row curated corpus. 200 mirrors
  // /vocab/cards/due; the client paginates with offset + the `total` count.
  limit: z.coerce.number().int().min(1).max(200).default(20),
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
      // The ILIKE operand is the escaped term wrapped in %…% for substring
      // match; null when no search term is given (the filter short-circuits).
      // Escaping happens in JS, the value is still bound as a parameter — no
      // string interpolation of user input into SQL.
      const likePattern =
        q.q !== undefined ? `%${escapeLikePattern(q.q)}%` : null;
      // Build a single parameterized query — no string concatenation of values.
      // window COUNT(*) OVER () returns the total matching rows alongside the
      // page so the client can paginate without a second round-trip.
      const { rows } = await query<{
        id: number;
        corpus: string;
        korean: string | null;
        english: string | null;
        proficiency: string | null;
        theme: string | null;
        total: string;
      }>(
        `SELECT id, corpus, korean, english, proficiency, theme,
                COUNT(*) OVER ()::text AS total
           FROM vocab_entries
          WHERE entry_type = 'word'
            AND ($1::text IS NULL
                 OR korean  ILIKE $1 ESCAPE '\\'
                 OR english ILIKE $1 ESCAPE '\\')
            AND ($2::corpus IS NULL OR corpus = $2::corpus)
            AND ($3::proficiency_level IS NULL OR proficiency = $3::proficiency_level)
          ORDER BY id
          LIMIT $4 OFFSET $5`,
        [
          likePattern,
          q.corpus ?? null,
          q.proficiency ?? null,
          q.limit,
          q.offset,
        ],
      );
      // COUNT(*) OVER () is identical on every row; an empty page (offset past
      // the end, or no matches) yields no rows, so total is 0 there.
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      // Strip the per-row window total from the entry DTOs — it's surfaced once
      // at the top level, not repeated on every entry.
      const entries = rows.map(({ total: _total, ...rest }) => rest);
      res.status(200).json({ entries, total, limit: q.limit, offset: q.offset });
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
      // FU-NF-42: LEFT JOIN grammar_entries so a grammar PRODUCTION card carries
      // its pattern display + summary inline (the client renders these to label
      // the card and route into the drill). The join is LEFT so non-grammar cards
      // (vocab / sentence / topik) are unaffected — their grammar_* columns come
      // back NULL. We alias g.* to grammar_pattern_display / grammar_summary_en to
      // avoid colliding with any vocab field name and to make the wire contract
      // explicit. Joining on the user-scoped grammar_entry_id (and ge.user_id) keeps
      // the read user-isolated even if a card's FK were ever cross-user (it cannot
      // be — FK + per-user writes — but defense-in-depth). Vocab semantics are
      // unchanged: same WHERE/ORDER/LIMIT, same existing columns.
      //
      // GRADUATION (migration 033): a grammar production card whose entry the
      // user marked as known (grammar_entries.graduated_at IS NOT NULL) is NOT
      // due — that's the whole point of graduating a pattern. The predicate is
      // in the WHERE (not the JOIN condition): moving it into the LEFT JOIN's
      // ON would merely null the joined columns and still return the card.
      // Guarded on `c.grammar_entry_id IS NULL OR …` so non-grammar cards
      // (vocab / sentence / topik — where ge.* is NULL) are untouched, and a
      // soft-deleted entry's card keeps its existing pass-through behavior.
      // Re-admission nulls graduated_at and the card resurfaces with its FSRS
      // state intact (nothing on vocab_cards is modified either way).
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
        grammar_pattern_display: string | null;
        grammar_summary_en: string | null;
        grammar_pattern_key: string | null;
      }>(
        // grammar_pattern_key is what a Review→Drill deep-link must hand back so
        // the drill resolves the SAME grammar_entries row (the server keys on
        // (user, pattern_key), not the numeric id). Without it the re-drill mints
        // a parallel entry and the due card never clears. See FU-NF-42 B3.
        `SELECT c.id, c.face, c.due_at, c.stability, c.difficulty, c.fsrs_state,
                c.vocab_entry_id, c.grammar_entry_id, c.source_sentence_id, c.topik_item_id,
                ge.pattern_display AS grammar_pattern_display,
                ge.summary_en      AS grammar_summary_en,
                ge.pattern_key     AS grammar_pattern_key
           FROM vocab_cards c
           LEFT JOIN grammar_entries ge
                  ON ge.id = c.grammar_entry_id
                 AND ge.user_id = c.user_id
                 AND ge.deleted_at IS NULL
          WHERE c.user_id = $1
            AND c.deleted_at IS NULL
            AND c.suspended_at IS NULL
            AND c.due_at <= now()
            AND (c.grammar_entry_id IS NULL OR ge.graduated_at IS NULL)
          ORDER BY c.due_at
          LIMIT $2`,
        [userId, q.limit],
      );
      // pg returns BIGINT columns as strings; the card DTO documents the id +
      // FK id fields as JSON numbers (nullable FKs stay null). NUMERIC columns
      // stability/difficulty are intentionally left as strings (precision-safe).
      const cards = rows.map((c) => ({
        ...c,
        id: Number(c.id),
        vocab_entry_id: c.vocab_entry_id === null ? null : Number(c.vocab_entry_id),
        grammar_entry_id: c.grammar_entry_id === null ? null : Number(c.grammar_entry_id),
        source_sentence_id:
          c.source_sentence_id === null ? null : Number(c.source_sentence_id),
        topik_item_id: c.topik_item_id === null ? null : Number(c.topik_item_id),
      }));
      res.status(200).json({ cards });
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
      // pg returns BIGINT (id) as a string; the API contract documents id as a
      // JSON number. vocab_entries.id fits comfortably in Number.MAX_SAFE_INTEGER.
      res.status(200).json({ ...rows[0], id: Number((rows[0] as { id: unknown }).id) });
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
      // pg returns BIGINT (card.id) as a string; the API contract documents id
      // as a JSON number. vocab_cards.id fits in Number.MAX_SAFE_INTEGER.
      res.status(201).json({ card: { ...out, id: Number(out.id) } });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- FU-NF-33: tap anything → bank it (KRDICT → review card) ---------- */

const MineBodySchema = z
  .object({
    // The KRDICT headword / tapped surface form. Bounded so a hostile client
    // can't store an unbounded blob in the shared dictionary table.
    lemma: NonEmptyText.max(100),
    // Gloss from /define or /enrich. Optional — a bare lemma is still bankable.
    english: z.string().trim().max(500).optional(),
    // Part of speech (accepted for forward compatibility; not stored today —
    // vocab_entries.part_of_speech is loader-curated and the mined path keeps
    // the shared row minimal). Bounded to reject oversized input.
    pos: z.string().trim().max(50).optional(),
    // The /define entries[0].id — gives a stable dedup key so homographs stay
    // distinct (krdict-<id>) rather than colliding on the surface form.
    krdictEntryId: z.number().int().positive().optional(),
  })
  .strict();

/**
 * POST /vocab/mine — "tap anything → bank it" (FU-NF-33).
 *
 * Resolves a tapped/OCR'd word (already looked up through KRDICT on the
 * client) into a SHARED `user_mined` vocab_entries row, then banks it as a
 * normal recognition card for the requesting user. This reuses the entire
 * existing card / FSRS / Review stack — no new card target.
 *
 * One transaction:
 *   1. Resolve the shared `user_mined` corpus_sources id (seeded by migration
 *      022). Absent → 500 loudly: the migration is a hard dependency.
 *   2. Upsert the vocab_entries row (SHARED, NOT user-scoped — it is just the
 *      public dictionary lemma + gloss, carrying no user data). Dedup key is
 *      `krdict-<id>` when a KRDICT id is supplied, else `lemma-<lemma>`. On
 *      conflict we coalesce a newly-supplied gloss and bump the version.
 *   3. Bank a recognition card for THIS user, idempotent on
 *      (user_id, vocab_entry_id, face='recognition', deleted_at IS NULL) —
 *      identical to POST /vocab/entries/:entryId/bank, so a double-tap returns
 *      the same card instead of minting a duplicate.
 *
 * Returns `201 { entryId, card: { id, version } }`. `card.version` is what the
 * client threads into the first review's `expected_version`.
 *
 * Threat model (see db/migrations/SECURITY.md addendum, migrations 021/022):
 *   - The vocab_entries upsert is SHARED and holds no user data — two users
 *     mining 사과 reuse one public entry; their cards stay private (user_id-
 *     scoped). So there is no cross-user data leak in the shared row.
 *   - `lemma` / `english` / `pos` are length-bounded, trimmed text stored as
 *     data via parameterized queries (no injection — values are never
 *     interpolated into SQL, and they are rendered as text, not executed).
 *   - Idempotent on both the entry (ON CONFLICT) and the card (existence
 *     check), so a retried or double-tapped request is safe.
 *   - requireAuth + cheapLimiter bound abuse (no unbounded write loop).
 */
router.post(
  '/mine',
  cheapLimiter(),
  validateBody(MineBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof MineBodySchema>;
      // Stable dedup key: prefer the KRDICT id (homographs stay distinct),
      // else fall back to the surface lemma. Built here so the SQL stays a
      // pure parameterized statement.
      const sourceId =
        body.krdictEntryId !== undefined
          ? `krdict-${body.krdictEntryId}`
          : `lemma-${body.lemma}`;

      const out = await withTransaction(async (client) => {
        // 1. Resolve the shared user_mined corpus source (seeded by mig 022).
        const src = await client.query<{ id: number }>(
          `SELECT id
             FROM corpus_sources
            WHERE corpus = 'user_mined'::corpus
            LIMIT 1`,
        );
        if (src.rowCount === 0) {
          // Migration 022 is a hard dependency — fail loudly rather than
          // silently mint an entry with a dangling provenance.
          throw new Error(
            'user_mined corpus_sources row missing — run migration 022',
          );
        }
        const corpusSourceId = src.rows[0]!.id;

        // 2. Upsert the SHARED vocab_entries row. korean=lemma satisfies the
        //    korean-required CHECK; proficiency 'L3' satisfies proficiency-
        //    required; book_level 'beginner' is the inert sentinel the relaxed
        //    ck_vocab_entries_level_matches_corpus allows for user_mined.
        const entry = await client.query<{ id: number }>(
          `INSERT INTO vocab_entries (
              corpus_source_id, corpus, source_id, book_level, entry_type,
              source_book, korean, english, proficiency, domain)
            VALUES ($1, 'user_mined'::corpus, $2, 'beginner'::book_level,
                    'word'::vocab_entry_type, 'user-mined', $3, $4,
                    'L3'::proficiency_level, 'general'::content_domain)
            ON CONFLICT (corpus, source_id) DO UPDATE
               SET english = COALESCE(EXCLUDED.english, vocab_entries.english),
                   version = vocab_entries.version + 1
            RETURNING id`,
          [corpusSourceId, sourceId, body.lemma, body.english ?? null],
        );
        const entryId = entry.rows[0]!.id;

        // 3. Bank a recognition card, idempotent — mirrors
        //    POST /vocab/entries/:entryId/bank exactly.
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
          return { entryId, card: existing.rows[0]! };
        }
        const ins = await client.query<{ id: number; version: number }>(
          `INSERT INTO vocab_cards (
              user_id, face, vocab_entry_id, proficiency, due_at)
            VALUES ($1, 'recognition'::card_face, $2,
                    'L3'::proficiency_level, now())
            RETURNING id, version`,
          [userId, entryId],
        );
        return { entryId, card: ins.rows[0]! };
      });
      // pg returns BIGINT (entryId, card.id) as strings; the API contract
      // documents both as JSON numbers. Both fit in Number.MAX_SAFE_INTEGER.
      res.status(201).json({
        entryId: Number(out.entryId),
        card: { ...out.card, id: Number(out.card.id) },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- Weekly suggestions (suggest-only — no auto-add) ---------- */

/**
 * GET /vocab/suggestions/weekly — 15 curated vocab the user hasn't carded yet,
 * stable for the whole ISO week and rotating the next.
 *
 * Suggest-only: this endpoint NEVER writes a card. The client renders each pick
 * with an [Add] button that POSTs /vocab/entries/:entryId/bank (the existing
 * add-to-deck path) — there is no parallel card-create here.
 *
 * Selection model — "stable per (user, ISO week), excludes what's already
 * studied" (mirrors plan.ts / hanja.ts deterministic-hash selection):
 *   - Source: curated `vocab_2000_*` corpora only (entry_type = 'word'). The
 *     mined / KRDICT corpora are user-driven, not a curated suggestion pool.
 *   - Exclusion: any vocab_entry the user already has a live recognition card
 *     for (NOT EXISTS on vocab_cards) is dropped — we never re-suggest a word
 *     the learner has already banked.
 *   - Ordering: md5(iso_week || user_id || entry.id). The same set of 15 comes
 *     back all week (idempotent refetch — no reshuffle under the user) and a
 *     fresh set surfaces when the ISO week rolls over (Asia/Seoul Monday).
 *   - LIMIT 15. Fewer rows only when the user has carded almost the whole
 *     corpus — then the week's pool is genuinely smaller.
 *
 * Read-only, auth-required, cheap limiter. No body, no params: the only SQL
 * input is the session user id (never client-supplied) and server-side date.
 */
router.get('/suggestions/weekly', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{
      id: number;
      corpus: string;
      korean: string | null;
      english: string | null;
      proficiency: string | null;
      theme: string | null;
    }>(
      `SELECT v.id, v.corpus, v.korean, v.english, v.proficiency, v.theme
         FROM vocab_entries v
        WHERE v.entry_type = 'word'
          AND v.corpus IN ('vocab_2000_beginner'::corpus,
                           'vocab_2000_intermediate'::corpus)
          AND NOT EXISTS (
                SELECT 1
                  FROM vocab_cards c
                 WHERE c.user_id = $1
                   AND c.vocab_entry_id = v.id
                   AND c.face = 'recognition'
                   AND c.deleted_at IS NULL
              )
        ORDER BY md5(${ISO_WEEK_SQL} || $1::text || v.id::text)
        LIMIT $2`,
      [userId, WEEKLY_SUGGESTION_LIMIT],
    );
    // pg returns BIGINT (id) as a string; the DTO documents id as a JSON number
    // (vocab_entries.id fits comfortably in Number.MAX_SAFE_INTEGER). The wire
    // key is `entries` (matches the client's VocabSuggestionsResponse — the rows
    // are plain VocabEntry shapes, bankable via the existing per-entry path).
    const entries = rows.map((r) => ({ ...r, id: Number(r.id) }));
    res.status(200).json({ entries });
  } catch (err) {
    next(err);
  }
});

export default router;
