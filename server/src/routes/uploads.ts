/**
 * /uploads routes — U1a, PDF book-upload feature (see
 * db/docs/PDF_UPLOAD_DESIGN.md §"U1 → U1a server"). The front door: any owned
 * scanned-book PDF can be uploaded, listed, viewed, and removed. NO
 * extraction/OCR happens here — U2 (a later, separate phase) is what turns an
 * uploaded PDF into tagged vocab/grammar/reading content via
 * `source_upload_id` (migration 040). This phase only needs the PDF to exist
 * and be viewable.
 *
 * Flow:
 *   POST   /uploads          → upload a PDF (multipart `file` + `title` + `type`),
 *                               store the blob, upsert the row (idempotent
 *                               replace by (user, title))
 *   GET    /uploads          → this user's uploads, newest first (list projection)
 *   GET    /uploads/:id      → one upload's metadata (user-scoped)
 *   GET    /uploads/:id/file → the stored PDF bytes, Range-capable (viewer)
 *   DELETE /uploads/:id      → remove the row + its blob file
 *
 * SECURITY (mirrors routes/images.ts + services/imageIngest.ts's posture,
 * reused rather than reinvented — see services/bookUploadIngest.ts's header
 * for the upload-side rationale):
 *   - UPLOAD: multer MEMORY storage, single field `file`, ~15 MiB fileSize
 *     cap, declared-mime fileFilter as an early reject, magic-byte (`%PDF-`)
 *     sniff as the authority (never trust the client-declared mime).
 *   - PATH TRAVERSAL: the blob filename is a SERVER-generated UUID + the
 *     session user id (services/uploadStore.ts); no client string ever enters
 *     a filesystem path. Every read/stream/delete resolves the stored
 *     relative path and asserts it stays under the configured root.
 *   - IDOR: every row/blob query is scoped to `getUserId(req)`. Another
 *     user's :id → 404 (not 403 — don't confirm existence), identical to a
 *     missing id so probing id-space reveals nothing.
 *   - MASS ASSIGNMENT: `title`/`type` are the only writable body fields, both
 *     validated by a `.strict()` Zod schema — an extra field (e.g. a client
 *     trying to set `status` or `user_id` directly) is REJECTED, not ignored.
 *   - COST/ABUSE: a per-user DAILY cap (config BOOK_UPLOAD_DAILY_CAP) on NEW
 *     titles → 429 BEFORE any write; a same-title re-upload (idempotent
 *     replace) is exempt (see bookUploadIngest.ts).
 *   - ATOMICITY: POST is transactional — blob write + book_uploads
 *     UPSERT land together; the PRIOR blob (on a same-title replace) is only
 *     deleted AFTER the transaction commits, so a rolled-back request never
 *     destroys the still-live prior file.
 *   - FILE SERVING: authed, `X-Content-Type-Options: nosniff`, exact
 *     `Content-Type: application/pdf`, `Content-Disposition: inline` (the
 *     in-app viewer renders it, never triggers a download-and-open-elsewhere
 *     flow), single-range `Range` support mirroring routes/ttmik.ts's audio
 *     streaming (reuses its `parseRangeHeader`) so pdf.js's partial-load
 *     requests work.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getLogger } from '../logging.js';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter, mediaLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { deleteBlob, resolveUnderRoot } from '../services/uploadStore.js';
import {
  BOOK_UPLOAD_TYPES,
  ingestUpload,
  multerBookUpload,
  persistUpload,
  type BookUploadDTO,
} from '../services/bookUploadIngest.js';
import { parseRangeHeader } from './ttmik.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** :id is a positive integer (BIGINT identity). Coerced + validated so a
 *  garbage id is a 400 (not a SQL cast error), and upper-bounded because
 *  Number.isInteger(1e20) is true — an unbounded 20-digit id passes Zod and
 *  overflows int8 in pg (mirrors routes/images.ts IdParamsSchema). */
const IdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * The two multipart TEXT fields alongside the `file` part. `.strict()`
 * rejects any extra field (mass-assignment defense — a client cannot smuggle
 * `status`/`user_id`/etc. onto the row). `title` is trimmed + bounded to match
 * the DB CHECK (migration 040: length BETWEEN 1 AND 200).
 */
const UploadBodySchema = z
  .object({
    title: z.string().trim().min(1, 'title must not be blank').max(200),
    type: z.enum(BOOK_UPLOAD_TYPES),
  })
  .strict();

// ---------------------------------------------------------------------------
// Row types + projections
// ---------------------------------------------------------------------------

interface UploadRow {
  id: string;
  title: string;
  type: (typeof BOOK_UPLOAD_TYPES)[number];
  status: 'processing' | 'ready' | 'failed';
  page_count: number | null;
  byte_size: number;
  created_at: Date;
}

