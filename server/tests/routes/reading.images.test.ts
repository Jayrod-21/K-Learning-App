/**
 * Per-route tests for the F-211 story-image endpoints (src/routes/reading.ts):
 *
 *   POST /reading/generated/:id/images       — idempotent, generate-once,
 *                                              daily-capped enqueue (the
 *                                              ON-DEMAND trigger)
 *   GET  /reading/generated/:id/images       — status envelope (+ ordered
 *                                              images[] when done)
 *   GET  /reading/generated/:id/image/:n/blob — the byte-serve sibling
 *   POST /reading/generate                   — the BATCH-AT-CREATION
 *                                              auto-enqueue (configured
 *                                              deploys only; best-effort)
 *
 * Pure ROUTE tests: no real image network call — the "illustrated" state is
 * seeded at rest (seedStoryImages), the runner pipeline itself is covered by
 * tests/services/storyImage.test.ts. A never-called mock provider is
 * installed per test so the routes see a CONFIGURED deploy
 * (isImageGenConfigured() → true); the dormant 503 posture has its own
 * describe block (reading.audio.test.ts's exact structure).
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedGeneratedStory,
  seedStoryImageJob,
  seedStoryImages,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { loadConfig } from '../../src/config/index.js';
import {
  resetImageGenProviderForTesting,
  setImageGenProvider,
  UnconfiguredImageGenProvider,
} from '../../src/services/imageGen.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  process.env.IMAGE_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-reading-images-test-${process.pid}-${Date.now()}`,
  );
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  resetImageGenProviderForTesting();
  await teardownTestApp(t);
  await stopPostgres(pg);
  await rm(process.env.IMAGE_STORAGE_DIR!, { recursive: true, force: true });
  delete process.env.IMAGE_STORAGE_DIR;
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE story_image_jobs, story_images, generated_stories, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
  // A CONFIGURED (but never-invoked) provider: routes only probe capability —
  // generation belongs to the runner, so any call here is a test bug.
  setImageGenProvider({
    generate: () => Promise.reject(new Error('route tests must never call generate')),
  });
});

/** Flip this suite's app to the DORMANT deploy posture (exactly what a
 *  keyless production deploy gets) — the same state a missing OPENAI_API_KEY
 *  produces, but hermetic against any ambient env key. beforeEach restores
 *  the configured mock. */
function makeImageGenUnconfigured(): void {
  setImageGenProvider(new UnconfiguredImageGenProvider());
}

describe('story images — auth required', () => {
  it('POST /reading/generated/:id/images unauthenticated → 401', async () => {
    const res = await request(t.app).post('/reading/generated/1/images');
    expect(res.status).toBe(401);
  });

  it('GET /reading/generated/:id/images unauthenticated → 401', async () => {
    const res = await request(t.app).get('/reading/generated/1/images');
    expect(res.status).toBe(401);
  });

  it('GET /reading/generated/:id/image/:n/blob unauthenticated → 401', async () => {
    const res = await request(t.app).get('/reading/generated/1/image/1/blob');
    expect(res.status).toBe(401);
  });
});

