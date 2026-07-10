/**
 * /plan routes — the daily study plan that drives the Today screen.
 *
 * `GET /plan/today` composes one response from data that already lives in the
 * database — no new user-state is written here, the endpoint is a pure read:
 *
 *   {
 *     dueCount:   number,                      // FSRS cards due as of now()
 *                                              // (hanja cards excluded until
 *                                              // the F-075 review UI ships)
 *     reading:    TodayTask | null,            // one TTMIK lesson
 *     listening:  TodayTask | null,            // one Iyagi episode
 *     writing:    TodayTask | null,            // one writing_prompts row
 *     largestGap: 'Reading'|'Listening'|'Writing'|null   // weakest modality
 *   }
 *
 * SELECTION MODEL — "stable per user per day, leveled to ability"
 *   Each content task (reading / listening / writing) is picked by ordering on
 *   `md5(user_id || seoul_date || row_id)`, where `seoul_date` is the current
 *   date in 'Asia/Seoul' (see `PLAN_DATE_SQL`). Two consequences, both deliberate:
 *     1. Deterministic within a day — refetching Today (e.g. the screen's
 *        retry, or a second device) returns the SAME plan, so the user never
 *        sees the day's tasks reshuffle under them.
 *     2. Rolls over at midnight in 'Asia/Seoul' — the app's target locale (a
 *        Korea-resident learner on a self-hosted server). The boundary is
 *        pinned with `(now() AT TIME ZONE 'Asia/Seoul')::date` rather than the
 *        bare `current_date`, which would evaluate in the DB session timezone
 *        (UTC on a stock container) and reshuffle the plan at 09:00 KST. The
 *        pin makes rollover deterministic and session-TZ-independent, with no
 *        cron or stored "plan of the day" row.
 *   When the user has a diagnostic snapshot, the reading/writing branches
 *   PREFER a row whose difficulty band matches that modality's estimate
 *   (band-match sorts first, deterministic hash breaks ties), so content is
 *   leveled to current ability. No snapshot → pure deterministic-random.
 *
 * `largestGap` is the weakest of the three *surfaced* modalities (reading /
 * listening / writing) in the latest snapshot — it drives which Today tile
 * wears the "Largest gap" highlight. Null when the user has no snapshot yet.
 *
 * THREAT MODEL
 *   - Auth required (requireAuth) — the plan is user-specific (due count +
 *     snapshot-leveled content). No body, no params: zero injection surface
 *     beyond the parameterized `user_id`, which comes from the session, never
 *     the client.
 *   - Read-only: no INSERT/UPDATE. A botched client retry is fully safe and
 *     idempotent within the day (same plan returned).
 *   - Rate limit: cheapLimiter (per-user) — the endpoint runs ~5 small indexed
 *     queries; the limiter caps abusive polling.
 *   - All title/level strings are returned as data and rendered as React
 *     children client-side (escaped) — no HTML is ever emitted here.
 */
import { Router } from 'express';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(requireAuth);

/**
 * The day-rollover boundary expression used in every selection hash. Pinned to
 * the app's target locale ('Asia/Seoul') so rollover is at local midnight
 * regardless of the DB session timezone — a bare `current_date` evaluates in
 * the session's TimeZone GUC (UTC on a stock container), which would reshuffle
 * the plan at 09:00 KST for a Korea-resident user.
 *
 * Built from a timestamp expression (default `now()`) so the regression test
 * can exercise THIS EXACT production expression against a fixed instant — see
 * `planDateSql` usage in `tests/routes/plan.test.ts`. Both the timestamp source
 * and the zone are server-side SQL, not interpolated client input — no
 * injection surface (the `tsExpr` argument is only ever a trusted literal).
 */
export function planDateSql(tsExpr = 'now()'): string {
  return `(${tsExpr} AT TIME ZONE 'Asia/Seoul')::date::text`;
}

const PLAN_DATE_SQL = planDateSql();

// ---------------------------------------------------------------------------
// Pure derivation helpers (exported for unit testing — no DB dependency).
// ---------------------------------------------------------------------------

/** Korean-speech-level / TOPIK-band label the client renders on a task tile. */
export type LevelLabel = 'L3' | 'L4' | 'L5+' | 'L3→L4';

/** book_level enum values as they arrive from Postgres (or null). */
export type BookLevel = 'beginner' | 'intermediate' | 'advanced' | null;

/** proficiency_level enum values used by writing_prompts.level. */
export type Proficiency = 'basic' | 'L3' | 'L4' | 'L5+';

/** The three modalities a Today plan highlights a gap for. */
export type GapTag = 'Reading' | 'Listening' | 'Writing';

