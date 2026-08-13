/**
 * Per-route tests for the F-210 story-audio endpoints (src/routes/reading.ts):
 *
 *   POST /reading/generated/:id/audio  — idempotent, voice-once, daily-capped
 *                                        TTS enqueue
 *   GET  /reading/generated/:id/audio  — status envelope (+ streamUrl and
 *                                        read-along segments when done)
 *   GET  /reading/generated/audio      — the voiced-story list (the Listen
 *                                        tab's "Generated Audio" section):
 *                                        voiced-only filter, full item shape,
 *                                        newest first, IDOR, and the
 *                                        literal-before-:id registration order
 *
 * Pure ROUTE tests: no filesystem and no real TTS network call — the "voiced"
 * state is seeded at rest (seedStoryAudio), the runner pipeline itself is
 * covered by tests/services/storyAudio.test.ts. A never-called mock provider
 * is installed per test so the routes see a CONFIGURED deploy
 * (isTtsConfigured() → true — the enqueue gate and the envelope's
 * `ttsConfigured` flag both derive from the active provider); the
 * unconfigured/dormant 503 posture has its own describe block which resets
 * to the keyless default provider.
 *
 * Focus:
 *   - auth (401) + malformed id (400)
 *   - IDOR: a foreign story id and a missing id are the same uniform 404 on
 *     both endpoints
 *   - enqueue: 202 pending envelope + a real job row (char_count snapshot)
 *   - idempotency: a second POST returns the SAME live job, no dup row; a
 *     voiced story returns 200 done with NO new job (voice-once)
 *   - a failed job does not block a retry (new job) but keeps counting
 *   - daily cap: cap-many rows today → 429 rate_limited BEFORE any write;
 *     yesterday's spend does not count (day boundary); other users unaffected
 *   - GET states: none / pending / failed (server-authored error surfaced) /
 *     done (streamUrl + ordered camelCase segments + durationMs); a 'done'
 *     job whose voiced set was deleted out-of-band reads 'none'
 *   - dormant deploy (no TTS provider): POST → 503 tts_unavailable with NO
 *     job row (no cap slot burned); voice-once 200 still serves; GET reports
 *     ttsConfigured: false
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedGeneratedStory,
  seedStoryAudio,
  seedStoryAudioJob,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { loadConfig } from '../../src/config/index.js';
import {
  resetTtsProviderForTesting,
  setTtsProvider,
  UnconfiguredTtsProvider,
} from '../../src/services/tts.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  resetTtsProviderForTesting();
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE story_audio_jobs, audio_transcript_segments, audio_tracks, audio_sources, generated_stories, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
  // A CONFIGURED (but never-invoked) provider: routes only probe capability —
  // synthesis belongs to the runner, so any call here is a test bug.
  setTtsProvider({
    synthesize: () =>
      Promise.reject(new Error('route tests must never call synthesize')),
  });
});

/** Flip this suite's app to the DORMANT deploy posture (exactly what a
 *  keyless production deploy gets): install the real UnconfiguredTtsProvider
 *  — isTtsConfigured() derives from the provider class, so this is the same
 *  state a missing ELEVENLABS_API_KEY produces, but hermetic against any
 *  ambient env key. beforeEach restores the configured mock. */
function makeTtsUnconfigured(): void {
  setTtsProvider(new UnconfiguredTtsProvider());
}

describe('story audio — auth required', () => {
  it('POST /reading/generated/:id/audio unauthenticated → 401', async () => {
    const res = await request(t.app).post('/reading/generated/1/audio');
    expect(res.status).toBe(401);
  });

  it('GET /reading/generated/:id/audio unauthenticated → 401', async () => {
    const res = await request(t.app).get('/reading/generated/1/audio');
    expect(res.status).toBe(401);
  });
});

