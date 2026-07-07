/**
 * /grammar routes — user grammar bank + KGIU corpus search.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';

const router = Router();
router.use(requireAuth);

/**
 * The ISO-week-rollover boundary expression for the weekly-suggestion hash.
 * Identical to vocab.ts: pinned to 'Asia/Seoul' + ISO-week numbering so the
 * same picks return all week and rotate at local Monday-00:00 regardless of the
 * DB session timezone. The zone + format are server-side SQL literals, never
 * client input.
 */
const ISO_WEEK_SQL = `to_char((now() AT TIME ZONE 'Asia/Seoul'), 'IYYY-IW')`;

/** How many grammar picks the weekly-suggestion endpoint returns. */
const WEEKLY_SUGGESTION_LIMIT = 15;

// Ids/offsets bind to BIGINT/int8 in pg. Without an upper bound a 20-digit
// value passes `int().positive()` (Number.isInteger(1e20) is true) and
// overflows in pg (22003 → 500) where the contract is 400/404 for a garbage
// id (routes sweep #3). MAX_SAFE_INTEGER ≪ int8 max, so bounded values are safe.
const MAX_ID = Number.MAX_SAFE_INTEGER;

/* ---------- KGIU corpus (read-only) ---------- */

const KgiuSearchQuerySchema = z.object({
  q: z.string().min(1).max(64).optional(),
  corpus: z
    .enum(['kgiu_beginner', 'kgiu_intermediate', 'kgiu_advanced'])
    .optional(),
  proficiency: z.enum(['basic', 'L3', 'L4', 'L5+']).optional(),
  // F-005: Reference Grammar-tab filters. `domain` is the content-tagging
  // genre (content_domain enum, migration 002) and `book_level` the difficulty
  // band. Closed enums mirroring the DB types, so an out-of-vocabulary value
  // 400s at the boundary instead of reaching the cast in SQL.
  domain: z.enum(['general', 'research', 'business']).optional(),
  book_level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  // The client's Reference "Grammar" tab requests one wide page (GRAMMAR_PAGE_SIZE
  // = 400) to list the whole corpus without a pager; the reference data is ~370
  // pattern rows, so 400 covers it. Ceiling raised from 100 → 400 to admit that.
  limit: z.coerce.number().int().min(1).max(400).default(20),
  offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
});

router.get(
  '/kgiu',
  cheapLimiter(),
  validateQuery(KgiuSearchQuerySchema),
  async (req, res, next) => {
    try {
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof KgiuSearchQuerySchema>;
      }).validatedQuery;
      const { rows } = await query(
        // Structural non-pattern rows (unit_intro / reference / introduction
        // categories carry an empty `pattern`) are excluded: they render as a
        // blank row in the Reference list and would pollute the weekly picks.
        // The same `btrim(coalesce(pattern,'')) <> ''` guard fences them out of
        // /grammar/suggestions/weekly below.
        `SELECT id, corpus, source_id, pattern, title_en, category, proficiency,
                unit, source_pages
           FROM kgiu_entries
          WHERE entry_type = 'grammar'
            AND btrim(coalesce(pattern, '')) <> ''
            AND ($1::corpus IS NULL OR corpus = $1::corpus)
            AND ($2::proficiency_level IS NULL OR proficiency = $2::proficiency_level)
            AND ($3::text IS NULL OR pattern = $3)
            AND ($4::content_domain IS NULL OR domain = $4::content_domain)
            AND ($5::book_level IS NULL OR book_level = $5::book_level)
          ORDER BY id
          LIMIT $6 OFFSET $7`,
        [
          q.corpus ?? null,
          q.proficiency ?? null,
          q.q ?? null,
          q.domain ?? null,
          q.book_level ?? null,
          q.limit,
          q.offset,
        ],
      );
      res.status(200).json({ entries: rows });
    } catch (err) {
      next(err);
    }
  },
);

const KgiuIdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
});

