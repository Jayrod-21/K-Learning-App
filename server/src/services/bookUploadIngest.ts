/**
 * Book-upload ingest service (U1a — PDF book-upload feature, the "front
 * door" of the design doc's U1 phase). Mirrors `services/imageIngest.ts`'s
 * shape (Pass 8 Images screen) — same split, same reasoning — adapted for a
 * plain PDF upload with no OCR/Vision call.
 *
 * Split into two halves on the transaction boundary (Bar §"Concurrency": no
 * external I/O inside an open tx):
 *
 *   1. `ingestUpload()` — file presence + magic-byte sniff + per-user daily
 *      cap. Pure validation (no network call exists in U1 — extraction is
 *      U2's async/manual curation pass, not a live upstream call); throws
 *      typed 4xx AppErrors, writes NOTHING.
 *   2. `persistUpload(client, …)` — blob write + INSERT-or-REPLACE into
 *      `book_uploads`, run inside the CALLER's transaction. Returns the prior
 *      blob ref (if this was a same-title replace) so the caller can delete
 *      the orphaned file AFTER the transaction commits (filesystem cleanup is
 *      not transactional, so it must not gate the DB commit).
 *
 * SECURITY (mirrors imageIngest.ts's posture — see its header for the
 * fuller rationale; here restated for this surface):
 *   - UPLOAD: multer MEMORY storage, single `file` field, ~15 MiB cap, mime
 *     `fileFilter` as an early reject only — the magic-byte sniff after
 *     multer is the authority (never trust the declared mime). A polyglot or
 *     a renamed non-PDF whose declared mime is application/pdf is rejected by
 *     the `%PDF-` signature check, not the declared mime.
 *   - PATH TRAVERSAL: blob filename is a SERVER-generated UUID + user id (see
 *     uploadStore.ts); no client string ever enters a filesystem path.
 *   - PER-USER CAP: a DAILY cap (config BOOK_UPLOAD_DAILY_CAP) on NEW titles
 *     → 429. A same-title re-upload (idempotent replace) does NOT consume
 *     budget — the cap only guards against an unbounded number of DISTINCT
 *     uploads accumulating on disk, not iterative re-uploads while a title
 *     is still being dialed in.
 *   - ATOMICITY: the blob write lives inside the caller's tx boundary; a DB
 *     failure after the write leaves an orphan file (harmless, GC-able),
 *     never a half-row. The REPLACED blob (on a same-title re-upload) is
 *     deleted only after the transaction commits, so a rolled-back request
 *     never deletes bytes a live row still points at.
 *   - MASS ASSIGNMENT: `title`/`type` are the only two body fields, both
 *     validated by a `.strict()` Zod schema at the route boundary (routes/
 *     uploads.ts) before this module ever sees them.
 */