describe('story images — id validation + IDOR', () => {
  it.each(['abc', '0', '-1', '1.5'])('malformed id %s → 400', async (bad) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const post = await agent.post(`/reading/generated/${bad}/images`);
    expect(post.status).toBe(400);
    const get = await agent.get(`/reading/generated/${bad}/images`);
    expect(get.status).toBe(400);
    const blob = await agent.get(`/reading/generated/${bad}/image/1/blob`);
    expect(blob.status).toBe(400);
  });

  it('malformed image number → 400 on the blob route', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const res = await agent.get(`/reading/generated/${storyId}/image/${bad}/blob`);
      expect(res.status).toBe(400);
    }
  });

  it("another user's story and a missing story are the same uniform 404 (POST + GET + blob)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, owner.userId);
    await seedStoryImages(pg.pool, owner.userId, storyId);

    const foreignPost = await other.agent.post(`/reading/generated/${storyId}/images`);
    const missingPost = await other.agent.post('/reading/generated/999999/images');
    expect(foreignPost.status).toBe(404);
    expect(missingPost.status).toBe(404);
    expect(foreignPost.body.error).toEqual(missingPost.body.error);

    const foreignGet = await other.agent.get(`/reading/generated/${storyId}/images`);
    const missingGet = await other.agent.get('/reading/generated/999999/images');
    expect(foreignGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    expect(foreignGet.body.error).toEqual(missingGet.body.error);

    const foreignBlob = await other.agent.get(`/reading/generated/${storyId}/image/1/blob`);
    const missingBlob = await other.agent.get('/reading/generated/999999/image/1/blob');
    expect(foreignBlob.status).toBe(404);
    expect(missingBlob.status).toBe(404);

    // The probe wrote nothing.
    const jobs = await pg.pool.query(`SELECT id FROM story_image_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });
});

describe('POST /reading/generated/:id/images — on-demand enqueue', () => {
  it('202 with a pending envelope + a job row snapshotting image_count', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(202);
    expect(res.body.images.status).toBe('pending');
    expect(typeof res.body.images.jobId).toBe('number');
    expect(res.body.images.error).toBeNull();
    expect(res.body.images.images).toEqual([]);
    expect(res.body.images.imageGenConfigured).toBe(true);

    const job = await pg.pool.query<{
      generated_story_id: string;
      user_id: string;
      status: string;
      image_count: number;
    }>(
      `SELECT generated_story_id::text AS generated_story_id, user_id::text AS user_id,
              status, image_count
         FROM story_image_jobs`,
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]!.generated_story_id).toBe(String(storyId));
    expect(job.rows[0]!.user_id).toBe(String(userId));
    expect(job.rows[0]!.status).toBe('pending');
    expect(job.rows[0]!.image_count).toBe(loadConfig().STORY_IMAGE_SCENE_COUNT);
  });

  it('IDEMPOTENT: a second POST returns the same live job — no duplicate row', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const first = await agent.post(`/reading/generated/${storyId}/images`);
    const second = await agent.post(`/reading/generated/${storyId}/images`);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.images.status).toBe('pending');
    expect(second.body.images.jobId).toBe(first.body.images.jobId);

    const jobs = await pg.pool.query(`SELECT id FROM story_image_jobs`);
    expect(jobs.rows).toHaveLength(1);
  });

  it('a RUNNING job also short-circuits (202, same job, no dup)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const jobId = await seedStoryImageJob(pg.pool, userId, storyId, {
      status: 'running',
      startedAt: new Date(),
    });

    const res = await agent.post(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(202);
    expect(res.body.images.status).toBe('running');
    expect(res.body.images.jobId).toBe(jobId);
    const jobs = await pg.pool.query(`SELECT id FROM story_image_jobs`);
    expect(jobs.rows).toHaveLength(1);
  });

  it('GENERATE-ONCE: an already-illustrated story → 200 done envelope, NO new job', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryImages(pg.pool, userId, storyId, { count: 3 });

    const res = await agent.post(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(200);
    expect(res.body.images.status).toBe('done');
    expect(res.body.images.images).toHaveLength(3);

    const jobs = await pg.pool.query(`SELECT id FROM story_image_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('a FAILED job does not block a retry: a fresh job is enqueued', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const failedId = await seedStoryImageJob(pg.pool, userId, storyId, {
      status: 'failed',
      error: 'the image service rejected the request (HTTP 503)',
    });

    const res = await agent.post(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(202);
    expect(res.body.images.status).toBe('pending');
    expect(res.body.images.jobId).not.toBe(failedId);

    const jobs = await pg.pool.query(`SELECT id FROM story_image_jobs ORDER BY id`);
    expect(jobs.rows).toHaveLength(2); // the failed ledger row survives
  });
});

describe('POST /reading/generated/:id/images — daily cap', () => {
  it('cap-many enqueues today → 429 rate_limited BEFORE any write', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_IMAGE_DAILY_CAP;
    // Spend the whole budget on ONE story via settled (failed) jobs — failures
    // count (cost stance), and settled rows never trip the live partial unique.
    const spentStory = await seedGeneratedStory(pg.pool, userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryImageJob(pg.pool, userId, spentStory, { status: 'failed' });
    }
    const freshStory = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${freshStory}/images`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.body.error.message).toContain('tomorrow');

    const jobs = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM story_image_jobs`,
    );
    expect(jobs.rows[0]!.n).toBe(String(cap)); // nothing new was written
  });

  it("YESTERDAY's spend does not count, and an illustrated story still 200s over the cap", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_IMAGE_DAILY_CAP;
    const spentStory = await seedGeneratedStory(pg.pool, userId);
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    for (let i = 0; i < cap; i++) {
      await seedStoryImageJob(pg.pool, userId, spentStory, {
        status: 'failed',
        createdAt: yesterday,
      });
    }
    const freshStory = await seedGeneratedStory(pg.pool, userId);
    const res = await agent.post(`/reading/generated/${freshStory}/images`);
    expect(res.status).toBe(202); // yesterday's rows are outside today's window

    // And the generate-once short-circuit is checked BEFORE the cap: an
    // illustrated story keeps returning 200 even when today's budget is gone.
    await pg.pool.query(`DELETE FROM story_image_jobs`);
    const today = await seedGeneratedStory(pg.pool, userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryImageJob(pg.pool, userId, today, { status: 'failed' });
    }
    const illustrated = await seedGeneratedStory(pg.pool, userId);
    await seedStoryImages(pg.pool, userId, illustrated);
    const doneRes = await agent.post(`/reading/generated/${illustrated}/images`);
    expect(doneRes.status).toBe(200);
    expect(doneRes.body.images.status).toBe('done');
  });

  it("the cap is PER USER — one user's spend never 429s another", async () => {
    const spender = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_IMAGE_DAILY_CAP;
    const spentStory = await seedGeneratedStory(pg.pool, spender.userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryImageJob(pg.pool, spender.userId, spentStory, { status: 'failed' });
    }
    const otherStory = await seedGeneratedStory(pg.pool, other.userId);
    const res = await other.agent.post(`/reading/generated/${otherStory}/images`);
    expect(res.status).toBe(202);
  });
});

