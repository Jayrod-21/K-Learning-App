/**
 * /vocab routes — corpus lookup + FSRS card queue + reviews.
 *
 * The SRS-engine math (FSRS state transitions) is SERVER-authoritative
 * (ADR-003 amendment, 2026-07-02): the client submits only its self-rating
 * (Again/Hard/Good/Easy); the server reads the card's CURRENT state from
 * vocab_cards, derives the next state via the shared engine
 * (services/fsrs.ts — the same math grammar production drills use), and
 * writes both the card advance and the append-only card_reviews snapshot.
 * A stubbed or tampered client can no longer dictate `due_at`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { escapeLikePattern } from '../db/like.js';
import { applyCardReview } from '../services/cardReview.js';

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

// Ids/offsets bind to BIGINT/int8 in pg. Without an upper bound a 20-digit
// value passes `int().positive()` (Number.isInteger(1e20) is true) and
// overflows in pg (22003 → 500) where the contract is 400/404 for a garbage
// id (routes sweep #3). MAX_SAFE_INTEGER ≪ int8 max, so bounded values are safe.
const MAX_ID = Number.MAX_SAFE_INTEGER;
/** Upper bound for values that bind to INTEGER (int4) columns. */
const INT4_MAX = 2_147_483_647;

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
  // F-003: Reference Vocabulary-tab filters. `domain` is the content-tagging
  // genre (content_domain enum, migration 002) and `book_level` the difficulty
  // band. Both are closed enums mirroring the DB types, so an out-of-vocabulary
  // value 400s at the boundary instead of reaching the cast in SQL.
  domain: z.enum(['general', 'research', 'business']).optional(),
  book_level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  // F-176: per-book chapter/topic facet (`vocab_entries.theme`, migration 002)
  // — a free-text label lifted verbatim from the source PDF extraction (e.g.
  // "01 인간 / People"), NOT a closed enum like `domain`/`book_level`. Bounded
  // to the column's own practical length so an absurd value can't ride an
  // unindexed equality scan; exact match (never ILIKE) since real theme
  // strings are stable corpus labels, not free text a user would misspell.
  // See GET /vocab/themes below for the ~31 real values this binds against.
  theme: z.string().trim().min(1).max(200).optional(),
  // U3a (source filtering): the `book_uploads.id` an uploaded-book source filter
  // is scoping to. Wired from the client's SourceFilterRow since U1 but inert
  // server-side until now — the WHERE clause below finally honours it. Coerced
  // from the query string to an int and bounded by MAX_ID (it binds to a BIGINT
  // FK), so a garbage id 400s at the boundary rather than overflowing in pg.
  // Ownership is enforced in SQL (see the EXISTS guard), so a user can only
  // filter by an upload they own — the shared vocab_entries rows a book tags
  // are never exposed via another user's id.
  source_upload_id: z.coerce.number().int().positive().max(MAX_ID).optional(),
  // Browse needs a higher ceiling than the original tap-lookup default — the
  // Resources tab pages the full 3,131-row curated corpus. 200 mirrors
  // /vocab/cards/due; the client paginates with offset + the `total` count.
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
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
      // Session user — needed only to scope the optional source-book filter to
      // uploads this user owns (the EXISTS guard below). The corpus itself is
      // shared reference data, so the rest of the query is user-agnostic.
      const userId = getUserId(req);
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
            AND ($4::content_domain IS NULL OR domain = $4::content_domain)
            AND ($5::book_level IS NULL OR book_level = $5::book_level)
            -- F-176: theme is a free-text per-book facet, not a Postgres enum.
            -- Exact match against the ix_vocab_entries_theme_subsection
            -- index's leading column (a composite (theme, subsection) B-tree
            -- fully serves an equality filter on theme alone).
            AND ($6::text IS NULL OR theme = $6)
            -- U3a source filter. When a source id is given, the row must be
            -- tagged with it AND the upload must belong to the requesting user.
            -- The EXISTS guard means a user filtering by an upload they don't
            -- own gets zero rows (never another user's tagged entries), and a
            -- hard-deleted upload's id likewise matches nothing (book_uploads
            -- has no soft-delete column — migration 040 is hard-delete only).
            AND ($7::bigint IS NULL
                 OR (source_upload_id = $7::bigint
                     AND EXISTS (SELECT 1 FROM book_uploads bu
                                  WHERE bu.id = $7::bigint
                                    AND bu.user_id = $8)))
          ORDER BY id
          LIMIT $9 OFFSET $10`,
        [
          likePattern,
          q.corpus ?? null,
          q.proficiency ?? null,
          q.domain ?? null,
          q.book_level ?? null,
          q.theme ?? null,
          q.source_upload_id ?? null,
          userId,
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

/**
 * GET /vocab/themes — the distinct, non-null `theme` values across the
 * curated corpus (F-176), for building a theme/genre filter UI.
 *
 * Unlike `domain`/`book_level` (closed Postgres enums), `theme` is free text
 * lifted verbatim from each source book's own chapter numbering — there is
 * no static whitelist in code or corpus JSON, so the client can't hardcode
 * this list. Read-only, auth-required (mirrors every other corpus-lookup
 * route in this file), cheap limiter. No user input — the query has no
 * parameters, so there is no injection surface.
 *
 * Ordered alphabetically (`"C"` collation for stable byte ordering across
 * Korean/mixed-script labels — same convention `GET /krdict/search`'s browse
 * path uses) so a dropdown built from this renders deterministically.
 */
router.get('/themes', cheapLimiter(), async (_req, res, next) => {
  try {
    // NOTE: `SELECT DISTINCT theme ... ORDER BY theme COLLATE "C"` would fail
    // with Postgres error 42803 ("for SELECT DISTINCT, ORDER BY expressions
    // must appear in select list") — DISTINCT requires the ORDER BY
    // expression to textually match a select-list item, and a bare `theme`
    // is a different expression from `theme COLLATE "C"`. Collating the
    // select-list column itself (aliased back to `theme`) makes the two
    // expressions match.
    const { rows } = await query<{ theme: string }>(
      `SELECT DISTINCT theme COLLATE "C" AS theme
         FROM vocab_entries
        WHERE theme IS NOT NULL
        ORDER BY theme COLLATE "C"`,
    );
    res.status(200).json({ themes: rows.map((r) => r.theme) });
  } catch (err) {
    next(err);
  }
});

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
      //
      // B-009: LEFT JOIN vocab_entries so a vocab card carries its real
      // korean / english / example / source fields inline. Without this the
      // client only ever saw `face` — which is the card_face ENUM
      // ('recognition' | 'production' | 'cloze'), NOT the word — so the Review
      // flashcard rendered the enum label on both sides with empty
      // gloss/examples/source. Aliased with a vocab_ prefix (same convention
      // as the grammar_* columns) so the wire contract is explicit and
      // collision-free. vocab_entries is SHARED reference data (no user_id,
      // no deleted_at — see 001_core_schema), so the join is on the FK alone;
      // per-user isolation stays enforced by `c.user_id = $1` on the card row.
      // Non-vocab cards (grammar / sentence / topik) get NULL vocab_* columns.
      //
      // F-075: hanja-target cards (migration 050's fifth XOR leg) are EXCLUDED
      // (`c.hanja_character_id IS NULL`) — they have their own due queue,
      // GET /hanja/cards/due, which joins hanja_characters for the fields the
      // hanja review UI renders. Serving them here too would double-present
      // every due hanja card and render it blank (all vocab_*/grammar_* NULL).
      //
      // COUNT reconciliation (TODAY_NAV_SCOPING Part A / the "665 due" vs
      // "0 cards due" bug): this route previously had NO total — only the
      // LIMIT-capped page's `.length`, which structurally can never exceed
      // `limit` (default 20) no matter how large the real backlog is, and
      // client code partitions that already-tiny page further into vocab vs.
      // grammar-production rows — so a landing screen reading `.length`
      // could show a wildly wrong (even zero) count against a real backlog
      // in the hundreds. `COUNT(*) OVER ()` rides the SAME WHERE this page
      // query uses (same `graduated_at` exclusion, same hanja exclusion) —
      // one exact, unbounded total for "how many vocab cards are actually
      // due," computed by the identical predicate the visible page obeys, so
      // the two numbers can never independently drift again.
      const { rows } = await query<{
        id: number;
        face: string;
        due_at: Date;
        stability: string;
        difficulty: string;
        fsrs_state: string;
        version: number;
        vocab_entry_id: number | null;
        grammar_entry_id: number | null;
        source_sentence_id: number | null;
        topik_item_id: number | null;
        vocab_korean: string | null;
        vocab_english: string | null;
        vocab_example_korean: string | null;
        vocab_example_english: string | null;
        vocab_source_book: string | null;
        grammar_pattern_display: string | null;
        grammar_summary_en: string | null;
        grammar_pattern_key: string | null;
        total: string;
      }>(
        // grammar_pattern_key is what a Review→Drill deep-link must hand back so
        // the drill resolves the SAME grammar_entries row (the server keys on
        // (user, pattern_key), not the numeric id). Without it the re-drill mints
        // a parallel entry and the due card never clears. See FU-NF-42 B3.
        // c.version is REQUIRED on the wire: the client echoes it back as
        // submitReview's `expected_version` (optimistic concurrency). Without
        // it every rating would post `expected_version: undefined` and 400.
        `SELECT c.id, c.face, c.due_at, c.stability, c.difficulty, c.fsrs_state, c.version,
                c.vocab_entry_id, c.grammar_entry_id, c.source_sentence_id, c.topik_item_id,
                ve.korean          AS vocab_korean,
                ve.english         AS vocab_english,
                ve.example_korean  AS vocab_example_korean,
                ve.example_english AS vocab_example_english,
                ve.source_book     AS vocab_source_book,
                ge.pattern_display AS grammar_pattern_display,
                ge.summary_en      AS grammar_summary_en,
                ge.pattern_key     AS grammar_pattern_key,
                COUNT(*) OVER ()::text AS total
           FROM vocab_cards c
           LEFT JOIN vocab_entries ve
                  ON ve.id = c.vocab_entry_id
           LEFT JOIN grammar_entries ge
                  ON ge.id = c.grammar_entry_id
                 AND ge.user_id = c.user_id
                 AND ge.deleted_at IS NULL
          WHERE c.user_id = $1
            AND c.deleted_at IS NULL
            AND c.suspended_at IS NULL
            AND c.due_at <= now()
            AND (c.grammar_entry_id IS NULL OR ge.graduated_at IS NULL)
            AND c.hanja_character_id IS NULL
          ORDER BY c.due_at
          LIMIT $2`,
        [userId, q.limit],
      );
      // pg returns BIGINT columns as strings; the card DTO documents the id +
      // FK id fields as JSON numbers (nullable FKs stay null). NUMERIC columns
      // stability/difficulty are intentionally left as strings (precision-safe).
      // COUNT(*) OVER () is identical on every row; an empty page (nothing
      // due) yields no rows, so total is legitimately 0 there — mirrors the
      // idiom `GET /vocab/entries` already uses just above.
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      const cards = rows.map(({ total: _total, ...c }) => ({
        ...c,
        id: Number(c.id),
        vocab_entry_id: c.vocab_entry_id === null ? null : Number(c.vocab_entry_id),
        grammar_entry_id: c.grammar_entry_id === null ? null : Number(c.grammar_entry_id),
        source_sentence_id:
          c.source_sentence_id === null ? null : Number(c.source_sentence_id),
        topik_item_id: c.topik_item_id === null ? null : Number(c.topik_item_id),
      }));
      res.status(200).json({ cards, total });
    } catch (err) {
      next(err);
    }
  },
);

const ReviewParamsSchema = z.object({
  cardId: z.coerce.number().int().positive().max(MAX_ID),
});

/**
 * Server-authoritative review body (ADR-003 amendment, 2026-07-02): the client
 * sends ONLY its self-rating + the optimistic-concurrency version snapshot.
 * Every `*_before` / `*_after` FSRS value is computed server-side from the
 * card's DB row — client-supplied state/interval fields are deliberately NOT
 * accepted (defends against schedule tampering: a client sending
 * `scheduled_days_after: 0` — or 3650 — must not control `due_at`). The
 * default zod object strips unknown keys, so a stale pre-cutover client still
 * sending the old snapshot fields degrades gracefully instead of 400ing.
 */
// DELIBERATELY NOT .strict(): the default zod object STRIPS unknown keys rather
// than 400ing on them — this is the tamper defense (see docstring above). A
// stale pre-cutover client still sending the old client-computed snapshot
// fields (`scheduled_days_after`, `*_after`, …) degrades gracefully instead of
// erroring, and those fields are dropped before they can influence scheduling.
// Do NOT "harden" this into .strict() — it would 400 every legacy client and
// defeat the strip. (Contrast MineBodySchema below, which IS .strict().)
const ReviewBodySchema = z.object({
  rating: z.enum(['again', 'hard', 'good', 'easy']),
  // duration_ms / version are INTEGER columns — bound to INT4 so an absurd
  // value 400s instead of overflowing in pg (routes sweep #3).
  duration_ms: z.number().int().nonnegative().max(INT4_MAX).optional(),
  expected_version: z.number().int().positive().max(INT4_MAX),
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

      // The whole lock → FSRS transition → versioned advance → card_reviews
      // append lives in services/cardReview.ts (extracted verbatim, F-075) so
      // this route and /hanja/cards/:cardId/reviews share ONE write path.
      // Semantics are unchanged: 404 not-found / 409 stale-version (FU-NF-8),
      // server-authoritative scheduling (ADR-003 amendment, 2026-07-02).
      const out = await applyCardReview({
        cardId,
        userId,
        rating: body.rating,
        durationMs: body.duration_ms,
        expectedVersion: body.expected_version,
        cardNoun: 'vocab card',
      });
      // `scheduled_days` lets the client render "next review in N days"
      // (0 ⇒ a minute-scale step: <1-min again re-queue / ~6-min hard learning
      // step) without re-deriving anything.
      res.status(200).json({
        version: out.version,
        due_at: out.dueAt,
        scheduled_days: out.scheduledDays,
      });
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
  entryId: z.coerce.number().int().positive().max(MAX_ID),
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
    krdictEntryId: z.number().int().positive().max(MAX_ID).optional(),
    // F-107 (user-saved upload provenance): the `book_uploads.id` the user
    // was working from when they saved this word. Optional — a tap outside
    // an upload context sends nothing. int/positive/MAX_ID-bounded like the
    // U3a query filter above (binds to a BIGINT FK; no coerce — this is a
    // JSON body, not a query string). OWNERSHIP is validated in the handler
    // (the upload must belong to the caller, else 404) BEFORE anything
    // persists — an attacker passing someone else's upload id must not tag
    // their save to it. Named snake_case to match the wire name this concept
    // already has everywhere else (query params, DB column).
    source_upload_id: z.number().int().positive().max(MAX_ID).optional(),
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
 *   0. F-107: when `source_upload_id` is supplied, verify the upload belongs
 *      to the CALLER (404 otherwise — identical for nonexistent and unowned
 *      ids, no existence oracle) before anything persists.
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
        // 0. F-107 upload provenance — validate the referenced upload BELONGS
        //    TO the caller before anything persists. One combined
        //    id+ownership predicate: a nonexistent id and another user's id
        //    both 404 identically, so the response is not an existence oracle
        //    for other users' upload ids (mirrors the grammar-bank graduate
        //    route's posture). Runs inside the transaction so the ownership
        //    fact and the tagged insert commit or roll back together.
        if (body.source_upload_id !== undefined) {
          const owned = await client.query(
            `SELECT 1
               FROM book_uploads
              WHERE id = $1
                AND user_id = $2
              LIMIT 1`,
            [body.source_upload_id, userId],
          );
          if (owned.rowCount === 0) {
            throw new NotFoundError('upload not found');
          }
        }

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
              source_book, korean, english, proficiency, domain,
              source_upload_id)
            VALUES ($1, 'user_mined'::corpus, $2, 'beginner'::book_level,
                    'word'::vocab_entry_type, 'user-mined', $3, $4,
                    'L3'::proficiency_level, 'general'::content_domain, $5)
            ON CONFLICT (corpus, source_id) DO UPDATE
               -- Existing gloss WINS: vocab_entries rows are SHARED across
               -- users (keyed by corpus/source_id, not user), so letting a
               -- re-mine overwrite a non-null english would let any user
               -- clobber the gloss everyone else's cards display (routes
               -- sweep #6). A re-mine only FILLS a missing gloss.
               --
               -- F-107: source_upload_id follows the SAME first-write-wins
               -- rule, for the same shared-row reason — a later re-mine
               -- (by anyone) only FILLS missing provenance, never re-tags
               -- an entry to a different upload. The ownership check in
               -- step 0 already guaranteed EXCLUDED.source_upload_id is an
               -- upload the CALLER owns, so a NULL->value fill can only tag
               -- the entry with the tagging user's own upload.
               --
               -- ACCEPTED TRADEOFF (single-user scope, tracked as F-199): a
               -- SECOND user genuinely mining this lemma from THEIR OWN
               -- upload gets a 201 while their tag is silently discarded —
               -- the word will never appear in that user's
               -- GET /vocab/saved-from-uploads. True per-user provenance
               -- needs the tag on the user-scoped save artifact
               -- (vocab_cards) instead of this shared row; deliberately NOT
               -- built while the deployment is single-user.
               SET english = COALESCE(vocab_entries.english, EXCLUDED.english),
                   source_upload_id = COALESCE(vocab_entries.source_upload_id,
                                               EXCLUDED.source_upload_id),
                   version = vocab_entries.version + 1
            RETURNING id`,
          [
            corpusSourceId,
            sourceId,
            body.lemma,
            body.english ?? null,
            body.source_upload_id ?? null,
          ],
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
      // F-107 race guard: the step-0 ownership check and the tagged upsert
      // run in one transaction, but READ COMMITTED does not stop a concurrent
      // hard-delete of the upload between the two statements — the FK from
      // migration 040 then rejects the insert (23503). That is still "this
      // upload does not exist for you", so it maps to the same 404 the
      // ownership check gives, not a 500. Scoped to THIS FK's constraint
      // name so unrelated integrity errors keep surfacing loudly.
      const pgErr = err as { code?: string; constraint?: string };
      if (
        pgErr.code === '23503' &&
        pgErr.constraint === 'vocab_entries_source_upload_id_fkey'
      ) {
        next(new NotFoundError('upload not found'));
        return;
      }
      next(err);
    }
  },
);

