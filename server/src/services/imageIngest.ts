/**
 * Image-ingest service — the shared upload → validate → Vision OCR → persist
 * pipeline behind BOTH image entry points:
 *
 *   POST /images/ocr                 (routes/images.ts — the Images screen)
 *   POST /conversation/:id/image     (routes/conversation.ts — image-in-chat)
 *
 * Extracted from routes/images.ts for the chat rework (Slice 1) so the chat
 * route reuses the EXACT same hardened pipeline (magic-byte sniff, daily
 * Vision cost cap, no-half-capture atomicity) instead of duplicating it.
 *
 * Split into two halves on the transaction boundary (Bar §"Concurrency": no
 * external I/O inside an open tx):
 *
 *   1. `ocrUploadedImage()` — file presence + magic-byte sniff + per-user
 *      daily cap + the Claude Vision call. Pure validation + external I/O;
 *      throws typed 4xx/5xx AppErrors, writes NOTHING. A Vision failure
 *      therefore never leaves a half-capture.
 *   2. `persistCapture(client, …)` — blob write + image_captures +
 *      image_words INSERTs, run inside the CALLER's transaction so a caller
 *      can atomically bundle extra writes (e.g. appending a conversation
 *      turn) with the capture persist.
 *
 * SECURITY (see SECURITY.md §16 — unchanged by the extraction):
 *   - UPLOAD: multer MEMORY storage, single `image` field, 8 MiB cap, mime
 *     fileFilter as an early reject only — the magic-byte sniff after multer
 *     is the authority (never trust the declared mime).
 *   - PATH TRAVERSAL: blob filename is a SERVER-generated UUID + user id;
 *     no client string ever enters a filesystem path.
 *   - VISION COST: per-user DAILY cap (config IMAGE_OCR_DAILY_CAP) → 429
 *     BEFORE any upstream call. Counts soft-deleted rows on purpose — the
 *     cap is a cost control, deleting captures must not reset the budget.
 *   - ATOMICITY: the blob write lives inside the caller's tx boundary; a DB
 *     failure after the write leaves an orphan file (harmless, GC-able),
 *     never a half-capture row.
 */
import multer, { MulterError } from 'multer';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';
import {
  AppError,
  PayloadTooLargeError,
  UpstreamError,
  ValidationError,
} from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { getClaudeProxy } from './claudeProxy.js';
import type { ImageOcrResult, ProxyResult } from './claudeProxy.js';
import { extForMime, saveBlob, type BlobExt } from './imageStore.js';

// ---------------------------------------------------------------------------
// Upload constraints + multer
// ---------------------------------------------------------------------------

/** The upload mime allowlist. CHECK-mirrored in migration 017. */
export const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedMime = (typeof ALLOWED_MIMES)[number];

/** 8 MiB — bounds memory use (memory storage) AND per-Vision-call cost. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * multer MEMORY storage: the buffer never touches disk via multer (we control
 * the only write, in saveBlob, with a server-generated path). A `fileFilter`
 * rejects an obviously-wrong declared mime EARLY (saves reading 8 MiB into
 * memory for a `.svg`), but it is NOT trusted — the magic-byte sniff in
 * `ocrUploadedImage` is the authority. `limits.files: 1` + `.single('image')`
 * reject extra files; `fields: 4` leaves room for small text fields (the chat
 * route sends `expected_version` alongside the file).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIMES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      // Reject without throwing — surfaces as no `req.file`, mapped to 400
      // by ocrUploadedImage's presence check.
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
 */
