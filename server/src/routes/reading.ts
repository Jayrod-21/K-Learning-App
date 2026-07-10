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
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';

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
                page_number    = EXCLUDED.page_number
         RETURNING ${POSITION_COLUMNS}`,
        [userId, uploadId, chapterId, passageNumber, pageNumber],
      );

      res.status(200).json({ position: toPositionDto(rows[0]!) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
