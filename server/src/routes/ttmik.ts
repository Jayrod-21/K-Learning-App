/**
 * /ttmik + /iyagi routes — lesson/episode browsing + mp3 streaming (F-012).
 *
 * Read-only corpus surface:
 *   GET /ttmik/lessons                        → { lessons: [{ level, number, title, hasAudio }] }
 *   GET /ttmik/lessons/:level/:number         → { meta, sentences[], audioUrl }
 *   GET /ttmik/lessons/:level/:number/audio   → the mp3 (Range-capable)
 *   GET /iyagi/episodes                       → { episodes: [{ number, title, hasAudio }] }
 *   GET /iyagi/episodes/:number               → { meta, sentences[], audioUrl }
 *   GET /iyagi/episodes/:number/audio         → the mp3 (Range-capable)
 *
 * `audioUrl` is the app-relative path of the sibling audio endpoint (or null
 * when no audio is mapped) — the client hands it straight to an <audio> tag;
 * the session cookie rides along same-origin.
 *
 * The list endpoints intentionally return the WHOLE corpus unpaginated: both
 * tables are small and fixed (232 lessons / 139 episodes — a closed published
 * catalog, not user data), and the lesson picker needs the full tree anyway.
 * (Deliberate, documented deviation from the paginate-every-list rule; the
 * paginated generic browser remains at GET /reading/units.)
 *
 * AUDIO STREAMING — the security-sensitive part (threat model, Bar §0):
 *   - PATH TRAVERSAL / SYMLINK ESCAPE: `audio_path` comes ONLY from the DB row
 *     (written by the corpus loader), NEVER from user input — the client picks
 *     a lesson by (level, number)/number and those are validated integers used
 *     purely as SQL parameters. Defense in depth still treats the stored value
 *     as hostile (poisoned row / future code path): reject absolute paths,
 *     resolve under CORPUS_AUDIO_DIR, then compare the kernel-resolved
 *     realpath()s of both root and file so neither `..` segments NOR a
 *     symlink planted inside the tree can escape the root. Any violation →
 *     404 (not 400) so the response never confirms what exists outside the
 *     root; the server log carries the real reason.
 *   - RANGE HANDLING: single `bytes=start-end` ranges per RFC 9110 — 206 +
 *     Content-Range + Accept-Ranges; suffix ranges supported; an unsatisfiable
 *     range → 416 carrying a total-size Content-Range; a malformed Range header
 *     is IGNORED (full 200) as the RFC permits, so a weird client degrades to
 *     a working download instead of an error. End is clamped to EOF; ranges
 *     are half-open nowhere — inclusive per spec.
 *   - DoS: no unbounded buffering — the file is streamed (createReadStream)
 *     with backpressure; cheapLimiter caps request rate; Content-Length is
 *     always set so clients can't hold slow unbounded reads open.
 *   - AuthN: requireAuth on every route (corpus is licensed content).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { getLogger } from '../logging.js';
import { requireAuth } from '../middleware/auth.js';
import { cheapLimiter, mediaLimiter } from '../middleware/rateLimits.js';
import { validateParams } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';

const ttmikRouter = Router();
const iyagiRouter = Router();
ttmikRouter.use(requireAuth);
iyagiRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Row shapes (SQL projections)
// ---------------------------------------------------------------------------

interface LessonListRow {
  level: number;
  number: number;
  title: string;
  hasAudio: boolean;
}

interface EpisodeListRow {
  number: number;
  title: string;
  hasAudio: boolean;
}

interface SentenceRow {
  id: number;
  ordinal: number;
  korean: string;
  english: string | null;
  romanization: string | null;
  speaker: string | null;
  is_dialog: boolean | null;
}

interface UnitRow {
  id: number;
  title: string;
  audio_path: string | null;
  hosts?: string[] | null;
}

const SENTENCE_COLUMNS =
  'id, ordinal, korean, english, romanization, speaker, is_dialog';

// ---------------------------------------------------------------------------
// Param schemas — positive ints only; these are the ONLY client inputs on this
// surface and they never touch the filesystem (SQL parameters exclusively).
// ---------------------------------------------------------------------------

const LessonParamsSchema = z.object({
  level: z.coerce.number().int().positive().max(100),
  number: z.coerce.number().int().positive().max(100_000),
});

const EpisodeParamsSchema = z.object({
  number: z.coerce.number().int().positive().max(100_000),
});

type LessonParams = z.infer<typeof LessonParamsSchema>;
type EpisodeParams = z.infer<typeof EpisodeParamsSchema>;

const lessonAudioUrl = (level: number, number: number): string =>
  `/ttmik/lessons/${level}/${number}/audio`;
const episodeAudioUrl = (number: number): string => `/iyagi/episodes/${number}/audio`;

// ---------------------------------------------------------------------------
// GET /ttmik/lessons — full catalog
// ---------------------------------------------------------------------------

ttmikRouter.get('/lessons', cheapLimiter(), async (_req, res, next) => {
  try {
    const { rows } = await query<LessonListRow>(
      `SELECT lesson_level          AS level,
              lesson_number         AS number,
              title,
              audio_path IS NOT NULL AS "hasAudio"
         FROM ttmik_lessons
        ORDER BY lesson_level, lesson_number`,
    );
    res.status(200).json({ lessons: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /ttmik/lessons/:level/:number — meta + transcript + audioUrl
// ---------------------------------------------------------------------------

ttmikRouter.get(
  '/lessons/:level/:number',
  cheapLimiter(),
  validateParams(LessonParamsSchema),
  async (req, res, next) => {
    try {
      const p = (req as typeof req & { validatedParams: LessonParams }).validatedParams;
      const unit = await query<UnitRow>(
        `SELECT id, title, audio_path
           FROM ttmik_lessons
          WHERE lesson_level = $1 AND lesson_number = $2`,
        [p.level, p.number],
      );
      const lesson = unit.rows[0];
      if (!lesson) throw new NotFoundError('lesson not found');
      const { rows: sentences } = await query<SentenceRow>(
        `SELECT ${SENTENCE_COLUMNS}
           FROM ttmik_sentences
          WHERE lesson_id = $1
          ORDER BY ordinal`,
        [lesson.id],
      );
      const hasAudio = lesson.audio_path !== null;
      res.status(200).json({
        meta: { level: p.level, number: p.number, title: lesson.title, hasAudio },
        sentences,
        audioUrl: hasAudio ? lessonAudioUrl(p.level, p.number) : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /ttmik/lessons/:level/:number/audio — mp3 stream
// ---------------------------------------------------------------------------

ttmikRouter.get(
  '/lessons/:level/:number/audio',
  mediaLimiter(),
  validateParams(LessonParamsSchema),
  async (req, res, next) => {
    try {
      const p = (req as typeof req & { validatedParams: LessonParams }).validatedParams;
      const { rows } = await query<Pick<UnitRow, 'audio_path'>>(
        `SELECT audio_path FROM ttmik_lessons
          WHERE lesson_level = $1 AND lesson_number = $2`,
        [p.level, p.number],
      );
      await streamCorpusAudio(req, res, next, rows[0]?.audio_path ?? null);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /iyagi/episodes — full catalog
// ---------------------------------------------------------------------------

iyagiRouter.get('/episodes', cheapLimiter(), async (_req, res, next) => {
  try {
    const { rows } = await query<EpisodeListRow>(
      `SELECT episode_number         AS number,
              title,
              audio_path IS NOT NULL AS "hasAudio"
         FROM iyagi_episodes
        ORDER BY episode_number`,
    );
    res.status(200).json({ episodes: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /iyagi/episodes/:number — meta + transcript + audioUrl
// ---------------------------------------------------------------------------

iyagiRouter.get(
  '/episodes/:number',
  cheapLimiter(),
  validateParams(EpisodeParamsSchema),
  async (req, res, next) => {
    try {
      const p = (req as typeof req & { validatedParams: EpisodeParams }).validatedParams;
      const unit = await query<UnitRow>(
        `SELECT id, title, hosts, audio_path
           FROM iyagi_episodes
          WHERE episode_number = $1`,
        [p.number],
      );
      const episode = unit.rows[0];
      if (!episode) throw new NotFoundError('episode not found');
      const { rows: sentences } = await query<SentenceRow>(
        `SELECT ${SENTENCE_COLUMNS}
           FROM iyagi_sentences
          WHERE episode_id = $1
          ORDER BY ordinal`,
        [episode.id],
      );
      const hasAudio = episode.audio_path !== null;
      res.status(200).json({
        meta: {
          number: p.number,
          title: episode.title,
          hosts: episode.hosts ?? [],
          hasAudio,
        },
        sentences,
        audioUrl: hasAudio ? episodeAudioUrl(p.number) : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /iyagi/episodes/:number/audio — mp3 stream
// ---------------------------------------------------------------------------

iyagiRouter.get(
  '/episodes/:number/audio',
  mediaLimiter(),
  validateParams(EpisodeParamsSchema),
  async (req, res, next) => {
    try {
      const p = (req as typeof req & { validatedParams: EpisodeParams }).validatedParams;
      const { rows } = await query<Pick<UnitRow, 'audio_path'>>(
        `SELECT audio_path FROM iyagi_episodes WHERE episode_number = $1`,
        [p.number],
      );
      await streamCorpusAudio(req, res, next, rows[0]?.audio_path ?? null);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Streaming core
// ---------------------------------------------------------------------------

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
async function resolveAudioFile(
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

/** A parsed, satisfiable byte range (inclusive, per RFC 9110). */
interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a Range header against a known size.
 * Returns: a ByteRange (→ 206), null (no/malformed header → full 200), or
 * 'unsatisfiable' (→ 416). Only single `bytes=` ranges are honored —
 * multipart/byteranges is deliberately unsupported (no client we serve sends
 * multi-range for audio, and coalescing logic is pure attack surface).
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Malformed / multi-range / non-bytes unit → ignore per RFC 9110 §14.2.
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // Suffix range: last N bytes. `bytes=-0` is unsatisfiable by definition.
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Stream the resolved mp3, honoring a single-byte-range request.
 * Shared by both audio endpoints — the ONLY difference upstream is which
 * table the audio_path came from.
 */
