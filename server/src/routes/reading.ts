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
 *     user-scoped).
 *   - INJECTION: every id is a coerced, upper-bounded integer bound as a query
 *     parameter — never string-interpolated into SQL.
 *   - READ-ONLY: these routes never write; ingestion is the loader's job
 *     (tools/ingest/load_literature.py), not an API surface.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

// Ids bind to BIGINT/int8 in pg. Without an upper bound a 20-digit value passes
// `int().positive()` (Number.isInteger(1e20) is true) and overflows in pg
// (22003 → 500) where the contract is 400/404 for a garbage id. MAX_SAFE_INTEGER
// ≪ int8 max, so bounded values are safe. (Mirrors routes/vocab.ts + uploads.ts.)
const MAX_ID = Number.MAX_SAFE_INTEGER;

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

      // Ownership gate: the upload must exist AND belong to the requester.
      // A miss is a 404 (identical to a non-existent id) so id-space probing
      // reveals nothing about other users' uploads. Scoped by user_id, so this
      // never confirms an upload owned by someone else.
      const owned = await query<{ id: string }>(
        `SELECT id FROM book_uploads WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [q.source_upload_id, userId],
      );
      if (owned.rows.length === 0) {
        throw new NotFoundError('upload not found');
      }

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

export default router;
