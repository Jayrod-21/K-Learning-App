/**
 * Per-route tests for the F-216 unified story experience
 * (src/routes/reading.ts):
 *
 *   POST /reading/generated/:id/experience — the one-tap combined enqueue:
 *                                            BOTH the F-210 narration gate
 *                                            and the F-211 illustration
 *                                            gate, each half independent
 *   GET  /reading/generated               — the library's per-row asset
 *                                            aggregates (audioStatus /
 *                                            imageStatus) + the envelope's
 *                                            ttsConfigured/imageGenConfigured
 *
 * Pure ROUTE tests: no filesystem and no real TTS/image network call — the
 * at-rest states are seeded directly (seedStoryAudio / seedStoryImages /
 * the job seeders), the runner pipelines are covered by their service
 * suites. Never-called mock providers are installed per test so the routes
 * see a CONFIGURED deploy for both halves; the dormant postures install the
 * real Unconfigured providers (reading.audio.test.ts's exact structure).
 *
 * Focus:
 *   - auth (401) + malformed id (400)
 *   - IDOR: a foreign story id and a missing id are the same uniform 404,
 *     and the probe reaches NEITHER enqueue gate (no rows written)
 *   - both halves configured: one POST enqueues BOTH jobs → 202, both
 *     envelopes 'pending' with enqueueBlocked null; idempotent on repeat
 *   - per-half independence: a dormant half reports enqueueBlocked
 *     'dormant' (capability flag false, NO job row) while the other half
 *     still enqueues; a capped half reports 'daily_cap' likewise — the
 *     route NEVER wholesale-503s (both-dormant is a settled 200)
 *   - already-done halves short-circuit (voice-/generate-once): blocked
 *     null, status 'done', no new job; 200 once both halves are settled
 *   - list aggregates: each asset resolves none/pending/running/failed/done
 *     with the per-story builders' exact precedence (the done authority
 *     beats a NEWER failed job; a 'done' job whose artifacts are gone reads
 *     'none'); mixed per-row states; existing row fields preserved; the
 *     envelope's capability flags track the providers
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
  seedStoryImageJob,
  seedStoryImages,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { loadConfig } from '../../src/config/index.js';
import {
  resetTtsProviderForTesting,
  setTtsProvider,
  UnconfiguredTtsProvider,
} from '../../src/services/tts.js';
import {
  resetImageGenProviderForTesting,
  setImageGenProvider,
  UnconfiguredImageGenProvider,
} from '../../src/services/imageGen.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  resetTtsProviderForTesting();
  resetImageGenProviderForTesting();
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE story_image_jobs, story_images, story_audio_jobs, audio_transcript_segments, audio_tracks, audio_sources, generated_stories, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
  // CONFIGURED (but never-invoked) providers for BOTH halves: routes only
  // probe capability — synthesis/generation belongs to the runners, so any
  // call here is a test bug.
  setTtsProvider({
    synthesize: () => Promise.reject(new Error('route tests must never call synthesize')),
  });
  setImageGenProvider({
    generate: () => Promise.reject(new Error('route tests must never call generate')),
  });
});

/** Flip one half (or both) to the DORMANT deploy posture — the real
 *  Unconfigured providers, hermetic against ambient env keys (the
 *  reading.audio/images suites' exact helpers). beforeEach restores the
 *  configured mocks. */
function makeTtsUnconfigured(): void {
  setTtsProvider(new UnconfiguredTtsProvider());
}
function makeImageGenUnconfigured(): void {
  setImageGenProvider(new UnconfiguredImageGenProvider());
}

async function countJobs(table: 'story_audio_jobs' | 'story_image_jobs'): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

describe('story experience — auth required', () => {
  it('POST /reading/generated/:id/experience unauthenticated → 401', async () => {
    const res = await request(t.app).post('/reading/generated/1/experience');
    expect(res.status).toBe(401);
  });
});