async function streamCorpusAudio(
  req: Request,
  res: Response,
  next: NextFunction,
  audioPath: string | null,
): Promise<void> {
  const { absPath, size } = await resolveAudioFile(audioPath);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mpeg');
  // Authed licensed content: cacheable only by the browser itself. The corpus
  // is immutable, so a day of private caching saves re-downloads on replay.
  res.setHeader('Cache-Control', 'private, max-age=86400');

  const range = parseRangeHeader(req.headers.range, size);
  if (range === 'unsatisfiable') {
    // RFC 9110 §15.5.17: tell the client the actual size so it can re-request.
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }

  // Degenerate empty file (should never ship, but a 0-byte mp3 must not make
  // createReadStream throw on an inverted start/end pair).
  if (size === 0) {
    res.status(200);
    res.setHeader('Content-Length', 0);
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', end - start + 1);

  const stream = createReadStream(absPath, { start, end });
  stream.on('error', (err) => {
    // File vanished / IO error mid-stream. If headers are gone we can only
    // sever the connection; otherwise surface a clean 500 via the handler.
    getLogger().error({ err, absPath }, 'corpus audio: stream error');
    stream.destroy();
    if (res.headersSent) {
      res.destroy();
    } else {
      next(err);
    }
  });
  // Client disconnect: stop reading the file (backpressure would eventually,
  // but destroying promptly frees the fd).
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export { iyagiRouter };
export default ttmikRouter;
