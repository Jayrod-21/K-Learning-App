/**
 * Story-illustration pipeline (F-211) — the in-server image job runner.
 * storyAudio.ts (F-210) with the provider swapped TTS→image; every job/ledger
 * contract carries over unchanged (claim FOR UPDATE SKIP LOCKED, stale-
 * 'running' reaping, generate OUTSIDE any tx, blob-before-rows, ONE
 * status-guarded persist tx, best-effort blob cleanup on failure).
 *
 * PIPELINE (one job = "illustrate this story" → N story_images rows):
 *   claim (tx: pending → running)
 *     → prompt set                              [outside any tx]
 *         ONE generateStoryImagePrompts call (services/claude — route
 *         'story_image_prompts'): the fixed webtoon style directive, the
 *         shared character sheet, and 2-4 self-contained scene prompts.
 *         CACHED per story (long TTL), so a retry after an image failure
 *         reuses the same scenes at $0. Character consistency across the
 *         images comes entirely from the carried descriptions — the image
 *         model has no seed lock.
 *     → per scene: provider.generate(prompt)    [outside any tx — minutes]
 *         → imageStore.saveBlob (blob-before-rows, 041's ordering)
 *     → ONE tx: N story_images rows + job → 'done', status-guarded.
 *   ANY failure → ALL-OR-NOTHING (F-211's locked partial-failure policy):
 *   the job settles 'failed' with a bounded, server-authored error, EVERY
 *   blob this run wrote is best-effort unlinked, and NO story_images row
 *   exists (the persist tx is atomic and only ever runs after every scene
 *   succeeded). A story is never left with 2 of 3 images.
 *
 * SECURITY:
 *   - Every value written is server-derived: the story row was
 *     ownership-checked at enqueue AND is joined owner-pinned at claim; blob
 *     paths come from imageStore.saveBlob (session-user dir + server UUID);
 *     prompts are Zod-bounded Claude-proxy output; job errors are
 *     whitelisted messages from services/imageGen.ts, never provider
 *     response text.
 *   - The composite FKs (083) make a cross-user image/job row structurally
 *     impossible even if this code were wrong.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { isRunnerActiveColor, loadConfig } from '../config/index.js';
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../middleware/errors.js';
import { getClaudeProxy } from './claudeProxy.js';
import {
  getImageGenProvider,
  ImageGenNotConfiguredError,
  ImageGenUpstreamError,
} from './imageGen.js';
import { deleteBlob, extForMime, saveBlob } from './imageStore.js';
import { parseStoryTurns } from './storyAudio.js';

/** 503 for a keyless deploy (story illustrations dormant — no
 *  OPENAI_API_KEY). Thrown by the enqueue path BEFORE any job row is
 *  written, so a guaranteed-to-fail job never burns a daily-cap slot; the
 *  keyless provider's job-failure path stays as defense-in-depth for a
 *  config change that lands mid-flight. Mirrors TtsUnavailableError. */
export class ImageGenUnavailableError extends AppError {
  public constructor() {
    super(
      503,
      'image_gen_unavailable',
      'story illustrations are not available on this server — ask the operator to enable them',
    );
    this.name = 'ImageGenUnavailableError';
  }
}

/** 429 for the per-user daily story-illustration cap (STORY_IMAGE_DAILY_CAP
 *  — mirrors StoryTtsDailyCapError's shape/copy posture). Thrown by the
 *  enqueue path BEFORE any job row is written. */
export class StoryImageDailyCapError extends AppError {
  public constructor(cap: number, usedToday: number) {
    super(
      429,
      'rate_limited',
      `daily story-illustration limit reached: ${usedToday} of ${cap} generations used today. ` +
        'Try again tomorrow.',
    );
    this.name = 'StoryImageDailyCapError';
  }
}

// ---------------------------------------------------------------------------
// The job runner
// ---------------------------------------------------------------------------

export type StoryImageTickResult = 'idle' | 'done' | 'failed';

interface ClaimedJob {
  jobId: number;
  storyId: number;
  userId: number;
  title: string;
  bodyKo: string;
  /** Raw JSONB from generated_stories.turns — validated by parseStoryTurns. */
  turns: unknown;
  imageCount: number;
}

/** Bounded, user-visible failure copy. imageGen-layer errors carry OUR
 *  whitelisted messages (imageGen.ts never embeds provider text or the key),
 *  so they pass through; anything else — INCLUDING Claude-proxy errors,
 *  whose messages can embed schema diffs — gets a generic line and full
 *  server-side logging. */
function failureMessage(err: unknown): string {
  if (err instanceof ImageGenNotConfiguredError || err instanceof ImageGenUpstreamError) {
    return err.message.slice(0, 2000);
  }
  return 'illustration generation failed unexpectedly — try again later';
}

/** Settle a running job as failed. Status-guarded so a reaped/settled row is
 *  never overwritten (the guard losing the race is fine — the row already
 *  carries a terminal state). */
