/**
 * /grammar routes — user grammar bank + KGIU corpus search + per-pattern
 * mastery (F-099, the Progress "Grammar" tab's read).
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { sourceUploadFenceSql } from '../db/corpusFences.js';
import { ConflictError, NotFoundError, mapClaudeError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import type { FsrsStateName } from '../services/fsrs.js';

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
  // U3a (source filtering): the `book_uploads.id` an uploaded-book source filter
  // is scoping to. Wired from the client's SourceFilterRow since U1 but inert
  // server-side until now — the WHERE clause below finally honours it. Coerced
  // to an int and bounded by MAX_ID (it binds to a BIGINT FK); ownership is
  // enforced in SQL (EXISTS guard) so a user can only filter by an upload they
  // own. Mirrors the vocab route.
  source_upload_id: z.coerce.number().int().positive().max(MAX_ID).optional(),
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
      // Session user — needed only to scope the optional source-book filter to
      // uploads this user owns (the EXISTS guard below). The KGIU corpus itself
      // is shared reference data, so the rest of the query is user-agnostic.
      const userId = getUserId(req);
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
            -- U3a source filter (mirrors the vocab route): the row must be
            -- tagged with the given source id AND that upload must belong to the
            -- requesting user, so filtering by an unowned/deleted upload returns
            -- zero rows rather than another user's tagged patterns.
            AND ($6::bigint IS NULL
                 OR (source_upload_id = $6::bigint
                     AND EXISTS (SELECT 1 FROM book_uploads bu
                                  WHERE bu.id = $6::bigint
                                    AND bu.user_id = $7)))
            -- F-108 fence: rows EXTRACTED from a book upload are derived from
            -- a user's PRIVATE upload — they must never surface in another
            -- user's Reference list. Untagged rows (the whole curated KGIU
            -- corpus, source_upload_id IS NULL) stay shared reference data.
            -- Shared fragment: db/corpusFences.ts (the fence audit surface).
            AND ${sourceUploadFenceSql('source_upload_id', '$7')}
          ORDER BY id
          LIMIT $8 OFFSET $9`,
        [
          q.corpus ?? null,
          q.proficiency ?? null,
          q.q ?? null,
          q.domain ?? null,
          q.book_level ?? null,
          q.source_upload_id ?? null,
          userId,
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
      const userId = getUserId(req);
      const { rows } = await query(
        // `unit` must ride along: the client's KgiuEntryDetail extends
        // KgiuEntrySummary (which declares `unit`) and the detail Sheet footer
        // renders `Unit · {detail.unit ?? '—'}`. It was omitted here until
        // REVIEW_F018 SHOULD-FIX-1 — every real row footer showed "Unit · —"
        // while client tests passed on mocks that included it. Pinned by a
        // route test so the wire-vs-mock gap can't recur.
        //
        // F-108 fence: an entry EXTRACTED from a book upload is derived from a
        // user's PRIVATE upload — another user probing sequential ids must get
        // the same 404 as a missing id. Untagged rows stay shared reference.
        // Shared fragment: db/corpusFences.ts (the fence audit surface).
        `SELECT id, corpus, source_id, pattern, title_en, category, proficiency,
                unit, explanation, formation_rules, examples, dialogues,
                vocabulary, tips, compare_with, exercises, cultural_notes,
                source_pages
           FROM kgiu_entries
          WHERE id = $1
            AND ${sourceUploadFenceSql('source_upload_id', '$2')}
          LIMIT 1`,
        [id, userId],
      );
      if (rows.length === 0) throw new NotFoundError('kgiu entry not found');
      // id arrives as a safe-integer number via the int8 parser (db/pool.ts),
      // matching the API contract's JSON number.
      res.status(200).json(rows[0]);
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
  // F-107 (user-saved upload provenance): the `book_uploads.id` the user was
  // working from when they banked this pattern — the exact mirror of
  // `POST /vocab/mine`'s field (same int/positive/MAX_ID bound; JSON body,
  // so no coerce). Optional — a bank outside an upload context sends
  // nothing. OWNERSHIP is validated in the handler (the upload must belong
  // to the caller, else 404) BEFORE anything persists — an attacker passing
  // someone else's upload id must not tag their save to it.
  source_upload_id: z.number().int().positive().max(MAX_ID).optional(),
});

router.post('/bank', cheapLimiter(), validateBody(BankBodySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof BankBodySchema>;
    const userId = getUserId(req);
    // One transaction (F-107): the upload-ownership check and the tagged
    // upsert commit or roll back together — mirrors POST /vocab/mine.
    const { rows } = await withTransaction(async (client) => {
      // 0. Validate the referenced upload BELONGS TO the caller before
      //    anything persists. One combined id+ownership predicate: a
      //    nonexistent id and another user's id both 404 identically, so
      //    the response is not an existence oracle for other users' upload
      //    ids (same posture as this file's graduate/readmit routes).
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
      return client.query<{ id: number }>(
        // F-107: source_upload_id is first-write-wins on re-bank (COALESCE
        // keeps the original tag) — provenance records where the pattern was
        // FIRST saved from, same convention as discovered_via (which the
        // upsert deliberately never updates). A later re-bank WITH an upload
        // id only FILLS missing provenance on a row that has none.
        `INSERT INTO grammar_entries (
            user_id, pattern_key, pattern_display, summary_en,
            proficiency, category, register, notes, discovered_via,
            source_upload_id)
         VALUES ($1,$2,$3,$4,$5::proficiency_level,$6,$7::register_level,$8::jsonb,$9,$10)
         ON CONFLICT (user_id, pattern_key)
           DO UPDATE SET pattern_display = EXCLUDED.pattern_display,
                         summary_en     = EXCLUDED.summary_en,
                         proficiency    = EXCLUDED.proficiency,
                         category       = EXCLUDED.category,
                         register       = EXCLUDED.register,
                         notes          = EXCLUDED.notes,
                         source_upload_id = COALESCE(grammar_entries.source_upload_id,
                                                     EXCLUDED.source_upload_id),
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
          body.source_upload_id ?? null,
        ],
      );
    });
    // id arrives as a safe-integer number via the int8 parser (db/pool.ts),
    // matching the API contract's JSON number.
    res.status(201).json({ id: rows[0]!.id });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      next(new ConflictError('grammar entry conflict'));
      return;
    }
    // F-107 race guard: READ COMMITTED does not stop a concurrent hard-delete
    // of the upload between the ownership check and the insert — the FK from
    // migration 068 then rejects the write (23503). Still "this upload does
    // not exist for you" → the same 404 the check gives, not a 500. Scoped
    // to THIS FK's constraint name so unrelated integrity errors stay loud.
    const pgErr = err as { code?: string; constraint?: string };
    if (
      pgErr.code === '23503' &&
      pgErr.constraint === 'fk_grammar_entries_source_upload'
    ) {
      next(new NotFoundError('upload not found'));
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
    //
    // F-111: LEFT JOIN each pattern's grammar PRODUCTION card so the client's
    // mastery rows can render the REAL FSRS schedule (state + due date) for
    // EVERY saved pattern, not only a due-NOW badge — the existing
    // `GET /vocab/cards/due` queue only ever surfaces cards that are due
    // right now, so a non-due pattern had no schedule signal at all. Folded
    // into this existing read rather than a new dedicated endpoint: it's the
    // lower-risk option — GET /grammar/bank is already user-scoped and
    // rate-limited, and it's the exact read the cards view fires on every
    // load, so the schedule rides along for free instead of growing the
    // route surface with a second per-pattern lookup the client would have
    // to fan out N times (one per saved pattern).
    //
    // The join cannot multiply a bank row: `uq_vocab_cards_user_grammar_
    // production` (migration 020) is a partial UNIQUE index on
    // (user_id, grammar_entry_id) WHERE face = 'production' AND deleted_at
    // IS NULL, so at most one card matches per grammar_entries row.
    // `vc.user_id = g.user_id` is defense-in-depth (the FK already ties a
    // card to one user's entry; mirrors the same belt-and-suspenders join
    // guard GET /vocab/cards/due uses for its grammar_entries LEFT JOIN).
    //
    // `schedule` is null when the pattern has never been drilled — no
    // production card exists yet (FU-NF-42 creates one lazily on the first
    // drill submit) — an honest "not started" rather than a synthesized
    // new-card default.
    const { rows } = await query<{
      id: unknown;
      pattern_key: string;
      pattern_display: string;
      summary_en: string;
      proficiency: string;
      category: string;
      register: string | null;
      discovered_via: string;
      created_at: Date;
      graduated_at: Date | null;
      card_state: FsrsStateName | null;
      card_stability: string | null;
      card_due_at: Date | null;
    }>(
      `SELECT g.id, g.pattern_key, g.pattern_display, g.summary_en, g.proficiency,
              g.category, g.register, g.discovered_via, g.created_at, g.graduated_at,
              vc.fsrs_state AS card_state,
              vc.stability  AS card_stability,
              vc.due_at     AS card_due_at
         FROM grammar_entries g
         LEFT JOIN vocab_cards vc
                ON vc.grammar_entry_id = g.id
               AND vc.face = 'production'
               AND vc.user_id = g.user_id
               AND vc.deleted_at IS NULL
        WHERE g.user_id = $1 AND g.deleted_at IS NULL
        ORDER BY g.created_at DESC`,
      [userId],
    );
    const entries = rows.map((r) => {
      const { card_state, card_stability, card_due_at, ...pub } = r;
      return {
        ...pub,
        // card_state/card_stability/card_due_at are all sourced from the SAME
        // joined row (vc.*), so they are null together or non-null together —
        // the non-null assertion on stability is safe once state is checked.
        schedule:
          card_state !== null && card_due_at !== null
            ? { state: card_state, stability: card_stability!, dueAt: card_due_at.toISOString() }
            : null,
      };
    });
    res.status(200).json({ entries });
  } catch (err) {
    next(err);
  }
});

/* ---------- Saved-from-uploads (F-056 — the F-053/F-107 grammar mirror) ---------- */