describe('story audio — id validation + IDOR', () => {
  it.each(['abc', '0', '-1', '1.5'])('malformed id %s → 400', async (bad) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const post = await agent.post(`/reading/generated/${bad}/audio`);
    expect(post.status).toBe(400);
    const get = await agent.get(`/reading/generated/${bad}/audio`);
    expect(get.status).toBe(400);
  });

  it("another user's story and a missing story are the same uniform 404 (POST + GET)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, owner.userId);

    const foreignPost = await other.agent.post(`/reading/generated/${storyId}/audio`);
    const missingPost = await other.agent.post('/reading/generated/999999/audio');
    expect(foreignPost.status).toBe(404);
    expect(missingPost.status).toBe(404);
    expect(foreignPost.body.error).toEqual(missingPost.body.error);

    const foreignGet = await other.agent.get(`/reading/generated/${storyId}/audio`);
    const missingGet = await other.agent.get('/reading/generated/999999/audio');
    expect(foreignGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    expect(foreignGet.body.error).toEqual(missingGet.body.error);

    // The probe wrote nothing.
    const jobs = await pg.pool.query(`SELECT id FROM story_audio_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });
});

describe('POST /reading/generated/:id/audio — enqueue', () => {
  it('202 with a pending envelope + a job row snapshotting char_count', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const bodyKo = '옛날 옛적에 고양이가 살았습니다. 고양이는 카페를 열었습니다.';
    const storyId = await seedGeneratedStory(pg.pool, userId, { bodyKo });

    const res = await agent.post(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(202);
    expect(res.body.audio.status).toBe('pending');
    expect(typeof res.body.audio.jobId).toBe('number');
    expect(res.body.audio.error).toBeNull();
    expect(res.body.audio.track).toBeNull();
    expect(res.body.audio.segments).toEqual([]);

    const job = await pg.pool.query<{
      generated_story_id: string;
      user_id: string;
      status: string;
      char_count: number;
    }>(
      `SELECT generated_story_id::text AS generated_story_id, user_id::text AS user_id,
              status, char_count
         FROM story_audio_jobs`,
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]!.generated_story_id).toBe(String(storyId));
    expect(job.rows[0]!.user_id).toBe(String(userId));
    expect(job.rows[0]!.status).toBe('pending');
    expect(job.rows[0]!.char_count).toBe(bodyKo.length);
  });

  it('IDEMPOTENT: a second POST returns the same live job — no duplicate row', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const first = await agent.post(`/reading/generated/${storyId}/audio`);
    const second = await agent.post(`/reading/generated/${storyId}/audio`);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.audio.status).toBe('pending');
    expect(second.body.audio.jobId).toBe(first.body.audio.jobId);

    const jobs = await pg.pool.query(`SELECT id FROM story_audio_jobs`);
    expect(jobs.rows).toHaveLength(1);
  });

  it('a RUNNING job also short-circuits (202, same job, no dup)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'running',
      startedAt: new Date(),
    });

    const res = await agent.post(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(202);
    expect(res.body.audio.status).toBe('running');
    expect(res.body.audio.jobId).toBe(jobId);
    const jobs = await pg.pool.query(`SELECT id FROM story_audio_jobs`);
    expect(jobs.rows).toHaveLength(1);
  });

  it('VOICE-ONCE: an already-voiced story → 200 done envelope, NO new job', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const { trackId } = await seedStoryAudio(pg.pool, userId, storyId, {
      durationMs: 4000,
      segmentCount: 2,
    });

    const res = await agent.post(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.audio.status).toBe('done');
    expect(res.body.audio.track).toEqual({
      id: trackId,
      streamUrl: `/audio/tracks/${trackId}/stream`,
      durationMs: 4000,
    });
    expect(res.body.audio.segments).toHaveLength(2);

    const jobs = await pg.pool.query(`SELECT id FROM story_audio_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('a FAILED job does not block a retry: a fresh job is enqueued', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const failedId = await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'failed',
      error: 'the speech service rejected the request (HTTP 503)',
    });

    const res = await agent.post(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(202);
    expect(res.body.audio.status).toBe('pending');
    expect(res.body.audio.jobId).not.toBe(failedId);

    const jobs = await pg.pool.query(`SELECT id FROM story_audio_jobs ORDER BY id`);
    expect(jobs.rows).toHaveLength(2); // the failed ledger row survives
  });
});

describe('POST /reading/generated/:id/audio — daily cap', () => {
  it('cap-many enqueues today → 429 rate_limited BEFORE any write', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_TTS_DAILY_CAP;
    // Spend the whole budget on ONE story via settled (failed) jobs — failures
    // count (cost stance), and settled rows never trip the live partial unique.
    const spentStory = await seedGeneratedStory(pg.pool, userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryAudioJob(pg.pool, userId, spentStory, { status: 'failed' });
    }
    const freshStory = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${freshStory}/audio`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.body.error.message).toContain('tomorrow');

    const jobs = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM story_audio_jobs`,
    );
    expect(jobs.rows[0]!.n).toBe(String(cap)); // nothing new was written
  });

  it("YESTERDAY's spend does not count (day boundary) and an already-voiced story still 200s over the cap", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_TTS_DAILY_CAP;
    const spentStory = await seedGeneratedStory(pg.pool, userId);
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    for (let i = 0; i < cap; i++) {
      await seedStoryAudioJob(pg.pool, userId, spentStory, {
        status: 'failed',
        createdAt: yesterday,
      });
    }
    const freshStory = await seedGeneratedStory(pg.pool, userId);
    const res = await agent.post(`/reading/generated/${freshStory}/audio`);
    expect(res.status).toBe(202); // yesterday's rows are outside today's window

    // And the voice-once short-circuit is checked BEFORE the cap: a voiced
    // story keeps returning 200 even when today's budget is gone.
    await pg.pool.query(`DELETE FROM story_audio_jobs`);
    const today = await seedGeneratedStory(pg.pool, userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryAudioJob(pg.pool, userId, today, { status: 'failed' });
    }
    const voicedStory = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudio(pg.pool, userId, voicedStory);
    const voicedRes = await agent.post(`/reading/generated/${voicedStory}/audio`);
    expect(voicedRes.status).toBe(200);
    expect(voicedRes.body.audio.status).toBe('done');
  });

  it("the cap is PER USER — one user's spend never 429s another", async () => {
    const spender = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_TTS_DAILY_CAP;
    const spentStory = await seedGeneratedStory(pg.pool, spender.userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryAudioJob(pg.pool, spender.userId, spentStory, { status: 'failed' });
    }
    const otherStory = await seedGeneratedStory(pg.pool, other.userId);
    const res = await other.agent.post(`/reading/generated/${otherStory}/audio`);
    expect(res.status).toBe(202);
  });
});