async function settleFailed(jobId: number, message: string): Promise<void> {
  await query(
    `UPDATE story_image_jobs
        SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId, message],
  );
}

/** Best-effort unlink of every blob a failed run wrote (the all-or-nothing
 *  policy's cleanup half). A cleanup failure must never mask the real error
 *  — it is logged and swallowed. */
async function cleanupBlobs(blobRefs: readonly string[], log: Logger, jobId: number): Promise<void> {
  for (const blobRef of blobRefs) {
    try {
      await deleteBlob(blobRef);
    } catch (cleanupErr) {
      log.warn(
        { jobId, blobRef, err: String(cleanupErr) },
        'storyImage: failed to delete blob after failed run (orphaned, non-fatal)',
      );
    }
  }
}

/**
 * Run ONE runner tick: reap stale 'running' rows, then claim and fully
 * process at most one pending job. Exported so tests drive the pipeline
 * deterministically (no timers involved).
 *
 * @returns 'idle' (no pending work), 'done' (a job settled done) or 'failed'
 *          (a job settled failed).
 */
export async function runStoryImageTick(log: Logger): Promise<StoryImageTickResult> {
  const cfg = loadConfig();

  // 1. Reap: a 'running' row older than the stale threshold is a crashed run
  //    (server killed mid-generation) that would otherwise brick its story's
  //    one-live-job slot forever. ONLY 'running' — 'pending' is the healthy
  //    backlog (076/081's reap contract). started_at is stamped at claim, so
  //    it is never NULL for a 'running' row.
  const reaped = await query(
    `UPDATE story_image_jobs
        SET status = 'failed',
            error = 'illustration generation was interrupted by a server restart — try again',
            finished_at = now()
      WHERE status = 'running'
        AND started_at < now() - make_interval(mins => $1)`,
    [cfg.STORY_IMAGE_STALE_RUN_MINUTES],
  );
  if (reaped.rowCount > 0) {
    log.warn({ reaped: reaped.rowCount }, 'storyImage: reaped stale running job(s)');
  }

  // Blue/green gate (audit §7.2 / Phase 1.3): the reap above is time-based
  // and benign to run in every color, but claim+process below must run in
  // only the color nginx is actively routing to — otherwise the idle color
  // silently processes live jobs with the PREVIOUS release's code. See
  // config/index.ts's `isRunnerActiveColor` doc for the mechanism and why it
  // fails open outside a blue/green deployment.
  if (!cfg.STORY_RUNNERS_ENABLED || !isRunnerActiveColor(cfg)) return 'idle';

  // 2. Claim (its own short tx — the generation must NOT run inside one).
  //    The join can't miss: the job CASCADEs with its story (083), so a
  //    claimed job's story exists at claim time; FOR UPDATE OF j locks only
  //    the job row, and SKIP LOCKED keeps concurrent claimants from
  //    double-running one job.
  const claimed = await withTransaction<ClaimedJob | null>(async (client) => {
    const { rows } = await client.query<{
      id: number;
      generated_story_id: number;
      user_id: number;
      title: string;
      body_ko: string;
      turns: unknown;
      image_count: number;
    }>(
      `SELECT j.id, j.generated_story_id, j.user_id, j.image_count,
              s.title, s.body_ko, s.turns
         FROM story_image_jobs j
         JOIN generated_stories s
           ON s.id = j.generated_story_id AND s.user_id = j.user_id
        WHERE j.status = 'pending'
        ORDER BY j.created_at, j.id
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE story_image_jobs SET status = 'running', started_at = now() WHERE id = $1`,
      [row.id],
    );
    return {
      jobId: Number(row.id),
      storyId: Number(row.generated_story_id),
      userId: Number(row.user_id),
      title: row.title,
      bodyKo: row.body_ko,
      turns: row.turns,
      imageCount: row.image_count,
    };
  });
  if (claimed === null) return 'idle';

  const { jobId, storyId, userId, title, bodyKo } = claimed;
  // The enqueue snapshot is the request; the config clamp (2-4) re-bounds a
  // legacy/hand-edited row so the proxy input schema can never reject it.
  const sceneCount = Math.min(4, Math.max(2, claimed.imageCount));
  log.info({ jobId, storyId, sceneCount }, 'storyImage: job claimed');

  // 3. Prompt set + per-scene generation + blobs (minutes-long external
  //    calls; no tx held). ALL-OR-NOTHING: a failure ANYWHERE in here fails
  //    the job and unlinks every blob written so far — a story never ends up
  //    with 2 of 3 images.
  const blobRefs: string[] = [];
  interface SceneRow {
    imageNumber: number;
    blobRef: string;
    prompt: string;
    width: number;
    height: number;
  }
  const sceneRows: SceneRow[] = [];
  try {
    // 3a. ONE prompt-set call per job. turns degrade exactly as the audio
    //     runner's: a malformed stored script falls back to body-only input
    //     (never fails a job) — parseStoryTurns is the shared validator.
    const turns = parseStoryTurns(claimed.turns);
    if (claimed.turns != null && turns === null) {
      log.warn(
        { jobId, storyId },
        'storyImage: turns present but unparseable — deriving the cast from the body only',
      );
    }
    const { result: promptSet } = await getClaudeProxy().generateStoryImagePrompts(
      {
        title,
        bodyKo,
        sceneCount,
        ...(turns !== null ? { turns } : {}),
      },
      { userId },
    );

    // 3b. Sequential per-scene generation (parallel calls would burst the
    //     image API and the rows must land in scene order anyway). The model
    //     may return a different (schema-legal, 2-4) count than requested —
    //     the returned set is authoritative; image_count stays the ledger's
    //     enqueue snapshot (069/081's snapshot stance).
    const provider = getImageGenProvider();
    for (let i = 0; i < promptSet.scenePrompts.length; i++) {
      const prompt = promptSet.scenePrompts[i]!;
      const generated = await provider.generate(prompt);
      const ext = extForMime(generated.mimeType);
      if (ext === null) {
        // Defensive: the provider contract pins image/png; a surprise mime
        // must fail the job, not write an unservable blob.
        throw new Error(`storyImage: provider returned unsupported mime ${generated.mimeType}`);
      }
      const blobRef = await saveBlob(userId, randomUUID(), ext, generated.image);
      blobRefs.push(blobRef);
      sceneRows.push({
        imageNumber: i + 1,
        blobRef,
        prompt,
        width: generated.width,
        height: generated.height,
      });
    }
  } catch (err) {
    log.warn({ jobId, storyId, err: String(err) }, 'storyImage: generation failed');
    await cleanupBlobs(blobRefs, log, jobId);
    await settleFailed(jobId, failureMessage(err));
    return 'failed';
  }

  // 4. ONE transaction: all rows + the job settle. The status-guarded job
  //    UPDATE returning 0 rows means a reaper settled the job mid-run —
  //    abort so the reaper's verdict stands and no orphaned "done" images
  //    appear out from under a failed job. The generate-once UNIQUE
  //    (uq_story_images_story_number) makes a double-illustration INSERT
  //    fail here — rolling this tx back — rather than ever duplicating.
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO story_images
           (generated_story_id, user_id, image_number, blob_ref, prompt, width, height)
         SELECT $1, $2, * FROM UNNEST($3::int[], $4::text[], $5::text[], $6::int[], $7::int[])`,
        [
          storyId,
          userId,
          sceneRows.map((s) => s.imageNumber),
          sceneRows.map((s) => s.blobRef),
          sceneRows.map((s) => s.prompt),
          sceneRows.map((s) => s.width),
          sceneRows.map((s) => s.height),
        ],
      );
      const settled = await client.query(
        `UPDATE story_image_jobs
            SET status = 'done', finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [jobId],
      );
      if (settled.rowCount === 0) {
        throw new Error('storyImage: job was reaped mid-run — discarding generated images');
      }
    });
  } catch (err) {
    // The persist tx rolled back — no story_images rows exist. Clean the
    // orphaned blobs best-effort and settle the job failed with a generic
    // message (this path is OUR failure, not the provider's — details stay
    // in the log).
    log.error({ jobId, storyId, err: String(err) }, 'storyImage: persist failed');
    await cleanupBlobs(blobRefs, log, jobId);
    await settleFailed(jobId, failureMessage(err));
    return 'failed';
  }

  log.info({ jobId, storyId, images: sceneRows.length }, 'storyImage: job done');
  return 'done';
}

/**
 * Start the in-server polling runner. Called once from index.ts after the
 * server binds (NEVER from createApp — tests build apps constantly and must
 * drive ticks explicitly). The interval is unref'd so it can't hold the
 * process open; ticks never overlap (a running drain skips the next fire);
 * each fire DRAINS the queue (loops until 'idle') so a burst of enqueues
 * doesn't wait one interval per job. Byte-for-byte startStoryAudioRunner's
 * contract.
 *
 * @returns a stop function for graceful shutdown.
 */
export function startStoryImageRunner(log: Logger): () => void {
  const cfg = loadConfig();
  let draining = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (draining || stopped) return;
    draining = true;
    void (async () => {
      try {
        let result: StoryImageTickResult;
        do {
          result = await runStoryImageTick(log);
        } while (result !== 'idle' && !stopped);
      } catch (err) {
        // A tick throwing (DB outage mid-poll) must never kill the interval —
        // the next fire retries; claimed-but-unsettled rows are the stale
        // reaper's job.
        log.error({ err: String(err) }, 'storyImage: runner tick threw');
      } finally {
        draining = false;
      }
    })();
  }, cfg.STORY_IMAGE_POLL_INTERVAL_MS);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