/**
 * GET /grammar/saved-from-uploads — the user's saved (banked) grammar that
 * carries upload provenance, grouped by source upload (F-056; feeds the
 * Review→Grammar "Uploads" view's saved section — the exact grammar mirror
 * of `GET /vocab/saved-from-uploads`, F-053/F-107).
 *
 * "Saved" means the user deliberately banked the pattern via
 * `POST /grammar/bank` with a `source_upload_id` (the migration-068 column,
 * ownership-validated at write time). Simpler than the vocab twin on
 * purpose: `grammar_entries` is USER-scoped (one row per (user, pattern) —
 * no shared corpus rows, no second list-membership save path), so one
 * predicate covers the whole read and `savedAt` is simply the bank row's
 * `created_at`. Distinct from the same view's EXTRACTED content
 * (`GET /grammar/kgiu?source_upload_id=`, F-108): this is only what the
 * user chose to keep.
 *
 * SECURITY (mirrors the vocab twin):
 *   - User-scoped on BOTH legs: `g.user_id = $1` (only the caller's bank
 *     rows) AND `bu.user_id = $1` ON the join (an upload title can never
 *     leak across users — a row tagged to an unowned upload, which only a
 *     direct DB write could produce, simply yields no row, never an error).
 *   - Fully parameterized; read-only; soft-deleted bank rows excluded.
 *   - No query params → no client-controlled paging; the response is bounded
 *     server-side by the row cap below.
 *
 * Response: `{ groups, total, truncated }` — `total` is the FULL
 * saved-with-provenance pattern count (window COUNT, unaffected by the
 * cap); `truncated: true` says the row cap trimmed the response. Every
 * returned group is guaranteed WHOLE — a group the cap would split
 * mid-group is dropped entirely (same contract, and the same sentinel
 * over-fetch technique, as the vocab twin).
 */
