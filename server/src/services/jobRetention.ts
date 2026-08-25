/**
 * jobRetention — best-effort retention sweeps for the ephemeral job-ledger
 * tables (`audio_transcription_jobs`, `story_audio_jobs`, `story_image_jobs`,
 * and — Phase 2.5 — terminal-`failed` `book_uploads` rows).
 *
 * WHY THIS EXISTS: each of these tables is a per-request WORK LEDGER — it
 * records that a transcription / audio-synthesis / image-generation job was
 * enqueued, ran, and reached a terminal state ('done' | 'failed'). Nothing
 * ever deleted terminal rows, so they accumulated forever (audit finding
 * §1.4). The produced ASSET is owned elsewhere — an audio_source / audio_track
 * for transcription + story audio, and the story's image rows for images (see
 * db/migrations/081_story_audio.up.sql: the job row "would take the
 * status/ledger record with it", i.e. it is NOT the asset's owner) — so a
 * terminal job row is pure history once it is old enough that no client is
 * still polling its status. Deleting it frees rows/indexes and never touches
 * a user-visible asset.
 *
 * DESIGN (mirrors the conversation-retention sweep in routes/conversation.ts):
 *   - Read-route-triggered, not cron: this repo has no scheduler. Each sweep
 *     runs at the top of the natural "list my …" read for its domain, so the
 *     housekeeping rides traffic the user already generates.
 *   - Strictly user-scoped (`WHERE user_id = $1`): a caller only ever sweeps
 *     their OWN old rows — no cross-user writes, and the work stays bounded to
 *     one account's backlog per call.
 *   - Idempotent: a swept row leaves the predicate, so re-running is a no-op.
 *   - Terminal-only + age-gated: `status IN ('done','failed')` guarantees we
 *     never delete a 'pending'/'running' row a worker could still be driving,
 *     and `finished_at < now() - <window>` keeps a just-finished job around
 *     long enough for the client's status poll to observe it. (`finished_at`
 *     is NULL until a row goes terminal, and `NULL < …` is false, so an
 *     in-flight row is doubly excluded.)
 *   - Best-effort: retention is housekeeping, never the caller's purpose, so a
 *     sweep failure is logged and swallowed — the read it rides must still
 *     succeed. (Contrast the conversation sweep, which shares the list's
 *     try/catch by design; here the two concerns are unrelated.)
 *
 * SECURITY: every statement is parameterized; the table names are fixed
 * literals in code (never interpolated from input), and the retention window
 * is bound as an integer via `make_interval(days => $2)`.
 */
import type { Logger } from 'pino';
import { query } from '../db/pool.js';

/**
 * Days a terminal job row is kept before it becomes eligible for sweeping.
 * Matches the 30-day conversation-retention window so the app has one
 * consistent "stale history" horizon.
 */
export const JOB_RETENTION_DAYS = 30;

/**
 * Run one user-scoped, terminal-only, age-gated DELETE and report the count.
 * Never throws: a retention failure is warned and swallowed so the read that
 * triggered the sweep still completes.
 *
 * `sql` is a fixed per-table statement supplied by this module (never caller
 * input); it takes `$1 = userId` and `$2 = JOB_RETENTION_DAYS`.
 */
async function runSweep(
  label: string,
  sql: string,
  userId: number,
  log: Logger,
): Promise<number> {
  try {
    const { rowCount } = await query(sql, [userId, JOB_RETENTION_DAYS]);
    const swept = rowCount ?? 0;
    if (swept > 0) {
      log.info({ userId, swept, table: label }, 'job retention sweep deleted stale terminal rows');
    }
    return swept;
  } catch (err) {
    // Best-effort: never let housekeeping fail the read it rides.
    log.warn({ err, userId, table: label }, 'job retention sweep failed (non-fatal)');
    return 0;
  }
}

/**
 * Sweep this user's terminal `audio_transcription_jobs` older than the
 * retention window. Trigger: the "My Audio" library read (GET /audio).
 */
export function sweepAudioTranscriptionJobs(userId: number, log: Logger): Promise<number> {
  return runSweep(
    'audio_transcription_jobs',
    `DELETE FROM audio_transcription_jobs
      WHERE user_id = $1
        AND status IN ('done', 'failed')
        AND finished_at < now() - make_interval(days => $2)`,
    userId,
    log,
  );
}

/**
 * Sweep this user's terminal `story_audio_jobs` older than the retention
 * window. Trigger: the generated-stories list read (GET /reading/generated).
 */
export function sweepStoryAudioJobs(userId: number, log: Logger): Promise<number> {
  return runSweep(
    'story_audio_jobs',
    `DELETE FROM story_audio_jobs
      WHERE user_id = $1
        AND status IN ('done', 'failed')
        AND finished_at < now() - make_interval(days => $2)`,
    userId,
    log,
  );
}

/**
 * Sweep this user's terminal `story_image_jobs` older than the retention
 * window. Trigger: the generated-stories list read (GET /reading/generated).
 */
export function sweepStoryImageJobs(userId: number, log: Logger): Promise<number> {
  return runSweep(
    'story_image_jobs',
    `DELETE FROM story_image_jobs
      WHERE user_id = $1
        AND status IN ('done', 'failed')
        AND finished_at < now() - make_interval(days => $2)`,
    userId,
    log,
  );
}

/**
 * Sweep this user's terminal `failed` `book_uploads` older than the
 * retention window (Phase 2.5 — async ingest, services/bookIngestRunner.ts).
 * Trigger: the "My Uploads" library read (GET /uploads).
 *
 * ONLY `status = 'failed'` — a `ready` upload is the user's actual content
 * (the whole point of the feature), never swept regardless of age; a
 * `pending`/`processing` row is live work a runner tick could still claim or
 * settle. `finished_at` is stamped only at settle (ready or failed), so a
 * still-in-flight row is doubly excluded the same way the other sweeps'
 * `finished_at < now() - …` predicate excludes their own in-flight rows.
 * `raw_blob_ref` is always NULL by the time a row is 'failed' — every path to
 * 'failed' (settleFailed's direct settle, AND the stale-run reaper) deletes
 * the raw file and clears the column before this sweep can ever see the row
 * — and a failed row's `book_pages` are likewise always empty by then
 * (cleared the same way, blob files included — see bookIngestRunner.ts's
 * `clearPagesAndBlobs`), so this DELETE needs no filesystem cleanup of its
 * own and cascades nothing.
 */
export function sweepFailedBookUploads(userId: number, log: Logger): Promise<number> {
  return runSweep(
    'book_uploads',
    `DELETE FROM book_uploads
      WHERE user_id = $1
        AND status = 'failed'
        AND finished_at < now() - make_interval(days => $2)`,
    userId,
    log,
  );
}
