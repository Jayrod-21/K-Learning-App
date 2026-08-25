/**
 * Book-upload ingest — request-side validation + enqueue helpers (U1a —
 * book-upload feature; Phase 2.5 — reworked to an ASYNC, bounded-memory
 * pipeline; see db/docs/PDF_UPLOAD_DESIGN.md §"REVISION (2026-07-08)" for the
 * original page-image model this still targets).
 *
 * THE OOM THIS MODULE USED TO CAUSE, AND THE FIX (Phase 2.5):
 *   Previously, `ingestUpload()` ran the ENTIRE zip/PDF decode SYNCHRONOUSLY
 *   inside the request — multer `memoryStorage` held the whole raw upload
 *   (up to 300 MiB) in heap, then every page (up to 2 GiB of zip entries, or
 *   up to 2000 rendered PDF pages) was decoded into one `IngestedPage[]`
 *   array, all resident together. km-server's 1 GiB cgroup limit OOM-killed
 *   the whole process on a large book (RECON.md). This module no longer
 *   decodes ANYTHING:
 *     - multer now uses **diskStorage** (below) — the raw upload is written
 *       straight to the km_book_uploads volume, never buffered in Node heap.
 *     - The zip/PDF -> page-image DECODE moved entirely to the in-process
 *       ingest runner (`services/bookIngestRunner.ts`), which streams ONE
 *       page at a time via `zipPageExtract.ts`'s / `pdfPageRender.ts`'s async
 *       generators — see that module's header for the bounded-memory
 *       contract.
 *   What THIS module still owns (the request-path half — fast, no
 *   decoding): raw-file multer plumbing, magic-byte sniffing of the raw
 *   file, and the per-user daily-cap check. `routes/uploads.ts`'s POST
 *   handler uses these to validate + enqueue a `book_uploads` row with
 *   `status = 'pending'` and returns 202 immediately; the runner does the
 *   rest.
 *
 * SECURITY (mirrors imageIngest.ts's posture — see its header for the fuller
 * rationale; here restated for this surface):
 *   - UPLOAD: multer DISK storage (Phase 2.5 — was memory storage), single
 *     `file` field, ~300 MiB cap (Jared's real books run up to ~240 MB),
 *     declared-mime `fileFilter` as an early reject only — the magic-byte
 *     sniff (`sniffUploadedFileKind`, reading only the file's first bytes
 *     off disk, never the whole thing) is the authority (never trust the
 *     declared mime). `PK\x03\x04` -> zip, `%PDF-` -> PDF; anything else is
 *     rejected regardless of declared mime.
 *   - RAW-FILE PATH: written under `BOOK_UPLOAD_STORAGE_DIR/raw/{userId}/`
 *     with a SERVER-generated UUID filename (multer's `filename` callback) —
 *     no client string (including the client's original filename) ever
 *     enters a filesystem path. Same traversal-guard contract as
 *     `book_pages.blob_ref` (uploadStore.ts's `resolveUnderRoot`, reused by
 *     the runner to open and later delete this file).
 *   - ZIP-BOMB / MALICIOUS-ARCHIVE / PDF-BOMB guards: unchanged, still fully
 *     enforced — just later, by the runner at decode time (see
 *     zipPageExtract.ts / pdfPageRender.ts headers). The request path never
 *     decodes, so it can't be exhausted by a bomb either.
 *   - PER-USER CAP: a DAILY cap (config BOOK_UPLOAD_DAILY_CAP) on NEW titles
 *     -> 429, checked BEFORE the row is written (routes/uploads.ts, inside
 *     the same transaction as the existing-row lookup so the check can't be
 *     raced). A same-title re-upload (idempotent replace) does NOT consume
 *     budget — the cap only guards against an unbounded number of DISTINCT
 *     uploads accumulating on disk, not iterative re-uploads while a title
 *     is still being dialed in.
 *   - MASS ASSIGNMENT: `title`/`type` are the only two body fields, both
 *     validated by a `.strict()` Zod schema at the route boundary (routes/
 *     uploads.ts) before this module ever sees them.
 */
