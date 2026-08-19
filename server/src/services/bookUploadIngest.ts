/**
 * Book-upload ingest service (U1a — book-upload feature, reworked to the
 * PAGE-IMAGE model). See db/docs/PDF_UPLOAD_DESIGN.md §"REVISION
 * (2026-07-08)" (authoritative) for the "why": Jared's real scans are a
 * vFlat export — a ZIP of ~500 high-res JPG page images (240 MB), not a
 * single <=15MB PDF. This module now accepts EITHER a zip-of-images or a
 * plain PDF and normalizes BOTH to an ORDERED SEQUENCE OF PAGE IMAGES before
 * anything is persisted — the DB (`book_pages`, migration 041) and the
 * viewer (`GET /uploads/:id/page/:n`) only ever deal in pages, never a whole
 * zip/PDF blob. The original upload is NOT retained once normalized (storage
 * savings — a book can be 240 MB; only its derived pages are kept).
 *
 * Split into two halves on the transaction boundary (Bar §"Concurrency": no
 * external I/O inside an open tx):
 *
 *   1. `ingestUpload()` — file presence + magic-byte sniff (zip vs. PDF) +
 *      the actual zip/PDF → page-images normalization + per-user daily cap.
 *      Pure validation + CPU-bound decode work (no network call — extraction/
 *      OCR is U2's separate, async/manual curation pass); throws typed 4xx
 *      AppErrors, writes NOTHING.
 *   2. `persistUpload(client, …)` — N page-blob writes + the `book_uploads`/
 *      `book_pages` INSERT-or-REPLACE, run inside the CALLER's transaction.
 *      Returns the PRIOR pages' blob refs (if this was a same-title replace)
 *      so the caller can delete the orphaned files AFTER the transaction
 *      commits (filesystem cleanup is not transactional, so it must not gate
 *      the DB commit).
 *
 * JUDGMENT CALL — synchronous processing: normalization (unzip/pdftoppm) now
 * runs INSIDE the request instead of being deferred to a background job. The
 * design doc explicitly leaves this as a judgment call ("OK to process async
 * ... your call"). Chosen SYNC because: (a) it's a personal, single-user app
 * (daily cap 10, effectively serial usage — no concurrent-upload contention
 * to worry about), (b) it avoids standing up a job queue/worker for a ~10s
 * worst case (a 240 MB zip's worth of JPEGs, or a few hundred pdftoppm pages),
 * (c) it keeps the request/response model — and the test suite — simple (one
 * call in, one call out, no polling). Trade-off: a very large upload ties up
 * one request/connection for its full processing time; if that ever becomes
 * painful in practice, flipping to async only requires moving the
 * `ingestUpload`/`persistUpload` call out of the request handler into a
 * background task and having the route return 202 with status='processing'
 * immediately — the schema (`book_upload_status` already has 'processing') and
 * the two-function split already support that without a redesign.
 *
 * SECURITY (mirrors imageIngest.ts's posture — see its header for the fuller
 * rationale; here restated for this surface):
 *   - UPLOAD: multer MEMORY storage, single `file` field, ~300 MiB cap
 *     (Jared's real books run up to ~240 MB), declared-mime `fileFilter` as
 *     an early reject only — the magic-byte sniff after multer is the
 *     authority (never trust the declared mime). `PK\x03\x04` -> zip,
 *     `%PDF-` -> PDF; anything else is rejected regardless of declared mime.
 *   - ZIP-BOMB / MALICIOUS-ARCHIVE: see services/zipPageExtract.ts's header
 *     (entry-count cap, per-entry + total declared-size caps checked before
 *     any decompression, non-image/dotfile/directory entries ignored).
 *   - PATH TRAVERSAL: each page's blob filename is a SERVER-generated UUID +
 *     the session user id (see uploadStore.ts); no client string (including
 *     zip entry filenames) ever enters a filesystem path — entry names are
 *     used ONLY for sort order, never as a path segment.
 *   - PER-USER CAP: a DAILY cap (config BOOK_UPLOAD_DAILY_CAP) on NEW titles
 *     -> 429. A same-title re-upload (idempotent replace) does NOT consume
 *     budget — the cap only guards against an unbounded number of DISTINCT
 *     uploads accumulating on disk, not iterative re-uploads while a title
 *     is still being dialed in.
 *   - ATOMICITY: every page blob write lives inside the caller's tx boundary
 *     (i.e. is followed by its `book_pages` INSERT before the tx commits); a
 *     DB failure partway through leaves orphan files (harmless, GC-able),
 *     never a half-written book. The REPLACED pages' blobs (on a same-title
 *     re-upload) are deleted only after the transaction commits, so a
 *     rolled-back request never deletes bytes a live row still points at.
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
import { saveBlob, type BlobExt } from './uploadStore.js';
import { extractZipPages, type PageImageMime } from './zipPageExtract.js';
import { renderPdfPagesToJpeg } from './pdfPageRender.js';

// ---------------------------------------------------------------------------
// Upload constraints + multer
// ---------------------------------------------------------------------------

/**
 * Declared-mime allowlist for the fileFilter's EARLY reject only — never the
 * authority (the magic-byte sniff in `ingestUpload` is). Zip archives arrive
 * under several different declared mimes depending on OS/browser/export tool
 * (a vFlat export is often `application/zip` or `application/x-zip-compressed`;
 * some browsers fall back to the generic `application/octet-stream` for any
 * binary they don't recognize), so this list is intentionally permissive —
 * being wrong here just means the request is 15-byte-sniffed and 400'd a
 * little later instead of at the fileFilter, never a security gap.
 */
