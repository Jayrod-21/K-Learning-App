/**
 * Per-route tests for src/routes/define.ts (B-FU-2).
 *
 * Covers: success (with KRDICT row seeded), validation rejection, 503 when
 * KRDICT not installed (graceful), 404 when word missing, auth-required,
 * rate-limit, DB error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedKrdictEntry } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { resetKrdictReadyCache } from '../../src/routes/define.js';

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
  resetLimiters();
  // Reset KRDICT availability cache so the rollback-cache-invalidation
  // test (FU-NF-5) doesn't carry state between tests.
  resetKrdictReadyCache();
});

const DefineResponseSchema = z.object({
  word: z.string(),
  entries: z.array(
    z.object({
      id: z.number().int().positive(),
      headword: z.string(),
      part_of_speech: z.string().nullable(),
    }),
  ),
});

describe('GET /define — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/define?word=먹다');
    expect(res.status).toBe(401);
  });
});

describe('GET /define — success', () => {
  it('returns 200 with matching krdict entries', async () => {
    await seedKrdictEntry(pg.pool, { headword: '먹다', definitionEn: 'to eat' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/define?word=먹다');
    expect(res.status).toBe(200);
    const parsed = DefineResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.word).toBe('먹다');
    expect(res.body.entries.length).toBeGreaterThan(0);
  });
});

describe('GET /define — validation rejection', () => {
  it('missing word → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/define');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('oversized word → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/define?word=${'x'.repeat(100)}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /define — not found', () => {
  it('no entries for word → 404 (deterministic, with KRDICT installed)', async () => {
    // Seed at least one row so krdictAvailable() = true.
    await seedKrdictEntry(pg.pool, { headword: '존재함' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/define?word=없는단어');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    // Constant message — no echo of input.
    expect(res.body.error.message).not.toContain('없는단어');
  });
});

describe('GET /define — DB error', () => {
  it('returns 500 with no SQL leakage when krdict_entries is missing', async () => {
    await seedKrdictEntry(pg.pool, { headword: '먹다' });
    const { agent } = await registerUser(t.app, pg.pool);
    // Prime the availability cache to TRUE, then drop the table behind the cache.
    // The route will still attempt the SELECT and 500.
    await agent.get('/define?word=먹다'); // primes cache to ready=true
    await pg.pool.query('ALTER TABLE krdict_entries RENAME TO krdict_entries_hidden');
    try {
      const res = await agent.get('/define?word=먹다');
      // Either 500 (if cache says ready) or 503 (if cache TTL re-checked). Both
      // are acceptable — the contract is that NO stack trace leaks.
      expect([500, 503]).toContain(res.status);
      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toMatch(/krdict_entries_hidden/);
      expect(bodyText).not.toMatch(/at Object\./i);
    } finally {
      await pg.pool.query('ALTER TABLE krdict_entries_hidden RENAME TO krdict_entries');
    }
  });

  it('invalidates availability cache on 42P01 and degrades to 503 on next request (FU-NF-5)', async () => {
    // Cache-symmetry-on-rollback test (FU-NF-5). The first request after
    // a hidden-rollback still sees a 500 (the cache was primed before the
    // drop and the route attempted the SELECT). The cache-invalidation
    // side effect ensures that subsequent requests within the 5-min TTL
    // window return 503 ``krdict_unavailable`` instead of more 500s.
    await seedKrdictEntry(pg.pool, { headword: '먹다' });
    const { agent } = await registerUser(t.app, pg.pool);
    // Prime cache to ready=true.
    const primed = await agent.get('/define?word=먹다');
    expect(primed.status).toBe(200);
    await pg.pool.query(
      'ALTER TABLE krdict_entries RENAME TO krdict_entries_hidden',
    );
    try {
      // FIRST request after the drop: cache says ready, route SELECTs,
      // 42P01 surfaces as 500. Side effect: cache marked not-ready.
      const first = await agent.get('/define?word=먹다');
      expect(first.status).toBe(500);
      // SECOND request: cache says not-ready, degrade to 503 (not 500).
      const second = await agent.get('/define?word=먹다');
      expect(second.status).toBe(503);
      expect(second.body.error.code).toBe('krdict_unavailable');
    } finally {
      await pg.pool.query(
        'ALTER TABLE krdict_entries_hidden RENAME TO krdict_entries',
      );
      // `beforeEach` clears the cache before the next test runs.
    }
  });
});

describe('GET /define — rate limit', () => {
  it('cheap-bucket exceeded → 429', async () => {
    await seedKrdictEntry(pg.pool, { headword: '먹다' });
    const { agent } = await registerUser(t.app, pg.pool);
    let got429 = false;
    // RATE_LIMIT_CHEAP_MAX defaults to 120 in test env — issue ~200.
    for (let i = 0; i < 200; i++) {
      const res = await agent.get('/define?word=먹다');
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});
