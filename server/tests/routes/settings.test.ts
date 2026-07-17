/**
 * Integration tests for /settings/prefs (Pass 9 — preferences server-sync;
 * F-093 CONTRACT — notif single-sourced from notification_schedules).
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
 *   - GET returns stored defaults + derived notif for a fresh user
 *   - PUT persists the stored slices + echoes them with the CANONICAL notif
 *   - F-093 contract: notif reads come from notification_schedules, never the
 *     blob; PUT never writes notif into the blob (no dual-write); a client-sent
 *     notif is validated but ignored; a body without notif is accepted
 *   - GET falls back to stored defaults on a corrupt stored blob (never 500),
 *     and a malformed LEGACY notif key alone cannot wipe the stored palette
 *   - PUT rejects a bad palette enum / unknown key / malformed notif → 400
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

/**
 * The derived notif for a user with NO notification_schedules rows — F-040's
 * "nothing is implicitly on" model. This is what BOTH routes report unless
 * schedule rows exist, regardless of anything a blob or a PUT body says.
 */
const NOTIF_NONE = {
  channel: { email: false, sms: false },
  reviewsDue: false,
  daily: false,
  weekly: false,
};

/** The blob-persisted defaults (palette/languageDisplay/textSize/toursSeen —
 *  no notif). */
const DEFAULT_STORED = {
  palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
  languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
  textSize: 'md',
  toursSeen: [],
};

/** What GET serves a fresh user: stored defaults + derived (empty) notif. */
const DEFAULT_VIEW = { ...DEFAULT_STORED, notif: NOTIF_NONE };

const CUSTOM_STORED = {
  palette: { paper: 'sumi', accent: 'mint', correct: 'pine', wrong: 'amber' },
  languageDisplay: { mode: 'en', primary: 'en', subScale: 0.5 },
  textSize: 'lg',
  toursSeen: ['first-run', 'hanja'],
};

/**
 * A pre-contract client's full PUT body — carries a notif slice the server
 * now validates but IGNORES (the echoed notif is derived, never this).
 */
const CUSTOM_PREFS = {
  notif: { channel: { email: false, sms: true }, reviewsDue: false, daily: true, weekly: false },
  ...CUSTOM_STORED,
};

/** The response view for CUSTOM_STORED with no schedule rows present. */
const CUSTOM_VIEW = { ...CUSTOM_STORED, notif: NOTIF_NONE };

/** Legacy full-default body a pre-contract client would send. */
const DEFAULT_PREFS_BODY = {
  notif: { channel: { email: true, sms: false }, reviewsDue: true, daily: false, weekly: true },
  ...DEFAULT_STORED,
};

interface SeedScheduleRow {
  kind: 'daily_reminder' | 'reviews_due' | 'weekly_report';
  channel: 'push' | 'email' | 'sms';
  enabled: boolean;
}

/** Insert canonical notification_schedules rows directly (parameterized). */
async function seedSchedules(userId: number, rows: SeedScheduleRow[]): Promise<void> {
  for (const r of rows) {
    await pg.pool.query(
      `INSERT INTO notification_schedules
              (user_id, kind, channel, time_of_day, tz, weekday, enabled)
       VALUES ($1, $2, $3, '08:00', 'UTC', $4, $5)`,
      [userId, r.kind, r.channel, r.kind === 'weekly_report' ? 0 : null, r.enabled],
    );
  }
}

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  // users CASCADE also clears notification_schedules (FK ON DELETE CASCADE).
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
        : await request(t.app).put(p).send(DEFAULT_PREFS_BODY);
    expect(res.status).toBe(401);
  });
});

