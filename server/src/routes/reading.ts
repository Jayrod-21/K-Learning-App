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
 *                                              library, newest first — each
 *                                              row also carries its F-216
 *                                              audioStatus/imageStatus
 *                                              aggregates (the library's
 *                                              per-story asset badges)
 *   GET /reading/generated/audio             → the caller's VOICED story
 *                                              library (F-210 surfaced on the
 *                                              Listen landing): only stories
 *                                              with a completed narration,
 *                                              newest first, each carrying its
 *                                              streamUrl + durationMs
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
 *   POST /reading/generated/:id/images       → request AI illustrations of an
 *                                              owned story (F-211): idempotent
 *                                              generate-once enqueue of a
 *                                              story_image_jobs row (083) the
 *                                              in-server runner processes
 *                                              async (services/storyImage.ts);
 *                                              202 while working, 200 when
 *                                              already illustrated. New
 *                                              stories are ALSO auto-enqueued
 *                                              at creation when the image
 *                                              provider is configured
 *                                              (batch-at-creation); this
 *                                              on-demand POST covers
 *                                              dormant-era/pre-083 stories.
 *   GET /reading/generated/:id/images        → the story's illustration
 *                                              status; when done, the ordered
 *                                              image list (blobUrl + prompt +
 *                                              dimensions) (F-211)
 *   GET /reading/generated/:id/image/:n/blob → one illustration's bytes
 *                                              (IDOR-404, nosniff, cookie
 *                                              auth) (F-211)
 *   POST /reading/generated/:id/experience   → one-tap FULL experience
 *                                              (F-216): attempt the F-210
 *                                              narration enqueue AND the
 *                                              F-211 illustration enqueue
 *                                              together, each half
 *                                              independently — a dormant or
 *                                              capped half reports itself in
 *                                              the payload (enqueueBlocked)
 *                                              instead of failing the other
 *                                              half; 202 while either half
 *                                              works, 200 once both are
 *                                              settled
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
 *   - STORY IMAGES (F-211): POST /generated/:id/images is the COST surface (a
 *     paid per-image provider call per scene) → expensiveLimiter PLUS a
 *     per-user daily enqueue cap (STORY_IMAGE_DAILY_CAP → 429 BEFORE any
 *     write, checked under a per-user advisory xact lock) PLUS generate-once
 *     idempotency (an already-illustrated story or a live job
 *     short-circuits with NO new job; migration 083's partial-unique
 *     live-job index and per-(story,slot) unique make both structural).
 *     The batch-at-creation enqueue inside POST /generate goes through the
 *     SAME gate (capability + cap + lock) and is best-effort: its failure
 *     can never fail story creation. IDOR: the story is ownership-checked
 *     first (uniform 404); the 083 composite FKs pin every image/job row's
 *     ownership structurally. Image BYTES serve via the sibling blob route
 *     below — user-scoped lookup (uniform 404), Content-Type from the
 *     stored extension, nosniff, Cache-Control private (the /images/:id/blob
 *     posture; no Range — these are small static images). The job `error`
 *     shown to the client is always server-authored whitelisted copy
 *     (services/imageGen.ts), never provider response text.
 *   - STORY EXPERIENCE (F-216): POST /generated/:id/experience is BOTH cost
 *     surfaces in one tap → expensiveLimiter, and each half runs the SAME
 *     shared enqueue gate its dedicated POST uses (enqueueStoryAudio /
 *     enqueueStoryImages: capability gate, advisory-locked daily cap,
 *     once-only idempotency) — combining them loosens nothing. The only new
 *     behavior is ERROR SHAPE: a KNOWN refusal (dormant provider / daily
 *     cap) degrades to that half's `enqueueBlocked` flag in the payload
 *     instead of an HTTP error, so one refused half can never block the
 *     other; unexpected errors still fail the route. IDOR: the story is
 *     ownership-checked first (uniform 404) before either gate runs.
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
import { StoryTtsDailyCapError, TtsUnavailableError } from '../services/storyAudio.js';
import { isTtsConfigured } from '../services/tts.js';
import { ImageGenUnavailableError, StoryImageDailyCapError } from '../services/storyImage.js';
import { isImageGenConfigured } from '../services/imageGen.js';
import { readBlob } from '../services/imageStore.js';
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

      const storyId = Number(rows[0]!.id);

      // 3. F-211 batch-at-creation: auto-enqueue the illustration job so a
      //    new story starts illustrating immediately — but ONLY on a
      //    configured deploy (a dormant deploy skips silently; the on-demand
      //    POST /generated/:id/images serves those stories once the key
      //    lands), and STRICTLY best-effort: the story is already committed,
      //    so an enqueue failure (cap hit, race, DB hiccup) logs and moves
      //    on — it must never turn a successful generation into an error.
      if (isImageGenConfigured()) {
        try {
          await enqueueStoryImages(storyId, userId);
        } catch (enqueueErr) {
          req.log.warn(
            { storyId, err: String(enqueueErr) },
            'reading: batch-at-creation illustration enqueue skipped',
          );
        }
      }

      res.status(201).json({ story: toStoryDto(rows[0]!) });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/**
 * One asset's library aggregate (F-216) — the same closed status set the
 * per-story envelopes use (StoryAudioDto.status / StoryImagesDto.status).
 * The list resolves it in SQL with the builders' exact precedence: the done
 * authority (the voiced set / the image rows) wins outright, else the latest
 * job's in-flight/failed state, else 'none'.
 */
