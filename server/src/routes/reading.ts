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
 *                                              readable literature book — owned
 *                                              or shared (F-207 phase 3a) — the
 *                                              reader's chapter selector
 *   GET /reading/chapters/:chapterId         → one readable (owned or shared)
 *                                              chapter + its ordered passages
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
 *   POST /reading/generated/:id/audio        → request TTS narration of an
 *                                              owned story (F-210): idempotent
 *                                              voice-once enqueue of a
 *                                              story_audio_jobs row (081) the
 *                                              in-server runner processes
 *                                              async (services/storyAudio.ts);
 *                                              202 while working, 200 when
 *                                              already voiced
 *   GET /reading/generated/:id/audio         → the story's audio status; when
 *                                              done, the streamUrl (the
 *                                              existing /audio/tracks/:id/
 *                                              stream route) + the read-along
 *                                              segments (F-210)
 *   POST /reading/translate                  → Claude authors a natural-
 *                                              English translation of a
 *                                              selected Korean passage or
 *                                              story paragraph (F-116).
 *                                              STATELESS — nothing persisted
 *                                              server-side by this route.
 *   POST /reading/attempts                   → log a completed reading action
 *                                              (F-172; reading_attempts, 060)
 *                                              — a finished chapter (optional
 *                                              passage reached) or a finished
 *                                              generated story. A NEW
 *                                              completion trigger point (no
 *                                              existing transaction to
 *                                              piggyback on, unlike
 *                                              grammar-drill's submit).
 *   GET /reading/attempts                    → the caller's own reading-
 *                                              completion history, paged,
 *                                              newest first (F-172).
 *
 * SECURITY:
 *   - IDOR: reading_chapters.user_id is the book owner (pinned to it by the
 *     migration-044 composite FK, so it can never drift). The two chapter
 *     READ endpoints widen to owned-OR-shared (F-207 phase 3a, mirroring
 *     routes/audio.ts's phase-1 track reads): a chapter is readable when its
 *     PARENT book is the caller's own OR carries the operator-set
 *     book_uploads.is_shared flag. The chapter-list endpoint first 404s an
 *     upload the caller can't READ (not owned and not shared, or not a real
 *     upload) — identical to a missing id, not 403, so probing id-space
 *     reveals nothing — so the client can tell "not your book" from "your
 *     book, no chapters yet" (a readable upload with zero chapters still
 *     200s with an empty list). The chapter-detail endpoint folds "missing"
 *     and "not readable" into that same uniform 404 in a single query that
 *     joins the parent book for the is_shared arm. Passages are only ever
 *     reached THROUGH an access-checked chapter (they CASCADE from it), so
 *     their read stays scoped by chapter_id. Neither route ever leaks
 *     another user's ids or identity (no user_id/email in any DTO). The
 *     position routes remain STRICTLY owner-scoped — deliberately NOT
 *     widened in phase 3a: migration 051's composite owner-guard FK
 *     ((source_upload_id, user_id) → book_uploads(id, user_id)) makes a
 *     non-owner position row structurally impossible at the DB level, so
 *     widening resume (and, with it, attempts — the same per-user-state
 *     story) needs a migration first; tracked in FOLLOW_UPS.md. That FK also
 *     DOUBLY guards the write path: even if the route-level user filter were
 *     bypassed, a cross-user position row cannot exist.
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
 *   - STORY AUDIO (F-210): POST /generated/:id/audio is the COST surface (a
 *     paid per-character TTS call) → expensiveLimiter PLUS a per-user daily
 *     enqueue cap (STORY_TTS_DAILY_CAP → 429 BEFORE any write, checked under
 *     a per-user advisory xact lock so concurrent requests can't race past
 *     it — audio.ts's exact pattern) PLUS voice-once idempotency (an already
 *     voiced story or a live job short-circuits with NO new job; migration
 *     081's partial-unique live-job index and one-set-per-story index make
 *     both structural). IDOR: the story is ownership-checked first (uniform
 *     404); every synthesized artifact lands user-owned in the audio tables,
 *     whose 081 composite FKs pin ownership structurally. Audio BYTES are
 *     never served here — the DTO points at the existing hardened
 *     /audio/tracks/:id/stream route (Range, nosniff, IDOR-404). The
 *     job `error` shown to the client is always server-authored whitelisted
 *     copy (services/tts.ts), never TTS-provider response text.
 *   - READING ATTEMPTS (F-172): POST /attempts is a plain, cheap DB write (no
 *     Claude call) — cheapLimiter, not expensiveLimiter. IDOR: the named
 *     chapter/story is looked up SCOPED to the caller in the same query that
 *     resolves `titleSnapshot` (`WHERE id = $1 AND user_id = $2`) — a missing
 *     or foreign id 404s uniformly before any INSERT runs, so a probe can
 *     never confirm another user's chapter/story exists. `titleSnapshot` is
 *     always SERVER-derived from that scoped row, never client-supplied free
 *     text — the client cannot inject arbitrary "history" copy into its own
 *     reading log. GET /attempts is user-scoped to `getUserId(req)` — no
 *     client-supplied id can ever select another user's rows.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { loadConfig } from '../config/index.js';
