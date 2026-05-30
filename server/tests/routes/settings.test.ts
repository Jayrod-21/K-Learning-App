/**
 * Integration tests for /settings/prefs (Pass 9 — preferences server-sync).
 *
 * Routes:
 *   GET /settings/prefs
 *   PUT /settings/prefs
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in). No
 * Claude (the route is cheap + Claude-free).
 *
 * Coverage:
 *   - auth required on both routes (401 unauthenticated)
 *   - GET returns DEFAULT_PREFS when the stored blob is empty `{}` (fresh user)
 *   - PUT persists + echoes the stored object; GET then echoes the same
 *   - GET falls back to DEFAULT_PREFS on a corrupt stored blob (never 500)
 *   - PUT rejects a bad palette enum → 400
 *   - PUT rejects an unknown key (strict) → 400
 *   - IDOR is structurally impossible (no :id) — each user reads only their own
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

const DEFAULT_PREFS = {
  notif: { channel: { email: true, sms: false }, reviewsDue: true, daily: false, weekly: true },
  palette: { paper: 'hanji', accent: 'vermilion', correct: 'moss', wrong: 'vermilion' },
};

const CUSTOM_PREFS = {
  notif: { channel: { email: false, sms: true }, reviewsDue: false, daily: true, weekly: false },
  palette: { paper: 'sumi', accent: 'indigo', correct: 'pine', wrong: 'amber' },
};

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  resetLimiters();
});

describe('settings — auth required', () => {
  it.each([
    ['GET', '/settings/prefs'],
    ['PUT', '/settings/prefs'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(p)
        : await request(t.app).put(p).send(DEFAULT_PREFS);
    expect(res.status).toBe(401);
  });
});

describe('GET /settings/prefs', () => {
  it('returns DEFAULT_PREFS for a fresh user (empty blob)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_PREFS);
  });

  it('echoes a stored blob after a PUT', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/settings/prefs').send(CUSTOM_PREFS).expect(200);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CUSTOM_PREFS);
  });

  it('falls back to DEFAULT_PREFS on a corrupt stored blob (never 500)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Poison the column directly with a shape that fails PrefsSchema.
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ notif: 'not an object', palette: { paper: 'neon' } }),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_PREFS);
  });
});

describe('PUT /settings/prefs', () => {
  it('persists + echoes the stored object', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/settings/prefs').send(CUSTOM_PREFS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CUSTOM_PREFS);
    // Confirm it actually landed in the column.
    const { rows } = await pg.pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM users WHERE id = $1`,
      [userId],
    );
    expect(rows[0]!.preferences).toEqual(CUSTOM_PREFS);
  });

  it('rejects a bad palette enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bad = { ...CUSTOM_PREFS, palette: { ...CUSTOM_PREFS.palette, paper: 'neon' } };
    const res = await agent.put('/settings/prefs').send(bad);
    expect(res.status).toBe(400);
  });

  it('rejects an unknown key (strict) → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bad = { ...CUSTOM_PREFS, extra: 'nope' };
    const res = await agent.put('/settings/prefs').send(bad);
    expect(res.status).toBe(400);
  });

  it('last-writer-wins on a second PUT', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/settings/prefs').send(CUSTOM_PREFS).expect(200);
    await agent.put('/settings/prefs').send(DEFAULT_PREFS).expect(200);
    const res = await agent.get('/settings/prefs');
    expect(res.body).toEqual(DEFAULT_PREFS);
  });
});

describe('settings — per-user isolation', () => {
  it("a user's prefs never leak to another user", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await a.agent.put('/settings/prefs').send(CUSTOM_PREFS).expect(200);
    // b never wrote anything → still defaults.
    const res = await b.agent.get('/settings/prefs');
    expect(res.body).toEqual(DEFAULT_PREFS);
  });
});