type AssetStatus = 'none' | 'pending' | 'running' | 'failed' | 'done';

/**
 * GET /reading/generated — the user's generated-story library, newest first.
 * List items carry metadata only (no body_ko — a story body can be multi-KB
 * and the library screen never renders it); GET /generated/:id serves the
 * full story. Served by ix_generated_stories_user_created
 * (user_id, created_at DESC); LIMIT 200 bounds the payload (single-user app —
 * far beyond any realistic library size, and a paging param can come later
 * without breaking the shape).
 *
 * F-216: each row also carries audioStatus + imageStatus so the library can
 * badge every story WITHOUT a per-story status call (no N+1 — one query).
 * Two LEFT JOIN LATERAL probes resolve, per story, EXACTLY the status the
 * per-story builders would: 'done' when the done authority exists (the
 * voiced audio_sources set with its track-1 row / any story_images rows —
 * so, as in the builders, a 'done' JOB whose artifacts are gone reads
 * 'none', and a done authority beats any newer failed job), else the latest
 * job's pending/running/failed, else 'none'. ttsConfigured/imageGenConfigured
 * ride the envelope once (not per row) so the client can hide a dormant
 * half's badges entirely.
 */
router.get('/generated', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // Metadata only — neither the multi-KB body nor the turns array rides
    // the list (GET /generated/:id serves both).
    const { rows } = await query<
      Omit<GeneratedStoryRow, 'body_ko' | 'turns'> & {
        audio_status: AssetStatus;
        image_status: AssetStatus;
      }
    >(
      `SELECT g.id::text AS id, g.title, g.level::text AS level, g.prompt, g.created_at,
              audio.status AS audio_status,
              images.status AS image_status
         FROM generated_stories g
         LEFT JOIN LATERAL (
           SELECT CASE
                    WHEN EXISTS (
                      SELECT 1
                        FROM audio_sources s
                        JOIN audio_tracks t ON t.source_id = s.id AND t.track_number = 1
                       WHERE s.generated_story_id = g.id AND s.user_id = g.user_id
                    ) THEN 'done'
                    ELSE COALESCE(
                      (SELECT CASE
                                WHEN j.status IN ('pending', 'running', 'failed') THEN j.status
                                ELSE 'none'
                              END
                         FROM story_audio_jobs j
                        WHERE j.generated_story_id = g.id
                        ORDER BY j.created_at DESC, j.id DESC
                        LIMIT 1),
                      'none')
                  END AS status
         ) audio ON true
         LEFT JOIN LATERAL (
           SELECT CASE
                    WHEN EXISTS (
                      SELECT 1 FROM story_images i
                       WHERE i.generated_story_id = g.id AND i.user_id = g.user_id
                    ) THEN 'done'
                    ELSE COALESCE(
                      (SELECT CASE
                                WHEN j.status IN ('pending', 'running', 'failed') THEN j.status
                                ELSE 'none'
                              END
                         FROM story_image_jobs j
                        WHERE j.generated_story_id = g.id
                        ORDER BY j.created_at DESC, j.id DESC
                        LIMIT 1),
                      'none')
                  END AS status
         ) images ON true
        WHERE g.user_id = $1
        ORDER BY g.created_at DESC, g.id DESC
        LIMIT 200`,
      [userId],
    );
    res.status(200).json({
      ttsConfigured: isTtsConfigured(),
      imageGenConfigured: isImageGenConfigured(),
      stories: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        level: r.level,
        prompt: r.prompt,
        createdAt: r.created_at,
        audioStatus: r.audio_status,
        imageStatus: r.image_status,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /reading/generated/audio — the caller's VOICED story library, most
 * recently VOICED first (the Listen tab's "Generated Audio" section): the
 * list is about the audio, so ordering follows the voiced set's created_at
 * (s.created_at), not the story's — voicing an old story surfaces it at the
 * top. One row per owned
 * story that has a completed narration: the voiced set — audio_sources
 * (kind 'generated_story') joined to its single track — is the authority
 * for "voiced", exactly as buildStoryAudioDto below treats it (a 'done'
 * job row whose set was deleted out-of-band is NOT voiced and must not
 * list). `streamUrl` is the existing hardened byte route
 * (/audio/tracks/:id/stream — Range, IDOR-404, cookie auth); nothing new
 * is exposed. IDOR: user-scoped on generated_stories AND the source join
 * is owner-pinned (s.user_id = g.user_id, the 081 composite-FK invariant),
 * so a foreign track id can never ride a caller's row. Single query;
 * LIMIT 200 mirrors GET /generated's bound.
 *
 * REGISTRATION ORDER MATTERS: this literal path must be registered BEFORE
 * GET /generated/:id, whose id param would otherwise capture "audio" and
 * 400 on the numeric coercion.
 */
router.get('/generated/audio', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{
      id: string;
      title: string;
      level: string;
      track_id: string;
      duration_ms: number | null;
    }>(
      `SELECT g.id::text AS id, g.title, g.level::text AS level,
              t.id::text AS track_id, t.duration_ms
         FROM generated_stories g
         JOIN audio_sources s
           ON s.generated_story_id = g.id AND s.user_id = g.user_id
         JOIN audio_tracks t
           ON t.source_id = s.id AND t.track_number = 1
        WHERE g.user_id = $1
        ORDER BY s.created_at DESC, g.id DESC
        LIMIT 200`,
      [userId],
    );
    res.status(200).json({
      stories: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        level: r.level,
        streamUrl: `/audio/tracks/${Number(r.track_id)}/stream`,
        durationMs: r.duration_ms,
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
 *   ttsConfigured tells the client whether this server can synthesize AT ALL
 *   (dormant-deploy posture: no ELEVENLABS_API_KEY → false → the client
 *   hides the feature instead of offering a button that can only 503).
 */
interface StoryAudioDto {
  status: 'none' | 'pending' | 'running' | 'failed' | 'done';
  jobId: number | null;
  error: string | null;
  track: { id: number; streamUrl: string; durationMs: number | null } | null;
  segments: StoryAudioSegmentDto[];
  ttsConfigured: boolean;
}

/**
 * Resolve a story's current audio state. The voiced set — not the job row —
 * is the authority for 'done' (voice-once: the set is the cache); job rows
 * supply the in-flight/failed states. Caller has ALREADY ownership-checked
 * the story (uniform 404), so the story-scoped reads here cannot leak: the
 * 081 composite FKs pin every set/job row to the story's owner.
 */
async function buildStoryAudioDto(storyId: number, userId: number): Promise<StoryAudioDto> {
  // Capability flag, stamped on EVERY envelope shape below: derived from the
  // active provider (services/tts.ts isTtsConfigured — false only for the
  // keyless UnconfiguredTtsProvider), so the client learns "this deploy
  // cannot synthesize" from the same GET it already polls.
  const ttsConfigured = isTtsConfigured();
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
      ttsConfigured,
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
    return { status: 'none', jobId: null, error: null, track: null, segments: [], ttsConfigured };
  }
  if (job.status === 'pending' || job.status === 'running') {
    return {
      status: job.status,
      jobId: Number(job.id),
      error: null,
      track: null,
      segments: [],
      ttsConfigured,
    };
  }
  if (job.status === 'failed') {
    // `error` is server-authored whitelisted copy (services/tts.ts /
    // storyAudio.ts) — safe to show verbatim.
    return {
      status: 'failed',
      jobId: Number(job.id),
      error: job.error,
      track: null,
      segments: [],
      ttsConfigured,
    };
  }
  // 'done' job whose voiced set is gone (out-of-band deletion / partial
  // restore): report 'none' so the client can simply re-generate.
  return { status: 'none', jobId: null, error: null, track: null, segments: [], ttsConfigured };
}

/**
 * The shared narration-enqueue gate (F-210's transaction, factored out for
 * F-216 — enqueueStoryImages' exact shape, provider-swapped back). Used by
 * BOTH triggers — the on-demand POST below (which maps the outcome/errors
 * onto HTTP) and the F-216 combined POST /generated/:id/experience (which
 * degrades a known refusal to that half's `enqueueBlocked` flag). The
 * check-then-insert runs inside ONE transaction under a per-user advisory
 * xact lock so two concurrent requests serialize: they cannot both pass the
 * cap, and they cannot both enqueue (belt: the lock; braces: 081's
 * partial-unique live-job index). Caller has ALREADY ownership-checked the
 * story.
 *
 * @returns 'done' (already voiced — the voiced set is a permanent cache),
 *          'live' (a pending/running job exists), or 'enqueued'.
 * @throws TtsUnavailableError on a keyless deploy (BEFORE the cap check and
 *         any write — a guaranteed-to-fail job must never spend a daily-cap
 *         slot; the keyless provider failing the job stays as
 *         defense-in-depth for a key removed mid-flight).
 * @throws StoryTtsDailyCapError over STORY_TTS_DAILY_CAP (BEFORE any write;
 *         failed jobs count — the failure already spent quota, but a
 *         `failed` job does NOT hold the live slot, so a retry enqueues).
 */
async function enqueueStoryAudio(
  storyId: number,
  userId: number,
): Promise<'done' | 'live' | 'enqueued'> {
  const cfg = loadConfig();
  return withTransaction(async (client) => {
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
      [storyId],
    );
    if (voiced.rows.length > 0) return 'done' as const;

    // 2. A live job already exists — return it rather than duplicating
    //    (081's partial UNIQUE would reject the INSERT anyway; checking
    //    first keeps the response a clean 202 instead of a mapped 23505).
    const live = await client.query(
      `SELECT 1 FROM story_audio_jobs
        WHERE generated_story_id = $1 AND status IN ('pending', 'running')
        LIMIT 1`,
      [storyId],
    );
    if (live.rows.length > 0) return 'live' as const;

    // 3. Capability gate — a keyless deploy (story TTS dormant) refuses
    //    the enqueue HERE, after the read-only short-circuits (existing
    //    audio still serves; an in-flight job still reports) but BEFORE
    //    the cap check and the INSERT: a job that can only fail must
    //    never spend a daily-cap slot. The keyless provider failing the
    //    job stays as defense-in-depth for a key removed mid-flight.
    if (!isTtsConfigured()) {
      throw new TtsUnavailableError();
    }

    // 4. Daily cap — count of today's enqueues, ALL statuses (a failed
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
      throw new StoryTtsDailyCapError(cfg.STORY_TTS_DAILY_CAP, usedToday);
    }

    // 5. Enqueue. char_count is the cost snapshot at enqueue (081's ledger
    //    contract) — body_ko is read here, at the single point that bills
    //    it, and measured with the SAME JS string length the runner uses;
    //    user_id is the session user, and the 081 composite FK would
    //    reject any (story, user) mismatch anyway.
    const story = await client.query<{ body_ko: string }>(
      `SELECT body_ko FROM generated_stories WHERE id = $1 LIMIT 1`,
      [storyId],
    );
    if (story.rows[0] === undefined) {
      // The story vanished between the route's ownership check and this
      // transaction (today only a user-cascade delete can do it — there is
      // no story DELETE route). Same uniform 404 as the route's IDOR gate;
      // both call sites rethrow it untouched.
      throw new NotFoundError('story not found');
    }
    await client.query(
      `INSERT INTO story_audio_jobs (generated_story_id, user_id, status, char_count)
       VALUES ($1, $2, 'pending', $3)`,
      [storyId, userId, story.rows[0]!.body_ko.length],
    );
    return 'enqueued' as const;
  });
}

/**
 * POST /reading/generated/:id/audio — request TTS narration of an owned story
 * (F-210 v1: single narrator voice over body_ko). The gate itself lives in
 * enqueueStoryAudio above (shared with the F-216 experience route); this
 * route maps its outcome/errors onto HTTP.
 *
 * IDEMPOTENT, VOICE-ONCE, COST-BOUNDED:
 *   already voiced        → 200 { audio: done-envelope } (no new job — the
 *                           voiced set is a permanent cache)
 *   live pending/running  → 202 { audio: that job's envelope } (no dup)
 *   TTS not configured    → 503 tts_unavailable BEFORE any write (dormant
 *                           deploy — a guaranteed-to-fail job must never
 *                           burn a daily-cap slot; the voice-once and
 *                           live-job short-circuits above still answer,
 *                           since serving EXISTING audio needs no key)
 *   else, under the cap   → enqueue 'pending' → 202 (the in-server runner
 *                           picks it up; the client polls the GET sibling)
 *   over STORY_TTS_DAILY_CAP → 429 rate_limited BEFORE any write
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

      // IDOR gate first: a missing id and another user's story are the same
      // uniform 404 (mirrors GET /generated/:id).
      const owned = await query<{ id: string }>(
        `SELECT id FROM generated_stories WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, userId],
      );
      if (owned.rows.length === 0) {
        throw new NotFoundError('story not found');
      }

      let outcome: 'done' | 'live' | 'enqueued';
      try {
        outcome = await enqueueStoryAudio(id, userId);
      } catch (err) {
        if (err instanceof StoryTtsDailyCapError) {
          req.log.warn(
            { userId, cap: loadConfig().STORY_TTS_DAILY_CAP },
            'storyAudio: daily cap hit — enqueue refused before any write',
          );
        }
        throw err;
      }

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

/* ---------- Story images (F-211; story_images + story_image_jobs, 083) ---------- */

/** One illustration as served: `blobUrl` is the byte-serve sibling route
 *  below (same-origin — the session cookie rides an <img src> request);
 *  `prompt` is the server-derived scene prompt (safe to display). */
interface StoryImageDto {
  imageNumber: number;
  blobUrl: string;
  prompt: string;
  width: number;
  height: number;
}

/**
 * The story-images status envelope both image routes return.
 *   status: 'none'    — never requested (client shows "Illustrate story")
 *           'pending' — enqueued, awaiting the runner
 *           'running' — generation in flight
 *           'failed'  — last attempt failed (error carries the reason; a new
 *                       POST re-enqueues)
 *           'done'    — illustrated: images[] is populated, in story order
 *   imageGenConfigured tells the client whether this server can generate AT
 *   ALL (dormant-deploy posture: no OPENAI_API_KEY → false → the client
 *   hides the feature instead of offering a button that can only 503).
 */
interface StoryImagesDto {
  status: 'none' | 'pending' | 'running' | 'failed' | 'done';
  jobId: number | null;
  error: string | null;
  images: StoryImageDto[];
  imageGenConfigured: boolean;
}

/**
 * Resolve a story's current illustration state. The story_images rows — not
 * the job row — are the authority for 'done' (generate-once: the rows are
 * the cache; the runner writes them tx-atomically with the settle, so they
 * are all-or-nothing); job rows supply the in-flight/failed states. Caller
 * has ALREADY ownership-checked the story (uniform 404); the 083 composite
 * FKs pin every image/job row to the story's owner. Mirrors
 * buildStoryAudioDto's structure exactly.
 */
async function buildStoryImagesDto(storyId: number, userId: number): Promise<StoryImagesDto> {
  const imageGenConfigured = isImageGenConfigured();
  const imgRes = await query<{
    image_number: number;
    prompt: string;
    width: number;
    height: number;
  }>(
    `SELECT image_number, prompt, width, height
       FROM story_images
      WHERE generated_story_id = $1 AND user_id = $2
      ORDER BY image_number`,
    [storyId, userId],
  );
  if (imgRes.rows.length > 0) {
    const jobRes = await query<{ id: string }>(
      `SELECT id FROM story_image_jobs
        WHERE generated_story_id = $1 AND user_id = $2 AND status = 'done'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [storyId, userId],
    );
    return {
      status: 'done',
      jobId: jobRes.rows[0] !== undefined ? Number(jobRes.rows[0].id) : null,
      error: null,
      images: imgRes.rows.map((r) => ({
        imageNumber: r.image_number,
        blobUrl: `/reading/generated/${storyId}/image/${r.image_number}/blob`,
        prompt: r.prompt,
        width: r.width,
        height: r.height,
      })),
      imageGenConfigured,
    };
  }

  const jobRes = await query<{ id: string; status: string; error: string | null }>(
    `SELECT id, status, error
       FROM story_image_jobs
      WHERE generated_story_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [storyId],
  );
  const job = jobRes.rows[0];
  if (job === undefined) {
    return { status: 'none', jobId: null, error: null, images: [], imageGenConfigured };
  }
  if (job.status === 'pending' || job.status === 'running') {
    return {
      status: job.status,
      jobId: Number(job.id),
      error: null,
      images: [],
      imageGenConfigured,
    };
  }
  if (job.status === 'failed') {
    // `error` is server-authored whitelisted copy (services/imageGen.ts /
    // storyImage.ts) — safe to show verbatim.
    return {
      status: 'failed',
      jobId: Number(job.id),
      error: job.error,
      images: [],
      imageGenConfigured,
    };
  }
  // 'done' job whose rows are gone (out-of-band deletion / partial restore):
  // report 'none' so the client can simply re-generate.
  return { status: 'none', jobId: null, error: null, images: [], imageGenConfigured };
}

/**
 * The shared illustration-enqueue gate (the F-210 audio-enqueue transaction,
 * provider-swapped). Used by BOTH triggers — the on-demand POST below (which
 * maps the outcome/errors onto HTTP) and the batch-at-creation call inside
 * POST /generate (which swallows errors — best-effort). The check-then-insert
 * runs inside ONE transaction under a per-user advisory xact lock so two
 * concurrent requests serialize: they cannot both pass the cap, and they
 * cannot both enqueue (belt: the lock; braces: 083's partial-unique live-job
 * index). Caller has ALREADY ownership-checked the story.
 *
 * @returns 'done' (already illustrated — the rows are a permanent cache),
 *          'live' (a pending/running job exists), or 'enqueued'.
 * @throws ImageGenUnavailableError on a keyless deploy (BEFORE the cap check
 *         and any write — a guaranteed-to-fail job must never spend a
 *         daily-cap slot; the keyless provider failing the job stays as
 *         defense-in-depth for a key removed mid-flight).
 * @throws StoryImageDailyCapError over STORY_IMAGE_DAILY_CAP (BEFORE any
 *         write; failed jobs count — the failure already spent quota, but a
 *         `failed` job does NOT hold the live slot, so a retry enqueues).
 */
async function enqueueStoryImages(
  storyId: number,
  userId: number,
): Promise<'done' | 'live' | 'enqueued'> {
  const cfg = loadConfig();
  return withTransaction(async (client) => {
    // Per-user advisory xact lock: two concurrent enqueues by one user would
    // otherwise both read pre-spend cap totals under READ COMMITTED
    // (audio.ts / the F-210 enqueue's exact reasoning). Released at
    // commit/rollback.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('story_image_daily_cap:' || $1::text, 0))`,
      [userId],
    );

    // 1. Generate-once cache hit: the story already has its images.
    const illustrated = await client.query(
      `SELECT 1 FROM story_images WHERE generated_story_id = $1 LIMIT 1`,
      [storyId],
    );
    if (illustrated.rows.length > 0) return 'done' as const;

    // 2. A live job already exists — return it rather than duplicating
    //    (083's partial UNIQUE would reject the INSERT anyway; checking
    //    first keeps the response a clean 202 instead of a mapped 23505).
    const live = await client.query(
      `SELECT 1 FROM story_image_jobs
        WHERE generated_story_id = $1 AND status IN ('pending', 'running')
        LIMIT 1`,
      [storyId],
    );
    if (live.rows.length > 0) return 'live' as const;

    // 3. Capability gate — a keyless deploy refuses HERE, after the
    //    read-only short-circuits (existing images still serve; an in-flight
    //    job still reports) but BEFORE the cap check and the INSERT.
    if (!isImageGenConfigured()) {
      throw new ImageGenUnavailableError();
    }

    // 4. Daily cap — count of today's enqueues, ALL statuses (a failed run
    //    spent quota too; 069/076/081's cost stance), BEFORE any write.
    const cap = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM story_image_jobs
        WHERE user_id = $1
          AND created_at >= date_trunc('day', now())`,
      [userId],
    );
    const usedToday = Number(cap.rows[0]?.n ?? '0');
    if (usedToday >= cfg.STORY_IMAGE_DAILY_CAP) {
      throw new StoryImageDailyCapError(cfg.STORY_IMAGE_DAILY_CAP, usedToday);
    }

    // 5. Enqueue. image_count is the cost snapshot at enqueue (083's ledger
    //    contract — the scene count this job will request); user_id is the
    //    session user, and the 083 composite FK would reject any
    //    (story, user) mismatch anyway.
    await client.query(
      `INSERT INTO story_image_jobs (generated_story_id, user_id, status, image_count)
       VALUES ($1, $2, 'pending', $3)`,
      [storyId, userId, cfg.STORY_IMAGE_SCENE_COUNT],
    );
    return 'enqueued' as const;
  });
}

/**
 * POST /reading/generated/:id/images — request AI illustrations of an owned
 * story (F-211): the ON-DEMAND trigger, covering stories that predate the
 * feature or were created on a dormant deploy (new stories on a configured
 * deploy are batch-enqueued at creation by POST /generate).
 *
 * IDEMPOTENT, GENERATE-ONCE, COST-BOUNDED (the F-210 audio POST's exact
 * contract):
 *   already illustrated       → 200 { images: done-envelope } (no new job)
 *   live pending/running      → 202 { images: that job's envelope } (no dup)
 *   provider not configured   → 503 image_gen_unavailable BEFORE any write
 *   else, under the cap       → enqueue 'pending' → 202 (the in-server
 *                               runner picks it up; the client polls the
 *                               GET sibling)
 *   over STORY_IMAGE_DAILY_CAP → 429 rate_limited BEFORE any write
 */
router.post(
  '/generated/:id/images',
  expensiveLimiter(),
  validateParams(StoryParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (
        req as typeof req & { validatedParams: z.infer<typeof StoryParamsSchema> }
      ).validatedParams;

      // IDOR gate first: a missing id and another user's story are the same
      // uniform 404 (mirrors GET /generated/:id).
      const owned = await query<{ id: string }>(
        `SELECT id FROM generated_stories WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, userId],
      );
      if (owned.rows.length === 0) {
        throw new NotFoundError('story not found');
      }

      let outcome: 'done' | 'live' | 'enqueued';
      try {
        outcome = await enqueueStoryImages(id, userId);
      } catch (err) {
        if (err instanceof StoryImageDailyCapError) {
          req.log.warn(
            { userId, cap: loadConfig().STORY_IMAGE_DAILY_CAP },
            'storyImage: daily cap hit — enqueue refused before any write',
          );
        }
        throw err;
      }

      // One envelope for every outcome (the client renders off `status`
      // alone): 200 when the images already exist, 202 while work is queued
      // or in flight.
      const dto = await buildStoryImagesDto(id, userId);
      res.status(outcome === 'done' ? 200 : 202).json({ images: dto });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /reading/generated/:id/images — the story's illustration status (the
 * client's polling surface while a job runs; poll every ~2s until status is
 * 'done' or 'failed'). When 'done', the envelope carries the ordered image
 * list (blobUrl + prompt + dimensions). IDOR: story ownership is asserted
 * first — a missing or foreign story id is a uniform 404.
 */
router.get(
  '/generated/:id/images',
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
      res.status(200).json({ images: await buildStoryImagesDto(id, userId) });
    } catch (err) {
      next(err);
    }
  },
);

const StoryImageBlobParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
  // image_number binds to an INTEGER column — bound at the column max so an
  // overlarge value 400s at the boundary instead of 22003 → 500 at the cast.
  n: z.coerce.number().int().positive().max(MAX_INT4),
});

