/**
 * Shared corpus-image resolution + serving (F-120 Phase 1) — the ONE place a
 * DB-stored corpus-relative `image_ref` (topik_items, migration 085) becomes
 * bytes on the wire. The path-resolution guard is NOT re-implemented here:
 * {@link resolveCorpusFile} (services/corpusAudio.ts — extracted content-type-
 * agnostic for exactly this consumer) supplies the identical absolute-path /
 * traversal / symlink / existence defenses, anchored under CORPUS_IMAGE_DIR
 * instead of CORPUS_AUDIO_DIR, so the audio and image surfaces can never
 * drift on containment or 404 behavior.
 *
 * Division of labor (corpusAudio.ts's exact shape):
 *   - Callers own WHICH row the image_ref came from and the SQL that fetched
 *     it (routes/topik.ts `GET /topik/image/:testNumber/:level/:itemNumber`).
 *   - This module owns turning that stored key into a safe absolute file and
 *     sending it with the corpus-image header policy.
 *
 * SECURITY (per the route file's threat model, restated for the shared part):
 *   - image_ref comes ONLY from DB rows written by the corpus loader, NEVER
 *     from user input — but defense in depth still treats the stored value as
 *     hostile (poisoned row / future code path); see resolveCorpusFile's doc.
 *   - Content-Type is derived from the STORED key's extension against a
 *     closed allow-map (png/webp/jpeg) — server state, never client input —
 *     and an unknown extension is a uniform 404, never a sniffable
 *     octet-stream. X-Content-Type-Options: nosniff pins the browser to it.
 *   - Every rejection is a uniform NotFoundError with the ONE
 *     'no image for this item' message, so this surface can never be used as
 *     an existence oracle for the host filesystem (the audio surface's exact
 *     posture).
 *   - No Range support BY DESIGN: the crops are small single-request images —
 *     Range parsing here would be pure attack surface (unlike the 38–85 MB
 *     MP3s, where seeking needs it).
 */
import { createReadStream } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { getLogger } from '../logging.js';
import { NotFoundError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { resolveCorpusFile } from './corpusAudio.js';

/** The ONE 404 message every miss on the image surface serializes to. */
export const CORPUS_IMAGE_NOT_FOUND = 'no image for this item';

/**
 * Closed extension → Content-Type allow-map (the extractor emits only these
 * three formats). Lower-cased lookup; anything else — including an
 * extension-less key — is a uniform 404 rather than a guessed type.
 */
const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Resolve a stored image_ref's Content-Type from its extension, or undefined
 * (→ the caller's uniform 404). Object.hasOwn first — IMAGE_CONTENT_TYPES is
 * a plain object literal, so a bare index with a prototype-chain key
 * ('constructor', '__proto__', 'toString') would return an inherited value
 * (the resolveTopikAudioLevel hardening, applied to this map). Exported for
 * the unit test that pins the closed set.
 */
export function resolveImageContentType(imageRef: string): string | undefined {
  const ext = extname(imageRef).toLowerCase();
  return Object.hasOwn(IMAGE_CONTENT_TYPES, ext)
    ? IMAGE_CONTENT_TYPES[ext]
    : undefined;
}

/**
 * Send the corpus image a stored image_ref names: resolve it inside
 * CORPUS_IMAGE_DIR (the shared guard), then stream the bytes with the
 * corpus-image header policy — Content-Type from the stored extension,
 * nosniff, a full day of private caching (the corpus is immutable, so
 * replays never re-download), explicit Content-Length, no Range.
 *
 * EVERY miss — NULL/absent ref, unknown extension, traversal/symlink
 * rejection, missing file — is the same uniform 404 (see module header).
 */
export async function sendCorpusImage(
  _req: Request,
  res: Response,
  next: NextFunction,
  imageRef: string | null,
): Promise<void> {
  // Content-Type first: an unmapped extension must 404 BEFORE any fs work
  // (same uniform message — the wire never says why).
  const contentType = imageRef !== null ? resolveImageContentType(imageRef) : undefined;
  if (imageRef === null || contentType === undefined) {
    throw new NotFoundError(CORPUS_IMAGE_NOT_FOUND);
  }
  const { absPath, size } = await resolveCorpusFile(imageRef, {
    root: resolve(loadConfig().CORPUS_IMAGE_DIR),
    notFoundMessage: CORPUS_IMAGE_NOT_FOUND,
    logContext: 'corpus image',
  });

  res.status(200);
  res.setHeader('Content-Type', contentType);
  // The browser must honor our Content-Type, never sniff the bytes (helmet()
  // already sets this globally; setting it here keeps the guarantee local
  // rather than hostage to middleware ordering — rangeStream's stance).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Length', size);

  const stream = createReadStream(absPath);
  stream.on('error', (err) => {
    // File vanished / IO error mid-stream (rangeStream's exact handling): if
    // headers are gone we can only sever the connection; otherwise a
    // stat→open ENOENT race is a missing resource (uniform 404), anything
    // else surfaces as a clean 500 via the handler.
    getLogger().error({ err, absPath }, 'corpus image: stream error');
    stream.destroy();
    if (res.headersSent) {
      res.destroy();
    } else {
      const code = (err as NodeJS.ErrnoException).code;
      next(code === 'ENOENT' ? new NotFoundError(CORPUS_IMAGE_NOT_FOUND) : err);
    }
  });
  // Client disconnect: stop reading promptly (frees the fd).
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