describe('GET /reading/generated/:id/images — status envelope', () => {
  it("a never-requested story → status 'none'", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const res = await agent.get(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(200);
    expect(res.body.images).toEqual({
      status: 'none',
      jobId: null,
      error: null,
      images: [],
      // The suite's default provider is a configured mock — the envelope
      // advertises the capability so the client offers the button.
      imageGenConfigured: true,
    });
  });

  it('pending after a POST (the polling loop the client runs)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const post = await agent.post(`/reading/generated/${storyId}/images`);
    const res = await agent.get(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(200);
    expect(res.body.images.status).toBe('pending');
    expect(res.body.images.jobId).toBe(post.body.images.jobId);
  });

  it("a failed job → status 'failed' with the server-authored error surfaced", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const jobId = await seedStoryImageJob(pg.pool, userId, storyId, {
      status: 'failed',
      error: 'the image service rejected the request (HTTP 503)',
    });
    const res = await agent.get(`/reading/generated/${storyId}/images`);
    expect(res.body.images.status).toBe('failed');
    expect(res.body.images.jobId).toBe(jobId);
    expect(res.body.images.error).toBe('the image service rejected the request (HTTP 503)');
    expect(res.body.images.images).toEqual([]);
  });

  it('done → ordered images[] with blobUrl (the sibling byte route), prompt, dimensions', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryImages(pg.pool, userId, storyId, { count: 3 });
    const res = await agent.get(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(200);
    expect(res.body.images.status).toBe('done');
    const images = res.body.images.images as Array<{
      imageNumber: number;
      blobUrl: string;
      prompt: string;
      width: number;
      height: number;
    }>;
    expect(images).toHaveLength(3);
    expect(images.map((i) => i.imageNumber)).toEqual([1, 2, 3]);
    for (const img of images) {
      expect(img.blobUrl).toBe(
        `/reading/generated/${storyId}/image/${img.imageNumber}/blob`,
      );
      expect(img.prompt).toContain(`seeded scene ${img.imageNumber}`);
      expect(img.width).toBe(1024);
      expect(img.height).toBe(1024);
    }
  });

  it("a 'done' job whose rows were deleted out-of-band reads 'none' — the client can simply re-generate", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryImageJob(pg.pool, userId, storyId, { status: 'done' });

    const res = await agent.get(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(200);
    expect(res.body.images.status).toBe('none');
    expect(res.body.images.jobId).toBeNull();
    expect(res.body.images.images).toEqual([]);
  });
});

