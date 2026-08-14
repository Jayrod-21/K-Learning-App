/**
 * Filesystem blob store for uploaded images (Pass 8, Images screen).
 *
 * WHY this module exists: the OCR route needs to persist the uploaded photo so
 * the client can later render it (`GET /images/:id/blob`). We store the bytes on
 * the local filesystem under a single configured root (`IMAGE_STORAGE_DIR`) and
 * keep only a RELATIVE path in Postgres. This is the v1 store; durable/offsite
 * (S3) is deferred — see SECURITY.md §16.
 *
 * SECURITY (the whole reason this is its own module, see SECURITY.md §16):
 *   - PATH TRAVERSAL. `readBlob` joins the stored relative path with the root
 *     and asserts the RESOLVED absolute path is still under the root. A stored
 *     value of `../../etc/passwd` (or an absolute path) resolves outside the
 *     root and is rejected before any read. No client string ever reaches the
 *     filesystem un-vetted.
 *   - INJECTION-FREE PATHS. `saveBlob` builds the path from the SESSION user id
 *     (a number) + a SERVER-generated UUID + a fixed extension — never from the
 *     client filename or any client string. So a malicious filename cannot
 *     steer where bytes land.
 *   - The root is created lazily and the per-user subdirectory is `mkdir -p`'d
 *     so a fresh deploy / new user works without manual provisioning.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { loadConfig } from '../config/index.js';

/** Map a sniffed mime to the on-disk extension. Closed set = the upload
 *  allowlist; an unknown mime never reaches here (the route rejects it). */
const MIME_TO_EXT: Readonly<Record<string, 'jpg' | 'png' | 'webp'>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The blob-store extensions we ever write. */
export type BlobExt = (typeof MIME_TO_EXT)[keyof typeof MIME_TO_EXT];

/** Resolve a sniffed mime to its on-disk extension, or null if unsupported. */
export function extForMime(mime: string): BlobExt | null {
  return MIME_TO_EXT[mime] ?? null;
}

/** Absolute, resolved storage root from config. Computed per call so a
 *  test-time config override is honored (config is memoized, so this is cheap). */
function storageRoot(): string {
  const cfg = loadConfig();
  return resolve(cfg.IMAGE_STORAGE_DIR);
}

/**
 * Persist a blob and return its RELATIVE path (what goes in
 * `image_captures.blob_path`).
 *
 * The path is `{userId}/{captureId}.{ext}` — built ENTIRELY from server-trusted
 * values: `userId` is the session user (a number), `captureId` is a
 * server-generated UUID, `ext` is derived from the sniffed mime. No client
 * string is involved, so the path is injection-free by construction.
 *
 * @param userId    session user id (number — never client-supplied)
 * @param captureId server-generated UUID for this capture (never client input)
 * @param ext       on-disk extension from `extForMime(mime)`
 * @param buffer    the validated image bytes
 * @returns the relative path under the storage root
 */
export async function saveBlob(
  userId: number,
  captureId: string,
  ext: BlobExt,
  buffer: Buffer,
): Promise<string> {
  // userId is a number from the session; captureId is a server UUID. Guard
  // defensively anyway so a programming error can never write outside the root.
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('saveBlob: userId must be a positive integer');
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(captureId)) {
    throw new Error('saveBlob: captureId must be a UUID');
  }
  const relPath = `${userId}/${captureId}.${ext}`;
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
 * Read a blob given the RELATIVE path stored in the DB.
 *
 * The stored path is server-generated, but we treat it as untrusted on the way
 * back IN (a compromised/corrupt row, or a future code path that lets a client
 * influence it, must not be able to escape the root). We normalize, join with
 * the root, and assert the resolved path stays under the root before reading.
 *
 * @throws Error if the resolved path escapes the storage root (traversal).
 * @throws NodeJS ENOENT (caller maps a missing file to 404).
 */
export async function readBlob(relPath: string): Promise<Buffer> {
  const root = storageRoot();
  // Reject anything that even looks like an absolute path or a parent escape
  // before resolving, so the error is specific.
  if (isAbsolute(relPath)) {
    throw new Error('readBlob: blob path must be relative');
  }
  const absPath = resolve(root, normalize(relPath));
  assertUnderRoot(root, absPath);
  return readFile(absPath);
}

/**
 * Delete a blob given its RELATIVE path (F-211 — the story-image runner's
 * best-effort cleanup after a rolled-back persist; mirrors
 * audioStore.deleteBlob). Same traversal posture as readBlob: the stored
 * path is treated as untrusted on the way back in. A missing file is NOT an
 * error (idempotent — the cleanup may race an operator sweep).
 *
 * @throws Error if the resolved path escapes the storage root (traversal).
 */
export async function deleteBlob(relPath: string): Promise<void> {
  const root = storageRoot();
  if (isAbsolute(relPath)) {
    throw new Error('deleteBlob: blob path must be relative');
  }
  const absPath = resolve(root, normalize(relPath));
  assertUnderRoot(root, absPath);
  try {
    await unlink(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Assert `absPath` is the root itself or strictly inside it. Compares on a
 * trailing-separator-normalized prefix so `/var/images-evil` is NOT treated as
 * under `/var/images`.
 */
function assertUnderRoot(root: string, absPath: string): void {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (absPath !== root && !absPath.startsWith(rootWithSep)) {
    throw new Error('blob path escapes storage root (path traversal blocked)');
  }
}
