/**
 * /ttmik + /iyagi routes — lesson/episode browsing + mp3 streaming (F-012).
 *
 * Read-only corpus surface:
 *   GET /ttmik/lessons                        → { lessons: [{ level, number, title, hasAudio }] }
 *   GET /ttmik/lessons/:level/:number         → { meta, highlights[], transcript[], audioUrl }
 *   GET /ttmik/lessons/:level/:number/audio   → the mp3 (Range-capable)
 *   GET /iyagi/episodes                       → { episodes: [{ number, title, hasAudio }] }
 *   GET /iyagi/episodes/:number               → { meta, sentences[], audioUrl }
 *   GET /iyagi/episodes/:number/audio         → the mp3 (Range-capable)
 *
 * Listening attempts (F-172; listening_attempts, migration 061) — the one
 * user-STATE-writing surface in this otherwise pure read-only file:
 *   POST /ttmik/attempts   → log a completed lesson listen, { level, number }
 *   POST /iyagi/attempts   → log a completed episode listen, { number }
 *   GET  /ttmik/attempts   → the caller's own listening history (BOTH TTMIK
 *                            lessons and Iyagi episodes — one shared table),
 *                            paged, newest first
 *
 * TTMIK lesson detail carries TWO bodies of text:
 *   - `highlights`  — the curated key phrases/vocab from ttmik_sentences
 *                     (previously the `sentences` field; renamed when the full
 *                     transcript landed so the two can't be confused).
 *   - `transcript`  — the FULL lesson notes from ttmik_transcript_lines
 *                     (migration 036), ordered by ordinal. Each line is
 *                     { ordinal, korean, english, kind } where kind ∈
 *                     header|pair|romanization|prose|dialog; for single-text
 *                     kinds render `korean ?? english` (see the migration's
 *                     column contract). Empty array until the transcript
 *                     loader has run — the client falls back to highlights.
 *
 * `audioUrl` is the app-relative path of the sibling audio endpoint (or null
 * when no audio is mapped) — the client hands it straight to an <audio> tag;
 * the session cookie rides along same-origin.
 *
 * The list endpoints intentionally return the WHOLE corpus unpaginated: both
 * tables are small and fixed (232 lessons / 139 episodes — a closed published
 * catalog, not user data), and the lesson picker needs the full tree anyway.
 * (Deliberate, documented deviation from the paginate-every-list rule.)
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
 *   - LISTENING ATTEMPTS (F-172): both POST routes are plain, cheap DB writes
 *     (no Claude call) — cheapLimiter, not expensiveLimiter. Unlike Reading's
 *     attempts (which target USER-OWNED chapter/story rows and need an
 *     ownership check), `ttmik_lessons`/`iyagi_episodes` are PUBLIC licensed
 *     corpus content — every authenticated user may log a listen against any
 *     REAL lesson/episode, so the only gate is existence (a garbage
 *     level/number/episode-number 404s before any INSERT runs), never a
 *     per-user ownership check. `titleSnapshot` is always SERVER-derived from
 *     the resolved lesson/episode row, never client-supplied free text. GET
 *     /ttmik/attempts is user-scoped to `getUserId(req)` — no client-supplied
 *     id can ever select another user's rows.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { getLogger } from '../logging.js';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, mediaLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
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
  speaker: string | null;
  is_dialog: boolean | null;
}

interface UnitRow {
  id: number;
  title: string;
  audio_path: string | null;
  // iyagi_episodes.hosts is a plain TEXT column ("최경은 & 진석진"), NOT an
  // array — the endpoint splits it into string[] for the client (see the
  // episode detail route). Typing it string here is what makes that mapping
  // compile-checked; the old `string[]` type let the raw string leak through
  // and crash the client's .map() render.
  hosts?: string | null;
}

interface TranscriptLineRow {
  ordinal: number;
  korean: string | null;
  english: string | null;
  kind: 'header' | 'pair' | 'romanization' | 'prose' | 'dialog';
}

/**
 * DB "최경은 & 진석진" → ['최경은', '진석진']; NULL/empty → [].
 * Tolerates missing spaces around '&' and stray whitespace — the column was
 * hand-entered per episode. Exported for direct unit coverage.
 */