/** Defensive row cap — same value and rationale as vocab.ts's
 *  SAVED_FROM_UPLOADS_ROW_CAP (500 saved patterns is far beyond a personal
 *  bank; newest uploads/saves win when it is ever hit). */
const SAVED_FROM_UPLOADS_ROW_CAP = 500;

router.get('/saved-from-uploads', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{
      upload_id: number;
      upload_title: string;
      entry_id: number;
      pattern_display: string;
      summary_en: string;
      saved_at: Date;
      total: string;
    }>(
      `SELECT bu.id              AS upload_id,
              bu.title           AS upload_title,
              g.id               AS entry_id,
              g.pattern_display,
              g.summary_en,
              g.created_at       AS saved_at,
              -- Full matching-row count alongside the capped page (window
              -- runs before LIMIT — same idiom as the vocab twin) so the
              -- client can see how much the cap hid.
              COUNT(*) OVER ()::text AS total
         FROM grammar_entries g
         -- The ownership predicate lives ON the join: a row tagged to an
         -- upload the caller does NOT own simply produces no row (never a
         -- leaked title, never an error).
         JOIN book_uploads bu
           ON bu.id = g.source_upload_id
          AND bu.user_id = $1
        WHERE g.user_id = $1
          AND g.deleted_at IS NULL
        ORDER BY bu.created_at DESC, bu.id DESC, g.created_at DESC, g.id
        LIMIT $2`,
      // Over-fetch ONE row past the cap: its presence proves truncation, and
      // its upload id tells whether the cap fell mid-group (see below).
      [userId, SAVED_FROM_UPLOADS_ROW_CAP + 1],
    );

    // Truncation handling — identical contract to the vocab twin:
    //   1. `truncated`/`total` say when (and how much) the cap hid.
    //   2. Every returned group is WHOLE: if the over-fetched sentinel row
    //      belongs to the same upload as the last kept row, the cap split
    //      that group — drop the whole group (its rows are the ordered
    //      tail). If the sentinel starts a NEW group, every kept group is
    //      whole. Degenerate case: one group larger than the cap yields
    //      zero groups with truncated=true — honest, and the client's
    //      truncated note still renders (batch-5 NIT-A).
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

    // Fold the flat rows into per-upload groups, preserving SQL order. The
    // ids arrive as safe-integer numbers via the int8 parser (db/pool.ts);
    // `total` is a ::text-cast window COUNT, so its Number() stays load-bearing.
    interface SavedGroup {
      upload: { id: number; title: string };
      entries: Array<{
        id: number;
        pattern: string;
        summary: string;
        savedAt: string;
      }>;
    }
    const groups: SavedGroup[] = [];
    const byUpload = new Map<number, SavedGroup>();
    for (const r of visible) {
      const uploadId = r.upload_id;
      let group = byUpload.get(uploadId);
      if (group === undefined) {
        group = { upload: { id: uploadId, title: r.upload_title }, entries: [] };
        byUpload.set(uploadId, group);
        groups.push(group);
      }
      group.entries.push({
        id: r.entry_id,
        pattern: r.pattern_display,
        summary: r.summary_en,
        savedAt: r.saved_at.toISOString(),
      });
    }
    res.status(200).json({ groups, total, truncated });
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
      const { rows } = await query<{ id: number }>(
        `UPDATE grammar_entries
            SET graduated_at = ${graduate ? 'COALESCE(graduated_at, now())' : 'NULL'},
                version      = version + 1
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          RETURNING id, pattern_key, pattern_display, summary_en, proficiency,
                    category, register, discovered_via, created_at, graduated_at`,
        [id, userId],
      );
      if (rows.length === 0) throw new NotFoundError('grammar entry not found');
      // id arrives as a safe-integer number via the int8 parser (db/pool.ts),
      // matching the API contract's JSON number.
      res.status(200).json({ entry: rows[0]! });
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
          -- F-108 fence: suggestions draw from the shared curated corpus only.
          -- Rows EXTRACTED from a book upload (source_upload_id tagged) are
          -- private to the upload's owner AND uncurated OCR candidates — wrong
          -- for the weekly picks on both counts.
          AND k.source_upload_id IS NULL
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
    // id arrives as a safe-integer number via the int8 parser (db/pool.ts),
    // matching the DTO's JSON number. The wire key is `patterns` (matches the
    // client's GrammarSuggestionsResponse).
    res.status(200).json({ patterns: rows });
  } catch (err) {
    next(err);
  }
});