describe('GET /settings/prefs', () => {
  it('returns stored defaults + all-off derived notif for a fresh user (empty blob, no schedules)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_VIEW);
  });

  it('echoes the stored slices after a PUT, with derived (not echoed) notif', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/settings/prefs').send(CUSTOM_PREFS).expect(200);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CUSTOM_VIEW);
  });

  it('falls back to stored defaults on a corrupt stored blob (never 500)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Poison the column directly with a shape that fails StoredPrefsSchema.
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ notif: 'not an object', palette: { paper: 'neon' } }),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_VIEW);
  });

  it('a malformed LEGACY notif key alone cannot wipe the stored palette (stripped before parse)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Pre-contract row: valid stored slices + garbage where notif used to live.
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ notif: 'garbage', ...CUSTOM_STORED }),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // The user's palette survives; notif is derived, not read from the blob.
    expect(res.body).toEqual(CUSTOM_VIEW);
  });
});

describe('F-093 — notif is single-sourced from notification_schedules', () => {
  it('GET derives notif from schedule rows (enabled email kinds → true; disabled → false)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedSchedules(userId, [
      { kind: 'daily_reminder', channel: 'email', enabled: true },
      { kind: 'reviews_due', channel: 'email', enabled: true },
      { kind: 'weekly_report', channel: 'email', enabled: false },
      { kind: 'daily_reminder', channel: 'sms', enabled: true },
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body.notif).toEqual({
      channel: { email: true, sms: true },
      daily: true,
      reviewsDue: true,
      weekly: false,
    });
  });

  it('a disabled-only email schedule derives channel.email=false', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedSchedules(userId, [{ kind: 'daily_reminder', channel: 'email', enabled: false }]);
    const res = await agent.get('/settings/prefs');
    expect(res.body.notif).toEqual(NOTIF_NONE);
  });

  it('GET ignores notif values stored in the blob — reads come from the canonical table', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A pre-contract blob claiming everything is ON — but no schedule rows.
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify({
        notif: { channel: { email: true, sms: true }, reviewsDue: true, daily: true, weekly: true },
        ...CUSTOM_STORED,
      }),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body.notif).toEqual(NOTIF_NONE);
  });

  it('PUT does NOT write notif into the blob (no dual-write remains)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await agent.put('/settings/prefs').send(CUSTOM_PREFS).expect(200);
    const { rows } = await pg.pool.query<{ preferences: Record<string, unknown> }>(
      `SELECT preferences FROM users WHERE id = $1`,
      [userId],
    );
    // The persisted blob is EXACTLY the stored slices — no notif key at all.
    expect(rows[0]!.preferences).toEqual(CUSTOM_STORED);
    expect(Object.keys(rows[0]!.preferences)).not.toContain('notif');
  });

  it('PUT ignores the client-sent notif and echoes the canonical derived value', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedSchedules(userId, [{ kind: 'weekly_report', channel: 'email', enabled: true }]);
    // The client claims daily=true / weekly=false — the schedules say otherwise.
    const res = await agent.put('/settings/prefs').send(CUSTOM_PREFS);
    expect(res.status).toBe(200);
    expect(res.body.notif).toEqual({
      channel: { email: true, sms: false },
      daily: false,
      reviewsDue: false,
      weekly: true,
    });
    // Everything else echoes what persisted.
    expect(res.body.palette).toEqual(CUSTOM_STORED.palette);
    expect(res.body.textSize).toBe(CUSTOM_STORED.textSize);
  });

  it('PUT dropping a stale blob notif also purges it: a pre-contract row loses its notif keys on the next save', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify({
        notif: { channel: { email: true, sms: false }, reviewsDue: true, daily: true, weekly: true },
        ...DEFAULT_STORED,
      }),
      userId,
    ]);
    await agent.put('/settings/prefs').send(CUSTOM_PREFS).expect(200);
    const { rows } = await pg.pool.query<{ preferences: Record<string, unknown> }>(
      `SELECT preferences FROM users WHERE id = $1`,
      [userId],
    );
    expect(rows[0]!.preferences).toEqual(CUSTOM_STORED);
  });

  it('PUT accepts a body WITHOUT notif (the forward contract shape)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/settings/prefs').send(CUSTOM_STORED);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CUSTOM_VIEW);
  });

  it('PUT still rejects a MALFORMED notif → 400 (strict posture retained)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bad = { ...CUSTOM_PREFS, notif: { channel: { email: 'yes', sms: false } } };
    const res = await agent.put('/settings/prefs').send(bad);
    expect(res.status).toBe(400);
  });
});

