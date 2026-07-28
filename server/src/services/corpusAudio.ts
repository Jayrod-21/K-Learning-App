/**
 * Shared corpus-audio resolution + streaming — the ONE place a DB-stored
 * corpus-relative audio_path becomes bytes on the wire. Extracted from
 * routes/ttmik.ts (F-012) when the TOPIK mock-audio serving route (F-119
 * Phase 4, GET /topik/audio/:testNumber/:level) needed the identical
 * hardened streamer — the same extraction rangeStream.ts got when Track A
 * (A-4a) needed the Range mechanics — so TTMIK, Iyagi, and TOPIK can never
 * drift on resolution/containment/404 behavior.
 *
 * Division of labor:
 *   - Callers own WHICH table the audio_path came from (ttmik_lessons /
 *     iyagi_episodes / topik_tests) and the SQL that fetched it.
 *   - This module owns turning that stored path into a safe absolute file
 *     (resolveAudioFile) and streaming it with the corpus header policy
 *     (streamCorpusAudio).
 *   - services/rangeStream.ts owns the RFC 9110 Range mechanics underneath.
 *
 * SECURITY (per the route files' threat models, restated for the shared part):
 *   - audio_path comes ONLY from DB rows written by the corpus loaders, NEVER
 *     from user input — but defense in depth still treats the stored value as
 *     hostile (poisoned row / future code path). See resolveAudioFile's doc
 *     for the per-defense enumeration.
 *   - Every rejection is a uniform NotFoundError (404), so a client can never
 *     use this surface as an existence oracle for the host filesystem.
 */
import type { NextFunction, Request, Response } from 'express';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { getLogger } from '../logging.js';
import { NotFoundError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { streamFileWithRange } from './rangeStream.js';

/**
 * Resolve a DB-stored corpus-relative audio path to a real file inside
 * CORPUS_AUDIO_DIR, or throw NotFoundError.
 *
 * Defends against (each named per Bar §0):
 *   - NULL mapping / missing row → 404 (no audio is a normal state).
 *   - ABSOLUTE-PATH INJECTION: a stored `/etc/shadow` is rejected before any
 *     fs call — audio_path must be relative by contract (migration 035).
 *   - DOT-DOT TRAVERSAL: `resolve(root, normalize(rel))` collapses `..`; the
 *     prefix check then catches anything that left the root.
 *   - SYMLINK ESCAPE: prefix-checking the LEXICAL path is not enough if a
 *     symlink inside the tree points outside it, so we realpath() the
 *     resolved file AND the root and re-verify containment on the kernel's
 *     answer. (Root realpath failing = mount absent → 404.)
 *   - EXISTENCE ORACLE: every rejection above is a uniform 404 — a client
 *     (or poisoned row) can never distinguish "outside root" from "no file",
 *     so probing reveals nothing about the host filesystem. The warn-level
 *     log carries the true reason for the operator.
 */
export async function resolveAudioFile(
  audioPath: string | null,
): Promise<{ absPath: string; size: number }> {
  if (audioPath === null || audioPath.length === 0) {
    throw new NotFoundError('no audio for this unit');
  }
  const log = getLogger();
  const root = resolve(loadConfig().CORPUS_AUDIO_DIR);
  if (isAbsolute(audioPath)) {
    log.warn({ audioPath }, 'corpus audio: absolute audio_path rejected');
    throw new NotFoundError('no audio for this unit');
  }
  const lexical = resolve(root, normalize(audioPath));
  if (lexical !== root && !lexical.startsWith(root + sep)) {
    log.warn({ audioPath }, 'corpus audio: traversal outside root rejected');
    throw new NotFoundError('no audio for this unit');
  }
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = await realpath(root);
    realAbs = await realpath(lexical);
  } catch {
    // Root not mounted, file missing, or a dangling symlink — all 404.
    throw new NotFoundError('no audio for this unit');
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
    log.warn({ audioPath }, 'corpus audio: symlink escape rejected');
    throw new NotFoundError('no audio for this unit');
  }
  const info = await stat(realAbs);
  if (!info.isFile()) {
    throw new NotFoundError('no audio for this unit');
  }
  return { absPath: realAbs, size: info.size };
}

/**
 * Stream the resolved mp3, honoring a single-byte-range request.
 * Shared by every corpus audio endpoint — the ONLY difference upstream is
 * which table the audio_path came from. The Range mechanics themselves live
 * in services/rangeStream.ts (shared with the user-audio streamer, A-4a):
 * this wrapper contributes only the corpus resolution + the corpus header
 * policy (audio/mpeg always — the corpus is all mp3; a full day of private
 * caching — the corpus is immutable, so replays never re-download).
 */
export async function streamCorpusAudio(
  req: Request,
  res: Response,
  next: NextFunction,
  audioPath: string | null,
): Promise<void> {
  const { absPath, size } = await resolveAudioFile(audioPath);
  streamFileWithRange(req, res, next, absPath, size, {
    contentType: 'audio/mpeg',
    cacheControl: 'private, max-age=86400',
    logContext: 'corpus audio',
  });
}
