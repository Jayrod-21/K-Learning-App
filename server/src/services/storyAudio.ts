/**
 * Story-audio pipeline (F-210) — the in-server TTS job runner + the text
 * segmentation that turns per-character TTS timings into the read-along
 * `audio_transcript_segments` windows.
 *
 * WHY IN-SERVER, NOT THE km-worker: the GPU worker mounts the audio volume
 * READ-ONLY (audioStore.ts's deploy note) — it physically cannot write the
 * synthesized mp3. Synthesis is a metered HTTP call (no GPU involved), so the
 * runner lives in the Node process that already mounts the blob store rw: a
 * lightweight unref'd interval claims `story_audio_jobs` rows exactly the way
 * the A-2 worker claims `audio_transcription_jobs` (FOR UPDATE SKIP LOCKED,
 * status-guarded settles, stale-'running' reaping — 076's contracts).
 *
 * PIPELINE (one job):
 *   claim (tx: pending → running)
 *     → synthesize                              [outside any tx — minutes]
 *         MULTI-VOICE (v2) when the story carries a usable `turns` array:
 *           one tts.synthesize per turn, each with the voice the palette
 *           assigned that turn's speaker (services/voicePalette.ts), then
 *           ffprobe each part's exact duration and ffmpeg-concat the parts
 *           into ONE mp3 (services/audioConcat.ts — injectable, mocked in
 *           tests). Each turn becomes ONE transcript segment whose window is
 *           the CUMULATIVE timeline: startMs = sum of all prior turns'
 *           probed durations, endMs = startMs + this turn's duration — so
 *           the read-along highlights exactly the line being spoken.
 *         SINGLE-NARRATOR (v1, unchanged) otherwise: one tts.synthesize of
 *           body_ko with the narrator voice; per-sentence segments windowed
 *           from the per-character alignment.
 *     → audioStore.saveBlob (mp3)               [outside the persist tx —
 *                                                blob-before-rows, 041's
 *                                                ordering: a later failure
 *                                                orphans only a FILE]
 *     → ONE tx: audio_sources (kind 'generated_story', owner-pinned story
 *       link) + audio_tracks (blob_ref, byte_size, duration_ms) +
 *       audio_transcript_segments + job → 'done'.
 *   ANY failure → job 'failed' with a bounded, server-authored error;
 *   best-effort blob unlink; NOTHING half-written (the persist tx is atomic).
 *
 * SECURITY:
 *   - Every value written is server-derived: the story row was
 *     ownership-checked at enqueue AND is joined owner-pinned at claim; blob
 *     paths come from audioStore.saveBlob (session-user dir + server UUID);
 *     job errors are whitelisted messages from services/tts.ts, never
 *     provider response text.
 *   - The composite FKs (081) make a cross-user source/job row structurally
 *     impossible even if this code were wrong.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../middleware/errors.js';
import { getMp3Concat } from './audioConcat.js';
import { deleteBlob, saveBlob } from './audioStore.js';
import { StoryTurnSchema, type StoryTurn } from './claude/models.js';
import {
  getTtsProvider,
  TtsNotConfiguredError,
  TtsUpstreamError,
  type TtsCharAlignment,
} from './tts.js';
import { assignVoices } from './voicePalette.js';

/** 503 for a keyless deploy (story TTS dormant — no ELEVENLABS_API_KEY).
 *  Thrown by the enqueue route BEFORE any job row is written, so a
 *  guaranteed-to-fail job never burns a daily-cap slot; the keyless
 *  provider's job-failure path stays as defense-in-depth for a config
 *  change that lands mid-flight. */
export class TtsUnavailableError extends AppError {
  public constructor() {
    super(
      503,
      'tts_unavailable',
      'audio generation is not available on this server — ask the operator to enable it',
    );
    this.name = 'TtsUnavailableError';
  }
}

/** 429 for the per-user daily story-TTS cap (STORY_TTS_DAILY_CAP — mirrors
 *  AudioDailyCapError's shape/copy posture). Thrown by the enqueue route
 *  BEFORE any job row is written. */
