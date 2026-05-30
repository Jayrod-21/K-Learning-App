/**
 * Per-route tests for src/routes/progress.ts (B-FU-2).
 *
 * Routes:
 *   GET  /progress                 — latest value per metric
 *   PUT  /progress/:metricType     — append snapshot
 *   POST /progress/study-log       — daily upsert with array append
 *
 * Defense-in-depth: any body with a non-self `user_id` must 403.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
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
    'TRUNCATE TABLE study_log, user_progress, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('GET /progress — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/progress');
    expect(res.status).toBe(401);
  });
});

describe('GET /progress — success', () => {
  it('returns 200 with empty metrics for a fresh user', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/progress');
    expect(res.status).toBe(200);
    expect(res.body.metrics).toEqual([]);
  });

  it('returns the latest snapshot per metric_type', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // Two snapshots of the same metric — newest wins.
    await agent.put('/progress/words_known').send({ value: 100 });
    await agent.put('/progress/words_known').send({ value: 250 });
    await agent.put('/progress/streak_days').send({ value: 7 });
    const res = await agent.get('/progress');
    expect(res.status).toBe(200);
    const byType = Object.fromEntries(
      (res.body.metrics as Array<{ metric_type: string; value: unknown }>).map((m) => [
        m.metric_type,
        m.value,
      ]),
    );
    expect(byType['words_known']).toBe(250);
    expect(byType['streak_days']).toBe(7);
  });
});

describe('PUT /progress/:metricType — success + validation', () => {
  const PutResponseSchema = z.object({
    id: z.union([z.number(), z.string()]),
    captured_at: z.string(),
  });

  it('valid scalar value → 201', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/progress/words_known').send({ value: 42 });
    expect(res.status).toBe(201);
    expect(PutResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('valid object value → 201', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/progress/levels')
      .send({ value: { L3: 12, L4: 5 } });
    expect(res.status).toBe(201);
  });

  it('invalid metricType (capitalized) → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/progress/WordsKnown').send({ value: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('missing value → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/progress/words_known').send({});
    expect(res.status).toBe(400);
  });

  it('value as boolean (not allowed) → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/progress/words_known').send({ value: true });
    expect(res.status).toBe(400);
  });
});

describe('POST /progress/study-log — success + validation', () => {
  it('first log of the day → 201, upsert combines a second log', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const a = await agent
      .post('/progress/study-log')
      .send({ minutes: 20, activity: 'reading', date: '2026-01-15' });
    expect(a.status).toBe(201);
    expect(Number(a.body.minutes_studied)).toBe(20);
    const b = await agent
      .post('/progress/study-log')
      .send({ minutes: 30, activity: 'listening', date: '2026-01-15' });
    expect(b.status).toBe(201);
    // Append-and-sum semantics.
    expect(Number(b.body.minutes_studied)).toBe(50);
  });

  it('invalid date format → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/progress/study-log')
      .send({ minutes: 20, activity: 'reading', date: '01/15/2026' });
    expect(res.status).toBe(400);
  });

  it('minutes negative → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/progress/study-log')
      .send({ minutes: -1, activity: 'reading' });
    expect(res.status).toBe(400);
  });

  it('minutes > 24h → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/progress/study-log')
      .send({ minutes: 24 * 60 + 1, activity: 'reading' });
    expect(res.status).toBe(400);
  });
});

describe('progress — IDOR defense', () => {
  it('study-log with another user_id in body → 403', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/progress/study-log').send({
      minutes: 20,
      activity: 'reading',
      user_id: 999_999, // not the agent's user
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('progress — rate limit', () => {
  it('GET /progress cheap-bucket exceeded → 429', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let got429 = false;
    for (let i = 0; i < 200; i++) {
      const res = await agent.get('/progress');
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});

describe('progress — DB error', () => {
  it('GET /progress with user_progress table missing → 500 (no leak)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await pg.pool.query('ALTER TABLE user_progress RENAME TO user_progress_hidden');
    try {
      const res = await agent.get('/progress');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('internal_error');
      expect(JSON.stringify(res.body)).not.toMatch(/user_progress_hidden/);
    } finally {
      await pg.pool.query('ALTER TABLE user_progress_hidden RENAME TO user_progress');
    }
  });
});