describe('GET /reading/generated/:id/audio — status envelope', () => {
  it("a never-requested story → status 'none'", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const res = await agent.get(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.audio).toEqual({
      status: 'none',
      jobId: null,
      error: null,
      track: null,
      segments: [],
      // The suite's default provider is a configured mock — the envelope
      // advertises the capability so the client offers the button.
      ttsConfigured: true,
    });
  });

  it('pending after a POST (the polling loop the client runs)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const post = await agent.post(`/reading/generated/${storyId}/audio`);
    const res = await agent.get(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.audio.status).toBe('pending');
    expect(res.body.audio.jobId).toBe(post.body.audio.jobId);
  });

  it("a failed job → status 'failed' with the server-authored error surfaced", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const jobId = await seedStoryAudioJob(pg.pool, userId, storyId, {
      status: 'failed',
      error: 'the speech service rejected the request (HTTP 503)',
    });
    const res = await agent.get(`/reading/generated/${storyId}/audio`);
    expect(res.body.audio.status).toBe('failed');
    expect(res.body.audio.jobId).toBe(jobId);
    expect(res.body.audio.error).toBe('the speech service rejected the request (HTTP 503)');
    expect(res.body.audio.track).toBeNull();
  });

  it('done → streamUrl (the existing /audio/tracks route) + ordered camelCase segments', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const { trackId } = await seedStoryAudio(pg.pool, userId, storyId, {
      durationMs: 6000,
      segmentCount: 3,
    });
    const res = await agent.get(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.audio.status).toBe('done');
    expect(res.body.audio.track.id).toBe(trackId);
    expect(res.body.audio.track.streamUrl).toBe(`/audio/tracks/${trackId}/stream`);
    expect(res.body.audio.track.durationMs).toBe(6000);
    const segments = res.body.audio.segments as Array<{
      segmentNumber: number;
      startMs: number;
      endMs: number;
      body: string;
    }>;
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.segmentNumber)).toEqual([1, 2, 3]);
    for (const s of segments) {
      expect(typeof s.startMs).toBe('number');
      expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);
      expect(typeof s.body).toBe('string');
    }
  });

  it('the DONE track is readable through GET /audio/tracks/:id (the segment/stream detail route)', async () => {
    // Cross-surface sanity: the streamUrl's sibling detail route serves the
    // SAME track for the same session user — proving story audio rides the
    // existing hardened audio read path with no special-casing.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const { trackId } = await seedStoryAudio(pg.pool, userId, storyId, { segmentCount: 2 });
    const res = await agent.get(`/audio/tracks/${trackId}`);
    expect(res.status).toBe(200);
    expect(res.body.track.id).toBe(trackId);
    expect(res.body.segments).toHaveLength(2);
  });

  it("a 'done' job whose voiced set was deleted out-of-band reads 'none' — the client can simply re-generate", async () => {
    // buildStoryAudioDto's last branch: the job LEDGER says done, but the
    // audio_sources set (the voice-once authority) is gone — e.g. an
    // out-of-band cleanup or a partial restore. 'none' (not a broken 'done')
    // is the honest answer: no track exists to stream.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'done' });

    const res = await agent.get(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.audio.status).toBe('none');
    expect(res.body.audio.jobId).toBeNull();
    expect(res.body.audio.track).toBeNull();
    expect(res.body.audio.segments).toEqual([]);
  });
});