/**
 * Map a corpus `book_level` to the TOPIK-aligned label the design shows.
 * Reading content (TTMIK) carries a book_level; we surface it as L3/L4/L5+.
 * NULL (level-spanning or unset) defaults to L4 — the design's centre band.
 */
export function bookLevelToLabel(book: BookLevel): LevelLabel {
  switch (book) {
    case 'beginner':
      return 'L3';
    case 'advanced':
      return 'L5+';
    case 'intermediate':
      return 'L4';
    default:
      return 'L4';
  }
}

/**
 * Diagnostic estimates are on the TOPIK 0–6 scale. To level reading content we
 * prefer a `book_level` band near the user's estimate. Returns null when there
 * is no estimate, which the SQL reads as "no band preference, pure random".
 *   < 3   → beginner   (TOPIK 1–2 territory)
 *   < 4.5 → intermediate
 *   ≥ 4.5 → advanced
 */
export function estimateToBookLevel(estimate: number | null): BookLevel {
  if (estimate === null || Number.isNaN(estimate)) return null;
  if (estimate < 3) return 'beginner';
  if (estimate < 4.5) return 'intermediate';
  return 'advanced';
}

/**
 * Prefer a writing prompt whose `proficiency_level` band matches the user's
 * writing estimate (0–6 scale). The prompt bank starts at L3, so 'basic' is
 * never targeted. Null → no band preference.
 *   < 3.5 → L3
 *   < 5   → L4
 *   ≥ 5   → L5+
 */
export function estimateToProficiency(
  estimate: number | null,
): Exclude<Proficiency, 'basic'> | null {
  if (estimate === null || Number.isNaN(estimate)) return null;
  if (estimate < 3.5) return 'L3';
  if (estimate < 5) return 'L4';
  return 'L5+';
}

/**
 * Estimate reading minutes from a lesson's sentence count. The corpus carries
 * no duration metadata, so we model a study pace of ~12s per sentence
 * (read + gloss + re-read) and clamp to a sane tile range.
 */
export function readingMinsFromSentences(sentenceCount: number): number {
  const PACE_SECONDS_PER_SENTENCE = 12;
  const mins = Math.round((sentenceCount * PACE_SECONDS_PER_SENTENCE) / 60);
  return Math.min(12, Math.max(2, mins));
}

/**
 * Estimate listening minutes from an episode's sentence count. Audio runs
 * slower than silent reading, so we model ~15s per spoken line.
 */
export function listeningMinsFromSentences(sentenceCount: number): number {
  const PACE_SECONDS_PER_SENTENCE = 15;
  const mins = Math.round((sentenceCount * PACE_SECONDS_PER_SENTENCE) / 60);
  return Math.min(15, Math.max(3, mins));
}

/**
 * Pick the weakest of the three surfaced modalities. Returns null when none of
 * the three estimates is present (no snapshot, or only other dimensions run).
 * Ties resolve in the order reading → listening → writing (stable, arbitrary).
 */
export function computeLargestGap(estimates: {
  reading: number | null;
  listening: number | null;
  writing: number | null;
}): GapTag | null {
  const candidates: Array<{ tag: GapTag; value: number }> = [];
  if (estimates.reading !== null) candidates.push({ tag: 'Reading', value: estimates.reading });
  if (estimates.listening !== null) candidates.push({ tag: 'Listening', value: estimates.listening });
  if (estimates.writing !== null) candidates.push({ tag: 'Writing', value: estimates.writing });
  if (candidates.length === 0) return null;
  return candidates.reduce((min, c) => (c.value < min.value ? c : min)).tag;
}

