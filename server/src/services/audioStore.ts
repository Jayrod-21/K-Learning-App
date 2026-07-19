/**
 * Filesystem blob store for user-uploaded AUDIO TRACKS (Track A, A-3 — the
 * server-side audio upload path). One blob per `audio_tracks` row; Postgres
 * keeps only the RELATIVE path (`audio_tracks.blob_ref`, migration 074) under
 * a single configured root (`AUDIO_UPLOAD_STORAGE_DIR`).
 *
 * WHY a sibling of `services/uploadStore.ts` rather than a generalization of
 * it: same reasoning as uploadStore vs. imageStore (see uploadStore.ts's
 * header) — the blob kinds share NOTHING but mechanism. Different config knob,
 * different size class (a 100 MB mp3 vs. a 500 KB page JPEG), different
 * lifecycle (audio blobs are read by a SEPARATE process — the km-worker
 * Whisper container mounts this root read-only, tools/audio_stt/blobstore.py —
 * while page images are only ever read back by this server), and a different
 * deploy story (the km_audio_uploads volume is rw here, ro on the worker).
 * Generalizing would grow a "kind" parameter threaded through every call for
 * zero shared behavior. The SECURITY POSTURE is copied verbatim by design:
 *
 *   - PATH TRAVERSAL. `resolveUnderRoot` joins a stored relative path with the
 *     root and asserts the RESOLVED absolute path is still under the root. A
 *     stored value of `../../etc/passwd` (or an absolute path) resolves
 *     outside the root and is rejected before any read/write/unlink. No
 *     client string ever reaches the filesystem un-vetted.
 *   - INJECTION-FREE PATHS. `saveBlob` builds the path from the SESSION user
 *     id (a number) + a SERVER-generated UUID + an extension derived from the
 *     SNIFFED (magic-byte) audio mime (audioUploadIngest.ts) — never from the
 *     client filename or any client string.
 *   - The root is created lazily and the per-user subdirectory is `mkdir -p`'d
 *     so a fresh deploy / new user works without manual provisioning.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { loadConfig } from '../config/index.js';

/** The audio blob-store extensions this module writes — one per
 *  `audio_tracks` row ('mp3' for MPEG audio, 'm4a' for ISO-BMFF/AAC audio;
 *  see audioUploadIngest.ts's magic-byte sniff → ext mapping). */
export type AudioBlobExt = 'mp3' | 'm4a';

/** Absolute, resolved storage root from config. Computed per call so a
 *  test-time config override is honored (config is memoized, so this is cheap). */
function storageRoot(): string {
  const cfg = loadConfig();
  return resolve(cfg.AUDIO_UPLOAD_STORAGE_DIR);
}

/**
 * Persist one track's audio blob and return its RELATIVE path (what goes in
 * `audio_tracks.blob_ref`).
 *
 * The path is `{userId}/{blobId}.{ext}` — built ENTIRELY from server-trusted
 * values: `userId` is the session user (a number), `blobId` is a
 * server-generated UUID, `ext` is derived from the SNIFFED audio mime (never
 * the client filename). No client string is involved, so the path is
 * injection-free by construction.
 *
 * @param userId  session user id (number — never client-supplied)
 * @param blobId  server-generated UUID for this track's blob (never client input)
 * @param ext     on-disk extension — 'mp3' or 'm4a', from the sniffed mime
 * @param buffer  the validated audio bytes
 * @returns the relative path under the storage root
 */
export async function saveBlob(
  userId: number,
  blobId: string,
  ext: AudioBlobExt,
  buffer: Buffer,
): Promise<string> {
  // userId is a number from the session; blobId is a server UUID. Guard
  // defensively anyway so a programming error can never write outside the root.
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('saveBlob: userId must be a positive integer');
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(blobId)) {
    throw new Error('saveBlob: blobId must be a UUID');
  }
  const relPath = `${userId}/${blobId}.${ext}`;
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
 * (A-4) streaming route, which will need the absolute path for
 * `fs.stat`/`createReadStream` rather than a full read.
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
 * missing file (ENOENT) is treated as already-deleted, not an error — callers
 * (rollback cleanup after a failed upload transaction; a future DELETE route)
 * invoke this best-effort and must not fail over a stale FS state.
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
 * trailing-separator-normalized prefix so `/var/audio-uploads-evil` is NOT
 * treated as under `/var/audio-uploads`.
 */
function assertUnderRoot(root: string, absPath: string): void {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (absPath !== root && !absPath.startsWith(rootWithSep)) {
    throw new Error('blob path escapes storage root (path traversal blocked)');
  }
}