describe('GET /reading/generated/audio — the voiced-story list (Listen "Generated Audio")', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/reading/generated/audio');
    expect(res.status).toBe(401);
  });

  it('no voiced stories → 200 with an empty list (and the literal path is NOT captured by /generated/:id)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedGeneratedStory(pg.pool, userId); // unvoiced — must not list
    const res = await agent.get('/reading/generated/audio');
    // A 400 here would mean /generated/:id captured "audio" as its id —
    // the registration-order regression this test pins against.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stories: [] });
  });

  it('lists ONLY voiced stories — full shape, most recently voiced first; pending/failed/unvoiced excluded', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const oldVoiced = await seedGeneratedStory(pg.pool, userId, {
      title: '바닷가 이야기',
      level: 'L2',
    });
    const oldTrack = await seedStoryAudio(pg.pool, userId, oldVoiced, {
      durationMs: 5000,
    });

    const pendingStory = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, pendingStory, { status: 'pending' });
    const failedStory = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, failedStory, { status: 'failed' });
    await seedGeneratedStory(pg.pool, userId); // never requested

    const newVoiced = await seedGeneratedStory(pg.pool, userId, {
      title: '겨울 산책',
      level: 'L4',
    });
    const newTrack = await seedStoryAudio(pg.pool, userId, newVoiced, {
      durationMs: 12000,
    });

    const res = await agent.get('/reading/generated/audio');
    expect(res.status).toBe(200);
    expect(res.body.stories).toEqual([
      {
        id: newVoiced,
        title: '겨울 산책',
        level: 'L4',
        streamUrl: `/audio/tracks/${newTrack.trackId}/stream`,
        durationMs: 12000,
      },
      {
        id: oldVoiced,
        title: '바닷가 이야기',
        level: 'L2',
        streamUrl: `/audio/tracks/${oldTrack.trackId}/stream`,
        durationMs: 5000,
      },
    ]);
  });

  it('orders by VOICED recency, not story age — an old story voiced just now lists FIRST', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Two stories with pinned, unambiguous ages: oldStory predates newStory.
    const oldStory = await seedGeneratedStory(pg.pool, userId, {
      title: '오래된 이야기',
    });
    const newStory = await seedGeneratedStory(pg.pool, userId, {
      title: '새 이야기',
    });
    await pg.pool.query(
      `UPDATE generated_stories SET created_at = now() - interval '2 days'
        WHERE id = $1`,
      [oldStory],
    );

    // The NEW story was voiced yesterday; the OLD story was voiced just now.
    const newSet = await seedStoryAudio(pg.pool, userId, newStory);
    await seedStoryAudio(pg.pool, userId, oldStory);
    await pg.pool.query(
      `UPDATE audio_sources SET created_at = now() - interval '1 day'
        WHERE id = $1`,
      [newSet.sourceId],
    );

    // The freshly-voiced OLD story must list first — the list orders by the
    // voiced set's created_at, not the story's (which would invert this).
    const res = await agent.get('/reading/generated/audio');
    expect(res.status).toBe(200);
    expect(res.body.stories.map((s: { id: number }) => s.id)).toEqual([
      oldStory,
      newStory,
    ]);
  });

  it("IDOR: user B never sees user A's voiced stories", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, owner.userId);
    await seedStoryAudio(pg.pool, owner.userId, storyId);

    const foreign = await other.agent.get('/reading/generated/audio');
    expect(foreign.status).toBe(200);
    expect(foreign.body.stories).toEqual([]);

    // …while the owner's own list serves it.
    const own = await owner.agent.get('/reading/generated/audio');
    expect(own.body.stories).toHaveLength(1);
    expect(own.body.stories[0].id).toBe(storyId);
  });

  it("a 'done' JOB whose voiced set was deleted out-of-band does not list (the set is the authority)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'done' });
    const res = await agent.get('/reading/generated/audio');
    expect(res.status).toBe(200);
    // Same honest answer the per-story GET gives ('none'): no track exists
    // to stream, so no row — a broken player must never render.
    expect(res.body.stories).toEqual([]);
  });
});

describe('story audio — dormant deploy (TTS not configured)', () => {
  it('POST → 503 tts_unavailable BEFORE any write: no job row, no daily-cap slot burned', async () => {
    makeTtsUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('tts_unavailable');

    // Nothing was written — the guaranteed-to-fail job never spent a slot.
    const jobs = await pg.pool.query(`SELECT id FROM story_audio_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('voice-once still serves: an ALREADY-VOICED story answers 200 done (streaming needs no key)', async () => {
    makeTtsUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const { trackId } = await seedStoryAudio(pg.pool, userId, storyId, {
      segmentCount: 1,
    });

    const res = await agent.post(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.audio.status).toBe('done');
    expect(res.body.audio.track.id).toBe(trackId);
    // …but the envelope is honest about the capability being off.
    expect(res.body.audio.ttsConfigured).toBe(false);
  });

  it('GET reports ttsConfigured: false so the client hides the feature', async () => {
    makeTtsUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.get(`/reading/generated/${storyId}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.audio.status).toBe('none');
    expect(res.body.audio.ttsConfigured).toBe(false);
  });
});
