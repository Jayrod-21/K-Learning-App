/**
 * Cross-user isolation — generated stories, reading chapters/positions, and
 * book uploads (Phase 2.10).
 *
 * F-207/F-217 carve-out: `book_uploads`/`reading_chapters` READS
 * intentionally widen to owned-OR-shared when `is_shared = true` — that is
 * NOT an isolation bug (see RECON_server.md §3 and the route comments in
 * uploads.ts/reading.ts). This suite asserts the DEFAULT (private, unshared)
 * case is denied, and separately asserts the shared-read widening is real
 * (not accidentally over-permissive) while owner-only MUTATIONS on a shared
 * book stay denied to a non-owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  seedGeneratedStory,
  seedBookUpload,
  seedReadingChapter,
} from '../helpers/seed.js';
import { twoUsers, expectDenied, type TwoUsers } from '../helpers/twoUsers.js';
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
    `TRUNCATE TABLE reading_attempts, reading_positions, reading_passages,
                     reading_chapters, generated_stories, book_uploads,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  resetLimiters();
});

describe('cross-user isolation — generated stories', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("B cannot GET A's story by id (404)", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: "A's private story",
    });

    const res = await users.b.agent.get(`/reading/generated/${String(storyId)}`);
    expectDenied(res);
  });

  it("B's story library excludes A's story", async () => {
    const aStoryId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: "A's story",
    });
    const bStoryId = await seedGeneratedStory(pg.pool, users.b.userId, {
      title: "B's story",
    });

    const res = await users.b.agent.get('/reading/generated');
    expect(res.status).toBe(200);
    const ids = (res.body.stories as Array<{ id: number }>).map((s) => s.id);
    expect(ids).toContain(bStoryId);
    expect(ids).not.toContain(aStoryId);
  });

  it("B cannot enqueue audio (owner-gated, cost-bearing mutation) for A's story", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId);

    const res = await users.b.agent.post(`/reading/generated/${String(storyId)}/audio`);
    expectDenied(res);
  });
});

describe('cross-user isolation — reading chapters & positions', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("a chapter of A's PRIVATE book is not reachable by B (404)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, users.a.userId, uploadId, {
      title: 'Chapter 1',
    });

    const res = await users.b.agent.get(`/reading/chapters/${String(chapterId)}`);
    expectDenied(res);
  });

  it("B cannot PUT a reading position against A's book (owner-strict, DB-FK-enforced)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
    });

    const res = await users.b.agent
      .put(`/reading/position/${String(uploadId)}`)
      .send({ page_number: 3 });
    expectDenied(res);

    const { rowCount } = await pg.pool.query(
      `SELECT 1 FROM reading_positions WHERE source_upload_id = $1 AND user_id = $2`,
      [uploadId, users.b.userId],
    );
    expect(rowCount).toBe(0);
  });

  it("a chapter of A's SHARED book IS readable by B (intentional F-207 widening, not a bug)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
    });
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);
    const chapterId = await seedReadingChapter(pg.pool, users.a.userId, uploadId, {
      title: 'Shared Chapter',
    });

    const res = await users.b.agent.get(`/reading/chapters/${String(chapterId)}`);
    expect(res.status).toBe(200);
    expect(res.body.chapter.title).toBe('Shared Chapter');

    // But the position write stays owner-strict even for a shared book (the
    // migration-051 composite FK makes a non-owner position row structurally
    // impossible — see RECON_server.md finding #3).
    const posRes = await users.b.agent
      .put(`/reading/position/${String(uploadId)}`)
      .send({ page_number: 1 });
    expectDenied(posRes);
  });
});

describe('cross-user isolation — book uploads', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("B cannot GET A's PRIVATE upload by id (404)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId);

    const res = await users.b.agent.get(`/uploads/${String(uploadId)}`);
    expectDenied(res);
  });

  it("A's SHARED upload IS readable by B via GET /uploads/:id (intentional F-217 widening)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      title: 'shared corpus book',
      status: 'ready',
    });
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);

    const res = await users.b.agent.get(`/uploads/${String(uploadId)}`);
    expect(res.status).toBe(200);
    expect(res.body.upload.title).toBe('shared corpus book');
  });

  it("B's GET /uploads (own uploads) excludes A's upload — even A's SHARED one", async () => {
    const aUploadId = await seedBookUpload(pg.pool, users.a.userId, {
      title: 'a upload',
    });
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      aUploadId,
    ]);
    const bUploadId = await seedBookUpload(pg.pool, users.b.userId, {
      title: 'b upload',
    });

    const res = await users.b.agent.get('/uploads');
    expect(res.status).toBe(200);
    // Wire contract: upload ids are emitted as STRINGS (uploads.ts's toDTO,
    // pre-int8-parser behavior) — compare as strings, not numbers.
    const ids = (res.body.uploads as Array<{ id: string }>).map((u) => u.id);
    expect(ids).toContain(String(bUploadId));
    expect(ids).not.toContain(String(aUploadId));
  });

  it("B cannot DELETE A's upload — even a SHARED one (owner-only mutation)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId);
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);

    const res = await users.b.agent.delete(`/uploads/${String(uploadId)}`);
    expectDenied(res);

    const { rowCount } = await pg.pool.query(`SELECT 1 FROM book_uploads WHERE id = $1`, [
      uploadId,
    ]);
    expect(rowCount).toBe(1);
  });

  it("B cannot POST /uploads/:id/extract against A's upload (owner-only, cost-bearing)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
      pageCount: 1,
    });

    const res = await users.b.agent.post(`/uploads/${String(uploadId)}/extract`).send({});
    expectDenied(res);
  });

  it("B cannot reorder pages of A's upload", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, { status: 'ready' });

    const res = await users.b.agent
      .patch(`/uploads/${String(uploadId)}/pages/order`)
      .send({ page_ids: [1] });
    expectDenied(res);
  });
});
