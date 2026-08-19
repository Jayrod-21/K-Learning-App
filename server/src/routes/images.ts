/**
 * /images routes — Images screen goes live (Pass 8, image OCR mining).
 *
 * Flow:
 *   POST /images/ocr        → upload a photo, run Claude Vision OCR, persist the
 *                             capture + its mined content words, return the DTO
 *   GET  /images            → this user's captures, newest first, WITHOUT words
 *   GET  /images/:id        → one capture + its words (user-scoped)
 *   GET  /images/:id/blob   → the stored image bytes (user-scoped, nosniff)
 *
 * DTO — matches the client `ImageCapture` shape (no bounding boxes):
 *   { id, name, caption_kr, caption_en, createdAt, blobUrl, words }
 *   where words = { kr, en, gloss, pos }[] (NO box field).
 *   The list view (`GET /images`) omits `words` (summary only).
 *
 * Chat rework (Slice 1): the upload → validate → Vision → persist pipeline
 * moved to services/imageIngest.ts so POST /conversation/:id/image reuses the
 * exact same hardened path (magic-byte sniff, daily Vision cap, atomicity).
 * This file keeps the route wiring + the read projections.
 *
 * SECURITY (see SECURITY.md §16 — uploads + external Vision + blob storage are
 * the real attack surface of this pass; the defenses now live in
 * services/imageIngest.ts, unchanged in substance):
 *   - UPLOAD: multer MEMORY storage, single field `image`, 8 MiB fileSize cap,
 *     declared-mime fileFilter as an early reject, magic-byte sniff as the
 *     authority (never trust the client-declared mime).
 *   - PATH TRAVERSAL: the blob filename is a SERVER-generated UUID + the session
 *     user id; no client string ever enters a filesystem path. readBlob
 *     resolves the stored relative path and asserts it stays under the root.
 *   - IDOR: every capture/word/blob query is scoped to `getUserId(req)`. Another
 *     user's :id or :id/blob → 404 (not 403 — don't confirm existence).
 *   - VISION COST: a per-user DAILY cap (config IMAGE_OCR_DAILY_CAP) returns 429
 *     BEFORE any upstream call; the 8 MiB limit bounds per-call cost; the Claude
 *     proxy's own per-minute image_ocr limiter bounds bursts.
 *   - ATOMICITY: POST /ocr is transactional — blob write + image_captures +
 *     image_words land together. On Vision failure → 502 and NO half-capture
 *     (the Vision call happens BEFORE the transaction opens, so a failure writes
 *     nothing). The blob is written inside the tx boundary and rolled back on a
 *     DB error.
 *   - DoS: memory storage bounded by fileSize; reads use cheapLimiter.
 *   - BLOB SERVING: authed, `Cache-Control: private`, `X-Content-Type-Options:
 *     nosniff`, exact sniffed content-type. The browser <img src> sends the
 *     session cookie (same-origin).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { readBlob } from '../services/imageStore.js';
import {
  blobUrlFor,
  multerImageUpload,
  ocrUploadedImage,
  persistCapture,
  type ImageCaptureDTO,
  type ImageWordDTO,
} from '../services/imageIngest.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Row types + projections
// ---------------------------------------------------------------------------

/** Summary (list view): everything but the words. */
type ImageCaptureSummaryDTO = Omit<ImageCaptureDTO, 'words'>;

interface CaptureRow {
  id: number;
  original_filename: string | null;
  caption_kr: string;
  caption_en: string;
  created_at: Date;
}

interface WordRow {
  kr: string;
  en: string;
  gloss: string;
  pos: string | null;
}

function toSummaryDTO(row: CaptureRow): ImageCaptureSummaryDTO {
  return {
    // Wire contract: capture ids are emitted as STRINGS (pre-int8-parser
    // behavior, pinned). String() keeps the wire byte-identical now that the
    // row id arrives as a number.
    id: String(row.id),
    name: row.original_filename ?? `capture-${row.id}`,
    caption_kr: row.caption_kr,
    caption_en: row.caption_en,
    createdAt: row.created_at.toISOString(),
    blobUrl: blobUrlFor(row.id),
  };
}