/** Map a stored blob_ref extension to its Content-Type. Closed set — the
 *  runner only ever writes imageStore's allow-listed extensions; an unknown
 *  suffix (a hand-mutated row) degrades to octet-stream + nosniff, never a
 *  sniffable type. */
const EXT_TO_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * GET /reading/generated/:id/image/:n/blob — one illustration's bytes
 * (F-211). The /images/:id/blob serving posture: authed (the same-origin
 * <img src> sends the session cookie), Cache-Control private,
 * X-Content-Type-Options nosniff, Content-Type from the STORED extension
 * (server-written, closed set — never client input). No Range support —
 * these are small static images, not streamed media. IDOR: the row lookup
 * is user-scoped in one query (the 083 composite FK pins user_id to the
 * story's owner), so a missing story, a foreign story, and a missing image
 * number are all the same uniform 404; a row whose FILE is gone
 * (out-of-band cleanup) is also a 404, not a 500.
 */
router.get(
  '/generated/:id/image/:n/blob',
  cheapLimiter(),
  validateParams(StoryImageBlobParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id, n } = (
        req as typeof req & { validatedParams: z.infer<typeof StoryImageBlobParamsSchema> }
      ).validatedParams;

      const { rows } = await query<{ blob_ref: string }>(
        `SELECT blob_ref FROM story_images
          WHERE generated_story_id = $1 AND user_id = $2 AND image_number = $3
          LIMIT 1`,
        [id, userId, n],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError('image not found');
      }

      let buffer: Buffer;
      try {
        buffer = await readBlob(row.blob_ref);
      } catch {
        // Missing/unreadable file (or a traversal-guard rejection on a
        // corrupt row): the row exists but the bytes are gone — 404, not 500.
        throw new NotFoundError('image not found');
      }

      const ext = row.blob_ref.slice(row.blob_ref.lastIndexOf('.') + 1).toLowerCase();
      res.setHeader('Content-Type', EXT_TO_MIME[ext] ?? 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(200).send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- Story experience (F-216; the one-tap combined enqueue) ---------- */

/**
 * Why a half's enqueue was refused, surfaced PER HALF in the experience
 * payload instead of as an HTTP error: 'dormant' (that provider is not
 * configured on this deploy — the half's capability flag is false too) or
 * 'daily_cap' (today's budget for that asset is spent). null = the half is
 * fine (enqueued now, already live, or already done). Wrapper-only — the
 * base StoryAudioDto/StoryImagesDto shapes are untouched.
 */
type EnqueueBlocked = 'dormant' | 'daily_cap' | null;

/** True while an asset half still has work in flight — the experience
 *  route's 202-vs-200 discriminator. */
function isAssetWorking(status: StoryAudioDto['status']): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * POST /reading/generated/:id/experience — one tap requests the story's FULL
 * experience (F-216): narration (F-210) AND illustrations (F-211) together.
 *
 * Each half runs the SAME hardened gate its dedicated POST uses
 * (enqueueStoryAudio / enqueueStoryImages: advisory-locked daily cap,
 * capability gate, voice-/generate-once idempotency) — but INDEPENDENTLY: a
 * dormant or capped half reports itself via `enqueueBlocked` on its own
 * envelope and the OTHER half still enqueues. Unlike the dedicated POSTs,
 * a KNOWN refusal here is never an HTTP error — with two halves there is no
 * single honest status line, so refusals ride the payload; unexpected
 * errors still fail the route.
 *
 * Both DTOs are built AFTER the attempts, so each half reflects the state
 * this request produced (a fresh 'pending', the pre-existing 'done', or the
 * untouched state behind a refusal). HTTP: 202 while EITHER half is
 * pending/running, else 200 (both halves settled: done/none/failed).
 * IDOR: the story is ownership-checked first — a missing or foreign id is a
 * uniform 404, and a probe never reaches either enqueue gate.
 */
router.post(
  '/generated/:id/experience',
  expensiveLimiter(),
  validateParams(StoryParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (
        req as typeof req & { validatedParams: z.infer<typeof StoryParamsSchema> }
      ).validatedParams;

      // IDOR gate first: a missing id and another user's story are the same
      // uniform 404 (mirrors GET /generated/:id).
      const owned = await query<{ id: string }>(
        `SELECT id FROM generated_stories WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, userId],
      );
      if (owned.rows.length === 0) {
        throw new NotFoundError('story not found');
      }

      let audioBlocked: EnqueueBlocked = null;
      try {
        await enqueueStoryAudio(id, userId);
      } catch (err) {
        if (err instanceof TtsUnavailableError) {
          audioBlocked = 'dormant';
        } else if (err instanceof StoryTtsDailyCapError) {
          audioBlocked = 'daily_cap';
          req.log.warn(
            { userId, cap: loadConfig().STORY_TTS_DAILY_CAP },
            'storyAudio: daily cap hit — experience audio half refused',
          );
        } else {
          throw err;
        }
      }

      let imagesBlocked: EnqueueBlocked = null;
      try {
        await enqueueStoryImages(id, userId);
      } catch (err) {
        if (err instanceof ImageGenUnavailableError) {
          imagesBlocked = 'dormant';
        } else if (err instanceof StoryImageDailyCapError) {
          imagesBlocked = 'daily_cap';
          req.log.warn(
            { userId, cap: loadConfig().STORY_IMAGE_DAILY_CAP },
            'storyImage: daily cap hit — experience images half refused',
          );
        } else {
          throw err;
        }
      }

      const audio = await buildStoryAudioDto(id, userId);
      const images = await buildStoryImagesDto(id, userId);
      const working = isAssetWorking(audio.status) || isAssetWorking(images.status);
      res.status(working ? 202 : 200).json({
        experience: {
          audio: { ...audio, enqueueBlocked: audioBlocked },
          images: { ...images, enqueueBlocked: imagesBlocked },
        },
      });
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
