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
 * SECURITY (see SECURITY.md §16 — uploads + external Vision + blob storage are
 * the real attack surface of this pass):
 *   - UPLOAD: multer MEMORY storage, single field `image`, 8 MiB fileSize cap.
 *     A fileFilter rejects non-(jpeg/png/webp) by declared mime, and AFTER
 *     multer we MAGIC-BYTE-SNIFF the buffer (JPEG FFD8FF / PNG 89504E47 /
 *     WEBP RIFF....WEBP) — we NEVER trust the client-declared mime. SVG / HTML /
 *     executables / a renamed `.png` that is really something else → 400.
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
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import {
  AppError,
  NotFoundError,
  PayloadTooLargeError,
  UpstreamError,
  ValidationError,
} from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import type { ImageOcrResult, ProxyResult } from '../services/claudeProxy.js';
import { extForMime, readBlob, saveBlob } from '../services/imageStore.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Upload constraints + multer
// ---------------------------------------------------------------------------

/** The upload mime allowlist. CHECK-mirrored in migration 017. */
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AllowedMime = (typeof ALLOWED_MIMES)[number];

/** 8 MiB — bounds memory use (memory storage) AND per-Vision-call cost. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * multer MEMORY storage: the buffer never touches disk via multer (we control
 * the only write, in saveBlob, with a server-generated path). A `fileFilter`
 * rejects an obviously-wrong declared mime EARLY (saves reading 8 MiB into
 * memory for a `.svg`), but it is NOT trusted — the magic-byte sniff after
 * multer is the authority. `limits.files: 1` + `.single('image')` reject extra
 * fields.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIMES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      // Reject without throwing — surfaces as no `req.file`, mapped to 400 below.
      cb(null, false);
    }
  },
});

const uploadSingle = upload.single('image');

/**
 * Run multer and translate its errors into our typed 4xx. A raw `MulterError`
 * (oversize → `LIMIT_FILE_SIZE`, unexpected field, too many files) would
 * otherwise reach the error handler as a generic 500. We map the size-limit
 * error to a 413 Payload Too Large — the correct HTTP semantic for an oversize
 * body, and the status the client keys "That image is too large" off of — and
 * every other MulterError (unexpected field, too many files/parts) to a 400.
 * This keeps the multer machinery from leaking through as a server error and
 * keeps the client/server contract on oversize aligned (413, not 400).
 */
function multerUpload(req: Request, res: Response, next: NextFunction): void {
  uploadSingle(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError(
            `image exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`,
          ),
        );
        return;
      }
      next(new ValidationError(`invalid upload: ${err.code}`));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

/**
 * Sniff the leading bytes of the buffer to confirm the REAL image type, never
 * trusting the client-declared mime. Returns the verified mime, or null if the
 * bytes match no allowed format (→ 400).
 *
 *   JPEG: FF D8 FF
 *   PNG : 89 50 4E 47 0D 0A 1A 0A
 *   WEBP: "RIFF" (52 49 46 46) .... "WEBP" (57 45 42 50) at offset 8
 *
 * This is the core "don't trust the client mime" defense: a polyglot or a
 * renamed SVG/HTML/exe whose declared mime is image/png is rejected here.
 */
function sniffImageMime(buf: Buffer): AllowedMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

// ---------------------------------------------------------------------------
// DTO + row types
// ---------------------------------------------------------------------------

interface ImageWordDTO {
  readonly kr: string;
  readonly en: string;
  readonly gloss: string;
  /** Part of speech, or '' when the model didn't tag it. */
  readonly pos: string;
}

interface ImageCaptureDTO {
  readonly id: string;
  /** Display name — the original filename, or a fallback. */
  readonly name: string;
  readonly caption_kr: string;
  readonly caption_en: string;
  readonly createdAt: string;
  /** Path the client uses as `<img src>`. Authed, same-origin. */
  readonly blobUrl: string;
  readonly words: readonly ImageWordDTO[];
}

/** Summary (list view): everything but the words. */
type ImageCaptureSummaryDTO = Omit<ImageCaptureDTO, 'words'>;