describe('GET /reading/generated/:id/image/:n/blob — byte serve', () => {
  it('serves the exact stored bytes with the ext-derived Content-Type + nosniff + private cache', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const [blobRef] = await seedStoryImages(pg.pool, userId, storyId, { count: 1, ext: 'png' });
    const bytes = Buffer.from('real-png-bytes-on-disk');
    const absPath = path.join(process.env.IMAGE_STORAGE_DIR!, blobRef!);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, bytes);

    const res = await agent
      .get(`/reading/generated/${storyId}/image/1/blob`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('private');
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it('a missing image number → 404 (same as a missing story — no slot probing)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryImages(pg.pool, userId, storyId, { count: 2 });
    const res = await agent.get(`/reading/generated/${storyId}/image/3/blob`);
    expect(res.status).toBe(404);
  });

  it('a row whose FILE is gone → 404, not 500', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryImages(pg.pool, userId, storyId, { count: 1 }); // blob_ref points at nothing
    const res = await agent.get(`/reading/generated/${storyId}/image/1/blob`);
    expect(res.status).toBe(404);
  });
});

describe('POST /reading/generate — batch-at-creation enqueue (F-211)', () => {
  it('a CONFIGURED deploy auto-enqueues an illustration job for the new story', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/reading/generate').send({ level: 'L3' });
    expect(res.status).toBe(201);
    const storyId = res.body.story.id as number;

    const jobs = await pg.pool.query<{
      generated_story_id: string;
      status: string;
      image_count: number;
    }>(
      `SELECT generated_story_id::text AS generated_story_id, status, image_count
         FROM story_image_jobs`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.generated_story_id).toBe(String(storyId));
    expect(jobs.rows[0]!.status).toBe('pending');
    expect(jobs.rows[0]!.image_count).toBe(loadConfig().STORY_IMAGE_SCENE_COUNT);
  });

  it('a DORMANT deploy skips the enqueue — the story still 201s, no job row', async () => {
    makeImageGenUnconfigured();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/reading/generate').send({ level: 'L2' });
    expect(res.status).toBe(201);
    const jobs = await pg.pool.query(`SELECT id FROM story_image_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('a cap-exhausted user still gets their story (best-effort enqueue swallows the 429)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const cap = loadConfig().STORY_IMAGE_DAILY_CAP;
    const spentStory = await seedGeneratedStory(pg.pool, userId);
    for (let i = 0; i < cap; i++) {
      await seedStoryImageJob(pg.pool, userId, spentStory, { status: 'failed' });
    }

    const res = await agent.post('/reading/generate').send({ level: 'L3' });
    expect(res.status).toBe(201); // creation must never fail on the enqueue
    const jobs = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM story_image_jobs`,
    );
    expect(jobs.rows[0]!.n).toBe(String(cap)); // no new job over the cap
  });
});

describe('story images — dormant deploy (image gen not configured)', () => {
  it('POST → 503 image_gen_unavailable BEFORE any write: no job row, no daily-cap slot burned', async () => {
    makeImageGenUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.post(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('image_gen_unavailable');

    const jobs = await pg.pool.query(`SELECT id FROM story_image_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('generate-once still serves: an ALREADY-illustrated story answers 200 done (serving needs no key)', async () => {
    makeImageGenUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryImages(pg.pool, userId, storyId, { count: 2 });

    const res = await agent.post(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(200);
    expect(res.body.images.status).toBe('done');
    expect(res.body.images.images).toHaveLength(2);
    // …but the envelope is honest about the capability being off.
    expect(res.body.images.imageGenConfigured).toBe(false);
  });

  it('GET reports imageGenConfigured: false so the client hides the feature', async () => {
    makeImageGenUnconfigured();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const res = await agent.get(`/reading/generated/${storyId}/images`);
    expect(res.status).toBe(200);
    expect(res.body.images.status).toBe('none');
    expect(res.body.images.imageGenConfigured).toBe(false);
  });
});
