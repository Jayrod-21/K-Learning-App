/**
 * Per-route tests for src/routes/reading.ts (U3b — digitized chapter reader).
 *
 * Routes:
 *   GET /reading/chapters?source_upload_id=
 *   GET /reading/chapters/:chapterId
 *   GET /reading/position/:uploadId   (F-069 — resume position)
 *   PUT /reading/position/:uploadId   (F-069 — resume position upsert)
 *
 * Focus: user-scoping / IDOR (a user must never read another user's chapters or
 * even confirm their upload's existence — and never read OR write another
 * user's resume position), ordering, upsert semantics, and the 400/404
 * boundaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedBookUpload,
  seedGeneratedStory,
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
  // book_uploads → reading_chapters → reading_passages / reading_positions
  // chain. reading_attempts (F-172, migration 060) and generated_stories
  // (F-068) are listed explicitly too (both also FK to users, so CASCADE
  // would reach them transitively — spelled out for the same clarity every
  // other table in this list gets, not relying on the transitive FK path).
  await pg.pool.query(
    'TRUNCATE TABLE reading_attempts, reading_positions, reading_passages, reading_chapters, generated_stories, book_uploads, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('reading — auth required', () => {
  it.each([
    ['GET', '/reading/chapters?source_upload_id=1'],
    ['GET', '/reading/chapters/1'],
    ['GET', '/reading/position/1'],
  ])('%s %s unauthenticated → 401', async (_method, path) => {
    const res = await request(t.app).get(path);
    expect(res.status).toBe(401);
  });

  it('PUT /reading/position/:uploadId unauthenticated → 401', async () => {
    const res = await request(t.app)
      .put('/reading/position/1')
      .send({ page_number: 1 });
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

describe('GET /reading/position/:uploadId — resume position (F-069)', () => {
  it('an owned book with no saved position → 200 { position: null }', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const res = await agent.get(`/reading/position/${uploadId}`);
    expect(res.status).toBe(200);
    expect(res.body.position).toBeNull();
  });

  it('a non-existent upload id → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/reading/position/99999999')).status).toBe(404);
  });

  it("another user's upload → 404 even when the owner HAS a saved position (IDOR)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const ownerUpload = await seedBookUpload(pg.pool, owner.userId, {
      type: 'literature',
      status: 'ready',
    });
    await owner.agent
      .put(`/reading/position/${ownerUpload}`)
      .send({ page_number: 7 })
      .expect(200);

    const other = await registerUser(t.app, pg.pool);
    const res = await other.agent.get(`/reading/position/${ownerUpload}`);
    expect(res.status).toBe(404);
  });

  it('garbage upload id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/reading/position/abc')).status).toBe(400);
    expect((await agent.get('/reading/position/0')).status).toBe(400);
  });

  it('a position degraded by a book re-load (chapter deleted, no page fallback) reads as null', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
    });
    await agent
      .put(`/reading/position/${uploadId}`)
      .send({ chapter_id: chapterId, passage_number: 3 })
      .expect(200);

    // A re-load purges + replaces chapters; the 051 chapter FK SET-NULLs the
    // pointer and the row degrades to pointing nowhere.
    await pg.pool.query('DELETE FROM reading_chapters WHERE id = $1', [chapterId]);

    const res = await agent.get(`/reading/position/${uploadId}`);
    expect(res.status).toBe(200);
    expect(res.body.position).toBeNull();
  });
});

describe('PUT /reading/position/:uploadId — resume position upsert (F-069)', () => {
  it('saves a chapter+passage position, then GET returns it', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 3,
    });

    const put = await agent
      .put(`/reading/position/${uploadId}`)
      .send({ chapter_id: chapterId, passage_number: 12, page_number: 41 });
    expect(put.status).toBe(200);
    expect(put.body.position).toMatchObject({
      source_upload_id: uploadId,
      chapter_id: chapterId,
      passage_number: 12,
      page_number: 41,
    });

    const get = await agent.get(`/reading/position/${uploadId}`);
    expect(get.status).toBe(200);
    expect(get.body.position).toMatchObject({
      source_upload_id: uploadId,
      chapter_id: chapterId,
      passage_number: 12,
      page_number: 41,
    });
  });

  it('a page-only position (raw scan viewer — no chapter) is valid', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const res = await agent
      .put(`/reading/position/${uploadId}`)
      .send({ page_number: 5 });
    expect(res.status).toBe(200);
    expect(res.body.position).toMatchObject({
      chapter_id: null,
      passage_number: null,
      page_number: 5,
    });
  });

  it('upsert overwrites: the second PUT fully replaces the first (one row per book)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
    });

    const first = await agent
      .put(`/reading/position/${uploadId}`)
      .send({ chapter_id: chapterId, passage_number: 2 });
    expect(first.status).toBe(200);
    const firstUpdatedAt = new Date(first.body.position.updated_at).getTime();

    // Full-replace PUT: the chapter fields the second body omits must CLEAR,
    // not linger from the first write.
    const second = await agent
      .put(`/reading/position/${uploadId}`)
      .send({ page_number: 99 });
    expect(second.status).toBe(200);
    expect(second.body.position).toMatchObject({
      chapter_id: null,
      passage_number: null,
      page_number: 99,
    });
    expect(new Date(second.body.position.updated_at).getTime()).toBeGreaterThan(
      firstUpdatedAt,
    );

    const get = await agent.get(`/reading/position/${uploadId}`);
    expect(get.body.position).toMatchObject({
      chapter_id: null,
      passage_number: null,
      page_number: 99,
    });

    // Upsert, not append: exactly one row per (user, upload).
    const { rows } = await pg.pool.query(
      'SELECT count(*)::int AS n FROM reading_positions WHERE source_upload_id = $1',
      [uploadId],
    );
    expect(rows[0].n).toBe(1);

    // Optimistic-concurrency convention (ADR-001 §D6): the UPDATE arm of the
    // upsert must bump `version` — first write leaves the DEFAULT 1, the
    // overwrite advances it to 2 (the 001 trigger only touches updated_at).
    const versionRow = await pg.pool.query<{ version: number }>(
      'SELECT version FROM reading_positions WHERE source_upload_id = $1',
      [uploadId],
    );
    expect(versionRow.rows[0]!.version).toBe(2);
  });

  it('positions are per-book: writing book B leaves book A untouched', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const bookA = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const bookB = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    await agent.put(`/reading/position/${bookA}`).send({ page_number: 10 }).expect(200);
    await agent.put(`/reading/position/${bookB}`).send({ page_number: 20 }).expect(200);

    const a = await agent.get(`/reading/position/${bookA}`);
    const b = await agent.get(`/reading/position/${bookB}`);
    expect(a.body.position.page_number).toBe(10);
    expect(b.body.position.page_number).toBe(20);
  });

  it("another user's upload → 404 and NO row is written (IDOR write path)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const ownerUpload = await seedBookUpload(pg.pool, owner.userId, {
      type: 'literature',
      status: 'ready',
    });

    const other = await registerUser(t.app, pg.pool);
    const res = await other.agent
      .put(`/reading/position/${ownerUpload}`)
      .send({ page_number: 1 });
    expect(res.status).toBe(404);

    const { rows } = await pg.pool.query(
      'SELECT count(*)::int AS n FROM reading_positions',
    );
    expect(rows[0].n).toBe(0);
  });

  it("a chapter belonging to ANOTHER user's book → 404 (no cross-user chapter pinning)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const ownerUpload = await seedBookUpload(pg.pool, owner.userId, {
      type: 'literature',
      status: 'ready',
    });
    const ownerChapter = await seedReadingChapter(
      pg.pool,
      owner.userId,
      ownerUpload,
      { chapterNumber: 1 },
    );

    const other = await registerUser(t.app, pg.pool);
    const otherUpload = await seedBookUpload(pg.pool, other.userId, {
      type: 'literature',
      status: 'ready',
    });
    const res = await other.agent
      .put(`/reading/position/${otherUpload}`)
      .send({ chapter_id: ownerChapter, passage_number: 1 });
    expect(res.status).toBe(404);
  });

  it("a chapter from a DIFFERENT book of the same user → 404 (chapter must belong to :uploadId)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const bookA = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const bookB = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterOfA = await seedReadingChapter(pg.pool, userId, bookA, {
      chapterNumber: 1,
    });
    const res = await agent
      .put(`/reading/position/${bookB}`)
      .send({ chapter_id: chapterOfA });
    expect(res.status).toBe(404);
  });

  it('a non-existent chapter id → 404', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const res = await agent
      .put(`/reading/position/${uploadId}`)
      .send({ chapter_id: 99999999 });
    expect(res.status).toBe(404);
  });

  it('invalid bodies → 400 (empty, passage without chapter, bad ints, unknown keys)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const put = (body: unknown) =>
      agent.put(`/reading/position/${uploadId}`).send(body as object);

    // A position must point somewhere.
    expect((await put({})).status).toBe(400);
    expect((await put({ chapter_id: null, page_number: null })).status).toBe(400);
    // passage_number requires chapter_id.
    expect((await put({ passage_number: 3 })).status).toBe(400);
    expect((await put({ page_number: 1, passage_number: 3 })).status).toBe(400);
    // Integer bounds.
    expect((await put({ page_number: 0 })).status).toBe(400);
    expect((await put({ page_number: -4 })).status).toBe(400);
    expect((await put({ page_number: 1.5 })).status).toBe(400);
    expect((await put({ page_number: 2147483648 })).status).toBe(400); // > int4
    expect((await put({ chapter_id: 'abc' })).status).toBe(400);
    // Unknown keys fail loud (a typo must not silently clear the real field).
    expect((await put({ page_number: 1, chapterId: 5 })).status).toBe(400);
  });

  it('garbage upload id in the path → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect(
      (await agent.put('/reading/position/abc').send({ page_number: 1 })).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /reading/translate (F-116)
// ---------------------------------------------------------------------------

describe('POST /reading/translate — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app)
      .post('/reading/translate')
      .send({ passage: '소년은 걸었다.' });
    expect(res.status).toBe(401);
  });
});

describe('POST /reading/translate — success', () => {
  it('200 with the translation from the stub, nothing persisted', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/reading/translate')
      .send({ passage: '소년은 걸었다.' });
    expect(res.status).toBe(200);
    expect(typeof res.body.translation).toBe('string');
    expect(res.body.translation).toContain('소년은 걸었다.');
    // Stateless: this route has no backing table — the response is the
    // whole contract. (Nothing to query for "no row written" here, unlike
    // /generate's generated_stories persistence.)
    expect(res.body).not.toHaveProperty('id');
  });

  it('accepts a passage at exactly the 6000-char boundary', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const passage = '가'.repeat(6000);
    const res = await agent.post('/reading/translate').send({ passage });
    expect(res.status).toBe(200);
    expect(typeof res.body.translation).toBe('string');
  });
});

describe('POST /reading/translate — validation rejection', () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'missing passage', body: {} },
    { name: 'empty passage', body: { passage: '' } },
    { name: 'whitespace-only passage (trims to empty)', body: { passage: '   ' } },
    { name: 'oversized passage (>6000)', body: { passage: '가'.repeat(6001) } },
    { name: 'non-string passage', body: { passage: 12345 } },
    // Unknown keys fail loud (`.strict()`) — a typo'd `model` probe must not
    // silently no-op.
    { name: 'unknown key (model probe)', body: { passage: '소년은 걸었다.', model: 'opus' } },
  ];
  for (const c of cases) {
    it(`${c.name} → 400`, async () => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.post('/reading/translate').send(c.body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  }
});

describe('POST /reading/translate — downstream error', () => {
  it('B4 5xx httpStatus error → flattened to a blanket 502 (mapClaudeError never forwards a 5xx upstream detail)', async () => {
    const broken = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        translatePassage: async () => {
          const e = new Error('upstream timeout') as Error & {
            httpStatus: number;
            code: string;
          };
          e.httpStatus = 504;
          e.code = 'b4_timeout';
          throw e;
        },
      },
    });
    try {
      const { agent } = await registerUser(broken.app, pg.pool);
      const res = await agent
        .post('/reading/translate')
        .send({ passage: '소년은 걸었다.' });
      // mapClaudeError (shared by writing.ts/reading.ts) flattens EVERY 5xx-
      // class proxy error to a blanket 502 — the upstream's real 504 is never
      // forwarded (middleware/errors.ts's mapClaudeError doc, SECURITY.md
      // §13.7).
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('upstream_error');
    } finally {
      await teardownTestApp(broken);
    }
  });

  it('a proxy-side prompt-injection rejection → mapped to a 400 (client-fault, not an outage)', async () => {
    // mapClaudeError passes 4xx-class proxy errors through as their real
    // status (a PromptInjectionRejectedError is the CALLER's fault, not an
    // upstream outage) — see middleware/errors.ts's mapClaudeError doc.
    const broken = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        translatePassage: async () => {
          const e = new Error('user input contains injection marker') as Error & {
            httpStatus: number;
            code: string;
          };
          e.httpStatus = 400;
          e.code = 'prompt_injection_rejected';
          throw e;
        },
      },
    });
    try {
      const { agent } = await registerUser(broken.app, pg.pool);
      const res = await agent
        .post('/reading/translate')
        .send({ passage: '소년은 걸었다.' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('upstream_error');
    } finally {
      await teardownTestApp(broken);
    }
  });
});

describe('POST /reading/translate — rate limit', () => {
  it('expensive-bucket exceeded → 429 with retry_after in the body AND a matching Retry-After header', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let status429 = 0;
    let body429: unknown = null;
    let headers429: Record<string, string | undefined> = {};
    for (let i = 0; i < 40; i++) {
      const res = await agent
        .post('/reading/translate')
        .send({ passage: `소년은 걸었다 ${String(i)}.` });
      if (res.status === 429) {
        status429 = res.status;
        body429 = res.body;
        headers429 = res.headers as Record<string, string | undefined>;
        break;
      }
    }
    expect(status429).toBe(429);
    const err = (body429 as { error?: { code?: string; retry_after?: unknown } }).error;
    expect(err?.code).toBe('rate_limited');
    expect(typeof err?.retry_after).toBe('number');
    const retryAfter = err?.retry_after as number;
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(headers429['retry-after']).toBe(String(retryAfter));
  });
});

// ---------------------------------------------------------------------------
// POST/GET /reading/attempts (F-172 — reading_attempts, migration 060)
// ---------------------------------------------------------------------------

describe('reading attempts — auth required', () => {
  it('POST /reading/attempts unauthenticated → 401', async () => {
    const res = await request(t.app)
      .post('/reading/attempts')
      .send({ sourceKind: 'story', storyId: 1 });
    expect(res.status).toBe(401);
  });

  it('GET /reading/attempts unauthenticated → 401', async () => {
    const res = await request(t.app).get('/reading/attempts');
    expect(res.status).toBe(401);
  });
});

describe('POST /reading/attempts — chapter completion', () => {
  it('logs a chapter attempt using the chapter title as the snapshot', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 2,
      title: '두 번째 장',
    });

    const res = await agent
      .post('/reading/attempts')
      .send({ sourceKind: 'chapter', chapterId, passageNumber: 4 });
    expect(res.status).toBe(201);
    expect(res.body.attempt).toMatchObject({
      sourceKind: 'chapter',
      chapterId,
      storyId: null,
      titleSnapshot: '두 번째 장',
      passageNumber: 4,
    });
    expect(typeof res.body.attempt.id).toBe('number');
    expect(typeof res.body.attempt.completedAt).toBe('string');

    const { rows } = await pg.pool.query(
      'SELECT count(*)::int AS n FROM reading_attempts WHERE user_id = $1',
      [userId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('falls back to "Chapter N" when the chapter has no title', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 5,
      title: null,
    });

    const res = await agent.post('/reading/attempts').send({ sourceKind: 'chapter', chapterId });
    expect(res.status).toBe(201);
    expect(res.body.attempt.titleSnapshot).toBe('Chapter 5');
    expect(res.body.attempt.passageNumber).toBeNull();
  });

  it('a non-existent chapter id → 404, no row written', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/reading/attempts')
      .send({ sourceKind: 'chapter', chapterId: 99999999 });
    expect(res.status).toBe(404);
    const { rows } = await pg.pool.query('SELECT count(*)::int AS n FROM reading_attempts');
    expect(rows[0].n).toBe(0);
  });

  it("another user's chapter → 404 (IDOR: cannot log against a chapter you don't own)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const ownerUpload = await seedBookUpload(pg.pool, owner.userId, {
      type: 'literature',
      status: 'ready',
    });
    const ownerChapter = await seedReadingChapter(pg.pool, owner.userId, ownerUpload, {
      chapterNumber: 1,
    });

    const other = await registerUser(t.app, pg.pool);
    const res = await other.agent
      .post('/reading/attempts')
      .send({ sourceKind: 'chapter', chapterId: ownerChapter });
    expect(res.status).toBe(404);
    const { rows } = await pg.pool.query('SELECT count(*)::int AS n FROM reading_attempts');
    expect(rows[0].n).toBe(0);
  });
});

describe('POST /reading/attempts — story completion', () => {
  it('logs a story attempt using the story title as the snapshot', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const storyId = await seedGeneratedStory(pg.pool, userId, { title: '바닷가 마을' });

    const res = await agent.post('/reading/attempts').send({ sourceKind: 'story', storyId });
    expect(res.status).toBe(201);
    expect(res.body.attempt).toMatchObject({
      sourceKind: 'story',
      chapterId: null,
      storyId,
      titleSnapshot: '바닷가 마을',
      passageNumber: null,
    });
  });

  it('a non-existent story id → 404, no row written', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/reading/attempts')
      .send({ sourceKind: 'story', storyId: 99999999 });
    expect(res.status).toBe(404);
    const { rows } = await pg.pool.query('SELECT count(*)::int AS n FROM reading_attempts');
    expect(rows[0].n).toBe(0);
  });

  it("another user's story → 404 (IDOR)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const ownerStory = await seedGeneratedStory(pg.pool, owner.userId);

    const other = await registerUser(t.app, pg.pool);
    const res = await other.agent
      .post('/reading/attempts')
      .send({ sourceKind: 'story', storyId: ownerStory });
    expect(res.status).toBe(404);
  });
});

describe('POST /reading/attempts — validation rejection', () => {
  it.each([
    { name: 'missing sourceKind', body: { chapterId: 1 } },
    { name: 'unknown sourceKind', body: { sourceKind: 'bogus', chapterId: 1 } },
    { name: 'chapter without chapterId', body: { sourceKind: 'chapter' } },
    { name: 'story without storyId', body: { sourceKind: 'story' } },
    {
      name: 'unknown key on the chapter arm (storyId probe)',
      body: { sourceKind: 'chapter', chapterId: 1, storyId: 2 },
    },
    { name: 'non-integer chapterId', body: { sourceKind: 'chapter', chapterId: 1.5 } },
    { name: 'zero chapterId', body: { sourceKind: 'chapter', chapterId: 0 } },
    {
      name: 'non-positive passageNumber',
      body: { sourceKind: 'chapter', chapterId: 1, passageNumber: 0 },
    },
  ])('$name → 400', async ({ body }) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/reading/attempts').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('GET /reading/attempts — the caller\'s reading-completion history (F-172)', () => {
  it('no attempts → 200 with an empty array (not an error)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/attempts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attempts: [], total: 0, limit: 20, offset: 0 });
  });

  it('returns both chapter- and story-sourced attempts, newest first, with the total', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'literature',
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
      title: '1장',
    });
    const storyId = await seedGeneratedStory(pg.pool, userId, { title: '이야기' });

    await agent.post('/reading/attempts').send({ sourceKind: 'chapter', chapterId }).expect(201);
    await agent.post('/reading/attempts').send({ sourceKind: 'story', storyId }).expect(201);

    const res = await agent.get('/reading/attempts');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.attempts).toHaveLength(2);
    // Newest first: the story attempt (second POST) leads.
    expect(res.body.attempts[0]).toMatchObject({ sourceKind: 'story', titleSnapshot: '이야기' });
    expect(res.body.attempts[1]).toMatchObject({ sourceKind: 'chapter', titleSnapshot: '1장' });
  });

  it("is user-scoped (no IDOR) — another user's attempts never appear", async () => {
    const a = await registerUser(t.app, pg.pool);
    const aStory = await seedGeneratedStory(pg.pool, a.userId, { title: 'A의 이야기' });
    await a.agent.post('/reading/attempts').send({ sourceKind: 'story', storyId: aStory }).expect(201);

    const b = await registerUser(t.app, pg.pool);
    const bStory = await seedGeneratedStory(pg.pool, b.userId, { title: 'B의 이야기' });
    await b.agent.post('/reading/attempts').send({ sourceKind: 'story', storyId: bStory }).expect(201);

    const resA = await a.agent.get('/reading/attempts');
    expect(resA.body.attempts).toHaveLength(1);
    expect(resA.body.attempts[0].titleSnapshot).toBe('A의 이야기');

    const resB = await b.agent.get('/reading/attempts');
    expect(resB.body.attempts).toHaveLength(1);
    expect(resB.body.attempts[0].titleSnapshot).toBe('B의 이야기');
  });

  it('paginates via limit/offset, total reflects the full count', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    for (let i = 0; i < 3; i++) {
      const storyId = await seedGeneratedStory(pg.pool, userId, { title: `이야기 ${String(i)}` });
      // eslint-disable-next-line no-await-in-loop
      await agent.post('/reading/attempts').send({ sourceKind: 'story', storyId }).expect(201);
    }
    const page1 = await agent.get('/reading/attempts?limit=2&offset=0');
    expect(page1.body.attempts).toHaveLength(2);
    expect(page1.body.total).toBe(3);

    const page2 = await agent.get('/reading/attempts?limit=2&offset=2');
    expect(page2.body.attempts).toHaveLength(1);
    expect(page2.body.total).toBe(3);
  });
});