import { mapClaudeError, NotFoundError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import { StoryTtsDailyCapError } from '../services/storyAudio.js';
import type { StoryTurn } from '../services/claude/index.js';

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
 * Ownership gate for the position routes (and any future per-user write
 * surface): the upload must exist AND belong to the requester. A miss throws
 * a 404 identical to a non-existent id, so id-space probing reveals nothing
 * about other users' uploads (the query is user-scoped, so it never even
 * confirms a foreign id). Positions stay on this STRICT gate in F-207 phase
 * 3a — see the header's SECURITY note (migration 051's composite owner-guard
 * FK forbids a non-owner position row at the DB level; widening is a
 * follow-up that needs a migration).
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

/**
 * READ-access gate for the chapter routes (F-207 phase 3a, mirroring
 * routes/audio.ts's owned-OR-shared probes): the upload must exist AND be
 * either the requester's own or in the operator-curated shared corpus
 * (book_uploads.is_shared). A miss — missing id OR another user's PRIVATE
 * book — throws the SAME uniform 404 as assertOwnedUpload, so the widening
 * never becomes an existence oracle for private rows. READ paths only; every
 * mutation and per-user-state route keeps the strict owner gate above.
 */
async function assertReadableUpload(uploadId: number, userId: number): Promise<void> {
  const readable = await query<{ id: string }>(
    `SELECT id FROM book_uploads
      WHERE id = $1 AND (user_id = $2 OR is_shared = true)
      LIMIT 1`,
    [uploadId, userId],
  );
  if (readable.rows.length === 0) {
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

      // READ-access gate (F-207 phase 3a): 404s a missing OR foreign-private
      // upload uniformly, without confirming foreign ids; a shared book is
      // readable by every account.
      await assertReadableUpload(q.source_upload_id, userId);

      // Access to the PARENT book was just confirmed (owned or shared), and
      // chapters CASCADE from it with their user_id pinned to the book's
      // owner by the 044 composite FK — so for a shared book the chapters'
      // user_id is the OWNER's, not the caller's, and the correct scope here
      // is the book itself (source_upload_id), not the session user. No
      // cross-user reachability: a chapter of any OTHER book is excluded by
      // this predicate, and this book's readability was already asserted.
      const { rows } = await query<{
        id: string;
        chapter_number: number;
        title: string | null;
        start_page: number | null;
        end_page: number | null;
      }>(
        `SELECT id, chapter_number, title, start_page, end_page
           FROM reading_chapters
          WHERE source_upload_id = $1
          ORDER BY chapter_number`,
        [q.source_upload_id],
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

      // Fetch the chapter, readable when its PARENT book is owned by the
      // caller OR shared (F-207 phase 3a — is_shared lives on book_uploads,
      // so the shared arm joins the parent; the owner arm still rides the
      // denormalized reading_chapters.user_id, which the 044 composite FK
      // pins to the book's true owner, so the two arms can never disagree
      // about whose book this is). A miss (missing OR another user's PRIVATE
      // chapter) is a uniform 404 — the widening never confirms a private
      // row's existence.
      const chapterRes = await query<{
        id: string;
        source_upload_id: string;
        chapter_number: number;
        title: string | null;
        start_page: number | null;
        end_page: number | null;
      }>(
        `SELECT rc.id, rc.source_upload_id, rc.chapter_number, rc.title,
                rc.start_page, rc.end_page
           FROM reading_chapters rc
           JOIN book_uploads bu ON bu.id = rc.source_upload_id
          WHERE rc.id = $1
            AND (rc.user_id = $2 OR bu.is_shared = true)
          LIMIT 1`,
        [chapterId, userId],
      );
      if (chapterRes.rows.length === 0) {
        throw new NotFoundError('chapter not found');
      }
      const chapter = chapterRes.rows[0]!;

      // Ordered passages for the chapter. The chapter's readability (owned or
      // shared-parent) was just confirmed, and passages CASCADE from it, so
      // scoping the passage read on chapter_id alone is safe (no cross-user
      // reachability — same reasoning as audio.ts's transcript segments).
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

/** Wire shape of one generated story (BIGINT id coerced to a JSON number).
 *  `turns` (F-210 groundwork) is the optional multi-voice split — null for
 *  pre-081 stories and turn-less generations; bodyKo stays the reader's
 *  source of truth either way. */
interface GeneratedStoryDto {
  id: number;
  title: string;
  bodyKo: string;
  level: string;
  prompt: string | null;
  turns: StoryTurn[] | null;
  createdAt: Date;
}

interface GeneratedStoryRow {
  id: string; // BIGINT arrives as string from pg
  title: string;
  body_ko: string;
  level: string;
  prompt: string | null;
  // JSONB arrives pre-parsed from pg. Written ONLY from the Zod-validated
  // StoryResultSchema.turns (the route below), so the stored shape is the
  // StoryTurn array by construction; 081's CHECK additionally pins array-ness.
  turns: StoryTurn[] | null;
  created_at: Date;
}

function toStoryDto(row: GeneratedStoryRow): GeneratedStoryDto {
  return {
    id: Number(row.id),
    title: row.title,
    bodyKo: row.body_ko,
    level: row.level,
    prompt: row.prompt,
    turns: row.turns,
    createdAt: row.created_at,
  };
}

const STORY_COLUMNS =
  'id::text AS id, title, body_ko, level::text AS level, prompt, turns, created_at';

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
      //    turns (F-210 groundwork) is stored verbatim when the model emitted
      //    it, NULL otherwise — JSON.stringify + ::jsonb because node-postgres
      //    would otherwise serialize a JS array as a Postgres ARRAY literal.
      const { rows } = await query<GeneratedStoryRow>(
        `INSERT INTO generated_stories (user_id, title, body_ko, level, prompt, turns)
         VALUES ($1, $2, $3, $4::proficiency_level, $5, $6::jsonb)
         RETURNING ${STORY_COLUMNS}`,
        [
          userId,
          story.title,
          story.bodyKo,
          body.level,
          body.topic ?? null,
          story.turns !== undefined ? JSON.stringify(story.turns) : null,
        ],
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
    // Metadata only — neither the multi-KB body nor the turns array rides
    // the list (GET /generated/:id serves both).
    const { rows } = await query<Omit<GeneratedStoryRow, 'body_ko' | 'turns'>>(
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

/* ---------- Story audio (F-210; story_audio_jobs + audio_* tables, 081) ---------- */

/** One read-along segment as served (same shape as routes/audio.ts's
 *  SegmentDTO — the client binary-searches [startMs, endMs] against the
 *  <audio> currentTime for the highlight). */
interface StoryAudioSegmentDto {
  segmentNumber: number;
  startMs: number;
  endMs: number;
  body: string;
}

/**
 * The story-audio status envelope both audio routes return.
 *   status: 'none'    — never requested (client shows "Generate audio")
 *           'pending' — enqueued, awaiting the runner
 *           'running' — synthesis in flight
 *           'failed'  — last attempt failed (error carries the reason; a new
 *                       POST re-enqueues)
 *           'done'    — voiced: track + segments are populated
 *   track.streamUrl is the EXISTING hardened audio byte route
 *   (/audio/tracks/:id/stream — Range, nosniff, IDOR-404); the client hands
 *   it to an <audio> element (same-origin, session cookie rides along).
 */
interface StoryAudioDto {
  status: 'none' | 'pending' | 'running' | 'failed' | 'done';
  jobId: number | null;
  error: string | null;
  track: { id: number; streamUrl: string; durationMs: number | null } | null;
  segments: StoryAudioSegmentDto[];
}

/**
 * Resolve a story's current audio state. The voiced set — not the job row —
 * is the authority for 'done' (voice-once: the set is the cache); job rows
 * supply the in-flight/failed states. Caller has ALREADY ownership-checked
 * the story (uniform 404), so the story-scoped reads here cannot leak: the
 * 081 composite FKs pin every set/job row to the story's owner.
 */
async function buildStoryAudioDto(storyId: number, userId: number): Promise<StoryAudioDto> {
  const trackRes = await query<{ track_id: string; duration_ms: number | null }>(
    `SELECT t.id AS track_id, t.duration_ms
       FROM audio_sources s
       JOIN audio_tracks t ON t.source_id = s.id AND t.track_number = 1
      WHERE s.generated_story_id = $1 AND s.user_id = $2
      LIMIT 1`,
    [storyId, userId],
  );
  const track = trackRes.rows[0];
  if (track !== undefined) {
    const trackId = Number(track.track_id);
    const segRes = await query<{
      segment_number: number;
      start_ms: number;
      end_ms: number;
      body: string;
    }>(
      `SELECT segment_number, start_ms, end_ms, body
         FROM audio_transcript_segments
        WHERE track_id = $1
        ORDER BY segment_number`,
      [trackId],
    );
    const jobRes = await query<{ id: string }>(
      `SELECT id FROM story_audio_jobs
        WHERE generated_story_id = $1 AND status = 'done'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [storyId],
    );
    return {
      status: 'done',
      jobId: jobRes.rows[0] !== undefined ? Number(jobRes.rows[0].id) : null,
      error: null,
      track: {
        id: trackId,
        streamUrl: `/audio/tracks/${trackId}/stream`,
        durationMs: track.duration_ms,
      },
      segments: segRes.rows.map((s) => ({
        segmentNumber: s.segment_number,
        startMs: s.start_ms,
        endMs: s.end_ms,
        body: s.body,
      })),
    };
  }

  const jobRes = await query<{ id: string; status: string; error: string | null }>(
    `SELECT id, status, error
       FROM story_audio_jobs
      WHERE generated_story_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [storyId],
  );
  const job = jobRes.rows[0];
  if (job === undefined) {
    return { status: 'none', jobId: null, error: null, track: null, segments: [] };
  }
  if (job.status === 'pending' || job.status === 'running') {
    return { status: job.status, jobId: Number(job.id), error: null, track: null, segments: [] };
  }
  if (job.status === 'failed') {
    // `error` is server-authored whitelisted copy (services/tts.ts /
    // storyAudio.ts) — safe to show verbatim.
    return { status: 'failed', jobId: Number(job.id), error: job.error, track: null, segments: [] };
  }
  // 'done' job whose voiced set is gone (out-of-band deletion / partial
  // restore): report 'none' so the client can simply re-generate.
  return { status: 'none', jobId: null, error: null, track: null, segments: [] };
}

/**
 * POST /reading/generated/:id/audio — request TTS narration of an owned story
 * (F-210 v1: single narrator voice over body_ko).
 *
 * IDEMPOTENT, VOICE-ONCE, COST-BOUNDED:
 *   already voiced        → 200 { audio: done-envelope } (no new job — the
 *                           voiced set is a permanent cache)
 *   live pending/running  → 202 { audio: that job's envelope } (no dup)
 *   else, under the cap   → enqueue 'pending' → 202 (the in-server runner
 *                           picks it up; the client polls the GET sibling)
 *   over STORY_TTS_DAILY_CAP → 429 rate_limited BEFORE any write
 *
 * The check-then-insert runs inside ONE transaction under a per-user
 * advisory xact lock (audio.ts's exact cap pattern), so two concurrent
 * requests serialize: they cannot both pass the cap, and they cannot both
 * enqueue (belt: the lock; braces: 081's partial-unique live-job index).
 * A `failed` job does NOT block a retry — the failure already spent today's
 * quota (its row still counts toward the cap), but the slot is free.
 */
router.post(
  '/generated/:id/audio',
  expensiveLimiter(),
  validateParams(StoryParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (
        req as typeof req & { validatedParams: z.infer<typeof StoryParamsSchema> }
      ).validatedParams;
      const cfg = loadConfig();

      // IDOR gate first: a missing id and another user's story are the same
      // uniform 404 (mirrors GET /generated/:id). body_ko rides along for the
      // char_count cost snapshot.
      const storyRes = await query<{ body_ko: string }>(
        `SELECT body_ko FROM generated_stories WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, userId],
      );
      const story = storyRes.rows[0];
      if (story === undefined) {
        throw new NotFoundError('story not found');
      }

      const outcome = await withTransaction(async (client) => {
        // Per-user advisory xact lock: two concurrent enqueues by one user
        // would otherwise both read pre-spend cap totals under READ COMMITTED
        // (audio.ts / uploadExtract.ts's exact reasoning). Released at
        // commit/rollback. Cross-user requests never contend (per-user key),
        // and cross-user same-story is impossible (stories are user-owned).
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('story_tts_daily_cap:' || $1::text, 0))`,
          [userId],
        );

        // 1. Voice-once cache hit: the story already has its audio set.
        const voiced = await client.query(
          `SELECT 1 FROM audio_sources WHERE generated_story_id = $1 LIMIT 1`,
          [id],
        );
        if (voiced.rows.length > 0) return 'done' as const;

        // 2. A live job already exists — return it rather than duplicating
        //    (081's partial UNIQUE would reject the INSERT anyway; checking
        //    first keeps the response a clean 202 instead of a mapped 23505).
        const live = await client.query(
          `SELECT 1 FROM story_audio_jobs
            WHERE generated_story_id = $1 AND status IN ('pending', 'running')
            LIMIT 1`,
          [id],
        );
        if (live.rows.length > 0) return 'live' as const;

        // 3. Daily cap — count of today's enqueues, ALL statuses (a failed
        //    run spent quota too; 069/076's cost stance), BEFORE any write.
        const cap = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM story_audio_jobs
            WHERE user_id = $1
              AND created_at >= date_trunc('day', now())`,
          [userId],
        );
        const usedToday = Number(cap.rows[0]?.n ?? '0');
        if (usedToday >= cfg.STORY_TTS_DAILY_CAP) {
          req.log.warn(
            { userId, usedToday, cap: cfg.STORY_TTS_DAILY_CAP },
            'storyAudio: daily cap hit — enqueue refused before any write',
          );
          throw new StoryTtsDailyCapError(cfg.STORY_TTS_DAILY_CAP, usedToday);
        }

        // 4. Enqueue. char_count is the cost snapshot at enqueue (081's
        //    ledger contract); user_id is the session user, and the 081
        //    composite FK would reject any (story, user) mismatch anyway.
        await client.query(
          `INSERT INTO story_audio_jobs (generated_story_id, user_id, status, char_count)
           VALUES ($1, $2, 'pending', $3)`,
          [id, userId, story.body_ko.length],
        );
        return 'enqueued' as const;
      });

      // One envelope for every outcome (the client renders off `status`
      // alone): 200 when the audio already exists, 202 while work is queued
      // or in flight.
      const dto = await buildStoryAudioDto(id, userId);
      res.status(outcome === 'done' ? 200 : 202).json({ audio: dto });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /reading/generated/:id/audio — the story's audio status (the client's
 * polling surface while a job runs; poll every ~2s until status is 'done' or
 * 'failed'). When 'done', the envelope carries the streamUrl + the ordered
 * read-along segments. IDOR: story ownership is asserted first — a missing
 * or foreign story id is a uniform 404.
 */
router.get(
  '/generated/:id/audio',
  cheapLimiter(),
  validateParams(StoryParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (
        req as typeof req & { validatedParams: z.infer<typeof StoryParamsSchema> }
      ).validatedParams;
      const owned = await query<{ id: string }>(
        `SELECT id FROM generated_stories WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, userId],
      );
      if (owned.rows.length === 0) {
        throw new NotFoundError('story not found');
      }
      res.status(200).json({ audio: await buildStoryAudioDto(id, userId) });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- Reading attempts (F-172; reading_attempts, migration 060) ---------- */

/**
 * POST /reading/attempts body: a completed chapter (with an optional
 * `passageNumber` recording how far) or a completed generated story.
 * `.strict()` on each arm rejects unknown keys (a `storyId` alongside
 * `sourceKind: 'chapter'` fails loud rather than silently ignored) and the
 * discriminated union rejects any `sourceKind` outside the two known values
 * before the handler ever runs.
 */
const LogReadingAttemptBodySchema = z.discriminatedUnion('sourceKind', [
  z
    .object({
      sourceKind: z.literal('chapter'),
      chapterId: z.number().int().positive().max(MAX_ID),
      passageNumber: z.number().int().positive().max(MAX_INT4).optional(),
    })
    .strict(),
  z
    .object({
      sourceKind: z.literal('story'),
      storyId: z.number().int().positive().max(MAX_ID),
    })
    .strict(),
]);

/** Wire shape of one logged reading attempt (BIGINT ids coerced to numbers). */
interface ReadingAttemptDto {
  id: number;
  sourceKind: 'chapter' | 'story';
  chapterId: number | null;
  storyId: number | null;
  titleSnapshot: string;
  passageNumber: number | null;
  completedAt: Date;
}

interface ReadingAttemptRow {
  id: string;
  source_kind: 'chapter' | 'story';
  chapter_id: string | null;
  story_id: string | null;
  title_snapshot: string;
  passage_number: number | null;
  completed_at: Date;
}

function toReadingAttemptDto(row: ReadingAttemptRow): ReadingAttemptDto {
  return {
    id: Number(row.id),
    sourceKind: row.source_kind,
    chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
    storyId: row.story_id === null ? null : Number(row.story_id),
    titleSnapshot: row.title_snapshot,
    passageNumber: row.passage_number,
    completedAt: row.completed_at,
  };
}

const ATTEMPT_COLUMNS =
  'id::text AS id, source_kind, chapter_id::text AS chapter_id, ' +
  'story_id::text AS story_id, title_snapshot, passage_number, completed_at';

/**
 * POST /reading/attempts — log a completed reading action (F-172). This is a
 * NEW completion trigger point (unlike grammar-drill's submit, there is no
 * existing transaction to piggyback on): the client fires this once when the
 * user finishes a chapter or a generated story. IDOR: the chapter/story is
 * looked up SCOPED to the caller (`WHERE id = $1 AND user_id = $2`) — a
 * missing or foreign id 404s uniformly, mirroring `assertOwnedUpload`/
 * grammar-drill's submit gate. `titleSnapshot` is resolved from that same
 * scoped row (the chapter's title / "Chapter N" fallback, or the story's
 * title) — SERVER-derived, never client-supplied free text, so this table
 * can never carry arbitrary injected "history" copy (migration 060's own
 * design note). Cheap, synchronous DB work only — no Claude call, so
 * `cheapLimiter`, not `expensiveLimiter`.
 */
router.post(
  '/attempts',
  cheapLimiter(),
  validateBody(LogReadingAttemptBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof LogReadingAttemptBodySchema>;

      let chapterId: number | null = null;
      let storyId: number | null = null;
      let titleSnapshot: string;
      let passageNumber: number | null = null;

      if (body.sourceKind === 'chapter') {
        const chapterRes = await query<{ title: string | null; chapter_number: number }>(
          `SELECT title, chapter_number FROM reading_chapters WHERE id = $1 AND user_id = $2 LIMIT 1`,
          [body.chapterId, userId],
        );
        if (chapterRes.rows.length === 0) {
          throw new NotFoundError('chapter not found');
        }
        const chapter = chapterRes.rows[0]!;
        chapterId = body.chapterId;
        titleSnapshot = chapter.title ?? `Chapter ${String(chapter.chapter_number)}`;
        passageNumber = body.passageNumber ?? null;
      } else {
        const storyRes = await query<{ title: string }>(
          `SELECT title FROM generated_stories WHERE id = $1 AND user_id = $2 LIMIT 1`,
          [body.storyId, userId],
        );
        if (storyRes.rows.length === 0) {
          throw new NotFoundError('story not found');
        }
        storyId = body.storyId;
        titleSnapshot = storyRes.rows[0]!.title;
      }

      const { rows } = await query<ReadingAttemptRow>(
        `INSERT INTO reading_attempts
           (user_id, source_kind, chapter_id, story_id, title_snapshot, passage_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${ATTEMPT_COLUMNS}`,
        [userId, body.sourceKind, chapterId, storyId, titleSnapshot, passageNumber],
      );

      res.status(201).json({ attempt: toReadingAttemptDto(rows[0]!) });
    } catch (err) {
      next(err);
    }
  },
);

// `offset`'s ceiling is a real bound (not a symbolic MAX_SAFE_INTEGER one), same
// posture writing.ts's AttemptsQuerySchema documents: a single user's reading
// history could never legitimately reach six figures.
const MAX_READING_ATTEMPTS_OFFSET = 100_000;

const ReadingAttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(MAX_READING_ATTEMPTS_OFFSET).default(0),
});

/**
 * GET /reading/attempts?limit=1..100(def 20)&offset=0..(def 0) — the caller's
 * own reading-completion history, newest first. User-scoped to
 * `getUserId(req)` (no IDOR); `COUNT(*) OVER ()` rides the total alongside the
 * page in one round trip, mirroring `GET /grammar-drill/attempts` and
 * `GET /writing/attempts`. An empty history is a 200 with `attempts: []`,
 * never an error.
 */
router.get(
  '/attempts',
  cheapLimiter(),
  validateQuery(ReadingAttemptsQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof ReadingAttemptsQuerySchema> }
      ).validatedQuery;
      const { rows } = await query<ReadingAttemptRow & { total: string }>(
        `SELECT ${ATTEMPT_COLUMNS}, COUNT(*) OVER ()::text AS total
           FROM reading_attempts
          WHERE user_id = $1
          ORDER BY completed_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [userId, q.limit, q.offset],
      );
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      const attempts = rows.map(({ total: _total, ...rest }) => toReadingAttemptDto(rest));
      res.status(200).json({ attempts, total, limit: q.limit, offset: q.offset });
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
