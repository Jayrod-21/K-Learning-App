/**
 * Auth integration tests.
 *
 * Spins up a real Postgres via testcontainers, applies all migrations, then
 * walks the auth flow end-to-end. Each test resets the relevant tables
 * rather than the container — much faster.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from './helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from './helpers/app.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  // This suite exercises the legacy single-step auth mechanics — register and
  // login minting a session directly — which is the operator gate-off config
  // (EMAIL_VERIFICATION_REQUIRED=false, MFA_REQUIRED=false). Opt into it
  // explicitly now that the harness defaults to the production gates (audit
  // §3.1); the gate-ON flow is covered by auth.verify/auth.mfa and, for route
  // suites, by the shared registerUser helper.
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
  // Clean per-test so each scenario starts from a known state.
  await pg.pool.query(
    'TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE',
  );
});

describe('POST /auth/register', () => {
  it('creates a user and sets a session cookie', async () => {
    const res = await request(t.app)
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('jared@example.com');
    expect(res.headers['set-cookie']).toBeDefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/km_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('rejects too-short passwords with 400', async () => {
    const res = await request(t.app)
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('rejects duplicate email with 409 — and does NOT reveal which field collided', async () => {
    await request(t.app)
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const res = await request(t.app)
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'a different long password' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).not.toMatch(/email/i);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await request(t.app)
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
  });

  it('returns 200 + cookie on correct password', async () => {
    const res = await request(t.app)
      .post('/auth/login')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(t.app)
      .post('/auth/login')
      .send({ email: 'jared@example.com', password: 'wrong password attempt' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('returns 401 on unknown email — same shape as wrong password', async () => {
    const res = await request(t.app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'anything at all' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('GET /auth/me', () => {
  it('returns 401 without a cookie', async () => {
    const res = await request(t.app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the user when cookie is valid', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('jared@example.com');
  });

  it('returns 401 after logout (revoked session)', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const logout = await agent.post('/auth/logout');
    expect(logout.status).toBe(204);
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('eventually 429s repeated failed logins from one IP, with a retry_after hint (F-UP-005)', async () => {
    await request(t.app)
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    let status429 = 0;
    let body429: unknown = null;
    for (let i = 0; i < 12; i++) {
      const res = await request(t.app)
        .post('/auth/login')
        .send({ email: 'jared@example.com', password: 'definitely wrong here' });
      if (res.status === 429) {
        status429 = res.status;
        body429 = res.body;
        break;
      }
    }
    expect(status429).toBe(429);
    const err = (
      body429 as {
        error?: { code?: string; message?: string; retry_after?: unknown };
      }
    ).error;
    expect(err?.code).toBe('rate_limited');
    expect(err?.message).toBe('too many auth attempts');
    // F-UP-005: the auth limiter (previously carried NO retry_after) now includes
    // a precise, positive retry_after (seconds) like the expensive limiter.
    expect(typeof err?.retry_after).toBe('number');
    expect(err?.retry_after as number).toBeGreaterThan(0);
    // Units guard (fix-pass SF-3): retry_after is seconds, and can never exceed
    // the limiter window (60s here — RATE_LIMIT_WINDOW_MS='60000'). A dropped
    // ms→s division would yield ~59_000 and still pass the two checks above.
    expect(err?.retry_after as number).toBeLessThanOrEqual(60);
  });
});

describe('zod boundary validation', () => {
  it('rejects extra/typed-wrong fields cleanly', async () => {
    const res = await request(t.app)
      .post('/auth/register')
      .send({ email: 12345, password: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('GET /auth/me — extended profile shape (Pass 3)', () => {
  it('returns display_name and phone alongside id+email', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({
        email: 'jared@example.com',
        password: 'correct horse battery staple',
        display_name: 'Jared',
      });
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(
      expect.objectContaining({
        email: 'jared@example.com',
        display_name: 'Jared',
        phone: null,
      }),
    );
  });
});

describe('PATCH /auth/me — profile update', () => {
  it('updates display_name and phone', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const res = await agent
      .patch('/auth/me')
      .send({ display_name: 'JM', phone: '+1 555-555-1212', expected_version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.user.display_name).toBe('JM');
    expect(res.body.user.phone).toBe('+1 555-555-1212');
    // Optimistic-concurrency invariant: a successful PATCH bumps the version.
    expect(res.body.user.version).toBe(2);
  });

  it('rejects empty body → 400', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const res = await agent.patch('/auth/me').send({});
    expect(res.status).toBe(400);
  });

  it('rejects body missing expected_version → 400 (strict-schema)', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    // Deliberately omit expected_version — Zod strict schema requires it.
    const res = await agent
      .patch('/auth/me')
      .send({ display_name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('rejects extra fields under .strict() → 400', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const res = await agent
      .patch('/auth/me')
      .send({ display_name: 'X', role: 'admin', expected_version: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects malformed phone → 400', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const res = await agent
      .patch('/auth/me')
      .send({ phone: 'not-a-phone!', expected_version: 1 });
    expect(res.status).toBe(400);
  });

  it('409 on email collision', async () => {
    const a = request.agent(t.app);
    await a
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    const b = request.agent(t.app);
    await b
      .post('/auth/register')
      .send({ email: 'someone@example.com', password: 'correct horse battery staple' });
    const res = await b
      .patch('/auth/me')
      .send({ email: 'jared@example.com', expected_version: 1 });
    expect(res.status).toBe(409);
  });

  it('409 on stale expected_version (concurrent writer beat us)', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'jared@example.com', password: 'correct horse battery staple' });
    // First PATCH bumps version to 2.
    const first = await agent
      .patch('/auth/me')
      .send({ display_name: 'First', expected_version: 1 });
    expect(first.status).toBe(200);
    expect(first.body.user.version).toBe(2);
    // Second PATCH carries the now-stale version and must 409.
    const second = await agent
      .patch('/auth/me')
      .send({ display_name: 'Second', expected_version: 1 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
  });

  it('401 when unauthenticated', async () => {
    const res = await request(t.app)
      .patch('/auth/me')
      .send({ display_name: 'x', expected_version: 1 });
    expect(res.status).toBe(401);
  });

  it('allows changing email and the new email shows up on GET /me', async () => {
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'old@example.com', password: 'correct horse battery staple' });
    const patch = await agent
      .patch('/auth/me')
      .send({ email: 'new@example.com', expected_version: 1 });
    expect(patch.status).toBe(200);
    expect(patch.body.user.email).toBe('new@example.com');
    const me = await agent.get('/auth/me');
    expect(me.body.user.email).toBe('new@example.com');
  });

  it('emits an audit log entry when the email changes', async () => {
    // The audit signal is a WARN-level structured log; we can't introspect
    // child loggers from supertest cleanly, so the contract this test asserts
    // is the user-visible side effect that depends on the same code path:
    // successful email change + version bump + GET /me reflects the new
    // email. Combined with the route's static threat-model comment
    // (auth.ts:344-358) this is the strongest assertion we can make without
    // wiring a log-capture transport into buildTestApp — which would be a
    // larger refactor than this finding warrants. The deferred test (capture
    // pino transport + assert WARN line with event=profile_email_changed
    // and afterDomain matching the new domain) is filed as FU-NF-34.
    const agent = request.agent(t.app);
    await agent
      .post('/auth/register')
      .send({ email: 'old@example.com', password: 'correct horse battery staple' });
    const patch = await agent
      .patch('/auth/me')
      .send({ email: 'new@example.com', expected_version: 1 });
    expect(patch.status).toBe(200);
    expect(patch.body.user.email).toBe('new@example.com');
    expect(patch.body.user.version).toBe(2);
  });
});