/**
 * GET /vocab/saved-from-uploads — the user's saved vocab that carries upload
 * provenance, grouped by source upload (F-107; feeds the F-053 "My Uploads"
 * section on the Review→Vocabulary page).
 *
 * "Saved" means the user deliberately kept the word, via EITHER save path:
 *   - a live recognition/production card (`vocab_cards`, e.g. POST
 *     /vocab/mine or the bank routes), or
 *   - membership in one of the user's live lists (`vocab_list_entries`).
 *
 * A word counts once no matter how many ways it was saved; `savedAt` is the
 * EARLIEST save. Only entries whose `vocab_entries.source_upload_id` points
 * at an upload THE CALLER OWNS appear — provenance tagged to another user's
 * upload is invisible here (the `bu.user_id = $1` join predicate), so upload
 * titles can never leak across users. Distinct from the U3a
 * `GET /vocab/entries?source_upload_id=` browse (everything a book tagged):
 * this is only what the user chose to keep.
 *
 * User-scoped on every leg (cards by `c.user_id`, lists by `vl.user_id`,
 * uploads by `bu.user_id` — all bound to the session user, never a client
 * id); fully parameterized; read-only. Groups are ordered newest upload
 * first, entries newest-saved first.
 *
 * Response: `{ groups, total, truncated }` — `total` is the user's FULL
 * saved-with-provenance word count (window COUNT, unaffected by the cap);
 * `truncated: true` says the row cap trimmed the response. Every returned
 * group is guaranteed WHOLE: rather than let the flat-row LIMIT cut the
 * last group mid-group (which would render as a complete-looking but
 * silently short list), a group split by the cap is dropped entirely —
 * the flag plus `total` tell the client data is missing.
 */