export const ALLOWED_MIMES = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
] as const;

/** ~300 MiB — the design doc's cap ("Jared has the storage; a book is ~240MB").
 *  Bounds memory use (memory storage) AND per-request cost. */
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/** The `book_uploads.type` enum, mirrored here so Zod/TS agree with the DB
 *  enum (migration 040; 'comic' added by 072 — Track P's display-only
 *  picture/comic/manga type, never grammar-bearing or auto-OCR'd). */
export const BOOK_UPLOAD_TYPES = [
  'vocab',
  'grammar',
  'both',
  'dialogue',
  'literature',
  'comic',
] as const;
export type BookUploadType = (typeof BOOK_UPLOAD_TYPES)[number];

/**
 * multer MEMORY storage: the buffer never touches disk via multer. A
 * `fileFilter` rejects an obviously-wrong declared mime EARLY (saves
 * buffering up to 300 MiB for a `.exe`), but it is NOT trusted — the
 * magic-byte sniff in `ingestUpload` is the authority. `limits.files: 1` +
 * `.single('file')` reject extra files; `fields: 4` leaves room for the
 * `title` + `type` text fields alongside the file part.
 *
 * (Kept as memory storage rather than switching to disk storage despite the
 * 15 MiB -> 300 MiB cap bump: this is a personal, single-user app with a
 * daily cap of ~10 uploads — effectively serial usage, not concurrent load —
 * so a transient ~300-400 MB memory spike per request is an acceptable
 * trade-off against the real complexity disk storage would add (temp-file
 * lifecycle, cleanup-on-crash, path-safety for a second storage location).)
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
 * (oversize -> `LIMIT_FILE_SIZE`, unexpected field, too many files) would
 * otherwise reach the error handler as a generic 500. The size-limit error
 * maps to 413 Payload Too Large — the status the client keys "that upload is
 * too large" off of — and every other MulterError (unexpected field, too many
 * files/parts) maps to 400.
 */