export class StoryTtsDailyCapError extends AppError {
  public constructor(cap: number, usedToday: number) {
    super(
      429,
      'rate_limited',
      `daily story-audio limit reached: ${usedToday} of ${cap} generations used today. ` +
        'Try again tomorrow.',
    );
    this.name = 'StoryTtsDailyCapError';
  }
}

// ---------------------------------------------------------------------------
// Segmentation — story text → read-along units with char offsets
// ---------------------------------------------------------------------------

/** One read-along unit of the story text: `body` is the TRIMMED segment text,
 *  [startChar, endChar) its UTF-16 code-unit span in the ORIGINAL body_ko
 *  (the same units the TTS per-character alignment indexes — and the same
 *  units String.slice uses, 080's offset stance). */
export interface StorySegmentText {
  segmentNumber: number;
  startChar: number;
  endChar: number;
  body: string;
}

/** Hard per-segment length bound — comfortably under the DB CHECK ceiling
 *  (075: body 1..5000) and small enough that a highlight never spans a wall
 *  of text; an unbreakable longer run is hard-chunked at this size. */
const MAX_SEGMENT_CHARS = 2000;

/** True when the character at `i` ends a sentence: sentence punctuation,
 *  optionally followed by closing quotes/brackets (the break lands AFTER
 *  those — the quote belongs to the sentence it closes). */