/** Defensive row cap for the saved-from-uploads read: no query params means
 *  no client-controlled paging, so bound the response server-side. 500 rows
 *  is far beyond a plausible personal saved-words set; if it is ever hit,
 *  the newest uploads/saves win (matches the ORDER BY), the response says so
 *  via `truncated`/`total`, and only WHOLE groups are returned (the query
 *  over-fetches one row past the cap to detect a mid-group cut). */
const SAVED_FROM_UPLOADS_ROW_CAP = 500;

router.get('/saved-from-uploads', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{
      upload_id: string;
      upload_title: string;
      entry_id: string;
      korean: string | null;
      english: string | null;
      saved_at: Date;
      total: string;
    }>(
      `WITH saves AS (
          -- Save path 1: a live card on the entry (mined or banked).
          SELECT c.vocab_entry_id AS entry_id, MIN(c.created_at) AS saved_at
            FROM vocab_cards c
           WHERE c.user_id = $1
             AND c.deleted_at IS NULL
             AND c.vocab_entry_id IS NOT NULL
           GROUP BY c.vocab_entry_id
          UNION ALL
          -- Save path 2: membership in one of the user's live lists.
          -- entry_id IS NOT NULL: 049's multitype rows (grammar/hanja
          -- memberships) carry a NULL vocab entry_id and are not vocab saves.
          SELECT le.entry_id, MIN(le.added_at)
            FROM vocab_list_entries le
            JOIN vocab_lists vl
              ON vl.id = le.list_id
             AND vl.user_id = $1
             AND vl.deleted_at IS NULL
           WHERE le.entry_id IS NOT NULL
           GROUP BY le.entry_id
       ),
       first_saves AS (
          -- One row per saved entry, earliest save wins.
          SELECT entry_id, MIN(saved_at) AS saved_at
            FROM saves
           GROUP BY entry_id
       )
       SELECT bu.id           AS upload_id,
              bu.title        AS upload_title,
              ve.id           AS entry_id,
              ve.korean,
              ve.english,
              fs.saved_at,
              -- Full matching-row count alongside the capped page (window
              -- runs before LIMIT — same idiom as GET /vocab/entries above)
              -- so the client can see how much the cap hid.
              COUNT(*) OVER ()::text AS total
         FROM first_saves fs
         JOIN vocab_entries ve
           ON ve.id = fs.entry_id
         -- The ownership predicate lives ON the join: an entry tagged to an
         -- upload the caller does NOT own simply produces no row (never a
         -- leaked title, never an error).
         JOIN book_uploads bu
           ON bu.id = ve.source_upload_id
          AND bu.user_id = $1
        ORDER BY bu.created_at DESC, bu.id DESC, fs.saved_at DESC, ve.id
        LIMIT $2`,
      // Over-fetch ONE row past the cap: its presence proves truncation, and
      // its upload id tells whether the cap fell mid-group (see below).
      [userId, SAVED_FROM_UPLOADS_ROW_CAP + 1],
    );

    // Truncation handling — two invariants the wire contract promises:
    //   1. `truncated`/`total` say when (and how much) the cap hid.
    //   2. Every returned group is WHOLE. The LIMIT applies to flat rows, so
    //      the cap can land mid-group; a partially-returned group would look
    //      complete (worse than absent). If the over-fetched sentinel row
    //      belongs to the same upload as the last kept row, the cap split
    //      that group — drop the whole group (its rows are the ordered tail,
    //      so filtering by upload id removes exactly that trailing run). If
    //      the sentinel starts a NEW group, the kept groups are all whole.
    //      Degenerate case: a single group larger than the cap yields zero
    //      groups with truncated=true — honest, and unreachable at personal
    //      scale (cap = 500 saved words in ONE upload).
    const truncated = rows.length > SAVED_FROM_UPLOADS_ROW_CAP;
    const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
    let visible = rows;
    if (truncated) {
      const lastKept = rows[SAVED_FROM_UPLOADS_ROW_CAP - 1]!;
      const sentinel = rows[SAVED_FROM_UPLOADS_ROW_CAP]!;
      visible = rows.slice(0, SAVED_FROM_UPLOADS_ROW_CAP);
      if (sentinel.upload_id === lastKept.upload_id) {
        visible = visible.filter((r) => r.upload_id !== lastKept.upload_id);
      }
    }

    // Fold the flat rows into per-upload groups, preserving SQL order. pg
    // returns BIGINTs as strings; the DTO documents ids as JSON numbers
    // (both fit in Number.MAX_SAFE_INTEGER — same convention as every other
    // route in this file).
    interface SavedGroup {
      upload: { id: number; title: string };
      entries: Array<{
        id: number;
        korean: string | null;
        english: string | null;
        savedAt: string;
      }>;
    }
    const groups: SavedGroup[] = [];
    const byUpload = new Map<number, SavedGroup>();
    for (const r of visible) {
      const uploadId = Number(r.upload_id);
      let group = byUpload.get(uploadId);
      if (group === undefined) {
        group = { upload: { id: uploadId, title: r.upload_title }, entries: [] };
        byUpload.set(uploadId, group);
        groups.push(group);
      }
      group.entries.push({
        id: Number(r.entry_id),
        korean: r.korean,
        english: r.english,
        savedAt: r.saved_at.toISOString(),
      });
    }
    res.status(200).json({ groups, total, truncated });
  } catch (err) {
    next(err);
  }
});

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