function toWordDTO(row: WordRow): ImageWordDTO {
  return {
    kr: row.kr,
    en: row.en,
    gloss: row.gloss,
    pos: row.pos ?? '',
  };
}

// ---------------------------------------------------------------------------
// POST /images/ocr — upload + Vision OCR + persist (transactional).
// ---------------------------------------------------------------------------

/**
 * POST /images/ocr — multipart upload of one `image` field.
 *
 * Order of operations (security-load-bearing — see services/imageIngest.ts):
 *   1. expensiveLimiter (per-user burst) + multer parse (8 MiB cap).
 *   2-4. ocrUploadedImage: file present + magic-byte sniff (400), per-user
 *        daily cap (429), Claude Vision OCR outside any tx (502, no writes).
 *   5. ONE transaction: save the blob (server UUID path) + INSERT the capture +
 *      INSERT its words. A DB error rolls the whole thing back.
 *   6. Return the capture DTO (with words).
 */
router.post('/ocr', expensiveLimiter(), multerImageUpload, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const file = (req as Request & { file?: Express.Multer.File }).file;

    const img = await ocrUploadedImage(file, userId, req.correlationId);
    const dto = await withTransaction((client) =>
      persistCapture(client, userId, img),
    );

    res.status(201).json({ capture: dto });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /images — this user's captures, newest first, WITHOUT words.
// ---------------------------------------------------------------------------

router.get('/', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<CaptureRow>(
      `SELECT id, original_filename, caption_kr, caption_en, created_at
         FROM image_captures
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    res.status(200).json({ captures: rows.map(toSummaryDTO) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /images/:id — one capture + its words (user-scoped).
// ---------------------------------------------------------------------------

/** :id is a positive integer (BIGINT identity). Coerced + validated so a
 *  garbage id is a 400 (not a SQL cast error) and never reaches the cap query
 *  as text. Upper-bounded because Number.isInteger(1e20) is true — an
 *  unbounded 20-digit id passes Zod and overflows int8 in pg (22003 → 500
 *  where the contract is 400/404; routes sweep #3). */
const IdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

router.get(
  '/:id',
  cheapLimiter(),
  validateParams(IdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & {
        validatedParams: z.infer<typeof IdParamsSchema>;
      }).validatedParams;

      const { rows: capRows } = await query<CaptureRow>(
        `SELECT id, original_filename, caption_kr, caption_en, created_at
           FROM image_captures
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      const capture = capRows[0];
      if (!capture) {
        // Not theirs / missing / soft-deleted → 404 (don't confirm existence).
        throw new NotFoundError('capture not found');
      }

      const { rows: wordRows } = await query<WordRow>(
        `SELECT kr, en, gloss, pos
           FROM image_words
          WHERE capture_id = $1
          ORDER BY ordinal`,
        [capture.id],
      );

      const dto: ImageCaptureDTO = {
        ...toSummaryDTO(capture),
        words: wordRows.map(toWordDTO),
      };
      res.status(200).json({ capture: dto });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /images/:id/blob — serve the stored image bytes (user-scoped).
// ---------------------------------------------------------------------------

router.get(
  '/:id/blob',
  cheapLimiter(),
  validateParams(IdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & {
        validatedParams: z.infer<typeof IdParamsSchema>;
      }).validatedParams;

      // User-scoped lookup of the blob path + mime. A row that isn't theirs (or
      // is soft-deleted) → 404 BEFORE any filesystem touch.
      const { rows } = await query<{ blob_path: string; mime: string }>(
        `SELECT blob_path, mime
           FROM image_captures
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError('capture not found');
      }

      let buffer: Buffer;
      try {
        buffer = await readBlob(row.blob_path);
      } catch (err) {
        // Missing file on disk (ENOENT) or a traversal guard trip → 404. We do
        // not 500 on a missing blob: the row exists but the bytes are gone
        // (e.g. a partial restore), which the client treats as a broken image.
        if (isEnoent(err)) {
          throw new NotFoundError('image bytes not found');
        }
        throw err;
      }

      // nosniff: the browser must honor our content-type, never sniff the bytes
      // into an executable type. private: per-user, never shared-cache.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.type(row.mime).send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the error is a filesystem "no such file" error. */
function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

export default router;