const SENTENCE_END = /[.!?…]/;
const CLOSERS = /["'”’」』)\]]/;

/**
 * Split a story body into ordered read-along segments (sentences, with
 * paragraph breaks always honored). Pure text math over the ORIGINAL string —
 * offsets index straight into body_ko, so the TTS alignment (index i = char
 * i of the synthesized text) maps each segment to its audio window with no
 * re-search. Whitespace-only spans are skipped; every returned body is
 * trimmed, non-empty and ≤ MAX_SEGMENT_CHARS (satisfying 075's CHECK).
 */
export function segmentStoryBody(bodyKo: string): StorySegmentText[] {
  // 1. Find raw break-delimited spans: after a newline run, or after
  //    sentence-ending punctuation (+ optional closers) followed by
  //    whitespace/end-of-text.
  const rawSpans: Array<{ start: number; end: number }> = [];
  let spanStart = 0;
  for (let i = 0; i < bodyKo.length; i++) {
    const ch = bodyKo[i]!;
    if (ch === '\n') {
      rawSpans.push({ start: spanStart, end: i });
      spanStart = i + 1;
      continue;
    }
    if (SENTENCE_END.test(ch)) {
      // Swallow any run of closers + further sentence punctuation ("…!?」).
      let j = i + 1;
      while (j < bodyKo.length && (CLOSERS.test(bodyKo[j]!) || SENTENCE_END.test(bodyKo[j]!))) j++;
      // Only a real boundary when followed by whitespace or end-of-text —
      // "3.5" or "www.example.com" must not split.
      if (j >= bodyKo.length || /\s/.test(bodyKo[j]!)) {
        rawSpans.push({ start: spanStart, end: j });
        spanStart = j;
        i = j - 1;
      }
    }
  }
  if (spanStart < bodyKo.length) rawSpans.push({ start: spanStart, end: bodyKo.length });

  // 2. Trim each span in place (offsets track the trimmed text), drop empties,
  //    hard-chunk anything still over the bound.
  const segments: StorySegmentText[] = [];
  for (const span of rawSpans) {
    let s = span.start;
    let e = span.end;
    while (s < e && /\s/.test(bodyKo[s]!)) s++;
    while (e > s && /\s/.test(bodyKo[e - 1]!)) e--;
    if (s >= e) continue;
    for (let chunkStart = s; chunkStart < e; chunkStart += MAX_SEGMENT_CHARS) {
      const chunkEnd = Math.min(chunkStart + MAX_SEGMENT_CHARS, e);
      segments.push({
        segmentNumber: segments.length + 1,
        startChar: chunkStart,
        endChar: chunkEnd,
        body: bodyKo.slice(chunkStart, chunkEnd),
      });
    }
  }
  return segments;
}

/** A persisted-shape segment window: [startMs, endMs] into the track. */
export interface StorySegmentWindow {
  segmentNumber: number;
  startMs: number;
  endMs: number;
  body: string;
}

/**
 * Attach audio windows to text segments from the TTS per-character alignment.
 *
 *   - EXACT path (the contract case): alignment length === text length, so
 *     char index i of body_ko is voiced during alignments[i] — a segment's
 *     window is [alignments[startChar].startMs, alignments[endChar-1].endMs].
 *   - PROPORTIONAL fallback: if the provider returned a differently-sized
 *     alignment (defensive — e.g. it normalized the text), indexes are scaled
 *     linearly. Coarser highlighting, but the audio still plays and every
 *     window stays inside the real duration.
 *   - NO-TIMING fallback: an empty alignment yields all-zero windows (legal
 *     under 075's end >= start CHECK); playback works, highlighting degrades
 *     to nothing.
 *
 * Windows are clamped monotone non-negative so malformed upstream timings can
 * never violate the DB CHECKs (start >= 0, end >= start).
 */
export function deriveSegmentWindows(
  segments: StorySegmentText[],
  alignments: TtsCharAlignment[],
  textLength: number,
): StorySegmentWindow[] {
  const mapIndex = (charIdx: number): number => {
    if (alignments.length === 0 || textLength === 0) return 0;
    if (alignments.length === textLength) return charIdx;
    return Math.min(
      alignments.length - 1,
      Math.floor((charIdx * alignments.length) / textLength),
    );
  };
  return segments.map((seg) => {
    let startMs = 0;
    let endMs = 0;
    if (alignments.length > 0) {
      startMs = Math.max(0, alignments[mapIndex(seg.startChar)]!.startMs);
      endMs = Math.max(startMs, alignments[mapIndex(seg.endChar - 1)]!.endMs);
    }
    return { segmentNumber: seg.segmentNumber, startMs, endMs, body: seg.body };
  });
}

// ---------------------------------------------------------------------------
// Multi-voice synthesis (F-210 v2)
// ---------------------------------------------------------------------------

/**
 * Validate a story's stored `turns` JSONB into a usable multi-voice script.
 * Returns null — meaning "use the single-narrator path" — for NULL/absent
 * turns (pre-081 stories, turn-less generations) AND for anything that fails
 * the schema (a hand-edited row, a pre-Zod shape): degrading to the v1 read
 * of body_ko is always correct, so malformed turns must never fail a job.
 * StoryTurnSchema trims each text, so every parsed turn is non-empty.
 */
export function parseStoryTurns(raw: unknown): StoryTurn[] | null {
  if (raw === null || raw === undefined) return null;
  const parsed = z.array(StoryTurnSchema).min(1).max(200).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What either synthesis path hands the shared persist step. */
interface SynthesizedStory {
  audio: Buffer;
  segments: StorySegmentWindow[];
  durationMs: number | null;
  /** Exact chars synthesized on the multi-voice path (sum of turn texts) —
   *  settles into the job's char_count ledger; null = keep the enqueue
   *  snapshot (the single-narrator path, where body_ko.length already IS
   *  the exact spend). */
  actualCharCount: number | null;
}

/**
 * v2 multi-voice: one synthesis per turn with the palette-assigned voice,
 * exact per-part durations via ffprobe, one concatenated mp3 via ffmpeg.
 *
 * OFFSET MATH (the read-along contract): the concatenated file's timeline is
 * the parts laid end to end, so turn i's segment window is
 *   startMs(i) = Σ durations[0..i-1],  endMs(i) = startMs(i) + durations[i]
 * with durations PROBED from the real per-turn audio — NOT taken from the
 * TTS char alignments, whose last endMs can undershoot the true file length
 * (trailing silence/padding) and would drift every later boundary.
 * segment_number is the 1-based turn index; segment body is the turn's text.
 */
async function synthesizeMultiVoice(
  turns: StoryTurn[],
  narratorVoiceId: string,
  log: Logger,
  jobId: number,
): Promise<SynthesizedStory> {
  const voices = assignVoices(turns, narratorVoiceId);
  const tts = getTtsProvider();
  const concat = getMp3Concat();

  const parts: Buffer[] = [];
  let actualCharCount = 0;
  for (const turn of turns) {
    // Sequential on purpose: parallel calls would burst the TTS API and the
    // parts must land in story order anyway.
    const part = await tts.synthesize(turn.text, { voiceId: voices.get(turn.speaker)! });
    parts.push(part.audio);
    actualCharCount += turn.text.length;
  }

  const durations: number[] = [];
  for (const part of parts) {
    durations.push(await concat.probeDurationMs(part));
  }
  const audio = await concat.concatMp3(parts);

  const segments: StorySegmentWindow[] = [];
  let cursorMs = 0;
  for (let i = 0; i < turns.length; i++) {
    const startMs = cursorMs;
    cursorMs += durations[i]!;
    segments.push({
      segmentNumber: i + 1,
      startMs,
      endMs: cursorMs,
      body: turns[i]!.text,
    });
  }
  log.info(
    { jobId, turns: turns.length, speakers: voices.size, durationMs: cursorMs },
    'storyAudio: multi-voice synthesis complete',
  );
  return { audio, segments, durationMs: cursorMs, actualCharCount };
}

/** v1 single-narrator read of body_ko (default voice, per-sentence segments
 *  windowed from the char alignment) — byte-for-byte the original behavior. */
async function synthesizeSingleNarrator(bodyKo: string): Promise<SynthesizedStory> {
  const synthesis = await getTtsProvider().synthesize(bodyKo);
  const segments = deriveSegmentWindows(
    segmentStoryBody(bodyKo),
    synthesis.charAlignments,
    bodyKo.length,
  );
  const durationMs =
    synthesis.charAlignments.length > 0
      ? Math.max(0, synthesis.charAlignments[synthesis.charAlignments.length - 1]!.endMs)
      : null;
  return { audio: synthesis.audio, segments, durationMs, actualCharCount: null };
}

// ---------------------------------------------------------------------------
// The job runner
// ---------------------------------------------------------------------------

export type StoryAudioTickResult = 'idle' | 'done' | 'failed';

interface ClaimedJob {
  jobId: number;
  storyId: number;
  userId: number;
  title: string;
  bodyKo: string;
  /** Raw JSONB from generated_stories.turns — validated by parseStoryTurns. */
  turns: unknown;
}

/** Bounded, user-visible failure copy. TTS-layer errors carry OUR whitelisted
 *  messages (tts.ts never embeds provider text or the key), so they pass
 *  through; anything else gets a generic line and full server-side logging. */
function failureMessage(err: unknown): string {
  if (err instanceof TtsNotConfiguredError || err instanceof TtsUpstreamError) {
    return err.message.slice(0, 2000);
  }
  return 'audio generation failed unexpectedly — try again later';
}

/** Settle a running job as failed. Status-guarded so a reaped/settled row is
 *  never overwritten (the guard losing the race is fine — the row already
 *  carries a terminal state). */
async function settleFailed(jobId: number, message: string): Promise<void> {
  await query(
    `UPDATE story_audio_jobs
        SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId, message],
  );
}

/**
 * Run ONE runner tick: reap stale 'running' rows, then claim and fully
 * process at most one pending job. Exported so tests drive the pipeline
 * deterministically (no timers involved).
 *
 * @returns 'idle' (no pending work), 'done' (a job settled done) or 'failed'
 *          (a job settled failed).
 */
export async function runStoryAudioTick(log: Logger): Promise<StoryAudioTickResult> {
  const cfg = loadConfig();

  // 1. Reap: a 'running' row older than the stale threshold is a crashed run
  //    (server killed mid-synthesis) that would otherwise brick its story's
  //    one-live-job slot forever. ONLY 'running' — 'pending' is the healthy
  //    backlog (076's reap contract). started_at is stamped at claim, so it
  //    is never NULL for a 'running' row.
  const reaped = await query(
    `UPDATE story_audio_jobs
        SET status = 'failed',
            error = 'audio generation was interrupted by a server restart — try again',
            finished_at = now()
      WHERE status = 'running'
        AND started_at < now() - make_interval(mins => $1)`,
    [cfg.STORY_TTS_STALE_RUN_MINUTES],
  );
  if (reaped.rowCount > 0) {
    log.warn({ reaped: reaped.rowCount }, 'storyAudio: reaped stale running job(s)');
  }

  // 2. Claim (its own short tx — the synthesis must NOT run inside one). The
  //    join can't miss: the job CASCADEs with its story (081), so a claimed
  //    job's story exists at claim time; FOR UPDATE OF j locks only the job
  //    row, and SKIP LOCKED keeps concurrent claimants (multi-instance
  //    deploys) from double-running one job.
  const claimed = await withTransaction<ClaimedJob | null>(async (client) => {
    const { rows } = await client.query<{
      id: number;
      generated_story_id: number;
      user_id: number;
      title: string;
      body_ko: string;
      turns: unknown;
    }>(
      `SELECT j.id, j.generated_story_id, j.user_id, s.title, s.body_ko, s.turns
         FROM story_audio_jobs j
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
      `UPDATE story_audio_jobs SET status = 'running', started_at = now() WHERE id = $1`,
      [row.id],
    );
    return {
      jobId: Number(row.id),
      storyId: Number(row.generated_story_id),
      userId: Number(row.user_id),
      title: row.title,
      bodyKo: row.body_ko,
      turns: row.turns,
    };
  });
  if (claimed === null) return 'idle';

  const { jobId, storyId, userId, title, bodyKo } = claimed;

  // 3. Synthesize (minutes-long external calls; no tx held). Multi-voice
  //    when the story carries a usable turns array, else the v1 narrator
  //    read — old/flat/malformed-turns stories keep working unchanged. A
  //    failure ANYWHERE in here (a per-turn synthesis, ffprobe, the concat)
  //    settles the job failed with nothing written: no blob exists yet.
  const turns = parseStoryTurns(claimed.turns);
  if (claimed.turns != null && turns === null) {
    // The graceful degrade is correct (never fail a job over bad turns), but
    // it must be VISIBLE: without this line a malformed stored script is
    // indistinguishable in logs from a genuinely flat v1 story.
    log.warn(
      { jobId, storyId },
      'storyAudio: turns present but unparseable — falling back to single-narrator',
    );
  }
  log.info(
    { jobId, storyId, chars: bodyKo.length, multiVoice: turns !== null },
    'storyAudio: job claimed',
  );
  let synthesized: SynthesizedStory;
  try {
    synthesized =
      turns !== null
        ? await synthesizeMultiVoice(turns, cfg.ELEVENLABS_VOICE_ID, log, jobId)
        : await synthesizeSingleNarrator(bodyKo);
  } catch (err) {
    log.warn({ jobId, storyId, err: String(err) }, 'storyAudio: synthesis failed');
    await settleFailed(jobId, failureMessage(err));
    return 'failed';
  }
  const { audio, segments, durationMs, actualCharCount } = synthesized;

  // 4. Blob first (041's blob-before-rows ordering): a failure after this
  //    point can only orphan a FILE — which the catch below best-effort
  //    unlinks — never commit a row pointing at missing bytes.
  let blobRef: string | null = null;
  try {
    blobRef = await saveBlob(userId, randomUUID(), 'mp3', audio);

    // 5. ONE transaction: set + track + segments + job settle. The
    //    status-guarded job UPDATE returning 0 rows means a reaper settled
    //    the job mid-run — abort so the reaper's verdict stands and no
    //    orphaned "done" content appears out from under a failed job.
    await withTransaction(async (client) => {
      const src = await client.query<{ id: number }>(
        `INSERT INTO audio_sources
           (user_id, slug, title, kind, source_upload_id, generated_story_id, status)
         VALUES ($1, $2, $3, 'generated_story', NULL, $4, 'ready')
         RETURNING id`,
        // Slug is server-derived + deterministic per story; the voice-once
        // partial UNIQUE (uq_audio_sources_generated_story) makes a
        // double-voice INSERT fail here — rolling this tx back — rather than
        // ever duplicating a story's audio.
        [userId, `generated-story-${storyId}`, title, storyId],
      );
      const sourceId = src.rows[0]!.id;

      const trk = await client.query<{ id: number }>(
        `INSERT INTO audio_tracks
           (source_id, user_id, track_number, title, blob_ref, byte_size, duration_ms,
            transcript_status)
         VALUES ($1, $2, 1, $3, $4, $5, $6, 'done')
         RETURNING id`,
        // transcript_status 'done': the segments land in this same tx (they
        // come from TTS timing, not Whisper — nothing further is pending).
        [sourceId, userId, title, blobRef, audio.length, durationMs],
      );
      const trackId = trk.rows[0]!.id;

      if (segments.length > 0) {
        await client.query(
          `INSERT INTO audio_transcript_segments
             (track_id, segment_number, start_ms, end_ms, body)
           SELECT $1, * FROM UNNEST($2::int[], $3::int[], $4::int[], $5::text[])`,
          [
            trackId,
            segments.map((s) => s.segmentNumber),
            segments.map((s) => s.startMs),
            segments.map((s) => s.endMs),
            segments.map((s) => s.body),
          ],
        );
      }

      const settled = await client.query(
        // char_count: the multi-voice path settles the EXACT synthesized
        // spend (sum of turn-text lengths — can differ from the enqueue-time
        // body_ko snapshot); the single-narrator path passes NULL and keeps
        // the snapshot, which already equals its exact spend.
        `UPDATE story_audio_jobs
            SET status = 'done', audio_source_id = $2, finished_at = now(),
                char_count = COALESCE($3, char_count)
          WHERE id = $1 AND status = 'running'`,
        [jobId, sourceId, actualCharCount],
      );
      if (settled.rowCount === 0) {
        throw new Error('storyAudio: job was reaped mid-run — discarding synthesis result');
      }
    });
  } catch (err) {
    // The persist tx rolled back — no source/track/segment rows exist. Clean
    // the orphaned blob best-effort (a cleanup failure must never mask the
    // real error) and settle the job failed with a generic message (this
    // path is OUR failure, not the provider's — details stay in the log).
    log.error({ jobId, storyId, err: String(err) }, 'storyAudio: persist failed');
    if (blobRef !== null) {
      try {
        await deleteBlob(blobRef);
      } catch (cleanupErr) {
        log.warn(
          { jobId, blobRef, err: String(cleanupErr) },
          'storyAudio: failed to delete blob after rolled-back persist (orphaned, non-fatal)',
        );
      }
    }
    await settleFailed(jobId, failureMessage(err));
    return 'failed';
  }

  log.info({ jobId, storyId }, 'storyAudio: job done');
  return 'done';
}

/**
 * Start the in-server polling runner. Called once from index.ts after the
 * server binds (NEVER from createApp — tests build apps constantly and must
 * drive ticks explicitly). The interval is unref'd so it can't hold the
 * process open; ticks never overlap (a running drain skips the next fire);
 * each fire DRAINS the queue (loops until 'idle') so a burst of enqueues
 * doesn't wait one interval per job.
 *
 * @returns a stop function for graceful shutdown.
 */
export function startStoryAudioRunner(log: Logger): () => void {
  const cfg = loadConfig();
  let draining = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (draining || stopped) return;
    draining = true;
    void (async () => {
      try {
        let result: StoryAudioTickResult;
        do {
          result = await runStoryAudioTick(log);
        } while (result !== 'idle' && !stopped);
      } catch (err) {
        // A tick throwing (DB outage mid-poll) must never kill the interval —
        // the next fire retries; claimed-but-unsettled rows are the stale
        // reaper's job.
        log.error({ err: String(err) }, 'storyAudio: runner tick threw');
      } finally {
        draining = false;
      }
    })();
  }, cfg.STORY_TTS_POLL_INTERVAL_MS);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