function toDTO(row: UploadRow): BookUploadDTO {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    page_count: row.page_count,
    byte_size: row.byte_size,
    created_at: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /uploads — upload a PDF (transactional; idempotent replace by title).
// ---------------------------------------------------------------------------

router.post('/', expensiveLimiter(), multerBookUpload, validateBody(UploadBodySchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const file = (req as Request & { file?: Express.Multer.File }).file;
    const body = (req as Request & { body: z.infer<typeof UploadBodySchema> }).body;

    const ingested = await ingestUpload(file, body, userId);
    const persisted = await withTransaction((client) => persistUpload(client, userId, ingested));

    // Filesystem cleanup happens AFTER the commit above succeeds — deleting
    // the prior blob earlier would destroy the only copy if the transaction
    // had rolled back. Best-effort: a leftover orphan file is harmless
    // (GC-able), so a delete failure here must not fail the request that
    // already committed its new row.
    if (persisted.priorBlobRef !== null) {
      try {
        await deleteBlob(persisted.priorBlobRef);
      } catch (err) {
        getLogger().warn(
          { err: String(err), blobRef: persisted.priorBlobRef },
          'uploads: failed to delete replaced blob (orphaned, non-fatal)',
        );
      }
    }

    res.status(persisted.wasNew ? 201 : 200).json({ upload: persisted.dto });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /uploads — this user's uploads, newest first.
// ---------------------------------------------------------------------------

router.get('/', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<UploadRow>(
      `SELECT id, title, type, status, page_count, byte_size, created_at
         FROM book_uploads
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    res.status(200).json({ uploads: rows.map(toDTO) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /uploads/:id — one upload's metadata (user-scoped).
// ---------------------------------------------------------------------------

router.get('/:id', cheapLimiter(), validateParams(IdParamsSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
      .validatedParams;

    const { rows } = await query<UploadRow>(
      `SELECT id, title, type, status, page_count, byte_size, created_at
         FROM book_uploads
        WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = rows[0];
    if (!row) {
      // Not theirs / missing → 404 (don't confirm existence).
      throw new NotFoundError('upload not found');
    }
    res.status(200).json({ upload: toDTO(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /uploads/:id/file — stream the PDF bytes (user-scoped, Range-capable).
// ---------------------------------------------------------------------------

router.get(
  '/:id/file',
  mediaLimiter(),
  validateParams(IdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
        .validatedParams;

      // User-scoped lookup of the blob path BEFORE any filesystem touch. A row
      // that isn't theirs → 404.
      const { rows } = await query<{ blob_ref: string }>(
        `SELECT blob_ref FROM book_uploads WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError('upload not found');
      }

      let absPath: string;
      try {
        absPath = resolveUnderRoot(row.blob_ref);
      } catch {
        // A poisoned/corrupt blob_ref (defense in depth — this should never
        // happen given the row is always written by saveBlob). Uniform 404,
        // never confirm what the traversal attempt would have hit.
        throw new NotFoundError('upload bytes not found');
      }

      let size: number;
      try {
        size = (await stat(absPath)).size;
      } catch (err) {
        // Missing file on disk (ENOENT) — the row exists but the bytes are
        // gone (e.g. a partial restore). Treat as 404, not 500.
        if (isEnoent(err)) {
          throw new NotFoundError('upload bytes not found');
        }
        throw err;
      }

      await streamPdf(req, res, next, absPath, size);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /uploads/:id — remove the row + its blob file (user-scoped).
// ---------------------------------------------------------------------------

router.delete(
  '/:id',
  cheapLimiter(),
  validateParams(IdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
        .validatedParams;

      // DELETE ... RETURNING is atomic: either a row we own existed and is now
      // gone (blob_ref returned), or nothing matched (404, IDOR-safe — same
      // response whether the id belongs to another user or doesn't exist).
      // Any content U2 has tagged via source_upload_id is un-tagged, not
      // deleted (ON DELETE SET NULL, migration 040) — nothing further to do
      // here for U1, since no extraction exists yet.
      const { rows } = await query<{ blob_ref: string }>(
        `DELETE FROM book_uploads WHERE id = $1 AND user_id = $2 RETURNING blob_ref`,
        [id, userId],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError('upload not found');
      }

      // Best-effort blob cleanup — the row is already gone; a failed unlink
      // leaves a harmless orphan file rather than failing a delete the user
      // already sees as successful.
      try {
        await deleteBlob(row.blob_ref);
      } catch (err) {
        getLogger().warn(
          { err: String(err), blobRef: row.blob_ref },
          'uploads: failed to delete blob on DELETE (orphaned, non-fatal)',
        );
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Streaming core — mirrors routes/ttmik.ts's streamCorpusAudio (RFC 9110
// single-range support), adapted for a user-scoped PDF instead of the shared
// read-only corpus tree. Reuses ttmik's `parseRangeHeader` rather than
// reimplementing range-parsing.
// ---------------------------------------------------------------------------

async function streamPdf(
  req: Request,
  res: Response,
  next: NextFunction,
  absPath: string,
  size: number,
): Promise<void> {
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/pdf');
  // nosniff: the browser must honor our content-type, never sniff the bytes
  // into an executable type. inline: the in-app viewer renders it directly.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  // Authed, per-user content: cacheable only by the browser itself.
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

  const range = parseRangeHeader(req.headers.range, size);
  if (range === 'unsatisfiable') {
    // RFC 9110 §15.5.17: tell the client the actual size so it can re-request.
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }

  // Degenerate empty file (should never ship, but defends createReadStream
  // against an inverted start/end pair on a 0-byte PDF).
  if (size === 0) {
    res.status(200);
    res.setHeader('Content-Length', 0);
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', end - start + 1);

  const stream = createReadStream(absPath, { start, end });
  stream.on('error', (err) => {
    getLogger().error({ err, absPath }, 'uploads: pdf stream error');
    stream.destroy();
    if (res.headersSent) {
      res.destroy();
    } else {
      next(err);
    }
  });
  // Client disconnect: stop reading the file (backpressure would eventually,
  // but destroying promptly frees the fd).
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

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