describe('story experience — id validation + IDOR', () => {
  it.each(['abc', '0', '-1', '1.5'])('malformed id %s → 400', async (bad) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post(`/reading/generated/${bad}/experience`);
    expect(res.status).toBe(400);
  });

  it("another user's story and a missing story are the same uniform 404 — and NEITHER gate runs", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, owner.userId);

    const foreign = await other.agent.post(`/reading/generated/${storyId}/experience`);
    const missing = await other.agent.post('/reading/generated/999999/experience');
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);

    // The probe wrote nothing on EITHER half.
    expect(await countJobs('story_audio_jobs')).toBe(0);
    expect(await countJobs('story_image_jobs')).toBe(0);
  });
});

describe('POST /reading/generated/:id/experience — both halves configured', () => {
  it('one tap enqueues BOTH jobs → 202, both pending, enqueueBlocked null/null', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const bodyKo = '옛날 옛적에 고양이가 살았습니다. 고양이는 카페를 열었습니다.';
    const storyId = await seedGeneratedStory(pg.pool, userId, { bodyKo });

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(202);

    // Audio half: the untouched StoryAudioDto shape + the wrapper-only flag.
    expect(res.body.experience.audio.status).toBe('pending');
    expect(typeof res.body.experience.audio.jobId).toBe('number');
    expect(res.body.experience.audio.error).toBeNull();
    expect(res.body.experience.audio.track).toBeNull();
    expect(res.body.experience.audio.segments).toEqual([]);
    expect(res.body.experience.audio.ttsConfigured).toBe(true);
    expect(res.body.experience.audio.enqueueBlocked).toBeNull();

    // Images half: the untouched StoryImagesDto shape + the wrapper-only flag.
    expect(res.body.experience.images.status).toBe('pending');
    expect(typeof res.body.experience.images.jobId).toBe('number');
    expect(res.body.experience.images.error).toBeNull();
    expect(res.body.experience.images.images).toEqual([]);
    expect(res.body.experience.images.imageGenConfigured).toBe(true);
    expect(res.body.experience.images.enqueueBlocked).toBeNull();

    // One REAL job row per half, with the same snapshots the dedicated
    // POSTs write (char_count = JS string length; image_count = scene count).
    const audioJobs = await pg.pool.query<{ status: string; char_count: number }>(
      `SELECT status, char_count FROM story_audio_jobs`,
    );
    expect(audioJobs.rows).toEqual([{ status: 'pending', char_count: bodyKo.length }]);
    const imageJobs = await pg.pool.query<{ status: string; image_count: number }>(
      `SELECT status, image_count FROM story_image_jobs`,
    );
    expect(imageJobs.rows).toEqual([
      { status: 'pending', image_count: loadConfig().STORY_IMAGE_SCENE_COUNT },
    ]);
  });

  it('IDEMPOTENT: a second POST returns the same live jobs — no duplicate rows', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const first = await agent.post(`/reading/generated/${storyId}/experience`);
    const second = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.experience.audio.jobId).toBe(first.body.experience.audio.jobId);
    expect(second.body.experience.images.jobId).toBe(first.body.experience.images.jobId);
    expect(second.body.experience.audio.enqueueBlocked).toBeNull();
    expect(second.body.experience.images.enqueueBlocked).toBeNull();

    expect(await countJobs('story_audio_jobs')).toBe(1);
    expect(await countJobs('story_image_jobs')).toBe(1);
  });

  it('both halves already done → 200, both envelopes done, blocked null/null, NO new jobs', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const { trackId } = await seedStoryAudio(pg.pool, userId, storyId, {
      durationMs: 4000,
      segmentCount: 2,
    });
    await seedStoryImages(pg.pool, userId, storyId, { count: 3 });

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(200);
    expect(res.body.experience.audio.status).toBe('done');
    expect(res.body.experience.audio.track.streamUrl).toBe(`/audio/tracks/${trackId}/stream`);
    expect(res.body.experience.audio.enqueueBlocked).toBeNull();
    expect(res.body.experience.images.status).toBe('done');
    expect(res.body.experience.images.images).toHaveLength(3);
    expect(res.body.experience.images.enqueueBlocked).toBeNull();

    expect(await countJobs('story_audio_jobs')).toBe(0);
    expect(await countJobs('story_image_jobs')).toBe(0);
  });

  it('one half already done + the other fresh → the fresh half enqueues (202)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudio(pg.pool, userId, storyId);

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(202); // the images half is now pending
    expect(res.body.experience.audio.status).toBe('done');
    expect(res.body.experience.audio.enqueueBlocked).toBeNull();
    expect(res.body.experience.images.status).toBe('pending');
    expect(res.body.experience.images.enqueueBlocked).toBeNull();

    expect(await countJobs('story_audio_jobs')).toBe(0); // voice-once held
    expect(await countJobs('story_image_jobs')).toBe(1);
  });
});

