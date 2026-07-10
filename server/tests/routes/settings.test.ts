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

const DEFAULT_LANGUAGE_DISPLAY = { mode: 'both', primary: 'ko', subScale: 0.7 };

const DEFAULT_PREFS = {
  notif: { channel: { email: true, sms: false }, reviewsDue: true, daily: false, weekly: true },
  palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
  languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
  textSize: 'md',
};

const CUSTOM_PREFS = {
  notif: { channel: { email: false, sms: true }, reviewsDue: false, daily: true, weekly: false },
  palette: { paper: 'sumi', accent: 'mint', correct: 'pine', wrong: 'amber' },
  languageDisplay: { mode: 'en', primary: 'en', subScale: 0.5 },
  textSize: 'lg',
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

describe('accent (Seoul-neon cross-device sync)', () => {
  it("GET coerces a stored LEGACY accent ('ochre') to 'coral' WITHOUT wiping the rest of the blob", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A pre-redesign stored blob: legacy accent id, everything else custom.
    const legacyBlob = {
      ...CUSTOM_PREFS,
      palette: { ...CUSTOM_PREFS.palette, accent: 'ochre' },
    };
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify(legacyBlob),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // The legacy accent coerces to the default; the user's OTHER stored
    // choices survive (this must NOT be the DEFAULT_PREFS fallback).
    expect(res.body).toEqual({
      ...CUSTOM_PREFS,
      palette: { ...CUSTOM_PREFS.palette, accent: 'coral' },
    });
  });

  it("PUT round-trips a valid new accent ('mint') via echo + GET", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS, palette: { ...DEFAULT_PREFS.palette, accent: 'mint' } };
    const put = await agent.put('/settings/prefs').send(body);
    expect(put.status).toBe(200);
    expect(put.body.palette.accent).toBe('mint');
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual(body);
  });

  it("PUT from a stale client carrying a LEGACY accent ('indigo') is accepted, coerced to 'coral' (not a 400)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...CUSTOM_PREFS, palette: { ...CUSTOM_PREFS.palette, accent: 'indigo' } };
    const res = await agent.put('/settings/prefs').send(body);
    expect(res.status).toBe(200);
    expect(res.body.palette.accent).toBe('coral');
    // The coerced value is what persisted — the next GET serves a valid id.
    const get = await agent.get('/settings/prefs');
    expect(get.body.palette.accent).toBe('coral');
    // ...and the rest of the PUT body persisted untouched.
    expect(get.body.notif).toEqual(CUSTOM_PREFS.notif);
    expect(get.body.palette.paper).toBe('sumi');
  });

  it("a totally unknown accent value also coerces to 'coral' (catch posture, never 400/500)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS, palette: { ...DEFAULT_PREFS.palette, accent: 'neon-zebra' } };
    const res = await agent.put('/settings/prefs').send(body);
    expect(res.status).toBe(200);
    expect(res.body.palette.accent).toBe('coral');
  });
});

describe('languageDisplay (Overhaul P3a)', () => {
  it('GET fills the default languageDisplay into a pre-P3a stored blob WITHOUT clobbering the stored palette', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A blob written before the field existed — notif + palette only.
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ notif: CUSTOM_PREFS.notif, palette: CUSTOM_PREFS.palette }),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // The user's stored choices survive; only the missing fields default
    // (textSize catches to 'md' the same way — F-025).
    expect(res.body).toEqual({
      notif: CUSTOM_PREFS.notif,
      palette: CUSTOM_PREFS.palette,
      languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
      textSize: 'md',
    });
  });

  it('PUT round-trips a custom languageDisplay (echo + GET)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const custom = { ...DEFAULT_PREFS, languageDisplay: { mode: 'ko', primary: 'ko', subScale: 0.4 } };
    const put = await agent.put('/settings/prefs').send(custom);
    expect(put.status).toBe(200);
    expect(put.body).toEqual(custom);
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual(custom);
  });

  it('PUT from a pre-P3a client (no languageDisplay) is accepted and stores the defaults', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const legacyBody = { notif: CUSTOM_PREFS.notif, palette: CUSTOM_PREFS.palette };
    const res = await agent.put('/settings/prefs').send(legacyBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...legacyBody,
      languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
      textSize: 'md',
    });
    const get = await agent.get('/settings/prefs');
    expect(get.body.languageDisplay).toEqual(DEFAULT_LANGUAGE_DISPLAY);
  });

  it('PUT applies inner-field defaults to a partial languageDisplay', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS, languageDisplay: { mode: 'en' } });
    expect(res.status).toBe(200);
    expect(res.body.languageDisplay).toEqual({ mode: 'en', primary: 'ko', subScale: 0.7 });
  });

  it('rejects a bad mode enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS, languageDisplay: { ...DEFAULT_LANGUAGE_DISPLAY, mode: 'fr' } });
    expect(res.status).toBe(400);
  });

  it.each([[1.5], [0.2], [-1]])('rejects out-of-range subScale %s → 400', async (subScale) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS, languageDisplay: { ...DEFAULT_LANGUAGE_DISPLAY, subScale } });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown key inside languageDisplay (strict) → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS, languageDisplay: { ...DEFAULT_LANGUAGE_DISPLAY, extra: true } });
    expect(res.status).toBe(400);
  });
});

describe('textSize (F-025 app-wide text size)', () => {
  it("GET coerces a stored bad textSize to 'md' WITHOUT wiping the rest of the blob", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const poisoned = { ...CUSTOM_PREFS, textSize: 'gigantic' };
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify(poisoned),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // The bad size coerces to the default; the user's OTHER stored choices
    // survive (this must NOT be the DEFAULT_PREFS fallback).
    expect(res.body).toEqual({ ...CUSTOM_PREFS, textSize: 'md' });
  });

  it("PUT round-trips a valid new textSize ('sm') via echo + GET", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS, textSize: 'sm' };
    const put = await agent.put('/settings/prefs').send(body);
    expect(put.status).toBe(200);
    expect(put.body.textSize).toBe('sm');
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual(body);
  });

  it("PUT from a pre-F-025 client (no textSize) is accepted and stores 'md' (not a 400)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = {
      notif: CUSTOM_PREFS.notif,
      palette: CUSTOM_PREFS.palette,
      languageDisplay: CUSTOM_PREFS.languageDisplay,
    };
    const res = await agent.put('/settings/prefs').send(body);
    expect(res.status).toBe(200);
    expect(res.body.textSize).toBe('md');
    // ...and the rest of the PUT body persisted untouched.
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual({ ...body, textSize: 'md' });
  });

  it("a totally unknown textSize value also coerces to 'md' (catch posture, never 400/500)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS, textSize: 'xl' };
    const res = await agent.put('/settings/prefs').send(body);
    expect(res.status).toBe(200);
    expect(res.body.textSize).toBe('md');
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