export function multerBookUpload(req: Request, res: Response, next: NextFunction): void {
  uploadSingle(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError(
            `upload exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`,
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

/**
 * Sniff the leading bytes for the ZIP local-file-header signature
 * `PK\x03\x04` (0x50 0x4B 0x03 0x04) — the standard signature every
 * conforming zip (including a vFlat export) starts with. Per the design doc,
 * only this signature is recognized (not the empty-archive `PK\x05\x06` or
 * spanned-archive `PK\x07\x08` variants) — a zip with zero pages is rejected
 * downstream anyway (0 usable pages -> 400), so there's no case where those
 * variants would matter for this feature.
 */
export function sniffZipMagicBytes(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 && // P
    buf[1] === 0x4b && // K
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

type UploadKind = 'zip' | 'pdf';

/** Classify the upload by magic bytes only — never the client-declared mime. */
function sniffUploadKind(buf: Buffer): UploadKind | null {
  if (sniffZipMagicBytes(buf)) return 'zip';
  if (sniffPdfMagicBytes(buf)) return 'pdf';
  return null;
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
// Half 1: validate + normalize + cap (no writes)
// ---------------------------------------------------------------------------

/** One normalized page, ready to be saved as a blob + a `book_pages` row. */
export interface IngestedPage {
  readonly buffer: Buffer;
  readonly mime: PageImageMime;
}

/** The validated + normalized upload, ready to persist. Produced by
 *  `ingestUpload`, consumed by `persistUpload`. */
export interface IngestedUpload {
  readonly pages: readonly IngestedPage[];
  readonly byteSize: number;
  readonly title: string;
  readonly type: BookUploadType;
}

/**
 * Validate an uploaded zip/PDF, normalize it to ordered page images, and
 * enforce the per-user daily cap. Throws typed AppErrors (400 bad/missing
 * file, unsupported type, zip-bomb guard trip, corrupt PDF, 0 usable pages;
 * 429 cap); performs NO writes, so any failure here leaves the DB and blob
 * store untouched.
 *
 * Order of operations (security-load-bearing — mirrors ocrUploadedImage):
 *   1. file present + non-empty + magic-byte sniff (zip vs. PDF) -> 400 on
 *      any mismatch.
 *   2. normalize to ordered page images (extractZipPages / renderPdfPagesToJpeg)
 *      -> 400 on a zip-bomb guard trip, a corrupt/encrypted PDF, or 0 usable
 *      pages.
 *   3. per-user DAILY cap on NEW titles -> 429 (an existing-title replace is
 *      exempt — see module header).
 */
export async function ingestUpload(
  file: Express.Multer.File | undefined,
  body: { title: string; type: BookUploadType },
  userId: number,
): Promise<IngestedUpload> {
  // 1. File present + non-empty + magic-byte verified.
  if (!file || file.buffer.length === 0) {
    throw new ValidationError('a zip (vFlat export) or PDF file is required in the "file" field');
  }
  const kind = sniffUploadKind(file.buffer);
  if (kind === null) {
    throw new ValidationError(
      'uploaded file is neither a zip archive (PK\\x03\\x04) nor a PDF (%PDF-)',
    );
  }

  // 2. Normalize to ordered page images. Both branches throw ValidationError
  //    on a bad/malicious archive or an unreadable PDF — nothing is written.
  const pages: IngestedPage[] =
    kind === 'zip'
      ? await extractZipPages(file.buffer)
      : (await renderPdfPagesToJpeg(file.buffer)).map((buffer) => ({
          buffer,
          mime: 'image/jpeg' as const,
        }));

  if (pages.length === 0) {
    throw new ValidationError(
      kind === 'zip'
        ? 'zip archive contained no usable image pages (jpg/png)'
        : 'PDF contains no pages',
    );
  }

  // 3. Per-user DAILY cap on NEW titles only. An existing (user, title) row
  //    means this request is a REPLACE, which the loop below is specifically
  //    designed to exempt (see module header "PER-USER CAP").
  const existing = await query<{ id: number }>(
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
    pages,
    byteSize: file.buffer.length,
    title: body.title,
    type: body.type,
  };
}

// ---------------------------------------------------------------------------
// Half 2: persist (inside the CALLER's transaction)
// ---------------------------------------------------------------------------

/** Result of persisting an upload: the DTO to return, plus the PRIOR pages'
 *  blob refs (if this request replaced an existing same-title upload) so the
 *  caller can delete the orphaned files once the transaction has committed.
 *  Empty means either a brand-new upload or a replace of a title that
 *  (somehow) had zero pages — nothing to clean up either way. */
export interface PersistedUpload {
  readonly dto: BookUploadDTO;
  readonly priorBlobRefs: readonly string[];
  readonly wasNew: boolean;
}

interface UpsertRow {
  id: number;
  title: string;
  type: BookUploadType;
  status: 'processing' | 'ready' | 'failed';
  page_count: number | null;
  byte_size: number;
  created_at: Date;
}

function extForMime(mime: PageImageMime): BlobExt {
  return mime === 'image/png' ? 'png' : 'jpg';
}

/**
 * Persist a normalized upload: N page-blob writes + INSERT-or-REPLACE
 * `book_uploads` + N `book_pages` INSERTs, all on the caller's transaction
 * client. Each page's blob id is a fresh SERVER UUID — never client input —
 * so its path is injection-free.
 *
 * Idempotent replace: a re-upload of the SAME (user, title) UPSERTs the
 * `book_uploads` row (new type/byte_size/page_count, status stays 'ready' —
 * normalization already fully completed by the time this function runs, see
 * module header's "synchronous processing" note) and REPLACES its
 * `book_pages` rows outright: the OLD rows are deleted (their blob_refs
 * captured first, for the caller to unlink after commit) and the NEW pages
 * are inserted fresh. The row is locked (`FOR UPDATE`) BEFORE any of this so
 * two concurrent replaces of the same title serialize rather than
 * interleaving their page writes.
 */
export async function persistUpload(
  client: PoolClient,
  userId: number,
  ingested: IngestedUpload,
): Promise<PersistedUpload> {
  const existing = await client.query<{ id: number }>(
    `SELECT id FROM book_uploads WHERE user_id = $1 AND title = $2 FOR UPDATE`,
    [userId, ingested.title],
  );
  const existingId = existing.rows[0]?.id ?? null;
  const wasNew = existingId === null;

  let priorBlobRefs: string[] = [];
  if (existingId !== null) {
    const priorPages = await client.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM book_pages WHERE upload_id = $1`,
      [existingId],
    );
    priorBlobRefs = priorPages.rows.map((r) => r.blob_ref);
    // Replace outright: the new page set is NOT a merge/patch of the old one
    // (a re-scan is a different set of images entirely) — see module header.
    await client.query(`DELETE FROM book_pages WHERE upload_id = $1`, [existingId]);
  }

  const pageCount = ingested.pages.length;
  const { rows } = await client.query<UpsertRow>(
    `INSERT INTO book_uploads (user_id, title, type, status, byte_size, page_count)
     VALUES ($1, $2, $3::book_upload_type, 'ready', $4, $5)
     ON CONFLICT (user_id, title) DO UPDATE SET
       type       = EXCLUDED.type,
       status     = 'ready',
       byte_size  = EXCLUDED.byte_size,
       page_count = EXCLUDED.page_count,
       version    = book_uploads.version + 1
     RETURNING id, title, type, status, page_count, byte_size, created_at`,
    [userId, ingested.title, ingested.type, ingested.byteSize, pageCount],
  );
  const row = rows[0];
  if (!row) {
    // Defensive: an INSERT ... RETURNING always yields a row or throws.
    throw new Error('book_uploads upsert returned no row');
  }
  const uploadId = row.id;

  // Save each page's blob THEN insert its book_pages row, in order — so a
  // failure partway through leaves at most an orphan FILE (the matching DB
  // row was never written), never a DB row pointing at a missing file.
  for (let i = 0; i < ingested.pages.length; i += 1) {
    const page = ingested.pages[i]!;
    const blobRef = await saveBlob(userId, randomUUID(), extForMime(page.mime), page.buffer);
    await client.query(
      `INSERT INTO book_pages (upload_id, page_number, blob_ref) VALUES ($1, $2, $3)`,
      [uploadId, i + 1, blobRef],
    );
  }

  return {
    dto: {
      // Wire contract: upload ids are emitted as STRINGS (pre-int8-parser
      // behavior, pinned) — matches routes/uploads.ts toDTO.
      id: String(row.id),
      title: row.title,
      type: row.type,
      status: row.status,
      page_count: row.page_count,
      byte_size: row.byte_size,
      created_at: row.created_at.toISOString(),
    },
    priorBlobRefs,
    wasNew,
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