import multer, { MulterError } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { getUserId } from '../middleware/auth.js';
import { AppError, PayloadTooLargeError, ValidationError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import type { Querier } from '../db/pool.js';
import { bookUploadStorageRoot, saveBlob, type BlobExt } from './uploadStore.js';
import type { PageImageMime } from './zipPageExtract.js';

// ---------------------------------------------------------------------------
// Upload constraints + multer (DISK storage — Phase 2.5)
// ---------------------------------------------------------------------------

/**
 * Declared-mime allowlist for the fileFilter's EARLY reject only — never the
 * authority (the magic-byte sniff is). Zip archives arrive under several
 * different declared mimes depending on OS/browser/export tool (a vFlat
 * export is often `application/zip` or `application/x-zip-compressed`; some
 * browsers fall back to the generic `application/octet-stream` for any
 * binary they don't recognize), so this list is intentionally permissive —
 * being wrong here just means the request is byte-sniffed and 400'd a little
 * later instead of at the fileFilter, never a security gap.
 */
export const ALLOWED_MIMES = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
] as const;

/** ~300 MiB — the design doc's cap ("Jared has the storage; a book is ~240MB").
 *  Bounds per-request disk cost (multer's diskStorage `limits.fileSize` — the
 *  raw upload NEVER touches Node heap at all now, see module header). */
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

/** Raw-upload subtree under BOOK_UPLOAD_STORAGE_DIR — kept separate from the
 *  per-page blob paths `uploadStore.ts` writes (`{userId}/{uuid}.{jpg|png}`)
 *  so "durable decoded page" and "transient raw source file awaiting decode"
 *  are distinguishable by path shape alone, and so a future sweep of stale
 *  raw files (jobRetention.ts) can target this subtree specifically. */
const RAW_UPLOAD_SUBDIR = 'raw';

/** The raw-upload directory for one user — `mkdir -p`'d lazily by multer's
 *  `destination` callback below, same posture as uploadStore.ts's per-user
 *  page-blob directory. */
function rawUploadDir(userId: number): string {
  return join(bookUploadStorageRoot(), RAW_UPLOAD_SUBDIR, String(userId));
}

/** The RELATIVE path (what the route stores as `book_uploads.raw_blob_ref`)
 *  for a raw file multer just wrote — `userId` from the session, `filename`
 *  from multer's own `filename` callback (a server-generated UUID, never
 *  client input). Resolved back to an absolute path the SAME way a page
 *  blob's `blob_ref` is — `uploadStore.ts`'s `resolveUnderRoot` — so the
 *  runner reads/deletes it with the identical traversal guard. */
export function bookUploadRawRelPath(userId: number, filename: string): string {
  return `${RAW_UPLOAD_SUBDIR}/${userId}/${filename}`;
}

/**
 * multer DISK storage (Phase 2.5 — was memory storage; see module header for
 * why). The raw upload is written straight to the km_book_uploads volume
 * under the caller's own subdirectory; `requireAuth` (router.use, ahead of
 * this middleware in routes/uploads.ts) has already populated `req.user` by
 * the time this `destination` callback runs, so `getUserId` is safe to call
 * here. The `filename` is a fresh SERVER UUID — never the client's original
 * filename — so the resulting path is injection-free by construction, same
 * guarantee `uploadStore.saveBlob` gives page blobs.
 *
 * `fileFilter` rejects an obviously-wrong declared mime EARLY (saves writing
 * up to 300 MiB for a `.exe`), but it is NOT trusted — the magic-byte sniff
 * (`sniffUploadedFileKind`, below) is the authority. `limits.files: 1` +
 * `.single('file')` reject extra files; `fields: 4` leaves room for the
 * `title` + `type` text fields alongside the file part. A file that fails
 * `limits.fileSize` is auto-unlinked by multer itself (diskStorage's
 * documented behavior) — no orphan to clean up for that case; every OTHER
 * post-multer validation failure is the route's job to clean up (it has the
 * path; see routes/uploads.ts).
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      let userId: number;
      try {
        userId = getUserId(req as Request);
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)), '');
        return;
      }
      const dir = rawUploadDir(userId);
      mkdir(dir, { recursive: true })
        .then(() => cb(null, dir))
        .catch((err: unknown) => cb(err instanceof Error ? err : new Error(String(err)), dir));
    },
    filename: (_req, _file, cb) => {
      cb(null, `${randomUUID()}.raw`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIMES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      // Reject without throwing — surfaces as no `req.file`, mapped to 400
      // by the route's presence check.
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

// ---------------------------------------------------------------------------
// Magic-byte sniffing (unchanged detection, now reads from DISK not a Buffer
// already in memory — both the route and the runner re-open the raw file by
// its stored relative path, so this operates on a small head-read either way)
// ---------------------------------------------------------------------------

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
 * downstream anyway (0 usable pages -> failed), so there's no case where
 * those variants would matter for this feature.
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

export type UploadKind = 'zip' | 'pdf';

/** Classify by magic bytes only — never the client-declared mime. Exported:
 *  both the route (validating the just-written raw file) and the runner
 *  (re-opening it later, in its own process tick) need this exact
 *  classification and must never disagree. */