export function multerImageUpload(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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
export function sniffImageMime(buf: Buffer): AllowedMime | null {
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
// DTO types (shared with routes/images.ts GET projections)
// ---------------------------------------------------------------------------

export interface ImageWordDTO {
  readonly kr: string;
  readonly en: string;
  readonly gloss: string;
  /** Part of speech, or '' when the model didn't tag it. */
  readonly pos: string;
}

export interface ImageCaptureDTO {
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

/** Build the blob URL the client renders. id is the DB id (server-trusted). */
export function blobUrlFor(id: string): string {
  return `/images/${id}/blob`;
}

// ---------------------------------------------------------------------------
// Half 1: validate + cap + Vision OCR (no writes)
// ---------------------------------------------------------------------------

/**
 * The validated upload + its OCR output, ready to persist. Produced by
 * `ocrUploadedImage`, consumed by `persistCapture`.
 */
export interface IngestedImage {
  readonly buffer: Buffer;
  readonly mime: AllowedMime;
  readonly ext: BlobExt;
  readonly originalFilename: string | null;
  readonly byteSize: number;
  readonly captionKr: string;
  readonly captionEn: string;
  readonly words: readonly {
    readonly kr: string;
    readonly en: string;
    readonly gloss: string;
    readonly pos: string | null;
  }[];
}

/**
 * Validate an uploaded image, enforce the per-user daily Vision cap, and run
 * Claude Vision OCR. Throws typed AppErrors (400 bad/missing file, 429 cap,
 * 502 Vision upstream); performs NO writes, so any failure here leaves the DB
 * and blob store untouched.
 *
 * Order of operations (security-load-bearing — mirrors the original
 * POST /images/ocr):
 *   1. file present + non-empty + magic-byte sniff → 400 on any mismatch.
 *   2. per-user DAILY cap → 429 if exceeded (BEFORE the costly Vision call).
 *   3. Claude Vision OCR (OUTSIDE any transaction). A failure → 502 and
 *      nothing is written.
 */
export async function ocrUploadedImage(
  file: Express.Multer.File | undefined,
  userId: number,
  correlationId: string,
): Promise<IngestedImage> {
  // 1. File present + non-empty + magic-byte verified.
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

  // 2. Per-user DAILY cap (Seoul-day-agnostic — uses the DB's `now()` day;
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

  // 3. Vision OCR — OUTSIDE any transaction. On failure this throws a Claude
  //    proxy error mapped to a 502 UpstreamError; nothing is persisted, so
  //    there is no half-capture.
  const proxy = getClaudeProxy();
  let ocr: ProxyResult<ImageOcrResult>;
  try {
    ocr = await proxy.ocrImage(
      {
        imageBase64: file.buffer.toString('base64'),
        mediaType: sniffedMime,
      },
      { requestId: correlationId, userId },
    );
  } catch (err) {
    throw mapClaudeError(err);
  }
  const result = ocr.result;
  // The OCR schema leaves caption_*/words optional (so the inferred type
  // matches runJsonRoute's output); coerce to the NOT-NULL DB shape here.
  return {
    buffer: file.buffer,
    mime: sniffedMime,
    ext,
    originalFilename: sanitizeFilename(file.originalname),
    byteSize: file.buffer.length,
    captionKr: result.caption_kr ?? '',
    captionEn: result.caption_en ?? '',
    words: (result.words ?? []).map((w) => ({
      kr: w.kr,
      en: w.en ?? '',
      gloss: w.gloss ?? '',
      pos: w.pos ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Half 2: persist (inside the CALLER's transaction)
// ---------------------------------------------------------------------------

/**
 * Persist an ingested image: blob write + image_captures + image_words, all
 * on the caller's transaction client so extra writes (e.g. a conversation
 * turn append) commit-or-roll-back atomically with the capture.
 *
 * captureId is a SERVER UUID — never client input — so the blob path is
 * injection-free. The blob write lives inside the tx boundary; a DB failure
 * (or a caller rollback) after the write leaves an orphan file (harmless,
 * GC-able), never a half-capture row.
 */
export async function persistCapture(
  client: PoolClient,
  userId: number,
  img: IngestedImage,
): Promise<ImageCaptureDTO> {
  const captureId = randomUUID();
  const blobPath = await saveBlob(userId, captureId, img.ext, img.buffer);

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
      img.originalFilename,
      img.mime,
      img.byteSize,
      blobPath,
      img.captionKr,
      img.captionEn,
    ],
  );
  const captureRow = capInsert[0];
  if (!captureRow) {
    // Defensive: a RETURNING INSERT always yields a row or throws.
    throw new Error('image_captures insert returned no row');
  }

  const words: ImageWordDTO[] = [];
  for (let i = 0; i < img.words.length; i += 1) {
    const w = img.words[i]!;
    await client.query(
      `INSERT INTO image_words (capture_id, ordinal, kr, en, gloss, pos)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [captureRow.id, i, w.kr, w.en, w.gloss, w.pos],
    );
    words.push({ kr: w.kr, en: w.en, gloss: w.gloss, pos: w.pos ?? '' });
  }

  return {
    id: captureRow.id,
    name: img.originalFilename ?? `capture-${captureRow.id}`,
    caption_kr: img.captionKr,
    caption_en: img.captionEn,
    createdAt: captureRow.created_at.toISOString(),
    blobUrl: blobUrlFor(captureRow.id),
    words,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 429 for the per-user daily Vision cap. Subclass so the message names the cap. */
export class DailyCapError extends AppError {
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
export function sanitizeFilename(name: string | undefined): string | null {
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
