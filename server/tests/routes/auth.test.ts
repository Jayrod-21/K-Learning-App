/**
 * Per-route tests for src/routes/auth.ts (B-FU-2).
 *
 * Covers: success, validation rejection, rate-limit, DB error, auth-required.
 *
 * The top-level `tests/auth.test.ts` already exercises happy-path flows;
 * this file goes deeper on the explicit ticket axes (validation matrix,
 * DB-failure path, /me cookie precondition) without duplicating.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
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
  resetLimiters();
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

describe('POST /auth/logout — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).post('/auth/logout');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('valid session → 204 and subsequent /me → 401', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'lo@b.com', password: 'correct horse battery staple' });
    const out = await agent.post('/auth/logout');
    expect(out.status).toBe(204);
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(401);
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
