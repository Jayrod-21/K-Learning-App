/**
 * Tests for src/services/storyAudio.ts (F-210 — segmentation + the in-server
 * TTS job runner).
 *
 * The runner is driven DETERMINISTICALLY: no timers — each test calls
 * runStoryAudioTick directly with an injected TtsProvider (setTtsProvider),
 * against a real Postgres (testcontainers) and a throwaway blob-store temp
 * dir (AUDIO_UPLOAD_STORAGE_DIR env-injected before buildTestApp).
 *
 * Coverage:
 *   - segmentStoryBody: sentence + paragraph splitting with correct UTF-16
 *     offsets into the ORIGINAL string; trimming; no empty segments
 *   - deriveSegmentWindows: exact per-char mapping; proportional fallback;
 *     no-timing fallback; monotone/non-negative clamps
 *   - tick, empty queue → 'idle'
 *   - tick, happy path → job 'done' + audio_sources (kind 'generated_story',
 *     story-linked, owner-pinned) + audio_tracks (blob on disk, exact bytes,
 *     duration from the last alignment) + ordered segments with
 *     alignment-derived windows — all committed atomically
 *   - provider failure → job 'failed' with the provider's whitelisted
 *     message; NO source/track/segment rows; NO blob left on disk
 *   - persist failure (voice-once unique tripped) → rollback: job 'failed',
 *     no second source, the freshly written blob is unlinked
 *   - stale-'running' reap: an old running job is settled 'failed'; 'pending'
 *     is never reaped
 *   - MULTI-VOICE (v2): parseStoryTurns validation/fallback; per-turn voice
 *     assignment via the palette (recorded by a mock provider); per-turn
 *     segments with CUMULATIVE probed-duration offsets; ONE concatenated
 *     blob; exact char_count settle; synth-mid-run and concat failures →
 *     'failed' with no half-state; a single-turn script runs the full
 *     pipeline (one part, one segment); malformed turns → the v1 narrator
 *     path WITH a warn log (never silent).
 *     ffmpeg is NEVER required here — audioConcat is injected (setMp3Concat).
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedGeneratedStory, seedStoryAudio, seedStoryAudioJob } from '../helpers/seed.js';
import {
  deriveSegmentWindows,
  parseStoryTurns,
  runStoryAudioTick,
  segmentStoryBody,
} from '../../src/services/storyAudio.js';
import {
  resetTtsProviderForTesting,
  setTtsProvider,
  TtsUpstreamError,
  type TtsCharAlignment,
  type TtsProvider,
} from '../../src/services/tts.js';
import {
  resetMp3ConcatForTesting,
  setMp3Concat,
  type Mp3ConcatHelper,
} from '../../src/services/audioConcat.js';
import { FEMALE_VOICE_POOL, MALE_VOICE_POOL } from '../../src/services/voicePalette.js';
import { loadConfig } from '../../src/config/index.js';
import { getLogger } from '../../src/logging.js';

let pg: PgHandle;
let t: TestApp;

const MP3_BYTES = Buffer.from('fake-mp3-bytes-for-story-audio-test');

/** Alignments where char i of `text` is voiced during [i*100, (i+1)*100) ms. */
function alignmentsFor(text: string): TtsCharAlignment[] {
  return Array.from(text, (char, i) => ({ char, startMs: i * 100, endMs: (i + 1) * 100 }));
}

function okProvider(text: string): TtsProvider {
  return {
    synthesize: async () => ({
      audio: MP3_BYTES,
      mimeType: 'audio/mpeg',
      charAlignments: alignmentsFor(text),
    }),
  };
}

