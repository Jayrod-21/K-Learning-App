/**
 * Per-route tests for src/routes/reading.ts (B-FU-2).
 *
 * Routes:
 *   GET /reading/units
 *   GET /reading/units/:corpus/:unitId/sentences
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedTtmikLesson, seedIyagiEpisode } from '../helpers/seed.js';
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
    'TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE',
  );
  // Reset the corpus tables too: several tests seed fixed source_ids
  // (e.g. ttmik-L1-1) and the per-file container is shared across tests, so
  // without this a re-seed collides on uq_ttmik_lessons_corpus_source_id.
  // (Mirrors the isolation in plan.test.ts.)
  await pg.pool.query('TRUNCATE TABLE ttmik_lessons, iyagi_episodes CASCADE');
  resetLimiters();
});

describe('reading — auth required', () => {
  it.each([
    ['GET', '/reading/units?corpus=ttmik'],
    ['GET', '/reading/units/ttmik/1/sentences'],
  ])('%s %s unauthenticated → 401', async (_method, path) => {
    const res = await request(t.app).get(path);
    expect(res.status).toBe(401);
  });
});

describe('GET /reading/units — success + validation', () => {
  it('lists ttmik lessons with corpus tag + total', async () => {
    await seedTtmikLesson(pg.pool, { level: 1, number: 1 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units?corpus=ttmik');
    expect(res.status).toBe(200);
    expect(res.body.corpus).toBe('ttmik');
    expect(Array.isArray(res.body.units)).toBe(true);
    expect(res.body.units.length).toBeGreaterThan(0);
    // `total` is the full corpus size (a number, not a stringified BIGINT)
    // and rides the envelope, not each unit row.
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.units.length);
    expect(res.body.units[0]).not.toHaveProperty('total');
  });

  it('lists iyagi episodes with corpus tag + total', async () => {
    await seedIyagiEpisode(pg.pool, { number: 1 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units?corpus=iyagi');
    expect(res.status).toBe(200);
    expect(res.body.corpus).toBe('iyagi');
    expect(res.body.units.length).toBeGreaterThan(0);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.units[0]).not.toHaveProperty('total');
  });

  it('reports the full corpus total across pages with limit=1', async () => {
    // Seed two lessons, then ask for one. The page carries one unit but the
    // total reflects both — that is what the picker pager needs.
    await seedTtmikLesson(pg.pool, { level: 9, number: 1 });
    await seedTtmikLesson(pg.pool, { level: 9, number: 2 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units?corpus=ttmik&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.units.length).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });

  it('returns total 0 on an empty page past the end', async () => {
    await seedTtmikLesson(pg.pool, { level: 1, number: 1 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units?corpus=ttmik&offset=100000');
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(0);
    // Empty page → COUNT(*) OVER () yields no rows → total falls back to 0.
    expect(res.body.total).toBe(0);
  });

  it('missing corpus → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units');
    expect(res.status).toBe(400);
  });

  it('bad corpus enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units?corpus=elsewhere');
    expect(res.status).toBe(400);
  });

  it('limit > 100 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units?corpus=ttmik&limit=500');
    expect(res.status).toBe(400);
  });
});

describe('GET /reading/units/:corpus/:unitId/sentences', () => {
  it('returns sentences for a ttmik lesson', async () => {
    const lessonId = await seedTtmikLesson(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/reading/units/ttmik/${lessonId}/sentences`);
    expect(res.status).toBe(200);
    expect(res.body.corpus).toBe('ttmik');
    expect(res.body.sentences.length).toBe(2);
  });

  it('returns sentences for an iyagi episode', async () => {
    const episodeId = await seedIyagiEpisode(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/reading/units/iyagi/${episodeId}/sentences`);
    expect(res.status).toBe(200);
    expect(res.body.corpus).toBe('iyagi');
    expect(res.body.sentences.length).toBe(2);
    // Iyagi is the client's DEFAULT prose corpus (B-001) — each row must
    // carry the dialog fields the Read tab renders alongside the text.
    const row = res.body.sentences[0];
    expect(typeof row.korean).toBe('string');
    expect(row).toHaveProperty('speaker');
    expect(row).toHaveProperty('is_dialog');
    expect(row).toHaveProperty('english');
  });

  it('unknown ttmik unit → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units/ttmik/9999999/sentences');
    expect(res.status).toBe(404);
  });

  it('unknown iyagi unit → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units/iyagi/9999999/sentences');
    expect(res.status).toBe(404);
  });

  it('non-numeric unitId → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units/ttmik/abc/sentences');
    expect(res.status).toBe(400);
  });

  it('bad corpus enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/units/elsewhere/1/sentences');
    expect(res.status).toBe(400);
  });
});

describe('reading — rate limit', () => {
  it('cheap-bucket exceeded → 429', async () => {
    await seedTtmikLesson(pg.pool, { level: 1, number: 2 });
    const { agent } = await registerUser(t.app, pg.pool);
    let got429 = false;
    for (let i = 0; i < 200; i++) {
      const r = await agent.get('/reading/units?corpus=ttmik');
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});

describe('reading — DB error', () => {
  it('GET /reading/units with ttmik_lessons missing → 500 no leak', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await pg.pool.query('ALTER TABLE ttmik_lessons RENAME TO ttmik_lessons_hidden');
    try {
      const res = await agent.get('/reading/units?corpus=ttmik');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('ttmik_lessons_hidden');
    } finally {
      await pg.pool.query('ALTER TABLE ttmik_lessons_hidden RENAME TO ttmik_lessons');
    }
  });
});
