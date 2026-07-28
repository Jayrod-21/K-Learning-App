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
 * AUDIO STREAMING — the security-sensitive part (threat model, Bar §0).
 * The streaming core itself (resolveAudioFile + streamCorpusAudio) lives in
 * services/corpusAudio.ts — extracted when the TOPIK mock-audio route (F-119
 * Phase 4) needed the identical hardened streamer — so the defenses below are
 * implemented there and merely CONSUMED here:
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
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, mediaLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { streamCorpusAudio } from '../services/corpusAudio.js';

// Re-exported from the extracted shared module (services/rangeStream.ts —
// A-4a moved the Range mechanics there so the user-audio streamer shares
// them) for existing importers of this route module.
export { parseRangeHeader } from '../services/rangeStream.js';

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

export { iyagiRouter };
export default ttmikRouter;