export function splitHosts(hosts: string | null | undefined): string[] {
  if (!hosts) return [];
  return hosts
    .split('&')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

// No romanization anywhere (user directive) — not selected, so never on the wire.
const SENTENCE_COLUMNS = 'id, ordinal, korean, english, speaker, is_dialog';

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
// GET /ttmik/lessons/:level/:number — meta + highlights + full transcript
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
      // Independent reads — fire in parallel (both keyed on the same
      // already-resolved lesson id; no waterfall).
      const [{ rows: highlights }, { rows: transcript }] = await Promise.all([
        query<SentenceRow>(
          `SELECT ${SENTENCE_COLUMNS}
             FROM ttmik_sentences
            WHERE lesson_id = $1
            ORDER BY ordinal`,
          [lesson.id],
        ),
        query<TranscriptLineRow>(
          // `kind <> 'romanization'` is belt-and-suspenders: the loader never
          // inserts romanization rows (no romanization anywhere), but the DB
          // CHECK still permits the value, so the endpoint defends it too.
          `SELECT ordinal, korean, english, kind
             FROM ttmik_transcript_lines
            WHERE lesson_id = $1 AND kind <> 'romanization'
            ORDER BY ordinal`,
          [lesson.id],
        ),
      ]);
      const hasAudio = lesson.audio_path !== null;
      res.status(200).json({
        meta: { level: p.level, number: p.number, title: lesson.title, hasAudio },
        highlights,
        transcript,
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
          // BUG FIX: hosts is a TEXT column ("최경은 & 진석진"); the old
          // `episode.hosts ?? []` passed the raw string through where the
          // client DTO expects string[], crashing the episode render. Split
          // at the endpoint boundary — the DTO stays string[].
          hosts: splitHosts(episode.hosts),
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
// Listening attempts (F-172; listening_attempts, migration 061)
// ---------------------------------------------------------------------------
//
// Unlike Reading (which already has a resume bookmark, reading_positions/051)
// and Hanja (whose FSRS card-review submit is an existing transaction to
// piggyback the attempt-log write onto), this file has ZERO user-state
// writing anywhere today — pure read-only corpus serving. F-172 is therefore
// a genuinely NEW completion trigger point, with no existing transaction to
// hang off of: the client fires POST /ttmik/attempts or POST /iyagi/attempts
// once when the `<audio>` element reaches its `ended` event (or an explicit
// "mark listened" action), and GET /ttmik/attempts serves the caller's own
// history across BOTH corpora (one underlying table, listening_attempts) —
// mirroring how GET /reading/attempts already serves both chapter- and
// story-sourced rows from one table. No duplicate GET is exposed on
// iyagiRouter: nothing in the client currently wants a corpus-scoped-only
// history feed, and a single canonical read keeps the "did the user listen
// today" query in one place (Today will read this later).

/** Wire shape of one logged listening attempt (BIGINT ids coerced to numbers). */
interface ListeningAttemptDto {
  id: number;
  sourceKind: 'ttmik_lesson' | 'iyagi_episode';
  lessonId: number | null;
  episodeId: number | null;
  titleSnapshot: string;
  completedAt: Date;
}

interface ListeningAttemptRow {
  id: string;
  source_kind: 'ttmik_lesson' | 'iyagi_episode';
  lesson_id: string | null;
  episode_id: string | null;
  title_snapshot: string;
  completed_at: Date;
}

function toListeningAttemptDto(row: ListeningAttemptRow): ListeningAttemptDto {
  return {
    id: Number(row.id),
    sourceKind: row.source_kind,
    lessonId: row.lesson_id === null ? null : Number(row.lesson_id),
    episodeId: row.episode_id === null ? null : Number(row.episode_id),
    titleSnapshot: row.title_snapshot,
    completedAt: row.completed_at,
  };
}

const LISTENING_ATTEMPT_COLUMNS =
  'id::text AS id, source_kind, lesson_id::text AS lesson_id, ' +
  'episode_id::text AS episode_id, title_snapshot, completed_at';

/**
 * POST /ttmik/attempts body: the completed lesson, identified by
 * (level, number) — the same pair the client already addresses a lesson by
 * (mirrors LessonParamsSchema). `.strict()` rejects unknown keys.
 */
const LogTtmikAttemptBodySchema = z
  .object({
    level: z.number().int().positive().max(100),
    number: z.number().int().positive().max(100_000),
  })
  .strict();

/**
 * POST /ttmik/attempts — log a completed TTMIK lesson listen (F-172). A NEW
 * completion trigger point (this file has no prior user-state write to
 * piggyback on). Unlike reading_attempts' chapter/story targets (user-owned
 * rows needing an ownership check), ttmik_lessons is PUBLIC licensed corpus
 * content — every authenticated user may log any real lesson, so the only
 * gate is existence: a garbage (level, number) pair 404s. `titleSnapshot` is
 * SERVER-derived from the resolved lesson row, never client-supplied text.
 * Cheap, synchronous DB work only — no Claude call, so `cheapLimiter`.
 */
ttmikRouter.post(
  '/attempts',
  cheapLimiter(),
  validateBody(LogTtmikAttemptBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof LogTtmikAttemptBodySchema>;

      const lessonRes = await query<{ id: string; title: string }>(
        `SELECT id, title FROM ttmik_lessons WHERE lesson_level = $1 AND lesson_number = $2 LIMIT 1`,
        [body.level, body.number],
      );
      if (lessonRes.rows.length === 0) {
        throw new NotFoundError('lesson not found');
      }
      const lesson = lessonRes.rows[0]!;
      const titleSnapshot = `Level ${String(body.level)} Lesson ${String(body.number)}: ${lesson.title}`;

      const { rows } = await query<ListeningAttemptRow>(
        `INSERT INTO listening_attempts (user_id, source_kind, lesson_id, title_snapshot)
         VALUES ($1, 'ttmik_lesson', $2, $3)
         RETURNING ${LISTENING_ATTEMPT_COLUMNS}`,
        [userId, lesson.id, titleSnapshot],
      );

      res.status(201).json({ attempt: toListeningAttemptDto(rows[0]!) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /iyagi/attempts body: the completed episode, identified by its
 * episode number (mirrors EpisodeParamsSchema). `.strict()` rejects unknown
 * keys.
 */
const LogIyagiAttemptBodySchema = z
  .object({
    number: z.number().int().positive().max(100_000),
  })
  .strict();

/**
 * POST /iyagi/attempts — log a completed Iyagi episode listen (F-172). Same
 * posture as the TTMIK lesson leg above: public corpus content, existence-only
 * gate (404 on a garbage episode number), server-derived titleSnapshot.
 */
iyagiRouter.post(
  '/attempts',
  cheapLimiter(),
  validateBody(LogIyagiAttemptBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof LogIyagiAttemptBodySchema>;

      const episodeRes = await query<{ id: string; title: string }>(
        `SELECT id, title FROM iyagi_episodes WHERE episode_number = $1 LIMIT 1`,
        [body.number],
      );
      if (episodeRes.rows.length === 0) {
        throw new NotFoundError('episode not found');
      }
      const episode = episodeRes.rows[0]!;
      const titleSnapshot = `Iyagi #${String(body.number)}: ${episode.title}`;

      const { rows } = await query<ListeningAttemptRow>(
        `INSERT INTO listening_attempts (user_id, source_kind, episode_id, title_snapshot)
         VALUES ($1, 'iyagi_episode', $2, $3)
         RETURNING ${LISTENING_ATTEMPT_COLUMNS}`,
        [userId, episode.id, titleSnapshot],
      );

      res.status(201).json({ attempt: toListeningAttemptDto(rows[0]!) });
    } catch (err) {
      next(err);
    }
  },
);

// `offset`'s ceiling is a real bound (not a symbolic MAX_SAFE_INTEGER one),
// same posture as writing.ts's / reading.ts's attempts-history query schemas.
const MAX_LISTENING_ATTEMPTS_OFFSET = 100_000;

const ListeningAttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(MAX_LISTENING_ATTEMPTS_OFFSET).default(0),
});

/**
 * GET /ttmik/attempts?limit=1..100(def 20)&offset=0..(def 0) — the caller's
 * own listening-completion history, newest first, across BOTH TTMIK lessons
 * and Iyagi episodes (one underlying table). User-scoped to `getUserId(req)`
 * (no IDOR); `COUNT(*) OVER ()` rides the total alongside the page in one
 * round trip, mirroring `GET /grammar-drill/attempts` / `GET /reading/attempts`.
 * An empty history is a 200 with `attempts: []`, never an error.
 */
ttmikRouter.get(
  '/attempts',
  cheapLimiter(),
  validateQuery(ListeningAttemptsQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof ListeningAttemptsQuerySchema> }
      ).validatedQuery;
      const { rows } = await query<ListeningAttemptRow & { total: string }>(
        `SELECT ${LISTENING_ATTEMPT_COLUMNS}, COUNT(*) OVER ()::text AS total
           FROM listening_attempts
          WHERE user_id = $1
          ORDER BY completed_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [userId, q.limit, q.offset],
      );
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      const attempts = rows.map(({ total: _total, ...rest }) => toListeningAttemptDto(rest));
      res.status(200).json({ attempts, total, limit: q.limit, offset: q.offset });
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