export function sniffUploadKind(buf: Buffer): UploadKind | null {
  if (sniffZipMagicBytes(buf)) return 'zip';
  if (sniffPdfMagicBytes(buf)) return 'pdf';
  return null;
}

/** Bytes needed to sniff either signature (`%PDF-` is the longer of the two,
 *  at 5). A little headroom costs nothing and a head-read is always this
 *  small regardless of the file's real size. */
export const UPLOAD_HEAD_SNIFF_BYTES = 8;

/**
 * Read the first `n` bytes of a file on disk WITHOUT loading the rest — used
 * to magic-byte-sniff a raw upload that can be up to 300 MiB, never buffering
 * more than a handful of bytes regardless of the real file size. Shared by
 * `sniffUploadedFileKind` below and `bookIngestRunner.ts` (which re-sniffs
 * the same raw file to pick a decoder, rather than trusting a stored "kind"
 * column — one fewer piece of persisted state that could drift from the
 * actual bytes on disk).
 */
export async function readFileHead(absPath: string, n: number): Promise<Buffer> {
  const fh = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Validate a just-written raw file (already on disk via `multerBookUpload`'s
 * diskStorage) is a real zip or PDF. Throws `ValidationError` (400) — never
 * trusts the declared mime. Performs NO writes/deletes; the caller (the
 * route) owns cleaning up the raw file on any validation failure (it has the
 * path; this function only reads).
 */
export async function sniffUploadedFileKind(absPath: string): Promise<UploadKind> {
  const head = await readFileHead(absPath, UPLOAD_HEAD_SNIFF_BYTES);
  const kind = sniffUploadKind(head);
  if (kind === null) {
    throw new ValidationError(
      'uploaded file is neither a zip archive (PK\\x03\\x04) nor a PDF (%PDF-)',
    );
  }
  return kind;
}

// ---------------------------------------------------------------------------
// Daily cap
// ---------------------------------------------------------------------------

/**
 * Per-user DAILY cap check for a BRAND-NEW title, run inside the CALLER's
 * transaction (routes/uploads.ts's enqueue transaction, which already holds
 * a row lock serializing concurrent requests for the same user — see that
 * route's header) so the check can't be raced past by two concurrent
 * uploads. Only relevant when NO existing (user, title) row exists yet — a
 * same-title replace of a terminal row is exempt (unchanged posture from the
 * sync-era `ingestUpload`; see this module's header "PER-USER CAP").
 * Throws `DailyCapError` (429) over the cap; performs no write itself.
 *
 * Takes a `Querier` (db/pool.ts) rather than a raw `PoolClient` — routes/
 * uploads.ts (where the caller lives) may not import `pg` directly
 * (eslint's route/pg boundary guardrail); `clientQuerier(client)` adapts its
 * `withTransaction` client into this shape.
 */
export async function assertUnderDailyCap(db: Querier, userId: number): Promise<void> {
  const cfg = loadConfig();
  const { rows } = await db<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM book_uploads
      WHERE user_id = $1
        AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  const usedToday = Number(rows[0]?.n ?? '0');
  if (usedToday >= cfg.BOOK_UPLOAD_DAILY_CAP) {
    throw new DailyCapError(cfg.BOOK_UPLOAD_DAILY_CAP);
  }
}

// ---------------------------------------------------------------------------
// Whole-book synchronous persist — OPERATOR CLI ONLY (scripts/bulk-ingest-
// books.ts), NOT the HTTP request path. The CLI reads archives straight off
// local disk (not through POST /uploads) and has no request/OOM concern of
// its own (an operator-run batch job, sequential, one book fully in memory
// at a time — mirrors its own long-standing posture, unchanged by Phase
// 2.5). It still needs a "here are N ordered pages, persist them" primitive,
// so that stays here rather than being deleted; `bookIngestRunner.ts` is the
// STREAMING equivalent for the async HTTP path and shares `persistOnePage`
// below so the actual blob-write + row-insert logic lives in exactly one
// place regardless of caller.
// ---------------------------------------------------------------------------

/** One normalized page, ready to be saved as a blob + a `book_pages` row
 *  (CLI's whole-array shape; the runner instead consumes the streaming
 *  generators' `ExtractedPage` one at a time — same `{buffer, mime}` shape). */
export interface IngestedPage {
  readonly buffer: Buffer;
  readonly mime: PageImageMime;
}

/** The CLI's normalized-and-ready-to-persist upload. */
export interface IngestedUpload {
  readonly pages: readonly IngestedPage[];
  readonly byteSize: number;
  readonly title: string;
  readonly type: BookUploadType;
}

/** Result of persisting an upload: the DTO to return, plus the PRIOR pages'
 *  blob refs (if this request replaced an existing same-title upload) so the
 *  caller can delete the orphaned files once the transaction has committed. */
export interface PersistedUpload {
  readonly dto: BookUploadDTO;
  readonly priorBlobRefs: readonly string[];
  readonly wasNew: boolean;
}

interface UpsertRow {
  id: number;
  title: string;
  type: BookUploadType;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  page_count: number | null;
  byte_size: number;
  error: string | null;
  created_at: Date;
}

/** Page-image mime -> on-disk blob extension. Exported so
 *  `bookIngestRunner.ts` (which writes page blobs one at a time via a plain
 *  pooled query, NOT this module's `persistOnePage`/`PoolClient`-bound
 *  helper — see that module's header for why) uses the identical mapping. */
export function extForMime(mime: PageImageMime): BlobExt {
  return mime === 'image/png' ? 'png' : 'jpg';
}

/**
 * Save ONE page's blob then insert its `book_pages` row, in that order — a
 * failure partway through leaves at most an orphan FILE (the matching DB row
 * was never written), never a DB row pointing at a missing file. Shared by
 * `persistUpload` below (looped over a whole array, CLI) and
 * `bookIngestRunner.ts` (looped over a streaming generator, one page at a
 * time, HTTP path) — the ONE place page persistence actually happens.
 */
export async function persistOnePage(
  client: PoolClient,
  userId: number,
  uploadId: number,
  pageNumber: number,
  page: IngestedPage,
): Promise<void> {
  const blobRef = await saveBlob(userId, randomUUID(), extForMime(page.mime), page.buffer);
  await client.query(
    `INSERT INTO book_pages (upload_id, page_number, blob_ref) VALUES ($1, $2, $3)`,
    [uploadId, pageNumber, blobRef],
  );
}

/**
 * Persist a normalized upload SYNCHRONOUSLY, whole-array: N page-blob writes
 * + INSERT-or-REPLACE `book_uploads` (status set straight to 'ready' — this
 * caller already has every page in hand) + N `book_pages` INSERTs, all on the
 * caller's transaction client. CLI-ONLY (`scripts/bulk-ingest-books.ts`) —
 * the HTTP path never calls this; see `bookIngestRunner.ts` for the async
 * per-page streaming equivalent.
 *
 * Idempotent replace: a re-run of the SAME (user, title) UPSERTs the
 * `book_uploads` row (new type/byte_size/page_count) and REPLACES its
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
       error      = NULL,
       byte_size  = EXCLUDED.byte_size,
       page_count = EXCLUDED.page_count,
       version    = book_uploads.version + 1
     RETURNING id, title, type, status, page_count, byte_size, error, created_at`,
    [userId, ingested.title, ingested.type, ingested.byteSize, pageCount],
  );
  const row = rows[0];
  if (!row) {
    // Defensive: an INSERT ... RETURNING always yields a row or throws.
    throw new Error('book_uploads upsert returned no row');
  }
  const uploadId = row.id;

  for (let i = 0; i < ingested.pages.length; i += 1) {
    await persistOnePage(client, userId, uploadId, i + 1, ingested.pages[i]!);
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
      error: row.error,
      created_at: row.created_at.toISOString(),
    },
    priorBlobRefs,
    wasNew,
  };
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export interface BookUploadDTO {
  readonly id: string;
  readonly title: string;
  readonly type: BookUploadType;
  readonly status: 'pending' | 'processing' | 'ready' | 'failed';
  readonly page_count: number | null;
  readonly byte_size: number;
  /** Bounded, server-authored failure message (bookIngestRunner.ts's
   *  `failureMessage`) — non-null only when `status === 'failed'`. */
  readonly error: string | null;
  readonly created_at: string;
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
