/**
 * Filesystem blob store for uploaded-book PAGE IMAGES (U1a — the book-upload
 * feature, reworked to the page-image model — see
 * db/docs/PDF_UPLOAD_DESIGN.md §"REVISION (2026-07-08)").
 *
 * WHY this module exists: mirrors `services/imageStore.ts` (Pass 8 Images
 * screen) exactly, for the same reason — the upload route needs to persist
 * bytes so the viewer can later stream them back
 * (`GET /uploads/:id/page/:n`). Originally (pre-rework) this stored ONE PDF
 * blob per upload; it now stores ONE BLOB PER PAGE (a `book_pages` row per
 * call to `saveBlob`) — the original zip/PDF the user uploaded is never
 * itself retained (see `services/bookUploadIngest.ts`, `services/
 * zipPageExtract.ts`, `services/pdfPageRender.ts`), only its normalized page
 * images. Bytes live on the local filesystem under a single configured root
 * (`BOOK_UPLOAD_STORAGE_DIR`); Postgres keeps only a RELATIVE path
 * (`book_pages.blob_ref`). Same v1-store caveat as images: durable/offsite
 * (S3) is deferred.
 *
 * A separate root + module from imageStore.ts (rather than generalizing that
 * one) because the two blob kinds have nothing else in common (different
 * config knob, different size class, different delete lifecycle — uploads are
 * hard-deleted with their blobs; images are soft-deleted and keep theirs) and
 * keeping them apart avoids a shared module growing a "kind" parameter that
 * has to be threaded through every call. The SECURITY POSTURE is identical by
 * design — copy the reasoning, not just the code:
 *
 *   - PATH TRAVERSAL. `resolveUnderRoot` joins a stored relative path with the
 *     root and asserts the RESOLVED absolute path is still under the root. A
 *     stored value of `../../etc/passwd` (or an absolute path) resolves
 *     outside the root and is rejected before any read/write/unlink. No
 *     client string ever reaches the filesystem un-vetted.
 *   - INJECTION-FREE PATHS. `saveBlob` builds the path from the SESSION user
 *     id (a number) + a SERVER-generated UUID + an extension derived from the
 *     SNIFFED (magic-byte) page-image mime — never from the client filename
 *     or any client string.
 *   - The root is created lazily and the per-user subdirectory is `mkdir -p`'d
 *     so a fresh deploy / new user works without manual provisioning.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { loadConfig } from '../config/index.js';

/** The page-image blob-store extensions this module writes — one per
 *  `book_pages` row (jpg for `image/jpeg` pages, png for `image/png` pages;
 *  see bookUploadIngest.ts's ext-from-mime mapping). */
export type BlobExt = 'jpg' | 'png';

/** Absolute, resolved storage root from config. Computed per call so a
 *  test-time config override is honored (config is memoized, so this is cheap).
 *  Exported as `bookUploadStorageRoot` for `services/bookUploadIngest.ts`
 *  (the RAW-upload multer diskStorage destination) and
 *  `services/bookIngestRunner.ts` (both need the same root the page-blob
 *  writer below resolves against, so the raw source file and its decoded
 *  pages live under one configured tree). */
function storageRoot(): string {
  const cfg = loadConfig();
  return resolve(cfg.BOOK_UPLOAD_STORAGE_DIR);
}

export function bookUploadStorageRoot(): string {
  return storageRoot();
}

/**
 * Persist one page's blob and return its RELATIVE path (what goes in
 * `book_pages.blob_ref`). Called ONCE PER PAGE — a book with 548 pages calls
 * this 548 times, each with its own fresh UUID (bookUploadIngest.ts's
 * `persistUpload`).
 *
 * The path is `{userId}/{pageId}.{ext}` — built ENTIRELY from server-trusted
 * values: `userId` is the session user (a number), `pageId` is a
 * server-generated UUID (one per page, never the upload's id), `ext` is
 * derived from the SNIFFED page-image mime (never the client filename). No
 * client string is involved, so the path is injection-free by construction.
 *
 * @param userId  session user id (number — never client-supplied)
 * @param pageId  server-generated UUID for this PAGE (never client input)
 * @param ext     on-disk extension — 'jpg' or 'png', from the sniffed mime
 * @param buffer  the validated page-image bytes
 * @returns the relative path under the storage root
 */
export async function saveBlob(
  userId: number,
  pageId: string,
  ext: BlobExt,
  buffer: Buffer,
): Promise<string> {
  // userId is a number from the session; pageId is a server UUID. Guard
  // defensively anyway so a programming error can never write outside the root.
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('saveBlob: userId must be a positive integer');
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(pageId)) {
    throw new Error('saveBlob: pageId must be a UUID');
  }
  const relPath = `${userId}/${pageId}.${ext}`;
  const root = storageRoot();
  const userDir = join(root, String(userId));
  await mkdir(userDir, { recursive: true });
  const absPath = join(root, relPath);
  // Defense in depth: assert the destination is under the root even though we
  // built it from trusted inputs.
  assertUnderRoot(root, absPath);
  await writeFile(absPath, buffer, { flag: 'w' });
  return relPath;
}

/**
 * Resolve the RELATIVE path stored in the DB to an absolute, traversal-checked
 * path under the storage root. Shared by `readBlob`, `deleteBlob`, and the
 * streaming route (which needs the absolute path for `fs.stat`/
 * `createReadStream` rather than a full read).
 *
 * @throws Error if `relPath` is absolute or resolves outside the storage root.
 */
export function resolveUnderRoot(relPath: string): string {
  const root = storageRoot();
  if (isAbsolute(relPath)) {
    throw new Error('blob path must be relative');
  }
  const absPath = resolve(root, normalize(relPath));
  assertUnderRoot(root, absPath);
  return absPath;
}

/**
 * Read a blob given the RELATIVE path stored in the DB.
 *
 * The stored path is server-generated, but we treat it as untrusted on the way
 * back IN (a compromised/corrupt row, or a future code path that lets a client
 * influence it, must not be able to escape the root).
 *
 * @throws Error if the resolved path escapes the storage root (traversal).
 * @throws NodeJS ENOENT (caller maps a missing file to 404).
 */
export async function readBlob(relPath: string): Promise<Buffer> {
  return readFile(resolveUnderRoot(relPath));
}

/**
 * Delete a blob given the RELATIVE path stored in the DB. Idempotent: a
 * missing file (ENOENT) is treated as already-deleted, not an error — both
 * the DELETE route (blob may already be gone) and the idempotent-replace path
 * (deleting the PRIOR blob after a same-title re-upload lands the new one)
 * call this best-effort and must not fail the request over a stale FS state.
 *
 * @throws Error if the resolved path escapes the storage root (traversal) —
 *   this one we do NOT swallow, since it indicates a poisoned row, not a
 *   benign "already gone" state.
 */
export async function deleteBlob(relPath: string): Promise<void> {
  const absPath = resolveUnderRoot(relPath);
  try {
    await unlink(absPath);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Assert `absPath` is the root itself or strictly inside it. Compares on a
 * trailing-separator-normalized prefix so `/var/uploads-evil` is NOT treated
 * as under `/var/uploads`.
 */
function assertUnderRoot(root: string, absPath: string): void {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (absPath !== root && !absPath.startsWith(rootWithSep)) {
    throw new Error('blob path escapes storage root (path traversal blocked)');
  }
}