// ── F-013: word mastery ──────────────────────────────────────────────────────
// "Mastered" mirrors the SRS "mature" convention: a review-state card whose
// memory stability is at least ~3 weeks (retained long enough to count as known).
const MASTERY_MATURE_DAYS = 21;

const MasteryQuerySchema = z.object({
  bucket: z.enum(['new', 'learning', 'reviewing', 'mastered']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
});

// Card → bucket, kept byte-identical between the summary counts and the per-word
// list so the two can never disagree. No user input is interpolated — the
// fragments below are fixed constants and MASTERY_MATURE_DAYS is a number.
const BUCKET_CASE = `CASE
    WHEN c.fsrs_state = 'new' THEN 'new'
    WHEN c.fsrs_state IN ('learning', 'relearning') THEN 'learning'
    WHEN c.fsrs_state = 'review' AND c.stability >= ${MASTERY_MATURE_DAYS} THEN 'mastered'
    ELSE 'reviewing'
  END`;
const BUCKET_PREDICATE: Record<'new' | 'learning' | 'reviewing' | 'mastered', string> =
  {
    new: `c.fsrs_state = 'new'`,
    learning: `c.fsrs_state IN ('learning', 'relearning')`,
    reviewing: `c.fsrs_state = 'review' AND c.stability < ${MASTERY_MATURE_DAYS}`,
    mastered: `c.fsrs_state = 'review' AND c.stability >= ${MASTERY_MATURE_DAYS}`,
  };

/**
 * GET /vocab/mastery — per-word FSRS mastery for the signed-in user (F-013).
 * Returns a bucket summary (New / Learning / Reviewing / Mastered) plus a
 * paginated, optionally bucket-filtered list of the user's vocab words. Only
 * vocab cards (vocab_entry_id set) count — grammar / sentence / topik cards are
 * not "words". User-isolated via c.user_id; vocab_entries is shared reference
 * data joined on the FK alone.
 */
router.get(
  '/mastery',
  cheapLimiter(),
  validateQuery(MasteryQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & {
          validatedQuery: z.infer<typeof MasteryQuerySchema>;
        }
      ).validatedQuery;

      const { rows: summaryRows } = await query<{
        new: string;
        learning: string;
        reviewing: string;
        mastered: string;
        total: string;
      }>(
        `SELECT
           count(*) FILTER (WHERE fsrs_state = 'new')::text AS new,
           count(*) FILTER (WHERE fsrs_state IN ('learning','relearning'))::text AS learning,
           count(*) FILTER (WHERE fsrs_state = 'review' AND stability <  $2)::text AS reviewing,
           count(*) FILTER (WHERE fsrs_state = 'review' AND stability >= $2)::text AS mastered,
           count(*)::text AS total
         FROM vocab_cards
         WHERE user_id = $1 AND deleted_at IS NULL AND vocab_entry_id IS NOT NULL`,
        [userId, MASTERY_MATURE_DAYS],
      );
      const s = summaryRows[0];
      const summary = {
        new: Number(s?.new ?? 0),
        learning: Number(s?.learning ?? 0),
        reviewing: Number(s?.reviewing ?? 0),
        mastered: Number(s?.mastered ?? 0),
        total: Number(s?.total ?? 0),
      };

      const filter = q.bucket ? `AND (${BUCKET_PREDICATE[q.bucket]})` : '';
      const { rows: wordRows } = await query<{
        id: number;
        korean: string;
        english: string | null;
        bucket: string;
        stability: string;
        reps: number;
        lapses: number;
        due_at: Date | null;
        total: string;
      }>(
        `SELECT c.id, v.korean, v.english,
                ${BUCKET_CASE} AS bucket,
                c.stability::text AS stability, c.reps, c.lapses, c.due_at,
                count(*) OVER ()::text AS total
           FROM vocab_cards c
           JOIN vocab_entries v ON v.id = c.vocab_entry_id
          WHERE c.user_id = $1 AND c.deleted_at IS NULL ${filter}
          ORDER BY c.stability DESC NULLS LAST, v.korean COLLATE "C", c.id
          LIMIT $2 OFFSET $3`,
        [userId, q.limit, q.offset],
      );

      const words = wordRows.map((r) => ({
        id: Number(r.id),
        korean: r.korean,
        english: r.english,
        bucket: r.bucket,
        stability: Number(r.stability),
        reps: r.reps,
        lapses: r.lapses,
        dueAt: r.due_at ? r.due_at.toISOString() : null,
      }));
      const total = wordRows.length > 0 ? Number(wordRows[0]?.total) : 0;

      res.status(200).json({ summary, words, total });
    } catch (err) {
      next(err);
    }
  },
);

