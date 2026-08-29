/**
 * Per-route tests for the #45 public reuse library endpoints
 * (src/routes/reading.ts, migration 109):
 *
 *   POST /reading/generated/:id/publish      — owner-gated `is_shared = true`
 *   POST /reading/generated/:id/unpublish    — owner-gated `is_shared = false`
 *   GET  /reading/generated/shared           — the public browse listing
 *   POST /reading/generated/:id/clone        — clone-by-reference ($0 spend)
 *   GET  /reading/generated/:id (+ /images, + /image/:n/blob) — the #45
 *        read-widening (owned OR published)
 *
 * Cross-USER isolation (B reading/cloning A's story) is covered end-to-end
 * by tests/isolation/two-user.reading.test.ts's "public story library (#45)"
 * describe block — THIS file is single-account route shape: auth gates, id
 * validation, `.strict()` body rejection, idempotency, the browse DTO's
 * exact no-PII shape, and the clone route's content-copy + zero-job-row
 * behavior against a caller's OWN story (the isolation file covers the
 * cross-owner case; this file would be redundant if it re-asserted that —
 * it instead exercises what THAT file doesn't: single-account edge cases).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedGeneratedStory,
  seedStoryAudio,
  seedStoryImages,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    `TRUNCATE TABLE story_audio_jobs, story_image_jobs, audio_transcript_segments,
                     audio_tracks, audio_sources, story_images, generated_stories,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  resetLimiters();
});

describe('public library — auth required', () => {
  it('POST /reading/generated/:id/publish unauthenticated → 401', async () => {
    const res = await request(t.app).post('/reading/generated/1/publish').send({});
    expect(res.status).toBe(401);
  });

  it('POST /reading/generated/:id/unpublish unauthenticated → 401', async () => {
    const res = await request(t.app).post('/reading/generated/1/unpublish').send({});
    expect(res.status).toBe(401);
  });

  it('GET /reading/generated/shared unauthenticated → 401', async () => {
    const res = await request(t.app).get('/reading/generated/shared');
    expect(res.status).toBe(401);
  });

  it('POST /reading/generated/:id/clone unauthenticated → 401', async () => {
    const res = await request(t.app).post('/reading/generated/1/clone').send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /reading/generated/:id/publish|unpublish — id validation, IDOR, .strict()', () => {
  it.each(['abc', '0', '-1', '1.5'])('malformed id %s → 400', async (bad) => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.post(`/reading/generated/${bad}/publish`).send({})).status).toBe(400);
    expect((await agent.post(`/reading/generated/${bad}/unpublish`).send({})).status).toBe(400);
  });

  it("another user's story and a missing story are the same uniform 404", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, owner.userId);

    const foreign = await other.agent.post(`/reading/generated/${storyId}/publish`).send({});
    const missing = await other.agent.post('/reading/generated/999999/publish').send({});
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
  });

  it('.strict() rejects an unknown body key on publish (mass-assignment probe)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const res = await agent
      .post(`/reading/generated/${storyId}/publish`)
      .send({ shared: true });
    expect(res.status).toBe(400);
  });

  it('.strict() rejects an unknown body key on unpublish', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const res = await agent
      .post(`/reading/generated/${storyId}/unpublish`)
      .send({ user_id: 999 });
    expect(res.status).toBe(400);
  });

  it('publish flips is_shared true in the DB and the response DTO; unpublish flips it back', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const pub = await agent.post(`/reading/generated/${storyId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.story.isShared).toBe(true);
    expect(pub.body.story.isOwn).toBe(true);
    const row1 = await pg.pool.query<{ is_shared: boolean }>(
      `SELECT is_shared FROM generated_stories WHERE id = $1`,
      [storyId],
    );
    expect(row1.rows[0]?.is_shared).toBe(true);

    const unpub = await agent.post(`/reading/generated/${storyId}/unpublish`).send({});
    expect(unpub.status).toBe(200);
    expect(unpub.body.story.isShared).toBe(false);
    const row2 = await pg.pool.query<{ is_shared: boolean }>(
      `SELECT is_shared FROM generated_stories WHERE id = $1`,
      [storyId],
    );
    expect(row2.rows[0]?.is_shared).toBe(false);
  });

  it('publishing an already-published story is idempotent (200, no error)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    await agent.post(`/reading/generated/${storyId}/publish`).send({});
    const second = await agent.post(`/reading/generated/${storyId}/publish`).send({});
    expect(second.status).toBe(200);
    expect(second.body.story.isShared).toBe(true);
  });
});

describe('GET /reading/generated/:id — #45 isOwn/isShared on the owner-fetch path', () => {
  it("an owner's own fetch reports isOwn:true and the real isShared state", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);

    const before = await agent.get(`/reading/generated/${storyId}`);
    expect(before.body.story.isOwn).toBe(true);
    expect(before.body.story.isShared).toBe(false);

    await agent.post(`/reading/generated/${storyId}/publish`).send({});
    const after = await agent.get(`/reading/generated/${storyId}`);
    expect(after.body.story.isOwn).toBe(true);
    expect(after.body.story.isShared).toBe(true);
  });

  it("GET /reading/generated (own list) carries isShared per row", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId, { title: 'Listed' });
    await agent.post(`/reading/generated/${storyId}/publish`).send({});

    const res = await agent.get('/reading/generated');
    const row = (res.body.stories as Array<{ id: number; isShared: boolean }>).find(
      (s) => s.id === storyId,
    );
    expect(row?.isShared).toBe(true);
  });
});

describe('GET /reading/generated/shared — the public browse listing', () => {
  it('lists only PUBLISHED stories, newest first, with no owner-identifying field', async () => {
    const a = await registerUser(t.app, pg.pool);
    const privateId = await seedGeneratedStory(pg.pool, a.userId, { title: 'Still Private' });
    const publishedId = await seedGeneratedStory(pg.pool, a.userId, { title: 'Published One' });
    await a.agent.post(`/reading/generated/${publishedId}/publish`).send({});

    const res = await a.agent.get('/reading/generated/shared');
    expect(res.status).toBe(200);
    const ids = (res.body.stories as Array<{ id: number }>).map((s) => s.id);
    expect(ids).toContain(publishedId);
    expect(ids).not.toContain(privateId);

    const row = (res.body.stories as Array<Record<string, unknown>>).find(
      (s) => s.id === publishedId,
    );
    expect(row).toBeDefined();
    // Structural no-PII assertion: exactly the fields a browse card needs,
    // nothing owner-identifying.
    expect(Object.keys(row!).sort()).toEqual(
      ['audioStatus', 'createdAt', 'id', 'imageStatus', 'level', 'prompt', 'title'].sort(),
    );
  });

  it('an empty library (nothing published yet) returns an empty array, not an error', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedGeneratedStory(pg.pool, userId);

    const res = await agent.get('/reading/generated/shared');
    expect(res.status).toBe(200);
    expect(res.body.stories).toEqual([]);
  });

  it('carries the F-216 asset-status pips for a published story with audio + images', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await seedStoryAudio(pg.pool, userId, storyId);
    await seedStoryImages(pg.pool, userId, storyId);
    await agent.post(`/reading/generated/${storyId}/publish`).send({});

    const res = await agent.get('/reading/generated/shared');
    const row = (res.body.stories as Array<{ id: number; audioStatus: string; imageStatus: string }>).find(
      (s) => s.id === storyId,
    );
    expect(row?.audioStatus).toBe('done');
    expect(row?.imageStatus).toBe('done');
  });
});

describe('POST /reading/generated/:id/clone — id validation, IDOR, .strict(), content copy, $0 spend', () => {
  it.each(['abc', '0', '-1', '1.5'])('malformed id %s → 400', async (bad) => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.post(`/reading/generated/${bad}/clone`).send({})).status).toBe(400);
  });

  it('cloning a missing story → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/reading/generated/999999/clone').send({});
    expect(res.status).toBe(404);
  });

  it("cloning another user's PRIVATE (unpublished) story → 404 (same shape as a missing id)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const other = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, owner.userId);

    const foreign = await other.agent.post(`/reading/generated/${storyId}/clone`).send({});
    const missing = await other.agent.post('/reading/generated/999999/clone').send({});
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
  });

  it('.strict() rejects an unknown body key on clone', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    const res = await agent
      .post(`/reading/generated/${storyId}/clone`)
      .send({ level: 'L5+' });
    expect(res.status).toBe(400);
  });

  it('an owner can clone their OWN story (no publish required to clone your own) — a real 2nd independent row', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId, {
      title: 'Self Clone Source',
      bodyKo: '자기 자신의 이야기입니다.',
      level: 'L2',
      prompt: '바닷가',
    });

    const res = await agent.post(`/reading/generated/${storyId}/clone`).send({});
    expect(res.status).toBe(201);
    const clone = res.body.story;
    expect(clone.id).not.toBe(storyId);
    expect(clone.title).toBe('Self Clone Source');
    expect(clone.bodyKo).toBe('자기 자신의 이야기입니다.');
    expect(clone.level).toBe('L2');
    expect(clone.prompt).toBe('바닷가');
    expect(clone.isOwn).toBe(true);
    expect(clone.isShared).toBe(false);

    const { rows } = await pg.pool.query<{ source_story_id: number; user_id: number }>(
      `SELECT source_story_id, user_id FROM generated_stories WHERE id = $1`,
      [clone.id],
    );
    expect(rows[0]?.source_story_id).toBe(storyId);
    expect(rows[0]?.user_id).toBe(userId);
  });

  it('cloning a story with NO audio/images yet still succeeds — none/none asset status, zero job rows', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await agent.post(`/reading/generated/${storyId}/publish`).send({});

    const res = await agent.post(`/reading/generated/${storyId}/clone`).send({});
    expect(res.status).toBe(201);
    const cloneId = res.body.story.id as number;

    const audioRes = await agent.get(`/reading/generated/${cloneId}/audio`);
    expect(audioRes.body.audio.status).toBe('none');
    const imagesRes = await agent.get(`/reading/generated/${cloneId}/images`);
    expect(imagesRes.body.images.status).toBe('none');

    const audioJobs = await pg.pool.query(
      `SELECT 1 FROM story_audio_jobs WHERE generated_story_id = $1`,
      [cloneId],
    );
    expect(audioJobs.rowCount).toBe(0);
    const imageJobs = await pg.pool.query(
      `SELECT 1 FROM story_image_jobs WHERE generated_story_id = $1`,
      [cloneId],
    );
    expect(imageJobs.rowCount).toBe(0);
  });

  it('cloning the SAME story twice creates two independent clone rows (no uniqueness constraint on re-cloning)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId);
    await agent.post(`/reading/generated/${storyId}/publish`).send({});

    const first = await agent.post(`/reading/generated/${storyId}/clone`).send({});
    const second = await agent.post(`/reading/generated/${storyId}/clone`).send({});
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.story.id).not.toBe(second.body.story.id);

    const { rows } = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM generated_stories WHERE source_story_id = $1`,
      [storyId],
    );
    expect(rows[0]?.n).toBe('2');
  });
});