describe('PUT /settings/prefs', () => {
  it('persists + echoes the stored slices (with derived notif)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/settings/prefs').send(CUSTOM_PREFS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CUSTOM_VIEW);
    // Confirm it actually landed in the column — stored slices only.
    const { rows } = await pg.pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM users WHERE id = $1`,
      [userId],
    );
    expect(rows[0]!.preferences).toEqual(CUSTOM_STORED);
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
    await agent.put('/settings/prefs').send(DEFAULT_PREFS_BODY).expect(200);
    const res = await agent.get('/settings/prefs');
    expect(res.body).toEqual(DEFAULT_VIEW);
  });
});

describe('accent (Seoul-neon cross-device sync)', () => {
  it("GET coerces a stored LEGACY accent ('ochre') to 'coral' WITHOUT wiping the rest of the blob", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A pre-redesign stored blob: legacy accent id, everything else custom.
    const legacyBlob = {
      ...CUSTOM_STORED,
      palette: { ...CUSTOM_STORED.palette, accent: 'ochre' },
    };
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify(legacyBlob),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // The legacy accent coerces to the default; the user's OTHER stored
    // choices survive (this must NOT be the defaults fallback).
    expect(res.body).toEqual({
      ...CUSTOM_VIEW,
      palette: { ...CUSTOM_STORED.palette, accent: 'coral' },
    });
  });

  it("PUT round-trips a valid new accent ('mint') via echo + GET", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS_BODY, palette: { ...DEFAULT_STORED.palette, accent: 'mint' } };
    const put = await agent.put('/settings/prefs').send(body);
    expect(put.status).toBe(200);
    expect(put.body.palette.accent).toBe('mint');
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual({
      ...DEFAULT_VIEW,
      palette: { ...DEFAULT_STORED.palette, accent: 'mint' },
    });
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
    // ...and the rest of the PUT body persisted untouched (notif is derived,
    // not the body's — F-093).
    expect(get.body.notif).toEqual(NOTIF_NONE);
    expect(get.body.palette.paper).toBe('sumi');
  });

  it("a totally unknown accent value also coerces to 'coral' (catch posture, never 400/500)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = {
      ...DEFAULT_PREFS_BODY,
      palette: { ...DEFAULT_STORED.palette, accent: 'neon-zebra' },
    };
    const res = await agent.put('/settings/prefs').send(body);
    expect(res.status).toBe(200);
    expect(res.body.palette.accent).toBe('coral');
  });
});

describe('languageDisplay (Overhaul P3a)', () => {
  it('GET fills the default languageDisplay into a pre-P3a stored blob WITHOUT clobbering the stored palette', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A blob written before the field existed — legacy notif + palette only.
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ notif: CUSTOM_PREFS.notif, palette: CUSTOM_STORED.palette }),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // The user's stored choices survive; only the missing fields default
    // (textSize catches to 'md' and toursSeen defaults to [] the same way).
    // notif is derived.
    expect(res.body).toEqual({
      notif: NOTIF_NONE,
      palette: CUSTOM_STORED.palette,
      languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
      textSize: 'md',
      toursSeen: [],
    });
  });

  it('PUT round-trips a custom languageDisplay (echo + GET)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const custom = {
      ...DEFAULT_PREFS_BODY,
      languageDisplay: { mode: 'ko', primary: 'ko', subScale: 0.4 },
    };
    const expected = {
      ...DEFAULT_VIEW,
      languageDisplay: { mode: 'ko', primary: 'ko', subScale: 0.4 },
    };
    const put = await agent.put('/settings/prefs').send(custom);
    expect(put.status).toBe(200);
    expect(put.body).toEqual(expected);
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual(expected);
  });

  it('PUT from a pre-P3a client (no languageDisplay) is accepted and stores the defaults', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const legacyBody = { notif: CUSTOM_PREFS.notif, palette: CUSTOM_STORED.palette };
    const res = await agent.put('/settings/prefs').send(legacyBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      notif: NOTIF_NONE,
      palette: CUSTOM_STORED.palette,
      languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
      textSize: 'md',
      toursSeen: [],
    });
    const get = await agent.get('/settings/prefs');
    expect(get.body.languageDisplay).toEqual(DEFAULT_LANGUAGE_DISPLAY);
  });

  it('PUT applies inner-field defaults to a partial languageDisplay', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS_BODY, languageDisplay: { mode: 'en' } });
    expect(res.status).toBe(200);
    expect(res.body.languageDisplay).toEqual({ mode: 'en', primary: 'ko', subScale: 0.7 });
  });

  it('rejects a bad mode enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS_BODY, languageDisplay: { ...DEFAULT_LANGUAGE_DISPLAY, mode: 'fr' } });
    expect(res.status).toBe(400);
  });

  it.each([[1.5], [0.2], [-1]])('rejects out-of-range subScale %s → 400', async (subScale) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS_BODY, languageDisplay: { ...DEFAULT_LANGUAGE_DISPLAY, subScale } });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown key inside languageDisplay (strict) → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/settings/prefs')
      .send({ ...DEFAULT_PREFS_BODY, languageDisplay: { ...DEFAULT_LANGUAGE_DISPLAY, extra: true } });
    expect(res.status).toBe(400);
  });
});

describe('textSize (F-025 app-wide text size)', () => {
  it("GET coerces a stored bad textSize to 'md' WITHOUT wiping the rest of the blob", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const poisoned = { ...CUSTOM_STORED, textSize: 'gigantic' };
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify(poisoned),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // The bad size coerces to the default; the user's OTHER stored choices
    // survive (this must NOT be the defaults fallback).
    expect(res.body).toEqual({ ...CUSTOM_VIEW, textSize: 'md' });
  });

  it("PUT round-trips a valid new textSize ('sm') via echo + GET", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS_BODY, textSize: 'sm' };
    const put = await agent.put('/settings/prefs').send(body);
    expect(put.status).toBe(200);
    expect(put.body.textSize).toBe('sm');
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual({ ...DEFAULT_VIEW, textSize: 'sm' });
  });

  it("PUT from a pre-F-025 client (no textSize) is accepted and stores 'md' (not a 400)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = {
      notif: CUSTOM_PREFS.notif,
      palette: CUSTOM_STORED.palette,
      languageDisplay: CUSTOM_STORED.languageDisplay,
    };
    const res = await agent.put('/settings/prefs').send(body);
    expect(res.status).toBe(200);
    expect(res.body.textSize).toBe('md');
    // ...and the rest of the PUT body persisted untouched (derived notif).
    // The body carried no toursSeen either → the field defaults to [].
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual({ ...CUSTOM_VIEW, textSize: 'md', toursSeen: [] });
  });

  it("a totally unknown textSize value also coerces to 'md' (catch posture, never 400/500)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS_BODY, textSize: 'xl' };
    const res = await agent.put('/settings/prefs').send(body);
    expect(res.status).toBe(200);
    expect(res.body.textSize).toBe('md');
  });
});

describe('toursSeen (guided tutorial tours)', () => {
  it('PUT round-trips toursSeen via echo + GET (and it lands in the column)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const body = { ...DEFAULT_PREFS_BODY, toursSeen: ['first-run', 'library'] };
    const put = await agent.put('/settings/prefs').send(body);
    expect(put.status).toBe(200);
    expect(put.body.toursSeen).toEqual(['first-run', 'library']);
    const get = await agent.get('/settings/prefs');
    expect(get.body).toEqual({ ...DEFAULT_VIEW, toursSeen: ['first-run', 'library'] });
    const { rows } = await pg.pool.query<{ preferences: { toursSeen: unknown } }>(
      `SELECT preferences FROM users WHERE id = $1`,
      [userId],
    );
    expect(rows[0]!.preferences.toursSeen).toEqual(['first-run', 'library']);
  });

  it('GET defaults toursSeen to [] on a legacy blob WITHOUT the field — palette/textSize survive', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A blob stored before the tours feature existed.
    const { toursSeen: _drop, ...legacy } = CUSTOM_STORED;
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify(legacy),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    // NOT the defaults fallback: the user's stored choices survive intact.
    expect(res.body).toEqual({ ...CUSTOM_VIEW, toursSeen: [] });
  });

  it('GET coerces a corrupt stored toursSeen to [] WITHOUT wiping the rest of the blob', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const poisoned = { ...CUSTOM_STORED, toursSeen: 'not-an-array' };
    await pg.pool.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
      JSON.stringify(poisoned),
      userId,
    ]);
    const res = await agent.get('/settings/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...CUSTOM_VIEW, toursSeen: [] });
  });

  it('PUT from a pre-feature client (no toursSeen) is accepted and stores [] (not a 400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const { toursSeen: _drop, ...legacyBody } = CUSTOM_PREFS;
    const res = await agent.put('/settings/prefs').send(legacyBody);
    expect(res.status).toBe(200);
    expect(res.body.toursSeen).toEqual([]);
    expect(res.body.palette).toEqual(CUSTOM_STORED.palette);
  });

  it('a malformed toursSeen coerces to [] on PUT (catch posture — never 400/500, bounds cannot be bloated)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // Oversized element (65 chars) — fails the item bound, catches to [].
    const bad1 = { ...DEFAULT_PREFS_BODY, toursSeen: ['x'.repeat(65)] };
    const res1 = await agent.put('/settings/prefs').send(bad1);
    expect(res1.status).toBe(200);
    expect(res1.body.toursSeen).toEqual([]);
    // Oversized array (201 ids) — fails the length bound, catches to [].
    const bad2 = {
      ...DEFAULT_PREFS_BODY,
      toursSeen: Array.from({ length: 201 }, (_, i) => `t${String(i)}`),
    };
    const res2 = await agent.put('/settings/prefs').send(bad2);
    expect(res2.status).toBe(200);
    expect(res2.body.toursSeen).toEqual([]);
    // Wrong element type — same catch.
    const bad3 = { ...DEFAULT_PREFS_BODY, toursSeen: [42] };
    const res3 = await agent.put('/settings/prefs').send(bad3);
    expect(res3.status).toBe(200);
    expect(res3.body.toursSeen).toEqual([]);
    // Nothing oversized ever reached the column.
    const get = await agent.get('/settings/prefs');
    expect(get.body.toursSeen).toEqual([]);
  });

  it('the prefs schema stays strict around the new field (unknown sibling key → 400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bad = { ...DEFAULT_PREFS_BODY, tourSeen: ['first-run'] }; // typo'd key
    const res = await agent.put('/settings/prefs').send(bad);
    expect(res.status).toBe(400);
  });
});

describe('settings — per-user isolation', () => {
  it("a user's prefs never leak to another user", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await a.agent.put('/settings/prefs').send(CUSTOM_PREFS).expect(200);
    // b never wrote anything → still defaults.
    const res = await b.agent.get('/settings/prefs');
    expect(res.body).toEqual(DEFAULT_VIEW);
  });

  it("a user's schedule rows never influence another user's derived notif", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await seedSchedules(a.userId, [{ kind: 'daily_reminder', channel: 'email', enabled: true }]);
    const res = await b.agent.get('/settings/prefs');
    expect(res.body.notif).toEqual(NOTIF_NONE);
  });
});
