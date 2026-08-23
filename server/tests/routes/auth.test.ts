/**
 * Per-route tests for src/routes/auth.ts (B-FU-2).
 *
 * Covers: success, validation rejection, rate-limit, DB error, auth-required.
 *
 * The top-level `tests/auth.test.ts` already exercises happy-path flows;
 * this file goes deeper on the explicit ticket axes (validation matrix,
 * DB-failure path, /me cookie precondition) without duplicating.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

// F-201: pass-through partial mock of the sessions module so a single test
// can inject a transient revoke failure. `impl` is null (real behavior) for
// every other test in the file.
const revokeOverride = vi.hoisted(() => ({
  impl: null as null | (() => Promise<void>),
}));
vi.mock('../../src/auth/sessions.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/auth/sessions.js')>();
  return {
    ...mod,
    revokeSessionById: async (id: number, reason: string): Promise<void> => {
      if (revokeOverride.impl) return revokeOverride.impl();
      return mod.revokeSessionById(id, reason);
    },
  };
});

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  // Legacy single-step register/logout/session mechanics = the operator
  // gate-off config; opt into it explicitly now that the harness defaults to
  // the production gates (audit §3.1). Gate-ON coverage lives in
  // auth.verify/auth.mfa and the shared registerUser helper.
  t = buildTestApp({
    connectionString: pg.connectionString,
    mfaRequired: false,
    emailVerificationRequired: false,
  });
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
  revokeOverride.impl = null;
});

// Zod schema of the success response, used so the test asserts the SHAPE,
// not just a single field. Catches accidental field renames in the route.
const RegisterResponseSchema = z.object({
  user: z.object({ id: z.number().int().positive(), email: z.string().email() }),
});

describe('POST /auth/register — success', () => {
  it('returns 201 with a typed user object and HttpOnly cookie', async () => {
    const res = await request(t.app)
      .post('/auth/register')
      .send({ email: 'a@b.com', password: 'correct horse battery staple' });
    expect(res.status).toBe(201);
    const parsed = RegisterResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie?.[0]).toMatch(/HttpOnly/i);
  });
});

describe('POST /auth/register — validation rejection', () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'missing email', body: { password: 'correct horse battery staple' } },
    { name: 'malformed email', body: { email: 'not-an-email', password: 'correct horse battery staple' } },
    { name: 'short password', body: { email: 'a@b.com', password: 'short' } },
    { name: 'email wrong type', body: { email: 123, password: 'correct horse battery staple' } },
    { name: 'password wrong type', body: { email: 'a@b.com', password: 9999 } },
    { name: 'oversized email', body: { email: `${'x'.repeat(250)}@b.com`, password: 'correct horse battery staple' } },
  ];
  for (const c of cases) {
    it(`${c.name} → 400 validation_error`, async () => {
      const res = await request(t.app).post('/auth/register').send(c.body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  }
});

describe('POST /auth/login — validation rejection', () => {
  it('empty password → 400', async () => {
    const res = await request(t.app)
      .post('/auth/login')
      .send({ email: 'a@b.com', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('POST /auth/login — public user payload (client-contracts sweep #16)', () => {
  it('authenticated response carries the FULL /auth/me user shape, not just {id,email}', async () => {
    // The client's LoginResponse type declares display_name/phone/version;
    // returning only {id,email} left post-login consumers of `.version` with
    // `undefined` until the next /auth/me probe.
    const agent = request.agent(t.app);
    await agent.post('/auth/register').send({
      email: 'shape@b.com',
      password: 'correct horse battery staple',
      display_name: 'Jared',
    });
    const res = await agent
      .post('/auth/login')
      .send({ email: 'shape@b.com', password: 'correct horse battery staple' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('authenticated');
    expect(typeof res.body.user.id).toBe('number');
    expect(res.body.user.email).toBe('shape@b.com');
    expect(res.body.user.display_name).toBe('Jared');
    expect(res.body.user.phone).toBeNull();
    expect(res.body.user.version).toBe(1);
  });
});

describe('POST /auth/login — rate-limit', () => {
  it('exceeding RATE_LIMIT_AUTH_MAX failed logins from one IP returns 429', async () => {
    await request(t.app)
      .post('/auth/register')
      .send({ email: 'rl@example.com', password: 'correct horse battery staple' });
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await request(t.app)
        .post('/auth/login')
        .send({ email: 'rl@example.com', password: 'wrong-attempt' });
      if (res.status === 429) {
        expect(res.body.error.code).toBe('rate_limited');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});

describe('GET /auth/me + POST /auth/logout — unauthenticated flood is limited (F-UP-018)', () => {
  it('unauthenticated /me attempts count toward the auth bucket → 429', async () => {
    // Pre-fix /me mounted NO limiter: bogus-cookie floods (one session-table
    // lookup each) were unbounded. authLimiter now runs before requireAuth;
    // RATE_LIMIT_AUTH_MAX is 5 in the test env, so the flood must trip 429.
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await request(t.app)
        .get('/auth/me')
        .set('Cookie', 'km_sid=bogus-flood-token');
      expect([401, 429]).toContain(res.status);
      if (res.status === 429) {
        expect(res.body.error.code).toBe('rate_limited');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('unauthenticated /logout flood is bounded by the cheap per-IP bucket → 429', async () => {
    // F-201 made logout idempotent-success (204 even without a live session),
    // so the failure-counting auth bucket (skipSuccessfulRequests) never sees
    // it. The route now mounts cheapLimiter — which counts ALL requests
    // per-IP — so a bogus-cookie flood (one session lookup each) stays
    // bounded. RATE_LIMIT_CHEAP_MAX is 120 in the test env.
    let got429 = false;
    for (let i = 0; i < 130; i++) {
      const res = await request(t.app)
        .post('/auth/logout')
        .set('Cookie', 'km_sid=bogus-flood-token');
      expect([204, 429]).toContain(res.status);
      if (res.status === 429) {
        expect(res.body.error.code).toBe('rate_limited');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('successful authenticated /me calls are never throttled (skipSuccessfulRequests)', async () => {
    // The auth bucket counts FAILURES only — a legitimate session polling /me
    // well past RATE_LIMIT_AUTH_MAX (5) must keep getting 200s.
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'me-flood@example.com', password: 'correct horse battery staple' });
    for (let i = 0; i < 10; i++) {
      const res = await agent.get('/auth/me');
      expect(res.status).toBe(200);
    }
  });
});

describe('POST /auth/logout — idempotent, always clears the cookie (F-201)', () => {
  /** The Set-Cookie header that clears km_sid (Expires in the past / empty value). */
  function expectClearingCookie(setCookie: string | string[] | undefined): void {
    const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const clearing = headers.find((h) => h.startsWith('km_sid=;'));
    expect(clearing).toBeDefined();
  }

  it('no cookie at all → 204 (no-op logout succeeds)', async () => {
    const res = await request(t.app).post('/auth/logout');
    expect(res.status).toBe(204);
    expectClearingCookie(res.headers['set-cookie']);
  });

  it('valid session → 204, /me → 401, and a REPEAT logout with the revoked cookie → 204', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'lo@b.com', password: 'correct horse battery staple' });
    const out = await agent.post('/auth/logout');
    expect(out.status).toBe(204);
    expectClearingCookie(out.headers['set-cookie']);
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(401);
    // The retry case a lost 204 forces on the client: the same (now revoked)
    // cookie must land as a clean success, not a 401/5xx.
    const again = await agent.post('/auth/logout');
    expect(again.status).toBe(204);
  });

  it('a transient revoke failure still returns 204 AND clears the cookie', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'lo-fail@b.com', password: 'correct horse battery staple' });
    revokeOverride.impl = () => Promise.reject(new Error('db down'));
    const out = await agent.post('/auth/logout');
    expect(out.status).toBe(204);
    expectClearingCookie(out.headers['set-cookie']);
    // The DB row is still live (revoke failed) — but the browser dropped the
    // token, so a client retry presents NO cookie and lands as a clean 204
    // no-op; the un-revoked row dies via idle/absolute expiry (see the
    // route's logout comment).
    revokeOverride.impl = null;
    const { rows } = await pg.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('GET /auth/me — auth required', () => {
  it('no cookie → 401', async () => {
    const res = await request(t.app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('valid cookie → 200 with user payload', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'me@b.com', password: 'correct horse battery staple' });
    const res = await agent.get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('me@b.com');
  });
});

describe('POST /auth/register — DB error', () => {
  it('returns 500 with no stack leakage when the users table is missing', async () => {
    // Force a DB-level failure: drop the users table within an aborted-then-restored
    // transaction. We restore it after, so the rest of the suite keeps working.
    await pg.pool.query('ALTER TABLE users RENAME TO users_hidden');
    try {
      const res = await request(t.app)
        .post('/auth/register')
        .send({ email: 'crash@b.com', password: 'correct horse battery staple' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('internal_error');
      // CRITICAL: do not leak SQL or stack traces.
      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toMatch(/users_hidden/);
      expect(bodyText).not.toMatch(/relation .* does not exist/i);
    } finally {
      await pg.pool.query('ALTER TABLE users_hidden RENAME TO users');
    }
  });
});
