/**
 * /reading routes — U3b, the digitized chapter reader's data surface.
 *
 * Serves the OCR'd + curated literature text an uploaded book was turned into
 * (reading_chapters + reading_passages, migration 044). The client renders a
 * chapter as tappable text (tap-to-define reuses the existing lemmatize →
 * define → enrich stack — no server work here beyond serving the passages).
 * See db/docs/U3_READER_DESIGN.md §U3b.
 *
 * Flow:
 *   GET /reading/chapters?source_upload_id=  → the ordered chapter list for one
 *                                              owned literature book (the reader's
 *                                              chapter selector)
 *   GET /reading/chapters/:chapterId         → one chapter + its ordered passages
 *                                              (the reader body)
 *   GET /reading/position/:uploadId          → the user's saved resume position
 *                                              for one owned book, or null
 *   PUT /reading/position/:uploadId          → upsert the resume position
 *                                              (F-069; reading_positions, 051)
 *   POST /reading/generate                   → Claude authors a short Korean
 *                                              story at a level (optional
 *                                              topic), persists it to
 *                                              generated_stories (054), and
 *                                              returns it (F-068)
 *   GET /reading/generated                   → the user's generated-story
 *                                              library, newest first
 *   GET /reading/generated/:id               → one generated story (full body)
 *   POST /reading/translate                  → Claude authors a natural-
 *                                              English translation of a
 *                                              selected Korean passage or
 *                                              story paragraph (F-116).
 *                                              STATELESS — nothing persisted
 *                                              server-side by this route.
 *
 * SECURITY:
 *   - IDOR: reading_chapters.user_id is the book owner (pinned to it by the
 *     migration-044 composite FK, so it can never drift), so every read scopes
 *     directly on `user_id = getUserId(req)`. The chapter-list endpoint first
 *     404s an upload the user doesn't own (or that isn't a real upload) —
 *     identical to a missing id, not 403, so probing id-space reveals nothing
 *     — so the client can tell "not your book" from "your book, no chapters
 *     yet" (an owned upload with zero chapters still 200s with an empty
 *     list). The chapter-detail endpoint folds "missing" and "not yours"
 *     into that same uniform 404 in a single scoped query. Neither route
 *     ever leaks another user's ids (both ownership checks are themselves
 *     user-scoped). The position routes reuse the same upload ownership
 *     gate, and the write path is DOUBLY guarded: even if the route-level
 *     user filter were bypassed, migration 051's composite owner-guard FK
 *     ((source_upload_id, user_id) → book_uploads(id, user_id)) makes a
 *     cross-user position row impossible at the DB level.
 *   - INJECTION: every id is a coerced, upper-bounded integer bound as a query
 *     parameter — never string-interpolated into SQL.
 *   - WRITES: the only mutating surface is the position upsert — a single
 *     parameterized INSERT … ON CONFLICT keyed by (user_id, source_upload_id),
 *     so a user can only ever touch their own one-row-per-book slot. Chapter
 *     ingestion remains the loader's job (tools/ingest/load_literature.py),
 *     not an API surface.
 *   - NOTE (migration 044's COMMENT ON CONSTRAINT caveat): the composite FK
 *     guarantees a chapter's user_id = its upload's owner, but does NOT enforce
 *     book_uploads.type = 'literature' — the loader and these routes own that
 *     invariant, not the FK.
 *   - GENERATED STORIES (F-068): /generate is a PAID upstream call →
 *     expensiveLimiter (per-user burst) PLUS the proxy's own per-route
 *     per-minute limiter. The Claude call runs BEFORE the INSERT, so a Claude
 *     failure (mapped by the shared mapClaudeError in middleware/errors.ts:
 *     injection → 400, proxy limiter → 429, upstream failure → 502) writes
 *     NO story row (no half-state).
 *     The optional topic is the route's only free text — bounded here and
 *     sanitized + <user_input>-wrapped again inside the proxy. Story reads are
 *     user-scoped (IDOR: a missing or foreign id is a uniform 404).
 *   - TRANSLATION (F-116): /translate is a PAID upstream call →
 *     expensiveLimiter (per-user burst) PLUS the proxy's own per-route
 *     per-minute limiter. The passage is the route's ONLY free text — bounded
 *     here (1..6000, `.strict()` body) and sanitized + <user_input>-wrapped
 *     again inside the proxy. Nothing is persisted (stateless translation — no
 *     table backs this route); a Claude failure maps through the shared
 *     mapClaudeError (injection → 400, proxy limiter → 429, upstream failure →
 *     502) with no server prose leaked to the client. Unlike /generate (F-068,
 *     deliberate variety, cacheTtl 0), translating a GIVEN passage is expected
 *     to be STABLE — the proxy caches (Layer B, 30-day TTL), so re-opening the
 *     same passage's translate sheet is a cache hit, not a repeat paid call.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { mapClaudeError, NotFoundError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';

const router = Router();
router.use(requireAuth);

// Ids bind to BIGINT/int8 in pg. Without an upper bound a 20-digit value passes
// `int().positive()` (Number.isInteger(1e20) is true) and overflows in pg
// (22003 → 500) where the contract is 400/404 for a garbage id. MAX_SAFE_INTEGER
// ≪ int8 max, so bounded values are safe. (Mirrors routes/vocab.ts + uploads.ts.)
const MAX_ID = Number.MAX_SAFE_INTEGER;

// passage_number / page_number bind to INTEGER (int4) columns — bound at the
// column max so an overlarge value 400s at the boundary instead of 22003 → 500
// at the cast.
const MAX_INT4 = 2147483647;

/**
 * Ownership gate shared by the chapter-list and position routes: the upload
 * must exist AND belong to the requester. A miss throws a 404 identical to a
 * non-existent id, so id-space probing reveals nothing about other users'
 * uploads (the query is user-scoped, so it never even confirms a foreign id).
 */