// ── F-017: per-skill stats time-series ───────────────────────────────────────

const SeriesQuerySchema = z.object({
  // Rolling window, 1..90 days, default 30 — mirrors /topik/mistakes. An
  // out-of-range value 400s at the boundary (ValidationError).
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/**
 * GET /vocab/series — daily SRS review-count time-series (F-017).
 *
 * Buckets the caller's append-only `card_reviews` log by UTC day over the last
 * `days` (default 30); each point's value is how many reviews (Again/Hard/Good/
 * Easy presses) the user logged that day. Points are ASCENDING by date with one
 * entry per day that has activity — inactive days are absent, not zero-filled
 * (locked F-017 contract; the topik/grammar series behave identically).
 *
 * User-scoped to `getUserId(req)` — never a client-supplied id (no IDOR).
 * Bucketing pins `AT TIME ZONE 'UTC'` so the day boundary is stable regardless
 * of the DB session TimeZone GUC. The date is formatted 'YYYY-MM-DD' in SQL so
 * the client never tz-reinterprets it.
 */
router.get(
  '/series',
  cheapLimiter(),
  validateQuery(SeriesQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof SeriesQuerySchema> }
      ).validatedQuery;
      const { rows } = await query<{ date: string; value: number }>(
        `SELECT to_char((reviewed_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
                count(*)::int AS value
           FROM card_reviews
          WHERE user_id = $1
            AND reviewed_at > now() - make_interval(days => $2)
          GROUP BY (reviewed_at AT TIME ZONE 'UTC')::date
          ORDER BY (reviewed_at AT TIME ZONE 'UTC')::date`,
        [userId, q.days],
      );
      res.status(200).json({
        series: {
          metric: 'count',
          unit: 'reviews',
          points: rows.map((r) => ({ date: r.date, value: r.value })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
