/**
 * Filesystem blob store for uploaded book PDFs (U1a — PDF book-upload feature).
 *
 * WHY this module exists: mirrors `services/imageStore.ts` (Pass 8 Images
 * screen) exactly, for the same reason — the upload route needs to persist
 * the PDF bytes so the viewer can later stream them back
 * (`GET /uploads/:id/file`). Bytes live on the local filesystem under a single
 * configured root (`BOOK_UPLOAD_STORAGE_DIR`); Postgres keeps only a RELATIVE
 * path (`book_uploads.blob_ref`). Same v1-store caveat as images: durable/
 * offsite (S3) is deferred.
 *
 * A separate root + module from imageStore.ts (rather than generalizing that
 * one) because the two blob kinds have nothing else in common (different
 * config knob, different size class, different delete lifecycle — uploads are
 * hard-deleted with their blob; images are soft-deleted and keep theirs) and
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
 *     id (a number) + a SERVER-generated UUID + a fixed extension ('.pdf') —
 *     never from the client filename or any client string.
 *   - The root is created lazily and the per-user subdirectory is `mkdir -p`'d
 *     so a fresh deploy / new user works without manual provisioning.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { loadConfig } from '../config/index.js';

/** The one blob-store extension this module ever writes (PDF-only upload). */
export type BlobExt = 'pdf';

/** Absolute, resolved storage root from config. Computed per call so a
 *  test-time config override is honored (config is memoized, so this is cheap). */
function storageRoot(): string {
  const cfg = loadConfig();
  return resolve(cfg.BOOK_UPLOAD_STORAGE_DIR);
}

/**
 * Persist a blob and return its RELATIVE path (what goes in
 * `book_uploads.blob_ref`).
 *
 * The path is `{userId}/{uploadId}.{ext}` — built ENTIRELY from server-trusted
 * values: `userId` is the session user (a number), `uploadId` is a
 * server-generated UUID, `ext` is fixed ('pdf'). No client string is involved,
 * so the path is injection-free by construction.
 *
 * @param userId    session user id (number — never client-supplied)
 * @param uploadId  server-generated UUID for this upload (never client input)
 * @param ext       on-disk extension (always 'pdf' today)
 * @param buffer    the validated PDF bytes
 * @returns the relative path under the storage root
 */
export async function saveBlob(
  userId: number,
  uploadId: string,
  ext: BlobExt,
  buffer: Buffer,
): Promise<string> {
  // userId is a number from the session; uploadId is a server UUID. Guard
  // defensively anyway so a programming error can never write outside the root.
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('saveBlob: userId must be a positive integer');
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(uploadId)) {
    throw new Error('saveBlob: uploadId must be a UUID');
  }
  const relPath = `${userId}/${uploadId}.${ext}`;
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