/* ---------- F-099: per-pattern grammar mastery (Progress "Grammar" tab) ---------- */

// "Mastered" mirrors /vocab/mastery's SRS "mature" convention: a review-state
// card whose memory stability is at least ~3 weeks. Same constant, same
// semantics — the Words and Grammar tabs on Progress must agree on what the
// "Mastered" bucket means.
const MASTERY_MATURE_DAYS = 21;

const GrammarMasteryQuerySchema = z.object({
  bucket: z.enum(['new', 'learning', 'reviewing', 'mastered']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
});

/**
 * Banked pattern → mastery bucket, computed over the pattern's grammar
 * PRODUCTION card (the same LEFT JOIN GET /grammar/bank uses — see its F-111
 * comment for why the join can never fan out: `uq_vocab_cards_user_grammar_
 * production` caps it at one card per entry). Kept as ONE fixed SQL fragment
 * shared by the summary counts and the per-pattern list so the two can never
 * disagree. No user input is interpolated — MASTERY_MATURE_DAYS is a
 * server-side numeric constant.
 *
 * Two deliberate divergences from the vocab BUCKET_CASE:
 *   - `graduated_at IS NOT NULL` → 'mastered' unconditionally: a graduated
 *     pattern is one the user explicitly marked as KNOWN (migration 033) and
 *     is excluded from the whole learning loop — reporting it as 'new'
 *     because its card was never drilled would be a lie.
 *   - `vc.id IS NULL` → 'new': a banked-but-never-drilled pattern has no
 *     production card at all (FU-NF-42 creates one lazily on the first drill
 *     submit) — honest "not started", same bucket a fresh card would get.
 */
const GRAMMAR_BUCKET_CASE = `CASE
    WHEN g.graduated_at IS NOT NULL THEN 'mastered'
    WHEN vc.id IS NULL OR vc.fsrs_state = 'new' THEN 'new'
    WHEN vc.fsrs_state IN ('learning', 'relearning') THEN 'learning'
    WHEN vc.fsrs_state = 'review' AND vc.stability >= ${MASTERY_MATURE_DAYS} THEN 'mastered'
    ELSE 'reviewing'
  END`;

/** The user-scoped bucketed derived table both /mastery queries select from. */
const GRAMMAR_MASTERY_SOURCE = `SELECT g.id, g.pattern_display, g.summary_en,
           ${GRAMMAR_BUCKET_CASE} AS bucket,
           vc.stability, vc.due_at
      FROM grammar_entries g
      LEFT JOIN vocab_cards vc
             ON vc.grammar_entry_id = g.id
            AND vc.face = 'production'
            AND vc.user_id = g.user_id
            AND vc.deleted_at IS NULL
     WHERE g.user_id = $1 AND g.deleted_at IS NULL`;

type GrammarMasteryBucket = 'new' | 'learning' | 'reviewing' | 'mastered';

/**
 * GET /grammar/mastery — per-pattern FSRS mastery for the signed-in user
 * (F-099; the Progress "Grammar" tab's backing read). Returns a bucket
 * summary (New / Learning / Reviewing / Mastered) plus a paginated,
 * optionally bucket-filtered list of the user's banked patterns — the
 * grammar sibling of GET /vocab/mastery, same query params, same envelope
 * shape (`patterns` instead of `words`).
 *
 * User-isolated via g.user_id = session user (never a client-supplied id);
 * the production-card join carries the same belt-and-suspenders
 * `vc.user_id = g.user_id` guard as GET /grammar/bank. Every query is
 * parameterized; `bucket` is a closed zod enum compared against the
 * derived bucket column as a bind parameter (no SQL fragment selection).
 */
router.get(
  '/mastery',
  cheapLimiter(),
  validateQuery(GrammarMasteryQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & {
          validatedQuery: z.infer<typeof GrammarMasteryQuerySchema>;
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
           count(*) FILTER (WHERE bucket = 'new')::text AS new,
           count(*) FILTER (WHERE bucket = 'learning')::text AS learning,
           count(*) FILTER (WHERE bucket = 'reviewing')::text AS reviewing,
           count(*) FILTER (WHERE bucket = 'mastered')::text AS mastered,
           count(*)::text AS total
         FROM (${GRAMMAR_MASTERY_SOURCE}) b`,
        [userId],
      );
      const s = summaryRows[0];
      const summary = {
        new: Number(s?.new ?? 0),
        learning: Number(s?.learning ?? 0),
        reviewing: Number(s?.reviewing ?? 0),
        mastered: Number(s?.mastered ?? 0),
        total: Number(s?.total ?? 0),
      };

      const { rows: patternRows } = await query<{
        id: number; // BIGINT IDENTITY — the int8 parser returns a number
        pattern_display: string;
        summary_en: string;
        bucket: GrammarMasteryBucket;
        stability: string | null; // NUMERIC arrives as string; null = no card
        due_at: Date | null;
        total: string;
      }>(
        // Same ordering family as /vocab/mastery (most-stable first), with
        // NULLS LAST so never-drilled patterns sink below every real card.
        // COLLATE "C" pins the Hangul tiebreak byte-wise (locale-independent),
        // and id is the final total-order tiebreak.
        `SELECT p.id, p.pattern_display, p.summary_en, p.bucket,
                p.stability::text AS stability, p.due_at,
                count(*) OVER ()::text AS total
           FROM (${GRAMMAR_MASTERY_SOURCE}) p
          WHERE ($2::text IS NULL OR p.bucket = $2)
          ORDER BY p.stability DESC NULLS LAST,
                   p.pattern_display COLLATE "C", p.id
          LIMIT $3 OFFSET $4`,
        [userId, q.bucket ?? null, q.limit, q.offset],
      );

      const patterns = patternRows.map((r) => ({
        id: Number(r.id),
        pattern: r.pattern_display,
        summaryEn: r.summary_en,
        bucket: r.bucket,
        // null (not 0) for a never-drilled pattern — the client renders "—",
        // never a fabricated zero-stability.
        stability: r.stability !== null ? Number(r.stability) : null,
        dueAt: r.due_at !== null ? r.due_at.toISOString() : null,
      }));
      const total = patternRows.length > 0 ? Number(patternRows[0]?.total) : 0;

      res.status(200).json({ summary, patterns, total });
    } catch (err) {
      next(err);
    }
  },
);

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
      // F-193: shared Claude-error mapper (see errors.ts) — a proxy-origin
      // client fault keeps its 400/429, everything upstream flattens to a
      // whitelisted-message 502; non-proxy errors pass through unchanged
      // (preserving the pre-existing generic-500-no-leak behavior).
      next(mapClaudeError(err));
    }
  },
);

export default router;