router.get(
  '/kgiu/:id',
  cheapLimiter(),
  validateParams(KgiuIdParamsSchema),
  async (req, res, next) => {
    try {
      const id = (req as typeof req & {
        validatedParams: z.infer<typeof KgiuIdParamsSchema>;
      }).validatedParams.id;
      const { rows } = await query(
        `SELECT id, corpus, source_id, pattern, title_en, category, proficiency,
                explanation, formation_rules, examples, dialogues, vocabulary,
                tips, compare_with, exercises, cultural_notes, source_pages
           FROM kgiu_entries
          WHERE id = $1
          LIMIT 1`,
        [id],
      );
      if (rows.length === 0) throw new NotFoundError('kgiu entry not found');
      // pg returns BIGINT (id) as a string; the API contract documents id as a
      // JSON number. kgiu_entries.id fits comfortably in Number.MAX_SAFE_INTEGER.
      res.status(200).json({ ...rows[0], id: Number((rows[0] as { id: unknown }).id) });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- User grammar bank ---------- */

const BankBodySchema = z.object({
  pattern_key: z.string().regex(/^GR-[a-z0-9_-]{1,64}$/),
  pattern_display: z.string().min(1).max(120),
  summary_en: z.string().min(1).max(240),
  proficiency: z.enum(['basic', 'L3', 'L4', 'L5+']),
  category: z.string().min(1).max(40),
  register: z
    .enum(['반말', '해요체', '합쇼체', '문어체', '하오체', '하게체'])
    .optional(),
  discovered_via: z
    .enum([
      'manual',
      'reading_highlight',
      'listening_highlight',
      'topik_item',
      'diagnostic',
      'conversation',
      'import',
    ])
    .default('manual'),
  notes: z.record(z.string(), z.unknown()).default({}),
});

router.post('/bank', cheapLimiter(), validateBody(BankBodySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof BankBodySchema>;
    const userId = getUserId(req);
    const { rows } = await query<{ id: number }>(
      `INSERT INTO grammar_entries (
          user_id, pattern_key, pattern_display, summary_en,
          proficiency, category, register, notes, discovered_via)
       VALUES ($1,$2,$3,$4,$5::proficiency_level,$6,$7::register_level,$8::jsonb,$9)
       ON CONFLICT (user_id, pattern_key)
         DO UPDATE SET pattern_display = EXCLUDED.pattern_display,
                       summary_en     = EXCLUDED.summary_en,
                       proficiency    = EXCLUDED.proficiency,
                       category       = EXCLUDED.category,
                       register       = EXCLUDED.register,
                       notes          = EXCLUDED.notes,
                       version        = grammar_entries.version + 1
       RETURNING id`,
      [
        userId,
        body.pattern_key,
        body.pattern_display,
        body.summary_en,
        body.proficiency,
        body.category,
        body.register ?? null,
        JSON.stringify(body.notes),
        body.discovered_via,
      ],
    );
    // pg returns BIGINT as a string; the API contract documents id as a JSON
    // number (grammar_entries.id fits comfortably in Number.MAX_SAFE_INTEGER).
    res.status(201).json({ id: Number(rows[0]!.id) });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      next(new ConflictError('grammar entry conflict'));
      return;
    }
    next(err);
  }
});

router.get('/bank', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // graduated_at (migration 033) rides along so the client can split the
    // bank into active vs known/graduated without a second endpoint: NULL =
    // active learning, non-NULL = graduated. Graduated rows are still
    // returned — they are banked, just retired from the drill/review loop.
    const { rows } = await query(
      `SELECT id, pattern_key, pattern_display, summary_en, proficiency,
              category, register, discovered_via, created_at, graduated_at
         FROM grammar_entries
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [userId],
    );
    res.status(200).json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

/* ---------- Graduate / re-admit a banked pattern (migration 033) ---------- */

const BankIdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
});

/**
 * Shared handler for the two graduation state flips. Ownership is enforced in
 * the UPDATE itself (`user_id = $2`): a row that exists but belongs to another
 * user updates nothing and falls to the same 404 as a nonexistent id — no
 * cross-user existence leak (mirrors the vocab-cards reviews route posture).
 * Soft-deleted rows are likewise untouchable (`deleted_at IS NULL`).
 *
 * GRADUATE is idempotent on the timestamp: COALESCE keeps the original
 * graduated_at on a double-tap instead of silently sliding it forward.
 * RE-ADMIT nulls it. Both bump `version` (manual optimistic-concurrency bump
 * per ADR-001 §D6, matching the POST /bank upsert) and return the updated row
 * in the same wire shape as a GET /grammar/bank entry.
 */
function setGraduation(graduate: boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = getUserId(req);
      const id = (req as typeof req & {
        validatedParams: z.infer<typeof BankIdParamsSchema>;
      }).validatedParams.id;
      const { rows } = await query<{ id: string }>(
        `UPDATE grammar_entries
            SET graduated_at = ${graduate ? 'COALESCE(graduated_at, now())' : 'NULL'},
                version      = version + 1
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          RETURNING id, pattern_key, pattern_display, summary_en, proficiency,
                    category, register, discovered_via, created_at, graduated_at`,
        [id, userId],
      );
      if (rows.length === 0) throw new NotFoundError('grammar entry not found');
      // pg returns BIGINT as a string; the API contract documents id as a
      // JSON number (fits comfortably in Number.MAX_SAFE_INTEGER).
      res.status(200).json({ entry: { ...rows[0]!, id: Number(rows[0]!.id) } });
    } catch (err) {
      next(err);
    }
  };
}

/** POST /grammar/bank/:id/graduate — mark a banked pattern as known. */
router.post(
  '/bank/:id/graduate',
  cheapLimiter(),
  validateParams(BankIdParamsSchema),
  setGraduation(true),
);

/** POST /grammar/bank/:id/readmit — return a graduated pattern to active learning. */
router.post(
  '/bank/:id/readmit',
  cheapLimiter(),
  validateParams(BankIdParamsSchema),
  setGraduation(false),
);

/* ---------- Weekly suggestions (suggest-only — no auto-add) ---------- */

/**
 * GET /grammar/suggestions/weekly — 15 KGIU patterns the user hasn't banked
 * yet, stable for the whole ISO week and rotating the next.
 *
 * Suggest-only: this endpoint NEVER writes. The client renders each pick with
 * an [Add] button that POSTs /grammar/bank (the existing add-to-bank path) —
 * there is no parallel bank-create here.
 *
 * Selection model — "stable per (user, ISO week), excludes what's already
 * banked" (mirrors /vocab/suggestions/weekly, plan.ts, hanja.ts):
 *   - Source: `kgiu_entries` grammar rows (entry_type = 'grammar').
 *   - Exclusion: a KGIU row is dropped when the user has already banked the
 *     SAME pattern. The only column the two tables share at the value level is
 *     the Hangul display form: `kgiu_entries.pattern` ≈
 *     `grammar_entries.pattern_display`. There is intentionally NO key bridge
 *     between source-canonical (`canonical_grammar.pattern_key`, a Korean
 *     normalized form) and user-canonical (`grammar_entries.pattern_key`, the
 *     `GR-…` app key) — that bridge is Phase D (see migration 006's module
 *     comment). Until it lands, matching on the trimmed display form is the
 *     soundest available exclusion. It can miss a pattern whose KGIU surface
 *     form differs cosmetically from the banked display string; the worst case
 *     is re-suggesting an already-banked pattern, whose [Add] is itself
 *     idempotent (ON CONFLICT (user_id, pattern_key) in POST /grammar/bank), so
 *     no duplicate is ever created. Documented as FU when 006's bridge ships.
 *   - Ordering: md5(iso_week || user_id || entry.id) — same set all week,
 *     rotates at the Asia/Seoul ISO-week boundary.
 *   - LIMIT 15.
 *   - GRADUATED patterns (migration 033) stay excluded BY DESIGN: the
 *     NOT-EXISTS below matches any non-deleted banked row and deliberately
 *     ignores graduated_at — a pattern the user has marked as known must not
 *     be re-suggested for study. Pinned by a route test.
 *
 * Read-only, auth-required, cheap limiter. The only SQL input is the session
 * user id (never client-supplied) and the server-side date.
 */
router.get('/suggestions/weekly', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // Same column set as GET /grammar/kgiu so a suggestion row is wire-identical
    // to a browse row (the client's KgiuEntrySummary) and can flow straight into
    // the existing bank-from-pattern UI.
    const { rows } = await query<{
      id: number;
      corpus: string;
      source_id: string | null;
      pattern: string | null;
      title_en: string | null;
      category: string | null;
      proficiency: string | null;
      unit: string | null;
      source_pages: unknown;
    }>(
      `SELECT k.id, k.corpus, k.source_id, k.pattern, k.title_en, k.category,
              k.proficiency, k.unit, k.source_pages
         FROM kgiu_entries k
        WHERE k.entry_type = 'grammar'
          AND btrim(coalesce(k.pattern, '')) <> ''
          AND NOT EXISTS (
                SELECT 1
                  FROM grammar_entries g
                 WHERE g.user_id = $1
                   AND g.deleted_at IS NULL
                   AND btrim(g.pattern_display) = btrim(k.pattern)
              )
        ORDER BY md5(${ISO_WEEK_SQL} || $1::text || k.id::text)
        LIMIT $2`,
      [userId, WEEKLY_SUGGESTION_LIMIT],
    );
    // pg returns BIGINT (id) as a string; the DTO documents id as a JSON number
    // (kgiu_entries.id fits comfortably in Number.MAX_SAFE_INTEGER). The wire key
    // is `patterns` (matches the client's GrammarSuggestionsResponse).
    const patterns = rows.map((r) => ({ ...r, id: Number(r.id) }));
    res.status(200).json({ patterns });
  } catch (err) {
    next(err);
  }
});

/* ---------- Per-skill stats time-series (F-017) ---------- */

const SeriesQuerySchema = z.object({
  // Rolling window, 1..90 days, default 30 — mirrors /topik/mistakes. An
  // out-of-range value 400s at the boundary (ValidationError).
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/**
 * GET /grammar/series — daily grammar-drill score time-series (F-017).
 *
 * Buckets the caller's SCORED `grammar_drill_attempts` (migration 019) by UTC
 * day over the last `days` (default 30); each point's value is round(avg(score))
 * for that day (Claude's 0..100 drill score). Unscored attempts
 * (`scored_at IS NULL` — generated but never submitted) never count; the
 * defensive `score IS NOT NULL` guard keeps a hypothetical scored-without-score
 * row from producing a NULL average. Points are ASCENDING by date with one
 * entry per day that has activity — inactive days are absent, not zero-filled
 * (locked F-017 contract; the topik/vocab series behave identically).
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
        `SELECT to_char((scored_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
                round(avg(score))::int AS value
           FROM grammar_drill_attempts
          WHERE user_id = $1
            AND scored_at IS NOT NULL
            AND score IS NOT NULL
            AND scored_at > now() - make_interval(days => $2)
          GROUP BY (scored_at AT TIME ZONE 'UTC')::date
          ORDER BY (scored_at AT TIME ZONE 'UTC')::date`,
        [userId, q.days],
      );
      res.status(200).json({
        series: {
          metric: 'score',
          unit: 'pts',
          points: rows.map((r) => ({ date: r.date, value: r.value })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- AI-assisted highlight → pattern identification ---------- */

const IdentifySchema = z.object({
  highlightSpan: z.string().min(1).max(120),
  fullSentence: z.string().min(1).max(2_000),
  contextHint: z.string().max(500).optional(),
});

/**
 * POST /grammar/identify — pattern recognition via B4. The "drag-to-highlight"
 * flow from DESIGN_SPEC: send span + sentence, get back a canonical pattern
 * mapping that the client can bank.
 */
router.post(
  '/identify',
  expensiveLimiter(),
  validateBody(IdentifySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof IdentifySchema>;
      const proxy = getClaudeProxy();
      const out = await proxy.recognizeGrammarPattern(body, {
        requestId: req.correlationId,
        userId: req.user?.id ?? null,
      });
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