import multer, { MulterError } from 'multer';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';
import { AppError, PayloadTooLargeError, ValidationError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { saveBlob } from './uploadStore.js';

// ---------------------------------------------------------------------------
// Upload constraints + multer
// ---------------------------------------------------------------------------

/** The one upload mime this route accepts. CHECK-mirrored nowhere in the DB
 *  (book_uploads has no mime column — every row is a PDF by construction). */
export const ALLOWED_MIMES = ['application/pdf'] as const;

/** ~15 MiB — the design doc's cap ("a few MB each" scanned book, generous
 *  headroom). Bounds memory use (memory storage) AND per-request cost. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** The `book_uploads.type` enum, mirrored here so Zod/TS agree with the DB
 *  CHECK (migration 040). */
export const BOOK_UPLOAD_TYPES = ['vocab', 'grammar', 'both', 'dialogue', 'literature'] as const;
export type BookUploadType = (typeof BOOK_UPLOAD_TYPES)[number];

/**
 * multer MEMORY storage: the buffer never touches disk via multer (we control
 * the only write, in saveBlob, with a server-generated path). A `fileFilter`
 * rejects an obviously-wrong declared mime EARLY (saves buffering 15 MiB for
 * a `.exe`), but it is NOT trusted — the magic-byte sniff in `ingestUpload` is
 * the authority. `limits.files: 1` + `.single('file')` reject extra files;
 * `fields: 4` leaves room for the `title` + `type` text fields alongside the
 * file part.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIMES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      // Reject without throwing — surfaces as no `req.file`, mapped to 400
      // by ingestUpload's presence check.
      cb(null, false);
    }
  },
});

const uploadSingle = upload.single('file');

/**
 * Run multer and translate its errors into our typed 4xx. A raw `MulterError`
 * (oversize → `LIMIT_FILE_SIZE`, unexpected field, too many files) would
 * otherwise reach the error handler as a generic 500. The size-limit error
 * maps to 413 Payload Too Large — the status the client keys "that PDF is too
 * large" off of — and every other MulterError (unexpected field, too many
 * files/parts) maps to 400.
 */
export function multerBookUpload(req: Request, res: Response, next: NextFunction): void {
  uploadSingle(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError(
            `PDF exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`,
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
 * Sniff the leading bytes to confirm the buffer is a REAL PDF, never trusting
 * the client-declared mime. PDF files begin with the literal ASCII signature
 * `%PDF-` (0x25 0x50 0x44 0x46 0x2D) followed by a version, e.g. `%PDF-1.7`.
 * This is the core "don't trust the client mime" defense: a renamed .exe/.html
 * whose declared mime is application/pdf is rejected here regardless.
 */
export function sniffPdfMagicBytes(buf: Buffer): boolean {
  return (
    buf.length >= 5 &&
    buf[0] === 0x25 && // %
    buf[1] === 0x50 && // P
    buf[2] === 0x44 && // D
    buf[3] === 0x46 && // F
    buf[4] === 0x2d // -
  );
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export interface BookUploadDTO {
  readonly id: string;
  readonly title: string;
  readonly type: BookUploadType;
  readonly status: 'processing' | 'ready' | 'failed';
  readonly page_count: number | null;
  readonly byte_size: number;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Half 1: validate + cap (no writes)
// ---------------------------------------------------------------------------

/** The validated upload, ready to persist. Produced by `ingestUpload`,
 *  consumed by `persistUpload`. */
export interface IngestedUpload {
  readonly buffer: Buffer;
  readonly byteSize: number;
  readonly title: string;
  readonly type: BookUploadType;
}

/**
 * Validate an uploaded PDF and enforce the per-user daily cap. Throws typed
 * AppErrors (400 bad/missing file, 429 cap); performs NO writes, so any
 * failure here leaves the DB and blob store untouched.
 *
 * Order of operations (security-load-bearing — mirrors ocrUploadedImage):
 *   1. file present + non-empty + magic-byte sniff → 400 on any mismatch.
 *   2. per-user DAILY cap on NEW titles → 429 (an existing-title replace is
 *      exempt — see module header).
 */
export async function ingestUpload(
  file: Express.Multer.File | undefined,
  body: { title: string; type: BookUploadType },
  userId: number,
): Promise<IngestedUpload> {
  // 1. File present + non-empty + magic-byte verified.
  if (!file || file.buffer.length === 0) {
    throw new ValidationError('a PDF file is required in the "file" field');
  }
  if (!sniffPdfMagicBytes(file.buffer)) {
    throw new ValidationError('uploaded file is not a PDF (missing %PDF- signature)');
  }

  // 2. Per-user DAILY cap on NEW titles only. An existing (user, title) row
  //    means this request is a REPLACE, which the loop below is specifically
  //    designed to exempt (see module header "PER-USER CAP").
  const existing = await query<{ id: string }>(
    `SELECT id FROM book_uploads WHERE user_id = $1 AND title = $2`,
    [userId, body.title],
  );
  if (!existing.rows[0]) {
    const cfg = loadConfig();
    const { rows: capRows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM book_uploads
        WHERE user_id = $1
          AND created_at >= date_trunc('day', now())`,
      [userId],
    );
    const usedToday = Number(capRows[0]?.n ?? '0');
    if (usedToday >= cfg.BOOK_UPLOAD_DAILY_CAP) {
      throw new DailyCapError(cfg.BOOK_UPLOAD_DAILY_CAP);
    }
  }

  return {
    buffer: file.buffer,
    byteSize: file.buffer.length,
    title: body.title,
    type: body.type,
  };
}

// ---------------------------------------------------------------------------
// Half 2: persist (inside the CALLER's transaction)
// ---------------------------------------------------------------------------

/** Result of persisting an upload: the DTO to return, plus the PRIOR blob ref
 *  (if this request replaced an existing same-title row) so the caller can
 *  delete the orphaned file once the transaction has committed. `null` means
 *  this was a brand-new row — nothing to clean up. */
export interface PersistedUpload {
  readonly dto: BookUploadDTO;
  readonly priorBlobRef: string | null;
  readonly wasNew: boolean;
}

/**
 * Persist an ingested upload: blob write + INSERT-or-REPLACE `book_uploads`,
 * on the caller's transaction client. `uploadId` is a SERVER UUID — never
 * client input — so the blob path is injection-free.
 *
 * Idempotent replace: a re-upload of the SAME (user, title) UPSERTs the
 * existing row (new blob_ref/byte_size/type, status reset to 'processing',
 * page_count cleared — a new PDF means any prior extraction is stale) rather
 * than erroring on the UNIQUE constraint. The row's PRIOR blob_ref is read
 * (with `FOR UPDATE` to serialize concurrent replaces of the same title)
 * BEFORE the UPSERT overwrites it, so the caller can delete that file once
 * the surrounding transaction commits — deleting it here, before commit,
 * would destroy the only copy of the old blob if the transaction later
 * rolled back.
 */
export async function persistUpload(
  client: PoolClient,
  userId: number,
  ingested: IngestedUpload,
): Promise<PersistedUpload> {
  const uploadId = randomUUID();
  const blobRef = await saveBlob(userId, uploadId, 'pdf', ingested.buffer);

  const { rows: priorRows } = await client.query<{ blob_ref: string }>(
    `SELECT blob_ref FROM book_uploads WHERE user_id = $1 AND title = $2 FOR UPDATE`,
    [userId, ingested.title],
  );
  const priorBlobRef = priorRows[0]?.blob_ref ?? null;

  const { rows } = await client.query<{
    id: string;
    title: string;
    type: BookUploadType;
    status: 'processing' | 'ready' | 'failed';
    page_count: number | null;
    byte_size: number;
    created_at: Date;
  }>(
    `INSERT INTO book_uploads (user_id, title, type, status, blob_ref, byte_size, page_count)
     VALUES ($1, $2, $3::book_upload_type, 'processing', $4, $5, NULL)
     ON CONFLICT (user_id, title) DO UPDATE SET
       type       = EXCLUDED.type,
       status     = 'processing',
       blob_ref   = EXCLUDED.blob_ref,
       byte_size  = EXCLUDED.byte_size,
       page_count = NULL,
       version    = book_uploads.version + 1
     RETURNING id, title, type, status, page_count, byte_size, created_at`,
    [userId, ingested.title, ingested.type, blobRef, ingested.byteSize],
  );
  const row = rows[0];
  if (!row) {
    // Defensive: an INSERT ... RETURNING always yields a row or throws.
    throw new Error('book_uploads upsert returned no row');
  }

  return {
    dto: {
      id: row.id,
      title: row.title,
      type: row.type,
      status: row.status,
      page_count: row.page_count,
      byte_size: row.byte_size,
      created_at: row.created_at.toISOString(),
    },
    priorBlobRef,
    wasNew: priorBlobRef === null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 429 for the per-user daily upload cap. Subclass so the message names the cap. */
export class DailyCapError extends AppError {
  public constructor(cap: number) {
    super(
      429,
      'rate_limited',
      `daily book-upload limit reached (${cap}/day). Try again tomorrow.`,
    );
    this.name = 'DailyCapError';
  }
}