describe('POST /reading/generated/:id/experience — per-half dormancy (never a wholesale 503)', () => {
  it("TTS dormant: audio half reports enqueueBlocked 'dormant' (no job row) while images STILL enqueue", async () => {
    makeTtsUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(202); // the images half is working
    expect(res.body.experience.audio.status).toBe('none');
    expect(res.body.experience.audio.ttsConfigured).toBe(false);
    expect(res.body.experience.audio.enqueueBlocked).toBe('dormant');
    expect(res.body.experience.images.status).toBe('pending');
    expect(res.body.experience.images.enqueueBlocked).toBeNull();

    // The dormant half wrote NOTHING (no cap slot burned).
    expect(await countJobs('story_audio_jobs')).toBe(0);
    expect(await countJobs('story_image_jobs')).toBe(1);
  });

  it("image gen dormant: images half reports 'dormant' while audio STILL enqueues (the mirror)", async () => {
    makeImageGenUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(202); // the audio half is working
    expect(res.body.experience.audio.status).toBe('pending');
    expect(res.body.experience.audio.enqueueBlocked).toBeNull();
    expect(res.body.experience.images.status).toBe('none');
    expect(res.body.experience.images.imageGenConfigured).toBe(false);
    expect(res.body.experience.images.enqueueBlocked).toBe('dormant');

    expect(await countJobs('story_audio_jobs')).toBe(1);
    expect(await countJobs('story_image_jobs')).toBe(0);
  });

  it("BOTH dormant → a settled 200 (not 503): both halves report 'dormant', nothing written", async () => {
    makeTtsUnconfigured();
    makeImageGenUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(200);
    expect(res.body.experience.audio.enqueueBlocked).toBe('dormant');
    expect(res.body.experience.images.enqueueBlocked).toBe('dormant');

    expect(await countJobs('story_audio_jobs')).toBe(0);
    expect(await countJobs('story_image_jobs')).toBe(0);
  });
});

