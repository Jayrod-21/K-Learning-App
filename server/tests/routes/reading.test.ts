/**
 * Per-route tests for src/routes/reading.ts (U3b — digitized chapter reader).
 *
 * Routes:
 *   GET /reading/chapters?source_upload_id=
 *   GET /reading/chapters/:chapterId
 *
 * Focus: user-scoping / IDOR (a user must never read another user's chapters or
 * even confirm their upload's existence), ordering, and the 400/404 boundaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedBookUpload,
  seedReadingChapter,
  seedReadingPassage,
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
  // reading_* are user-owned content; CASCADE from users clears the whole
  // book_uploads → reading_chapters → reading_passages chain.
  await pg.pool.query(
    'TRUNCATE TABLE reading_passages, reading_chapters, book_uploads, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('reading — auth required', () => {
  it.each([
    ['GET', '/reading/chapters?source_upload_id=1'],
    ['GET', '/reading/chapters/1'],
  ])('%s %s unauthenticated → 401', async (_method, path) => {
    const res = await request(t.app).get(path);
    expect(res.status).toBe(401);
  });
});

describe('GET /reading/chapters — list', () => {
  it('lists a book\'s chapters ordered by chapter_number', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    // Seed out of order to prove the ORDER BY, not insertion order.
    await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 2,
      title: 'Second',
    });
    await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
      title: 'First',
      startPage: 3,
      endPage: 10,
    });

    const res = await agent.get(`/reading/chapters?source_upload_id=${uploadId}`);
    expect(res.status).toBe(200);
    const nums = (res.body.chapters as Array<{ chapter_number: number }>).map(
      (c) => c.chapter_number,
    );
    expect(nums).toEqual([1, 2]);
    expect(res.body.chapters[0].title).toBe('First');
    expect(res.body.chapters[0].start_page).toBe(3);
    expect(res.body.chapters[0].end_page).toBe(10);
    expect(typeof res.body.chapters[0].id).toBe('number');
  });

  it('an owned book with no chapters yet → 200 empty list', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const res = await agent.get(`/reading/chapters?source_upload_id=${uploadId}`);
    expect(res.status).toBe(200);
    expect(res.body.chapters).toEqual([]);
  });

  it('a non-existent upload id → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/chapters?source_upload_id=99999999');
    expect(res.status).toBe(404);
  });

  it("another user's upload → 404 (IDOR: cannot list their chapters or confirm their upload)", async () => {
    // Owner has a literature book with a chapter…
    const owner = await registerUser(t.app, pg.pool);
    const ownerUpload = await seedBookUpload(pg.pool, owner.userId, {
      type: 'literature',
      status: 'ready',
    });
    await seedReadingChapter(pg.pool, owner.userId, ownerUpload, {
      chapterNumber: 1,
      title: "Owner's chapter",
    });
    // …a different user asking for that upload's chapters gets a uniform 404,
    // identical to a non-existent id — no existence leak.
    const other = await registerUser(t.app, pg.pool);
    const res = await other.agent.get(
      `/reading/chapters?source_upload_id=${ownerUpload}`,
    );
    expect(res.status).toBe(404);
  });

  it('missing source_upload_id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/reading/chapters')).status).toBe(400);
  });

  it('garbage source_upload_id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/reading/chapters?source_upload_id=abc')).status).toBe(400);
    expect((await agent.get('/reading/chapters?source_upload_id=0')).status).toBe(400);
  });
});

describe('GET /reading/chapters/:chapterId — detail', () => {
  it('returns the chapter plus its passages ordered by passage_number', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
      title: 'Ch 1',
      startPage: 5,
    });
    // Seed passages out of order to prove ORDER BY passage_number.
    await seedReadingPassage(pg.pool, chapterId, {
      passageNumber: 2,
      body: '두 번째 문단입니다.',
      pageNumber: 6,
    });
    await seedReadingPassage(pg.pool, chapterId, {
      passageNumber: 1,
      body: '첫 번째 문단입니다.',
      pageNumber: 5,
    });

    const res = await agent.get(`/reading/chapters/${chapterId}`);
    expect(res.status).toBe(200);
    expect(res.body.chapter.id).toBe(chapterId);
    expect(res.body.chapter.source_upload_id).toBe(uploadId);
    expect(res.body.chapter.title).toBe('Ch 1');
    expect(res.body.chapter.start_page).toBe(5);
    const bodies = (res.body.passages as Array<{ body: string }>).map((p) => p.body);
    expect(bodies).toEqual(['첫 번째 문단입니다.', '두 번째 문단입니다.']);
    expect(res.body.passages[0].page_number).toBe(5);
    expect(typeof res.body.passages[0].id).toBe('number');
  });

  it('a chapter with no passages → 200 with an empty passages list', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
    });
    const res = await agent.get(`/reading/chapters/${chapterId}`);
    expect(res.status).toBe(200);
    expect(res.body.passages).toEqual([]);
  });

  it('a non-existent chapter id → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/reading/chapters/99999999')).status).toBe(404);
  });

  it("another user's chapter → 404 (IDOR: body never served cross-user)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const ownerUpload = await seedBookUpload(pg.pool, owner.userId, {
      type: 'literature',
      status: 'ready',
    });
    const ownerChapter = await seedReadingChapter(pg.pool, owner.userId, ownerUpload, {
      chapterNumber: 1,
    });
    await seedReadingPassage(pg.pool, ownerChapter, { body: '비밀 내용' });

    const other = await registerUser(t.app, pg.pool);
    const res = await other.agent.get(`/reading/chapters/${ownerChapter}`);
    expect(res.status).toBe(404);
  });

  it('garbage chapter id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/reading/chapters/abc')).status).toBe(400);
    expect((await agent.get('/reading/chapters/-1')).status).toBe(400);
  });
});