/** Parse a Postgres NUMERIC (returned as string) into a number, null-safe. */
function parseEstimate(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

interface TodayTask {
  title: string;
  mins: number;
  level: LevelLabel;
  tag: GapTag;
}

router.get('/today', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);

    // 1. FSRS due count — live, non-suspended, non-deleted cards due now.
    //    Hanja cards (050) are EXCLUDED to match what the Review screen can
    //    actually drain: /vocab/cards/due filters them out (vocab.ts) and no
    //    client consumes /hanja/cards/due yet, so counting them here would
    //    show phantom workload the user cannot clear. Re-include (or report
    //    the split) when the hanja review UI ships (F-075 client wiring).
    const due = await query<{ due_count: number }>(
      `SELECT count(*)::int AS due_count
         FROM vocab_cards
        WHERE user_id = $1
          AND due_at <= now()
          AND suspended_at IS NULL
          AND deleted_at IS NULL
          AND hanja_character_id IS NULL`,
      [userId],
    );
    const dueCount = due.rows[0]?.due_count ?? 0;

    // 2. Latest diagnostic snapshot — drives band preference + largestGap.
    //    NB: a snapshot existing does NOT guarantee leveled content. If all
    //    three modality estimates are NULL (e.g. a run that exercised only
    //    grammar/vocab), every band param degrades to NULL and selection falls
    //    back to pure deterministic-random — same as having no snapshot at all.
    const snap = await query<{
      reading_estimate: string | null;
      listening_estimate: string | null;
      writing_estimate: string | null;
    }>(
      `SELECT reading_estimate, listening_estimate, writing_estimate
         FROM diagnostic_snapshots
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY captured_at DESC
        LIMIT 1`,
      [userId],
    );
    const readingEstimate = parseEstimate(snap.rows[0]?.reading_estimate ?? null);
    const listeningEstimate = parseEstimate(snap.rows[0]?.listening_estimate ?? null);
    const writingEstimate = parseEstimate(snap.rows[0]?.writing_estimate ?? null);

    const userKey = String(userId);

    // 3. Reading — one TTMIK lesson, band-preferred + deterministic per day.
    const readingBand = estimateToBookLevel(readingEstimate);
    const reading = await query<{
      title: string | null;
      book_level: BookLevel;
      sentence_count: number;
    }>(
      `SELECT l.title,
              l.book_level::text AS book_level,
              (SELECT count(*)::int
                 FROM ttmik_sentences s
                WHERE s.lesson_id = l.id) AS sentence_count
         FROM ttmik_lessons l
        ORDER BY (CASE WHEN $2::book_level IS NOT NULL
                        AND l.book_level = $2::book_level THEN 0 ELSE 1 END),
                 md5($1::text || ${PLAN_DATE_SQL} || l.id::text)
        LIMIT 1`,
      [userKey, readingBand],
    );
    const readingTask: TodayTask | null = reading.rows[0]
      ? {
          title: reading.rows[0].title ?? 'TTMIK reading',
          mins: readingMinsFromSentences(reading.rows[0].sentence_count),
          level: bookLevelToLabel(reading.rows[0].book_level),
          tag: 'Reading',
        }
      : null;

    // 4. Listening — one Iyagi episode. Iyagi carries no per-episode level, so
    //    the label is the fixed 'L3→L4' band (Iyagi targets intermediate
    //    listeners) and selection is pure deterministic-per-day.
    const listening = await query<{
      title: string | null;
      sentence_count: number;
    }>(
      `SELECT e.title,
              (SELECT count(*)::int
                 FROM iyagi_sentences s
                WHERE s.episode_id = e.id) AS sentence_count
         FROM iyagi_episodes e
        ORDER BY md5($1::text || ${PLAN_DATE_SQL} || e.id::text)
        LIMIT 1`,
      [userKey],
    );
    const listeningTask: TodayTask | null = listening.rows[0]
      ? {
          title: listening.rows[0].title ?? 'Iyagi episode',
          mins: listeningMinsFromSentences(listening.rows[0].sentence_count),
          level: 'L3→L4',
          tag: 'Listening',
        }
      : null;

    // 5. Writing — one active prompt, band-preferred + deterministic per day.
    // `rubric IS NOT NULL` mirrors GET /writing/prompts (writing.ts): the tile
    // must only advertise a prompt the Writing screen can actually serve
    // (F-014). Migration 038 retired every rubric-NULL row by data, but an
    // operator re-activating a legacy row must not reopen the tile-vs-screen
    // mismatch — the invariant is enforced structurally in BOTH queries.
    const writingBand = estimateToProficiency(writingEstimate);
    const writing = await query<{
      title: string;
      level: Proficiency;
      est_minutes: number;
    }>(
      `SELECT title, level::text AS level, est_minutes
         FROM writing_prompts
        WHERE is_active
          AND rubric IS NOT NULL
        ORDER BY (CASE WHEN $2::proficiency_level IS NOT NULL
                        AND level = $2::proficiency_level THEN 0 ELSE 1 END),
                 md5($1::text || ${PLAN_DATE_SQL} || id::text)
        LIMIT 1`,
      [userKey, writingBand],
    );
    const writingRow = writing.rows[0];
    const writingTask: TodayTask | null = writingRow
      ? {
          title: writingRow.title,
          mins: writingRow.est_minutes,
          // writing_prompts.level is L3/L4/L5+ (never 'basic' in the bank);
          // narrow to the label union with an L4 fallback for safety.
          level:
            writingRow.level === 'L3' ||
            writingRow.level === 'L4' ||
            writingRow.level === 'L5+'
              ? writingRow.level
              : 'L4',
          tag: 'Writing',
        }
      : null;

    const largestGap = computeLargestGap({
      reading: readingEstimate,
      listening: listeningEstimate,
      writing: writingEstimate,
    });

    res.status(200).json({
      dueCount,
      reading: readingTask,
      listening: listeningTask,
      writing: writingTask,
      largestGap,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