interface CaptureRow {
  id: string;
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

/** Build the blob URL the client renders. id is the DB id (server-trusted). */
function blobUrlFor(id: string): string {
  return `/images/${id}/blob`;
}

function toSummaryDTO(row: CaptureRow): ImageCaptureSummaryDTO {
  return {
    id: row.id,
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
 * Order of operations (security-load-bearing):
 *   1. expensiveLimiter (per-user burst) + multer parse (8 MiB cap).
 *   2. file present + magic-byte sniff → 400 on any mismatch.
 *   3. per-user DAILY cap → 429 if exceeded (BEFORE the costly Vision call).
 *   4. Claude Vision OCR (OUTSIDE any transaction — Bar §1: no external I/O in
 *      an open tx). A failure → 502 and nothing is written.
 *   5. ONE transaction: save the blob (server UUID path) + INSERT the capture +
 *      INSERT its words. A DB error rolls the whole thing back.
 *   6. Return the capture DTO (with words).
 */
router.post('/ocr', expensiveLimiter(), multerUpload, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const file = (req as Request & { file?: Express.Multer.File }).file;

    // 2. File present + non-empty + magic-byte verified.
    if (!file || file.buffer.length === 0) {
      throw new ValidationError(
        'an image file is required in the "image" field (jpeg, png, or webp)',
      );
    }
    const sniffedMime = sniffImageMime(file.buffer);
    if (sniffedMime === null) {
      // The bytes are not a JPEG/PNG/WEBP regardless of the declared mime.
      throw new ValidationError(
        'uploaded file is not a supported image (jpeg, png, or webp)',
      );
    }
    const ext = extForMime(sniffedMime);
    if (ext === null) {
      // Unreachable (sniff only returns allowlisted mimes) — defensive.
      throw new ValidationError('unsupported image type');
    }

    // 3. Per-user DAILY cap (Seoul-day-agnostic — uses the DB's `now()` day;
    //    captures are stamped server-side so this is tamper-proof). Counts even
    //    soft-deleted rows: the cap is a COST control on the Vision call, and a
    //    user deleting captures must not reset their daily Vision budget.
    const cfg = loadConfig();
    const { rows: capRows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM image_captures
        WHERE user_id = $1
          AND created_at >= date_trunc('day', now())`,
      [userId],
    );
    const usedToday = Number(capRows[0]?.n ?? '0');
    if (usedToday >= cfg.IMAGE_OCR_DAILY_CAP) {
      throw new DailyCapError(cfg.IMAGE_OCR_DAILY_CAP);
    }

    // 4. Vision OCR — OUTSIDE any transaction. On failure this throws a Claude
    //    proxy error (httpStatus 502) mapped to UpstreamError below; nothing is
    //    persisted, so there is no half-capture.
    const proxy = getClaudeProxy();
    let ocr: ProxyResult<ImageOcrResult>;
    try {
      ocr = await proxy.ocrImage(
        {
          imageBase64: file.buffer.toString('base64'),
          mediaType: sniffedMime,
        },
        { requestId: req.correlationId, userId },
      );
    } catch (err) {
      next(mapClaudeError(err));
      return;
    }
    const result = ocr.result;
    // The OCR schema leaves caption_*/words optional (so the inferred type
    // matches runJsonRoute's output); coerce to the NOT-NULL DB shape here.
    const captionKr = result.caption_kr ?? '';
    const captionEn = result.caption_en ?? '';
    const ocrWords = result.words ?? [];

    // 5. ONE transaction: blob + capture + words. captureId is a SERVER UUID —
    //    never client input — so the blob path is injection-free. The blob
    //    write lives inside the tx boundary; a DB failure after the write leaves
    //    an orphan file (harmless, GC-able), never a half-capture row.
    const captureId = randomUUID();
    const byteSize = file.buffer.length;
    const originalFilename = sanitizeFilename(file.originalname);

    const dto = await withTransaction(async (client) => {
      const blobPath = await saveBlob(userId, captureId, ext, file.buffer);

      const { rows: capInsert } = await client.query<{
        id: string;
        created_at: Date;
      }>(
        `INSERT INTO image_captures
           (user_id, original_filename, mime, byte_size, blob_path,
            caption_kr, caption_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, created_at`,
        [
          userId,
          originalFilename,
          sniffedMime,
          byteSize,
          blobPath,
          captionKr,
          captionEn,
        ],
      );
      const captureRow = capInsert[0];
      if (!captureRow) {
        // Defensive: a RETURNING INSERT always yields a row or throws.
        throw new Error('image_captures insert returned no row');
      }

      const words: ImageWordDTO[] = [];
      for (let i = 0; i < ocrWords.length; i += 1) {
        const w = ocrWords[i]!;
        await client.query(
          `INSERT INTO image_words (capture_id, ordinal, kr, en, gloss, pos)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [captureRow.id, i, w.kr, w.en ?? '', w.gloss ?? '', w.pos ?? null],
        );
        words.push({ kr: w.kr, en: w.en ?? '', gloss: w.gloss ?? '', pos: w.pos ?? '' });
      }

      const out: ImageCaptureDTO = {
        id: captureRow.id,
        name: originalFilename ?? `capture-${captureRow.id}`,
        caption_kr: captionKr,
        caption_en: captionEn,
        createdAt: captureRow.created_at.toISOString(),
        blobUrl: blobUrlFor(captureRow.id),
        words,
      };
      return out;
    });

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

/** 429 for the per-user daily Vision cap. Subclass so the message names the cap. */
class DailyCapError extends AppError {
  public constructor(cap: number) {
    super(
      429,
      'rate_limited',
      `daily image upload limit reached (${cap}/day). Try again tomorrow.`,
    );
    this.name = 'DailyCapError';
  }
}

/**
 * Sanitize the client-declared filename for DISPLAY storage only. It is NEVER
 * used to build a filesystem path (the blob path is a server UUID), but we
 * still strip control characters + path separators and cap the length so a
 * crafted name can't pollute the DTO or a log line. Returns null for an
 * empty/whitespace name.
 */
function sanitizeFilename(name: string | undefined): string | null {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\x00-\x1f\x7f/\\]/g, '').trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : null;
}

/** Map a Claude proxy error (carries httpStatus/code) to a 502 UpstreamError.
 *  Mirrors diagnostic.ts mapClaudeError — we never forward the upstream status
 *  or provider-specific details to the wire. */
function mapClaudeError(err: unknown): unknown {
  if (err && typeof err === 'object' && 'httpStatus' in err) {
    const code = (err as { code?: string }).code ?? 'upstream_error';
    const message = (err as { message?: string }).message ?? 'vision error';
    return new UpstreamError(`${code}: ${message}`);
  }
  return err;
}

/** True when the error is a filesystem "no such file" error. */
function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

export default router;