async function assertOwnedUpload(uploadId: number, userId: number): Promise<void> {
  const owned = await query<{ id: string }>(
    `SELECT id FROM book_uploads WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [uploadId, userId],
  );
  if (owned.rows.length === 0) {
    throw new NotFoundError('upload not found');
  }
}

/* ---------- GET /reading/chapters?source_upload_id= ---------- */

const ChapterListQuerySchema = z.object({
  // The literature book (book_uploads.id) whose chapters to list. Required —
  // the reader always browses one book at a time. Coerced + upper-bounded so a
  // garbage id 400s at the boundary rather than reaching the cast in SQL.
  source_upload_id: z.coerce.number().int().positive().max(MAX_ID),
});

router.get(
  '/chapters',
  cheapLimiter(),
  validateQuery(ChapterListQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & {
          validatedQuery: z.infer<typeof ChapterListQuerySchema>;
        }
      ).validatedQuery;

      // Ownership gate (shared helper): 404s a missing OR foreign upload
      // uniformly, without confirming foreign ids.
      await assertOwnedUpload(q.source_upload_id, userId);

      // reading_chapters.user_id is the owner (composite FK), so scoping by it
      // is sufficient isolation; source_upload_id narrows to this one book.
      const { rows } = await query<{
        id: string;
        chapter_number: number;
        title: string | null;
        start_page: number | null;
        end_page: number | null;
      }>(
        `SELECT id, chapter_number, title, start_page, end_page
           FROM reading_chapters
          WHERE user_id = $1
            AND source_upload_id = $2
          ORDER BY chapter_number`,
        [userId, q.source_upload_id],
      );

      // pg returns BIGINT (id) as a string; the DTO documents id as a JSON
      // number (reading_chapters.id fits in Number.MAX_SAFE_INTEGER).
      const chapters = rows.map((r) => ({ ...r, id: Number(r.id) }));
      res.status(200).json({ chapters });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- GET /reading/chapters/:chapterId ---------- */

const ChapterParamsSchema = z.object({
  chapterId: z.coerce.number().int().positive().max(MAX_ID),
});

router.get(
  '/chapters/:chapterId',
  cheapLimiter(),
  validateParams(ChapterParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const chapterId = (
        req as typeof req & {
          validatedParams: z.infer<typeof ChapterParamsSchema>;
        }
      ).validatedParams.chapterId;

      // Fetch the chapter, scoped to the requester. A miss (missing OR another
      // user's) is a uniform 404.
      const chapterRes = await query<{
        id: string;
        source_upload_id: string;
        chapter_number: number;
        title: string | null;
        start_page: number | null;
        end_page: number | null;
      }>(
        `SELECT id, source_upload_id, chapter_number, title, start_page, end_page
           FROM reading_chapters
          WHERE id = $1
            AND user_id = $2
          LIMIT 1`,
        [chapterId, userId],
      );
      if (chapterRes.rows.length === 0) {
        throw new NotFoundError('chapter not found');
      }
      const chapter = chapterRes.rows[0]!;

      // Ordered passages for the chapter. The chapter's ownership was just
      // confirmed, and passages CASCADE from it, so scoping the passage read on
      // chapter_id alone is safe (no cross-user reachability).
      const passageRes = await query<{
        id: string;
        passage_number: number;
        body: string;
        page_number: number | null;
      }>(
        `SELECT id, passage_number, body, page_number
           FROM reading_passages
          WHERE chapter_id = $1
          ORDER BY passage_number`,
        [chapterId],
      );

      // pg returns BIGINT ids as strings; the DTO documents them as JSON numbers.
      res.status(200).json({
        chapter: {
          id: Number(chapter.id),
          source_upload_id: Number(chapter.source_upload_id),
          chapter_number: chapter.chapter_number,
          title: chapter.title,
          start_page: chapter.start_page,
          end_page: chapter.end_page,
        },
        passages: passageRes.rows.map((p) => ({ ...p, id: Number(p.id) })),
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- /reading/position/:uploadId (F-069, reading_positions/051) ---------- */

const PositionParamsSchema = z.object({
  uploadId: z.coerce.number().int().positive().max(MAX_ID),
});

/** The wire shape of a saved position (BIGINTs already coerced to numbers). */
interface PositionDto {
  source_upload_id: number;
  chapter_id: number | null;
  passage_number: number | null;
  page_number: number | null;
  updated_at: Date;
}

function toPositionDto(row: {
  source_upload_id: string;
  chapter_id: string | null;
  passage_number: number | null;
  page_number: number | null;
  updated_at: Date;
}): PositionDto {
  return {
    source_upload_id: Number(row.source_upload_id),
    chapter_id: row.chapter_id === null ? null : Number(row.chapter_id),
    passage_number: row.passage_number,
    page_number: row.page_number,
    updated_at: row.updated_at,
  };
}

const POSITION_COLUMNS =
  'source_upload_id, chapter_id, passage_number, page_number, updated_at';

/**
 * GET /reading/position/:uploadId — the user's saved resume spot for one owned
 * book. Returns `{ position: null }` when nothing is saved yet (an owned book
 * with no position is a normal state, not an error); a missing or foreign
 * upload is a uniform 404 via the shared ownership gate.
 */
router.get(
  '/position/:uploadId',
  cheapLimiter(),
  validateParams(PositionParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const uploadId = (
        req as typeof req & {
          validatedParams: z.infer<typeof PositionParamsSchema>;
        }
      ).validatedParams.uploadId;

      await assertOwnedUpload(uploadId, userId);

      // PK (user_id, source_upload_id) — at most one row; user-scoped, so no
      // cross-user read is expressible. The pointer filter normalizes the
      // DEGRADED row (a chapter-only position whose chapter was deleted by a
      // book re-load — the 051 chapter FK SET-NULLs chapter_id, and the DB
      // deliberately carries no "points somewhere" CHECK because it would
      // abort that referential action): a row that no longer points anywhere
      // reads as "no saved position" instead of pushing that judgment onto
      // every client.
      const { rows } = await query<{
        source_upload_id: string;
        chapter_id: string | null;
        passage_number: number | null;
        page_number: number | null;
        updated_at: Date;
      }>(
        `SELECT ${POSITION_COLUMNS}
           FROM reading_positions
          WHERE user_id = $1
            AND source_upload_id = $2
            AND (chapter_id IS NOT NULL OR page_number IS NOT NULL)`,
        [userId, uploadId],
      );

      res.status(200).json({ position: rows[0] ? toPositionDto(rows[0]) : null });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PUT /reading/position/:uploadId — upsert the resume position (full-replace,
 * PUT semantics: omitted fields clear to NULL). This schema is the SOLE
 * enforcement point for the two semantic invariants (deliberately not DB
 * CHECKs — as table CHECKs they would abort the 051 chapter FK's SET NULL
 * when a book re-load deletes a chapter; see the migration's design notes):
 *   - the position must point somewhere (chapter_id and/or page_number);
 *   - passage_number is only meaningful within a chapter.
 * `.strict()` rejects unknown keys, so a client typo (`chapterId`) fails loud
 * instead of silently clearing the field it meant to set.
 */
const PositionBodySchema = z
  .object({
    chapter_id: z.number().int().positive().max(MAX_ID).nullable().optional(),
    passage_number: z.number().int().positive().max(MAX_INT4).nullable().optional(),
    page_number: z.number().int().positive().max(MAX_INT4).nullable().optional(),
  })
  .strict()
  .refine((b) => (b.chapter_id ?? null) !== null || (b.page_number ?? null) !== null, {
    message: 'a position must reference a chapter_id and/or a page_number',
  })
  .refine((b) => (b.passage_number ?? null) === null || (b.chapter_id ?? null) !== null, {
    message: 'passage_number requires chapter_id',
  });

router.put(
  '/position/:uploadId',
  cheapLimiter(),
  validateParams(PositionParamsSchema),
  validateBody(PositionBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const uploadId = (
        req as typeof req & {
          validatedParams: z.infer<typeof PositionParamsSchema>;
        }
      ).validatedParams.uploadId;
      const body = req.body as z.infer<typeof PositionBodySchema>;
      const chapterId = body.chapter_id ?? null;
      const passageNumber = body.passage_number ?? null;
      const pageNumber = body.page_number ?? null;

      await assertOwnedUpload(uploadId, userId);

      // Chapter gate: when a chapter is named it must be a chapter of THIS
      // book (and, being user-scoped, this never confirms a foreign chapter
      // id — a foreign or wrong-book chapter 404s exactly like a missing
      // one). Migration 051's composite chapter FK re-enforces the same
      // invariant at the DB level, so a TOCTOU race can at worst turn this
      // 404 into a rejected insert — never a cross-book row.
      if (chapterId !== null) {
        const chapter = await query<{ id: string }>(
          `SELECT id FROM reading_chapters
            WHERE id = $1
              AND source_upload_id = $2
              AND user_id = $3
            LIMIT 1`,
          [chapterId, uploadId, userId],
        );
        if (chapter.rows.length === 0) {
          throw new NotFoundError('chapter not found');
        }
      }

      // One-row-per-(user, book) upsert on the PK. All values are bound
      // parameters; user_id comes from the session, never the client, and the
      // 051 owner-guard FK makes a cross-user write structurally impossible
      // even if this handler were wrong. updated_at is refreshed by the row
      // trigger on the UPDATE arm (and defaults to now() on first insert).
      // version increments on the UPDATE arm per the ADR-001 §D6 convention —
      // the app, not a trigger, owns the optimistic-concurrency counter
      // (mirrors notifications.ts's schedule upsert).
      const { rows } = await query<{
        source_upload_id: string;
        chapter_id: string | null;
        passage_number: number | null;
        page_number: number | null;
        updated_at: Date;
      }>(
        `INSERT INTO reading_positions
           (user_id, source_upload_id, chapter_id, passage_number, page_number)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, source_upload_id) DO UPDATE
            SET chapter_id     = EXCLUDED.chapter_id,
                passage_number = EXCLUDED.passage_number,
                page_number    = EXCLUDED.page_number,
                version        = reading_positions.version + 1
         RETURNING ${POSITION_COLUMNS}`,
        [userId, uploadId, chapterId, passageNumber, pageNumber],
      );

      res.status(200).json({ position: toPositionDto(rows[0]!) });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- Generated stories (F-068; generated_stories, migration 054) ---------- */

/** Story target bands (mirrors the proxy's StoryLevelSchema): 'basic' is a
 *  legacy corpus content tag, never a generation target. */
const StoryLevelBodySchema = z.enum(['L1', 'L2', 'L3', 'L4', 'L5+']);

/**
 * POST /reading/generate body. `.strict()` rejects unknown keys (probing
 * `model` or a typo'd key fails loud). level defaults to L3 (the app's
 * intermediate center of gravity); topic is the route's ONLY free text —
 * bounded 1..500 here (under the proxy's generate_story input cap) and
 * sanitized + wrapped as untrusted data again inside the proxy.
 */
const GenerateStoryBodySchema = z
  .object({
    level: StoryLevelBodySchema.default('L3'),
    topic: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** Wire shape of one generated story (BIGINT id coerced to a JSON number). */
interface GeneratedStoryDto {
  id: number;
  title: string;
  bodyKo: string;
  level: string;
  prompt: string | null;
  createdAt: Date;
}

interface GeneratedStoryRow {
  id: string; // BIGINT arrives as string from pg
  title: string;
  body_ko: string;
  level: string;
  prompt: string | null;
  created_at: Date;
}

function toStoryDto(row: GeneratedStoryRow): GeneratedStoryDto {
  return {
    id: Number(row.id),
    title: row.title,
    bodyKo: row.body_ko,
    level: row.level,
    prompt: row.prompt,
    createdAt: row.created_at,
  };
}

const STORY_COLUMNS =
  'id::text AS id, title, body_ko, level::text AS level, prompt, created_at';

/**
 * POST /reading/generate — Claude authors a short Korean story, the route
 * PERSISTS it to generated_stories, and returns it (201).
 *
 * Ordering is deliberate: the Claude call runs BEFORE the INSERT, so a Claude
 * failure (→ 502) writes no row — no half-state, mirroring grammarDrill.ts.
 * Unlike gradeWriting's best-effort persist, a persist failure here IS a route
 * failure (500): the story's whole purpose is to live in the library, so
 * returning a story that silently never persisted would be a lie the user
 * discovers on their next visit. The stored `level` is the SERVER-chosen
 * request value (never a model echo); `prompt` stores the user's topic.
 * Cache/usage rows are written by the proxy under route 'generate_story'
 * (migration 053; cacheTtl 0 — variety on regenerate).
 */
router.post(
  '/generate',
  expensiveLimiter(),
  validateBody(GenerateStoryBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof GenerateStoryBodySchema>;

      // 1. Generate via Claude BEFORE any INSERT — a failure writes no row.
      //    The proxy Zod-validates the model output (StoryResultSchema), so a
      //    malformed model reply is a 502, never a malformed row.
      const proxy = getClaudeProxy();
      const { result: story } = await proxy.generateStory(
        {
          level: body.level,
          ...(body.topic !== undefined ? { topic: body.topic } : {}),
        },
        { ...(req.correlationId !== undefined ? { requestId: req.correlationId } : {}), userId },
      );

      // 2. Persist. user_id comes from the session (never the client); level
      //    is the server-chosen request value; all values are bound parameters.
      //    StoryResultSchema's caps (title 200 / body 6000) sit UNDER the DB
      //    CHECK ceilings (300 / 20000), so a schema-valid story always fits.
      const { rows } = await query<GeneratedStoryRow>(
        `INSERT INTO generated_stories (user_id, title, body_ko, level, prompt)
         VALUES ($1, $2, $3, $4::proficiency_level, $5)
         RETURNING ${STORY_COLUMNS}`,
        [userId, story.title, story.bodyKo, body.level, body.topic ?? null],
      );

      res.status(201).json({ story: toStoryDto(rows[0]!) });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/**
 * GET /reading/generated — the user's generated-story library, newest first.
 * List items carry metadata only (no body_ko — a story body can be multi-KB
 * and the library screen never renders it); GET /generated/:id serves the
 * full story. Served by ix_generated_stories_user_created
 * (user_id, created_at DESC); LIMIT 200 bounds the payload (single-user app —
 * far beyond any realistic library size, and a paging param can come later
 * without breaking the shape).
 */
router.get('/generated', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<Omit<GeneratedStoryRow, 'body_ko'>>(
      `SELECT id::text AS id, title, level::text AS level, prompt, created_at
         FROM generated_stories
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 200`,
      [userId],
    );
    res.status(200).json({
      stories: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        level: r.level,
        prompt: r.prompt,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const StoryParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
});

/**
 * GET /reading/generated/:id — one generated story, full body. User-scoped in
 * a single query: a missing id and another user's id are the same uniform 404
 * (IDOR — never confirm a foreign id).
 */
router.get(
  '/generated/:id',
  cheapLimiter(),
  validateParams(StoryParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (
        req as typeof req & { validatedParams: z.infer<typeof StoryParamsSchema> }
      ).validatedParams;
      const { rows } = await query<GeneratedStoryRow>(
        `SELECT ${STORY_COLUMNS}
           FROM generated_stories
          WHERE id = $1 AND user_id = $2
          LIMIT 1`,
        [id, userId],
      );
      if (rows.length === 0) {
        throw new NotFoundError('story not found');
      }
      res.status(200).json({ story: toStoryDto(rows[0]!) });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- POST /reading/translate (F-116) ---------- */

/**
 * POST /reading/translate body. `.strict()` rejects unknown keys (probing
 * `model` or a typo'd key fails loud). `passage` is the route's ONLY free
 * text — bounded 1..6000 here (under the proxy's translate_passage input cap
 * of 8000; see services/claude/config.ts) and sanitized + <user_input>-wrapped
 * again inside the proxy. 6000 sits comfortably under both source columns'
 * DB ceiling (reading_passages.body / generated_stories.body_ko, both capped
 * at 20000 chars, migrations 044/054) — a real curated passage/paragraph is
 * far smaller than either ceiling.
 */
const TranslatePassageBodySchema = z
  .object({
    passage: z.string().trim().min(1).max(6000),
  })
  .strict();

/**
 * POST /reading/translate — Claude authors a natural-English translation of
 * the given passage (F-116, replacing the F-070 honest "coming soon"
 * `TranslateSheet` stub). STATELESS: no table backs this route — the
 * translation is returned inline and never persisted server-side, so there is
 * no half-state to worry about on a downstream failure (unlike /generate,
 * which persists a story). A Claude failure is mapped by the shared
 * mapClaudeError (injection → 400, proxy limiter → 429, upstream failure →
 * 502) with no server prose leaked.
 */
router.post(
  '/translate',
  expensiveLimiter(),
  validateBody(TranslatePassageBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof TranslatePassageBodySchema>;

      const proxy = getClaudeProxy();
      const { result } = await proxy.translatePassage(
        { passage: body.passage },
        { ...(req.correlationId !== undefined ? { requestId: req.correlationId } : {}), userId },
      );

      res.status(200).json({ translation: result.translation });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

export default router;
