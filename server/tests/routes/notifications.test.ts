/**
 * Integration tests for /notifications/schedules (F-040 — user-selectable
 * notification timing; supersedes F-006).
 *
 * Routes:
 *   GET /notifications/schedules
 *   PUT /notifications/schedules
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in). No
 * Claude (the route is cheap + Claude-free).
 *
 * Coverage:
 *   - auth required on both routes (401 unauthenticated)
 *   - GET returns an empty set for a fresh user (nothing is implicitly on)
 *   - PUT upserts a daily_reminder at a time + tz + channel; GET round-trips
 *   - re-PUT of the same (kind, channel) UPDATES in place (no duplicate row;
 *     version bumped, updated_at trigger fires)
 *   - weekly_report requires a weekday; non-weekly kinds must not carry one
 *   - sms channel is accepted + stored, flagged placeholder: true
 *   - invalid kind / channel / time / tz / unknown key / empty array /
 *     intra-payload duplicate → 400
 *   - IDOR: schedules are user-scoped; one user's PUT is invisible to another
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

const DAILY = {
  kind: 'daily_reminder',
  channel: 'push',
  timeOfDay: '07:30',
  tz: 'Asia/Seoul',
  enabled: true,
};

const WEEKLY = {
  kind: 'weekly_report',
  channel: 'email',
  timeOfDay: '18:00',
  tz: 'America/Denver',
  weekday: 0, // Sunday (JS Date.getDay() convention)
  enabled: true,
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

describe('notifications — auth required', () => {
  it.each([
    ['GET', '/notifications/schedules'],
    ['PUT', '/notifications/schedules'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(p)
        : await request(t.app).put(p).send({ schedules: [DAILY] });
    expect(res.status).toBe(401);
  });
});

describe('GET /notifications/schedules', () => {
  it('returns an empty set for a fresh user — no schedule is implicitly on', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/notifications/schedules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schedules: [] });
  });
});

describe('PUT /notifications/schedules — upsert + round-trip', () => {
  it('stores a daily_reminder at a chosen time/tz/channel and round-trips it', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const put = await agent.put('/notifications/schedules').send({ schedules: [DAILY] });
    expect(put.status).toBe(200);
    expect(put.body.schedules).toEqual([
      {
        kind: 'daily_reminder',
        channel: 'push',
        timeOfDay: '07:30',
        tz: 'Asia/Seoul',
        weekday: null,
        enabled: true,
        placeholder: false,
        updatedAt: expect.any(String),
      },
    ]);
    const get = await agent.get('/notifications/schedules');
    expect(get.status).toBe(200);
    expect(get.body).toEqual(put.body);
  });

  it('stores a weekly_report with its weekday', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/notifications/schedules').send({ schedules: [WEEKLY] });
    expect(res.status).toBe(200);
    expect(res.body.schedules[0]).toMatchObject({
      kind: 'weekly_report',
      channel: 'email',
      timeOfDay: '18:00',
      tz: 'America/Denver',
      weekday: 0,
      enabled: true,
    });
  });

  it('upserts multiple kinds in one call and echoes the FULL stored set', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/notifications/schedules').send({ schedules: [DAILY] }).expect(200);
    // Second PUT sends only WEEKLY — the echo must still include DAILY.
    const res = await agent.put('/notifications/schedules').send({ schedules: [WEEKLY] });
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(2);
    const kinds = res.body.schedules.map((s: { kind: string }) => s.kind);
    expect(kinds).toEqual(['daily_reminder', 'weekly_report']);
  });

  it('re-PUT of the same (kind, channel) updates in place — one row, version bumped', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await agent.put('/notifications/schedules').send({ schedules: [DAILY] }).expect(200);
    const res = await agent.put('/notifications/schedules').send({
      schedules: [{ ...DAILY, timeOfDay: '21:15', enabled: false }],
    });
    expect(res.status).toBe(200);
    expect(res.body.schedules).toEqual([
      expect.objectContaining({ timeOfDay: '21:15', enabled: false }),
    ]);
    // Prove the row was UPDATED, not duplicated, and audit columns moved.
    const { rows } = await pg.pool.query<{
      time_of_day: string;
      version: number;
      moved: boolean;
    }>(
      `SELECT to_char(time_of_day, 'HH24:MI') AS time_of_day,
              version,
              updated_at > created_at AS moved
         FROM notification_schedules
        WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ time_of_day: '21:15', version: 2, moved: true });
  });

  it('accepts + stores the sms placeholder channel, flagged placeholder: true', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/notifications/schedules').send({
      schedules: [{ ...DAILY, channel: 'sms' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.schedules[0]).toMatchObject({ channel: 'sms', placeholder: true });
    // Stored for real — the choice persists even though nothing sends yet.
    const { rows } = await pg.pool.query(
      `SELECT channel FROM notification_schedules WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([{ channel: 'sms' }]);
  });

  it('the same kind on two channels is two independent schedules', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/notifications/schedules').send({
      schedules: [DAILY, { ...DAILY, channel: 'email', timeOfDay: '08:00' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(2);
  });
});

describe('PUT /notifications/schedules — validation (400s)', () => {
  const cases: Array<[string, unknown]> = [
    ['unknown kind', [{ ...DAILY, kind: 'hourly_nag' }]],
    ['unknown channel', [{ ...DAILY, channel: 'carrier_pigeon' }]],
    ['hour out of range', [{ ...DAILY, timeOfDay: '25:00' }]],
    ['minute out of range', [{ ...DAILY, timeOfDay: '07:60' }]],
    ['not zero-padded', [{ ...DAILY, timeOfDay: '7:30' }]],
    ['seconds not allowed', [{ ...DAILY, timeOfDay: '07:30:00' }]],
    ['unresolvable tz', [{ ...DAILY, tz: 'Not/AZone' }]],
    ['empty tz', [{ ...DAILY, tz: '' }]],
    ['weekday on a daily kind', [{ ...DAILY, weekday: 1 }]],
    ['weekly_report without weekday', [{ ...WEEKLY, weekday: undefined }]],
    ['weekday out of range', [{ ...WEEKLY, weekday: 7 }]],
    ['fractional weekday', [{ ...WEEKLY, weekday: 1.5 }]],
    ['unknown key (strict)', [{ ...DAILY, snooze: true }]],
    ['empty schedules array', []],
    ['duplicate (kind, channel) in one payload', [DAILY, { ...DAILY, timeOfDay: '09:00' }]],
  ];

  it.each(cases)('%s → 400, nothing persisted', async (_name, schedules) => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/notifications/schedules').send({ schedules });
    expect(res.status).toBe(400);
    const { rows } = await pg.pool.query(
      `SELECT 1 FROM notification_schedules WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects a payload larger than the 9-schedule ceiling → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // 10 entries (> 3 kinds x 3 channels) — necessarily contains a duplicate
    // key too, but the length cap must reject it before anything else runs.
    const schedules = Array.from({ length: 10 }, () => ({ ...DAILY }));
    const res = await agent.put('/notifications/schedules').send({ schedules });
    expect(res.status).toBe(400);
  });
});

describe('IDOR — schedules are strictly user-scoped', () => {
  it("one user's PUT is invisible to another user", async () => {
    const { agent: alice } = await registerUser(t.app, pg.pool);
    const { agent: bob } = await registerUser(t.app, pg.pool);

    await alice.put('/notifications/schedules').send({ schedules: [DAILY] }).expect(200);

    const bobGet = await bob.get('/notifications/schedules');
    expect(bobGet.status).toBe(200);
    expect(bobGet.body).toEqual({ schedules: [] });

    // Bob storing his own schedule does not disturb Alice's.
    await bob
      .put('/notifications/schedules')
      .send({ schedules: [{ ...DAILY, timeOfDay: '23:45' }] })
      .expect(200);
    const aliceGet = await alice.get('/notifications/schedules');
    expect(aliceGet.body.schedules).toEqual([
      expect.objectContaining({ timeOfDay: '07:30' }),
    ]);
  });
});