describe('POST /reading/generated/:id/experience — per-half daily cap', () => {
  it("audio budget spent → audio half 'daily_cap' (no new row) while images STILL enqueue", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_TTS_DAILY_CAP;
    const spentStory = await seedGeneratedStory(pg.pool, userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryAudioJob(pg.pool, userId, spentStory, { status: 'failed' });
    }
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(202); // the images half is working
    expect(res.body.experience.audio.enqueueBlocked).toBe('daily_cap');
    expect(res.body.experience.images.enqueueBlocked).toBeNull();
    expect(res.body.experience.images.status).toBe('pending');

    expect(await countJobs('story_audio_jobs')).toBe(cap); // nothing new
    expect(await countJobs('story_image_jobs')).toBe(1);
  });

  it("image budget spent → images half 'daily_cap' while audio STILL enqueues (the mirror)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_IMAGE_DAILY_CAP;
    const spentStory = await seedGeneratedStory(pg.pool, userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryImageJob(pg.pool, userId, spentStory, { status: 'failed' });
    }
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/experience`);
    expect(res.status).toBe(202); // the audio half is working
    expect(res.body.experience.audio.enqueueBlocked).toBeNull();
    expect(res.body.experience.audio.status).toBe('pending');
    expect(res.body.experience.images.enqueueBlocked).toBe('daily_cap');

    expect(await countJobs('story_audio_jobs')).toBe(1); // the fresh audio job
    expect(await countJobs('story_image_jobs')).toBe(cap); // nothing new
  });
});

describe('GET /reading/generated — the F-216 asset aggregates', () => {
  it('a fresh story reads none/none; existing row fields + envelope flags ride along', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId, {
      title: '겨울 산책',
      level: 'L4',
      prompt: '산책',
    });

    const res = await agent.get('/reading/generated');
    expect(res.status).toBe(200);
    expect(res.body.ttsConfigured).toBe(true);
    expect(res.body.imageGenConfigured).toBe(true);
    expect(res.body.stories).toHaveLength(1);
    const row = res.body.stories[0];
    // Every PRE-F-216 field is preserved…
    expect(row.id).toBe(storyId);
    expect(row.title).toBe('겨울 산책');
    expect(row.level).toBe('L4');
    expect(row.prompt).toBe('산책');
    expect(typeof row.createdAt).toBe('string');
    // …and only the two aggregates are added.
    expect(row.audioStatus).toBe('none');
    expect(row.imageStatus).toBe('none');
  });

  it("each asset resolves the latest job's in-flight/failed state (pending / running / failed)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const pendingStory = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, pendingStory, { status: 'pending' });
    await seedStoryImageJob(pg.pool, userId, pendingStory, { status: 'pending' });
    const runningStory = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, runningStory, {
      status: 'running',
      startedAt: new Date(),
    });
    await seedStoryImageJob(pg.pool, userId, runningStory, {
      status: 'running',
      startedAt: new Date(),
    });
    const failedStory = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, failedStory, { status: 'failed' });
    await seedStoryImageJob(pg.pool, userId, failedStory, { status: 'failed' });

    const res = await agent.get('/reading/generated');
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.stories as Array<{ id: number; audioStatus: string; imageStatus: string }>).map(
        (s) => [s.id, s],
      ),
    );
    expect(byId.get(pendingStory)).toMatchObject({ audioStatus: 'pending', imageStatus: 'pending' });
    expect(byId.get(runningStory)).toMatchObject({ audioStatus: 'running', imageStatus: 'running' });
    expect(byId.get(failedStory)).toMatchObject({ audioStatus: 'failed', imageStatus: 'failed' });
  });

  it("the done AUTHORITY beats a NEWER failed job (buildStory*Dto's exact precedence)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    // Voiced + illustrated at rest…
    await seedStoryAudio(pg.pool, userId, storyId);
    await seedStoryImages(pg.pool, userId, storyId);
    // …then a LATER failed job on each half (e.g. an old re-request attempt's
    // ledger row). The artifacts are the authority — the row must read done.
    await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'failed' });
    await seedStoryImageJob(pg.pool, userId, storyId, { status: 'failed' });

    const res = await agent.get('/reading/generated');
    expect(res.body.stories[0].audioStatus).toBe('done');
    expect(res.body.stories[0].imageStatus).toBe('done');
  });

  it("a 'done' JOB whose artifacts are gone reads 'none' (the builders' last branch)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudioJob(pg.pool, userId, storyId, { status: 'done' });
    await seedStoryImageJob(pg.pool, userId, storyId, { status: 'done' });

    const res = await agent.get('/reading/generated');
    expect(res.body.stories[0].audioStatus).toBe('none');
    expect(res.body.stories[0].imageStatus).toBe('none');
  });

  it('the two aggregates are independent per row (audio done + images none)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudio(pg.pool, userId, storyId);

    const res = await agent.get('/reading/generated');
    expect(res.body.stories[0].audioStatus).toBe('done');
    expect(res.body.stories[0].imageStatus).toBe('none');
  });

  it('dormant deploys surface in the ENVELOPE flags (rows still aggregate normally)', async () => {
    makeTtsUnconfigured();
    makeImageGenUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudio(pg.pool, userId, storyId); // serving needs no key

    const res = await agent.get('/reading/generated');
    expect(res.status).toBe(200);
    expect(res.body.ttsConfigured).toBe(false);
    expect(res.body.imageGenConfigured).toBe(false);
    expect(res.body.stories[0].audioStatus).toBe('done');
    expect(res.body.stories[0].imageStatus).toBe('none');
  });
});