/** Files currently under the user's blob dir ([] when the dir doesn't exist). */
async function userBlobFiles(userId: number): Promise<string[]> {
  try {
    return await readdir(path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, String(userId)));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  process.env.AUDIO_UPLOAD_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-story-audio-test-${process.pid}-${Date.now()}`,
  );
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
  delete process.env.AUDIO_UPLOAD_STORAGE_DIR;
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE story_audio_jobs, audio_transcript_segments, audio_tracks, audio_sources, generated_stories, sessions, users RESTART IDENTITY CASCADE',
  );
  // RESTART IDENTITY reuses user ids across tests, but blob FILES survive the
  // TRUNCATE — wipe the store root so "no blob left behind" assertions can
  // never see a previous test's file.
  await rm(process.env.AUDIO_UPLOAD_STORAGE_DIR!, { recursive: true, force: true });
});

afterEach(() => {
  resetTtsProviderForTesting();
  resetMp3ConcatForTesting();
});

// ---------------------------------------------------------------------------
// Segmentation (pure text math — no DB)
// ---------------------------------------------------------------------------

describe('segmentStoryBody', () => {
  it('splits sentences and paragraphs with offsets into the ORIGINAL string', () => {
    const body = '고양이가 왔다. 고양이가 갔다.\n\n새로운 문단이다!';
    const segs = segmentStoryBody(body);
    expect(segs.map((s) => s.body)).toEqual(['고양이가 왔다.', '고양이가 갔다.', '새로운 문단이다!']);
    // Offsets must slice the original back out exactly (the alignment-index
    // contract the windows ride).
    for (const s of segs) {
      expect(body.slice(s.startChar, s.endChar)).toBe(s.body);
    }
    expect(segs.map((s) => s.segmentNumber)).toEqual([1, 2, 3]);
  });

  it('does not split on a non-boundary dot (decimals) and honors closing quotes', () => {
    const body = '점수는 3.5점이었다. "정말요?" 그가 물었다.';
    const segs = segmentStoryBody(body);
    expect(segs.map((s) => s.body)).toEqual(['점수는 3.5점이었다.', '"정말요?"', '그가 물었다.']);
  });

  it('skips whitespace-only spans and trims every segment', () => {
    const body = '  첫 문장.  \n\n   \n둘째 문장?   ';
    const segs = segmentStoryBody(body);
    expect(segs.map((s) => s.body)).toEqual(['첫 문장.', '둘째 문장?']);
    for (const s of segs) {
      expect(body.slice(s.startChar, s.endChar)).toBe(s.body);
    }
  });

  it('hard-chunks an unbreakable run to stay under the DB body CHECK', () => {
    const body = '가'.repeat(4100); // no punctuation, no newline
    const segs = segmentStoryBody(body);
    expect(segs.length).toBe(3); // 2000 + 2000 + 100
    for (const s of segs) {
      expect(s.body.length).toBeLessThanOrEqual(2000);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });
});

describe('deriveSegmentWindows', () => {
  it('maps exact per-char alignments to [start of first char, end of last char]', () => {
    const body = '안녕. 잘가.';
    const segs = segmentStoryBody(body);
    const windows = deriveSegmentWindows(segs, alignmentsFor(body), body.length);
    // '안녕.' = chars [0,3) → [0, 300); '잘가.' = chars [4,7) → [400, 700)
    expect(windows).toEqual([
      { segmentNumber: 1, startMs: 0, endMs: 300, body: '안녕.' },
      { segmentNumber: 2, startMs: 400, endMs: 700, body: '잘가.' },
    ]);
  });

  it('falls back to proportional mapping when the alignment length differs', () => {
    const body = '안녕. 잘가.'; // 7 chars
    const segs = segmentStoryBody(body);
    // Half-length alignment (provider normalized the text): still monotone,
    // still inside the real duration.
    const halved = alignmentsFor(body).filter((_, i) => i % 2 === 0);
    const windows = deriveSegmentWindows(segs, halved, body.length);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.startMs).toBeGreaterThanOrEqual(0);
    expect(windows[0]!.endMs).toBeGreaterThanOrEqual(windows[0]!.startMs);
    expect(windows[1]!.endMs).toBeGreaterThanOrEqual(windows[1]!.startMs);
    const maxEnd = Math.max(...halved.map((a) => a.endMs));
    expect(windows[1]!.endMs).toBeLessThanOrEqual(maxEnd);
  });

  it('yields zero windows (not a crash, not a CHECK violation shape) with no timing data', () => {
    const body = '안녕하세요.';
    const windows = deriveSegmentWindows(segmentStoryBody(body), [], body.length);
    expect(windows).toEqual([{ segmentNumber: 1, startMs: 0, endMs: 0, body: '안녕하세요.' }]);
  });
});

// ---------------------------------------------------------------------------
// The runner tick
// ---------------------------------------------------------------------------

describe('runStoryAudioTick', () => {
  it('returns idle when nothing is pending', async () => {
    setTtsProvider(okProvider('unused'));
    await expect(runStoryAudioTick(getLogger())).resolves.toBe('idle');
  });

  it('happy path: claims, synthesizes, persists set+track+segments atomically, settles done', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const body = '고양이가 왔다. 고양이가 갔다.';
    const storyId = await seedGeneratedStory(pg.pool, userId, { title: '고양이', bodyKo: body });
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'pending',
      charCount: body.length,
    });
    setTtsProvider(okProvider(body));

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('done');

    // Job settled done + linked to the set.
    const job = await pg.pool.query<{
      status: string;
      audio_source_id: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      error: string | null;
    }>(
      `SELECT status, audio_source_id::text AS audio_source_id, started_at, finished_at, error
         FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.status).toBe('done');
    expect(job.rows[0]!.audio_source_id).not.toBeNull();
    expect(job.rows[0]!.started_at).not.toBeNull();
    expect(job.rows[0]!.finished_at).not.toBeNull();
    expect(job.rows[0]!.error).toBeNull();

    // The set: kind 'generated_story', story-linked, owner-pinned, ready.
    const src = await pg.pool.query<{
      id: string;
      user_id: string;
      kind: string;
      generated_story_id: string;
      slug: string;
      status: string;
    }>(
      `SELECT id::text AS id, user_id::text AS user_id, kind,
              generated_story_id::text AS generated_story_id, slug, status
         FROM audio_sources`,
    );
    expect(src.rows).toHaveLength(1);
    expect(src.rows[0]!.kind).toBe('generated_story');
    expect(src.rows[0]!.generated_story_id).toBe(String(storyId));
    expect(src.rows[0]!.user_id).toBe(String(userId));
    expect(src.rows[0]!.slug).toBe(`generated-story-${storyId}`);
    expect(src.rows[0]!.status).toBe('ready');
    expect(job.rows[0]!.audio_source_id).toBe(src.rows[0]!.id);

    // The track: real blob on disk with the exact synthesized bytes;
    // duration = the last alignment's end (body.length chars × 100ms).
    const trk = await pg.pool.query<{
      blob_ref: string;
      byte_size: string;
      duration_ms: number;
      transcript_status: string;
      track_number: number;
    }>(
      `SELECT blob_ref, byte_size::text AS byte_size, duration_ms, transcript_status, track_number
         FROM audio_tracks`,
    );
    expect(trk.rows).toHaveLength(1);
    expect(trk.rows[0]!.track_number).toBe(1);
    expect(trk.rows[0]!.transcript_status).toBe('done');
    expect(Number(trk.rows[0]!.byte_size)).toBe(MP3_BYTES.length);
    expect(trk.rows[0]!.duration_ms).toBe(body.length * 100);
    const files = await userBlobFiles(userId);
    expect(files).toHaveLength(1);
    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(
      path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, trk.rows[0]!.blob_ref),
    );
    expect(Buffer.compare(onDisk, MP3_BYTES)).toBe(0);

    // Segments: one per sentence, ordered, alignment-derived windows.
    const segs = await pg.pool.query<{
      segment_number: number;
      start_ms: number;
      end_ms: number;
      body: string;
    }>(
      `SELECT segment_number, start_ms, end_ms, body
         FROM audio_transcript_segments ORDER BY segment_number`,
    );
    expect(segs.rows.map((s) => s.body)).toEqual(['고양이가 왔다.', '고양이가 갔다.']);
    expect(segs.rows[0]!.start_ms).toBe(0);
    expect(segs.rows[0]!.end_ms).toBe(800); // '고양이가 왔다.' = chars [0,8)
    expect(segs.rows[1]!.start_ms).toBe(900); // second sentence starts at char 9
    expect(segs.rows[1]!.end_ms).toBe(body.length * 100);
  });

  it('provider failure → job failed with the whitelisted message, NO rows, NO blob', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'pending' });
    setTtsProvider({
      synthesize: async () => {
        throw new TtsUpstreamError(503, 'the speech service rejected the request (HTTP 503)');
      },
    });

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('failed');

    const job = await pg.pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.status).toBe('failed');
    expect(job.rows[0]!.error).toContain('HTTP 503');

    const counts = await pg.pool.query<{ sources: string; tracks: string; segs: string }>(
      `SELECT (SELECT count(*) FROM audio_sources)::text AS sources,
              (SELECT count(*) FROM audio_tracks)::text  AS tracks,
              (SELECT count(*) FROM audio_transcript_segments)::text AS segs`,
    );
    expect(counts.rows[0]).toEqual({ sources: '0', tracks: '0', segs: '0' });
    expect(await userBlobFiles(userId)).toHaveLength(0);

    // A failed job frees the live slot: a new pending job for the same story
    // is insertable (the partial unique covers only pending/running).
    await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'pending' });
  });

  it('a non-TTS unexpected error settles the job with a GENERIC message (no internals)', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'pending' });
    setTtsProvider({
      synthesize: async () => {
        throw new Error('ECONNREFUSED 10.0.0.7:5432 super-secret-internal-detail');
      },
    });

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('failed');
    const job = await pg.pool.query<{ error: string | null }>(
      `SELECT error FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.error).toBe('audio generation failed unexpectedly — try again later');
  });

  it('persist failure (voice-once unique tripped) → rollback, job failed, fresh blob unlinked', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const body = '중복 방지 테스트다.';
    const storyId = await seedGeneratedStory(pg.pool, userId, { bodyKo: body });
    // The story is ALREADY voiced (one-set-per-story unique will reject a
    // second set) but a pending job somehow exists — the runner must fail the
    // job cleanly, leave exactly ONE set, and unlink the blob it wrote.
    await seedStoryAudio(pg.pool, userId, storyId);
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'pending' });
    setTtsProvider(okProvider(body));

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('failed');

    const job = await pg.pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.status).toBe('failed');
    expect(job.rows[0]!.error).toBe('audio generation failed unexpectedly — try again later');

    const sources = await pg.pool.query(`SELECT id FROM audio_sources`);
    expect(sources.rows).toHaveLength(1); // only the pre-existing set
    // The blob the runner wrote for the rolled-back persist was unlinked
    // (the seeded set's blob_ref never existed on disk).
    expect(await userBlobFiles(userId)).toHaveLength(0);
  });

  it('reaps a stale running job as failed; pending survives untouched', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const staleStory = await seedGeneratedStory(pg.pool, userId);
    const staleId = await seedStoryAudioJob(pg.pool, userId, staleStory, {
      status: 'running',
      startedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago ≫ 15min threshold
    });
    const freshStory = await seedGeneratedStory(pg.pool, userId);
    // A FRESH pending job — old created_at must NOT get it reaped ('pending'
    // is the healthy backlog); the tick claims and runs it normally.
    const body = '옛날 옛적에 이야기가 있었습니다.';
    const pendingId = await seedStoryAudioJob(pg.pool, userId, freshStory, {
      status: 'pending',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    setTtsProvider(okProvider(body));

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('done');

    const rows = await pg.pool.query<{ id: string; status: string; error: string | null }>(
      `SELECT id::text AS id, status, error FROM story_audio_jobs ORDER BY id`,
    );
    const stale = rows.rows.find((r) => r.id === String(staleId))!;
    expect(stale.status).toBe('failed');
    expect(stale.error).toContain('interrupted');
    const pending = rows.rows.find((r) => r.id === String(pendingId))!;
    expect(pending.status).toBe('done');
  });

  it('a YOUNG running job is neither reaped nor re-claimed', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'running',
      startedAt: new Date(),
    });
    setTtsProvider(okProvider('unused'));

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('idle');
    const job = await pg.pool.query<{ status: string }>(`SELECT status FROM story_audio_jobs`);
    expect(job.rows[0]!.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Multi-voice (F-210 v2)
// ---------------------------------------------------------------------------

describe('parseStoryTurns', () => {
  it('null/undefined → null (v1 flat story → narrator path)', () => {
    expect(parseStoryTurns(null)).toBeNull();
    expect(parseStoryTurns(undefined)).toBeNull();
  });

  it('a valid script parses; gender stays optional per turn', () => {
    const parsed = parseStoryTurns([
      { speaker: 'narrator', text: '민수가 말했다.', gender: 'narrator' },
      { speaker: '민수', text: '"안녕."' }, // pre-v2 row without gender
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed![1]!.gender).toBeUndefined();
  });

  it('malformed shapes → null, never a throw (hand-edited rows must not brick a job)', () => {
    expect(parseStoryTurns([])).toBeNull(); // min(1)
    expect(parseStoryTurns([{ speaker: '민수' }])).toBeNull(); // no text
    expect(parseStoryTurns([{ speaker: '민수', text: '   ' }])).toBeNull(); // blank text
    expect(parseStoryTurns('not-an-array')).toBeNull();
    expect(parseStoryTurns([{ speaker: '민수', text: 'x', gender: 'robot' }])).toBeNull();
  });
});

/** A provider that records every (text, voiceId) call. `failAtCall` (1-based)
 *  makes exactly that call throw a whitelisted upstream error. Audio bytes =
 *  the utf8 text, so each part's byte length is deterministic per turn. */
function recordingProvider(
  calls: Array<{ text: string; voiceId: string | undefined }>,
  failAtCall?: number,
): TtsProvider {
  let n = 0;
  return {
    synthesize: async (text, opts) => {
      n++;
      if (n === failAtCall) {
        throw new TtsUpstreamError(500, 'the speech service rejected the request (HTTP 500)');
      }
      calls.push({ text, voiceId: opts?.voiceId });
      // Multi-voice ignores charAlignments entirely (offsets come from the
      // probed durations) — return none to prove it.
      return { audio: Buffer.from(text, 'utf8'), mimeType: 'audio/mpeg', charAlignments: [] };
    },
  };
}

/** Deterministic concat/probe mock: duration = byteLength × 10 ms; concat =
 *  Buffer.concat. Records concat inputs; `failConcat` makes concat throw. */
function mockConcat(opts: { failConcat?: boolean } = {}): {
  helper: Mp3ConcatHelper;
  concatCalls: Buffer[][];
} {
  const concatCalls: Buffer[][] = [];
  const helper: Mp3ConcatHelper = {
    concatMp3: async (buffers) => {
      concatCalls.push([...buffers]);
      if (opts.failConcat === true) throw new Error('mock ffmpeg concat blew up');
      return Buffer.concat(buffers);
    },
    probeDurationMs: async (buffer) => buffer.length * 10,
  };
  return { helper, concatCalls };
}

const SCRIPT = [
  { speaker: 'narrator', text: '민수가 인사했다.', gender: 'narrator' },
  { speaker: '민수', text: '"안녕하세요."', gender: 'male' },
  { speaker: '지은', text: '"어서 와요."', gender: 'female' },
  { speaker: '민수', text: '"고마워요."', gender: 'male' },
] as const;

/** The mock 'duration' of one turn: utf8 byte length × 10 (mockConcat's rule). */
function turnDurMs(text: string): number {
  return Buffer.byteLength(text, 'utf8') * 10;
}

describe('runStoryAudioTick — multi-voice (v2)', () => {
  it('assigns palette voices per speaker, concats ONE blob, writes per-turn segments with CUMULATIVE offsets', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId, {
      title: '두 사람',
      turns: [...SCRIPT],
    });
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'pending',
      charCount: 999, // stale enqueue snapshot — the settle must correct it
    });
    const synthCalls: Array<{ text: string; voiceId: string | undefined }> = [];
    setTtsProvider(recordingProvider(synthCalls));
    const { helper, concatCalls } = mockConcat();
    setMp3Concat(helper);

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('done');

    // One synthesize per turn, in story order, with the palette's voices:
    // narrator → env voice; 민수 → 1st male; 지은 → 1st female; 민수 again →
    // the SAME male voice.
    const narratorVoice = loadConfig().ELEVENLABS_VOICE_ID;
    expect(synthCalls.map((c) => c.text)).toEqual(SCRIPT.map((t2) => t2.text));
    expect(synthCalls.map((c) => c.voiceId)).toEqual([
      narratorVoice,
      MALE_VOICE_POOL[0],
      FEMALE_VOICE_POOL[0],
      MALE_VOICE_POOL[0],
    ]);

    // Exactly one concat call, over the 4 per-turn buffers in order.
    expect(concatCalls).toHaveLength(1);
    expect(concatCalls[0]!.map((b) => b.toString('utf8'))).toEqual(SCRIPT.map((t2) => t2.text));

    // ONE blob on disk = the concatenated bytes.
    const expectedBlob = Buffer.concat(SCRIPT.map((t2) => Buffer.from(t2.text, 'utf8')));
    const files = await userBlobFiles(userId);
    expect(files).toHaveLength(1);
    const { readFile } = await import('node:fs/promises');
    const trk = await pg.pool.query<{ blob_ref: string; byte_size: string; duration_ms: number }>(
      `SELECT blob_ref, byte_size::text AS byte_size, duration_ms FROM audio_tracks`,
    );
    expect(trk.rows).toHaveLength(1);
    const onDisk = await readFile(
      path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, trk.rows[0]!.blob_ref),
    );
    expect(Buffer.compare(onDisk, expectedBlob)).toBe(0);
    expect(Number(trk.rows[0]!.byte_size)).toBe(expectedBlob.length);

    // Per-turn segments with the CUMULATIVE probed-duration timeline:
    // startMs(i) = Σ durations[0..i-1]; endMs(i) = startMs(i) + durations[i].
    const durs = SCRIPT.map((t2) => turnDurMs(t2.text));
    const segs = await pg.pool.query<{
      segment_number: number;
      start_ms: number;
      end_ms: number;
      body: string;
    }>(
      `SELECT segment_number, start_ms, end_ms, body
         FROM audio_transcript_segments ORDER BY segment_number`,
    );
    expect(segs.rows.map((s) => s.body)).toEqual(SCRIPT.map((t2) => t2.text));
    expect(segs.rows.map((s) => s.segment_number)).toEqual([1, 2, 3, 4]);
    expect(segs.rows[0]!.start_ms).toBe(0);
    expect(segs.rows[0]!.end_ms).toBe(durs[0]);
    expect(segs.rows[1]!.start_ms).toBe(durs[0]); // turn2 starts where turn1's audio ends
    expect(segs.rows[1]!.end_ms).toBe(durs[0]! + durs[1]!);
    expect(segs.rows[2]!.start_ms).toBe(durs[0]! + durs[1]!);
    expect(segs.rows[3]!.end_ms).toBe(durs[0]! + durs[1]! + durs[2]! + durs[3]!);
    // Track duration = the full cumulative timeline.
    expect(trk.rows[0]!.duration_ms).toBe(durs.reduce((a, b) => a + b, 0));

    // char_count settled to the EXACT multi-voice spend (sum of turn chars).
    const job = await pg.pool.query<{ status: string; char_count: number }>(
      `SELECT status, char_count FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.status).toBe('done');
    expect(job.rows[0]!.char_count).toBe(SCRIPT.reduce((a, t2) => a + t2.text.length, 0));
  });

  it('a SINGLE-turn script runs the full multi-voice pipeline: one part, one segment [0, dur)', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const turn = { speaker: '민수', text: '"혼자 왔어요."', gender: 'male' } as const;
    const storyId = await seedGeneratedStory(pg.pool, userId, {
      title: '독백',
      turns: [turn],
    });
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'pending',
      charCount: 999, // stale enqueue snapshot — the settle must correct it
    });
    const synthCalls: Array<{ text: string; voiceId: string | undefined }> = [];
    setTtsProvider(recordingProvider(synthCalls));
    const { helper, concatCalls } = mockConcat();
    setMp3Concat(helper);

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('done');

    // ONE synthesis, with the first male palette voice (no narrator turn).
    expect(synthCalls).toEqual([{ text: turn.text, voiceId: MALE_VOICE_POOL[0] }]);
    // The concat ran over exactly the one part (the real ffmpeg impl
    // short-circuits a single buffer — the contract is the same bytes out).
    expect(concatCalls).toHaveLength(1);
    expect(concatCalls[0]!.map((b) => b.toString('utf8'))).toEqual([turn.text]);

    // ONE blob on disk = that part's bytes.
    const expectedBlob = Buffer.from(turn.text, 'utf8');
    const files = await userBlobFiles(userId);
    expect(files).toHaveLength(1);
    const { readFile } = await import('node:fs/promises');
    const trk = await pg.pool.query<{ blob_ref: string; duration_ms: number }>(
      `SELECT blob_ref, duration_ms FROM audio_tracks`,
    );
    expect(trk.rows).toHaveLength(1);
    const onDisk = await readFile(
      path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, trk.rows[0]!.blob_ref),
    );
    expect(Buffer.compare(onDisk, expectedBlob)).toBe(0);

    // Exactly one segment spanning [0, probed duration); track duration = it.
    const dur = turnDurMs(turn.text);
    const segs = await pg.pool.query<{
      segment_number: number;
      start_ms: number;
      end_ms: number;
      body: string;
    }>(
      `SELECT segment_number, start_ms, end_ms, body FROM audio_transcript_segments`,
    );
    expect(segs.rows).toEqual([
      { segment_number: 1, start_ms: 0, end_ms: dur, body: turn.text },
    ]);
    expect(trk.rows[0]!.duration_ms).toBe(dur);

    // Job done, char_count settled to the exact single-turn spend.
    const job = await pg.pool.query<{ status: string; char_count: number }>(
      `SELECT status, char_count FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.status).toBe('done');
    expect(job.rows[0]!.char_count).toBe(turn.text.length);
  });

  it('a synthesis failure MID-SCRIPT → job failed, NO rows, NO blob', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId, { turns: [...SCRIPT] });
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'pending' });
    const synthCalls: Array<{ text: string; voiceId: string | undefined }> = [];
    setTtsProvider(recordingProvider(synthCalls, 3)); // 3rd turn throws
    const { helper, concatCalls } = mockConcat();
    setMp3Concat(helper);

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('failed');

    expect(synthCalls).toHaveLength(2); // stopped at the failure
    expect(concatCalls).toHaveLength(0); // never reached the concat
    const job = await pg.pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.status).toBe('failed');
    expect(job.rows[0]!.error).toContain('HTTP 500'); // the whitelisted message
    const counts = await pg.pool.query<{ sources: string; tracks: string; segs: string }>(
      `SELECT (SELECT count(*) FROM audio_sources)::text AS sources,
              (SELECT count(*) FROM audio_tracks)::text  AS tracks,
              (SELECT count(*) FROM audio_transcript_segments)::text AS segs`,
    );
    expect(counts.rows[0]).toEqual({ sources: '0', tracks: '0', segs: '0' });
    expect(await userBlobFiles(userId)).toHaveLength(0);
  });

  it('a concat failure → job failed with the GENERIC message, NO rows, NO blob', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId, { turns: [...SCRIPT] });
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'pending' });
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat({ failConcat: true }).helper);

    await expect(runStoryAudioTick(getLogger())).resolves.toBe('failed');

    const job = await pg.pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM story_audio_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.status).toBe('failed');
    // Not a TTS-layer error → the generic line, never the internal detail.
    expect(job.rows[0]!.error).toBe('audio generation failed unexpectedly — try again later');
    expect(job.rows[0]!.error).not.toContain('ffmpeg');
    const counts = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audio_sources`,
    );
    expect(counts.rows[0]!.n).toBe('0');
    expect(await userBlobFiles(userId)).toHaveLength(0);
  });

  it('MALFORMED turns fall back to the v1 single-narrator path (default voice, sentence segments)', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const body = '고양이가 왔다. 고양이가 갔다.';
    const storyId = await seedGeneratedStory(pg.pool, userId, {
      bodyKo: body,
      turns: [{ speaker: '민수' }], // array (passes 081's CHECK) but schema-invalid
    });
    await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'pending',
      charCount: body.length,
    });
    const synthCalls: Array<{ text: string; voiceId: string | undefined }> = [];
    setTtsProvider({
      synthesize: async (text, opts) => {
        synthCalls.push({ text, voiceId: opts?.voiceId });
        return { audio: MP3_BYTES, mimeType: 'audio/mpeg', charAlignments: alignmentsFor(text) };
      },
    });
    const { helper, concatCalls } = mockConcat();
    setMp3Concat(helper);
    const logger = getLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    try {
      await expect(runStoryAudioTick(logger)).resolves.toBe('done');

      // The degrade is silent to the USER but never to the logs: a stored-but-
      // unparseable turns array must be distinguishable from a flat story.
      expect(
        warnSpy.mock.calls.some((c) => String(c[1]).includes('turns present but unparseable')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    // ONE whole-body synthesis with NO voice override; no concat involved.
    expect(synthCalls).toEqual([{ text: body, voiceId: undefined }]);
    expect(concatCalls).toHaveLength(0);
    // v1 sentence segmentation, alignment-derived windows — unchanged.
    const segs = await pg.pool.query<{ body: string }>(
      `SELECT body FROM audio_transcript_segments ORDER BY segment_number`,
    );
    expect(segs.rows.map((s) => s.body)).toEqual(['고양이가 왔다.', '고양이가 갔다.']);
    // Single-narrator settle keeps the enqueue char_count snapshot.
    const job = await pg.pool.query<{ char_count: number }>(
      `SELECT char_count FROM story_audio_jobs`,
    );
    expect(job.rows[0]!.char_count).toBe(body.length);
  });
});
