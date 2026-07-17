/**
 * F-006 — email verification: end-to-end route tests against a real Postgres
 * (testcontainer) with the MOCK mail transport captured in-process. NO real
 * SMTP is ever touched (buildTestApp clears SMTP_HOST and resets the
 * transport; this file installs a capture transport on top).
 *
 * Covers, per the F-006 security contract:
 *   - register (gate ON) → typed verification_required, NO session cookie,
 *     token issued (hashed at rest) + email captured;
 *   - login blocked while unverified (typed email_unverified) and allowed
 *     when EMAIL_VERIFICATION_REQUIRED=false;
 *   - verify consumes the token once, stamps email_verified_at, unblocks
 *     login; GET and POST variants; idempotent double-verify;
 *   - expired token → token_expired; garbage/consumed/superseded → token_invalid;
 *   - replayed token cannot verify a LATER address (email change resets);
 *   - resend: generic non-enumerating 200 in every case, per-user cooldown,
 *     supersedes prior tokens;
 *   - mail-transport failure never fails registration;
 *   - /auth/me carries email_verified.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import {
  _setMailTransportForTesting,
  type MailMessage,
} from '../../src/services/mail.js';

const PASSWORD = 'correct horse battery staple';

let pg: PgHandle;
let t: TestApp;
/** Every message the capture transport "sent" since the last beforeEach. */
let sent: MailMessage[] = [];

/** Extract the raw verification token from a captured email's text body. */
function tokenFrom(msg: MailMessage): string {
  const m = /token=([A-Za-z0-9_-]+)/.exec(msg.text);
  expect(m, 'verification email must contain a token link').not.toBeNull();
  return m![1]!;
}

/** Wait until the capture transport has recorded `n` messages (the resend
 *  path sends fire-and-forget AFTER the response, so a fresh capture may
 *  land a tick later). */
async function waitForMail(n: number): Promise<void> {
  await vi.waitFor(() => {
    expect(sent.length).toBeGreaterThanOrEqual(n);
  });
}

function installCaptureTransport(): void {
  _setMailTransportForTesting({
    // eslint-disable-next-line @typescript-eslint/require-await
    sendMail: async (msg) => {
      sent.push(msg);
    },
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  // Gate ON — the F-006 production posture. MFA stays off (its own suite
  // covers the interplay-free claim: the gate runs BEFORE any MFA branch).
  t = buildTestApp({
    connectionString: pg.connectionString,
    emailVerificationRequired: true,
  });
  installCaptureTransport();
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  resetLimiters();
  sent = [];
  installCaptureTransport();
});

async function register(email: string): Promise<request.Response> {
  return request(t.app).post('/auth/register').send({ email, password: PASSWORD });
}

describe('POST /auth/register — verification-gated', () => {
  it('returns typed verification_required with NO session cookie, issues a hashed token, sends the email', async () => {
    const res = await register('v1@example.com');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('verification_required');
    expect(res.body.user.email).toBe('v1@example.com');
    // SECURITY: no session for an unverified browser.
    expect(res.headers['set-cookie']).toBeUndefined();

    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);
    expect(sent[0]!.to).toBe('v1@example.com');

    // Hashed at rest: the raw token must NOT appear in the DB; the stored
    // hash must be SHA-256 hex.
    const { rows } = await pg.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM email_verification_tokens',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.token_hash).not.toContain(raw);

    const u = await pg.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users',
    );
    expect(u.rows[0]!.email_verified_at).toBeNull();
  });

  it('a mail-transport failure never fails the registration (best-effort send)', async () => {
    _setMailTransportForTesting({
      // eslint-disable-next-line @typescript-eslint/require-await
      sendMail: async () => {
        throw new Error('relay down');
      },
    });
    const res = await register('mailfail@example.com');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('verification_required');
    // The account and its token exist; resend is the recovery path.
    const { rows } = await pg.pool.query('SELECT 1 FROM email_verification_tokens');
    expect(rows).toHaveLength(1);
  });
});

describe('login gate (EMAIL_VERIFICATION_REQUIRED=true)', () => {
  it('unverified login → typed 403 email_unverified (not a generic failure)', async () => {
    await register('gated@example.com');
    const res = await request(t.app)
      .post('/auth/login')
      .send({ email: 'gated@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('email_unverified');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('WRONG password on an unverified account stays the generic 401 (no verification-status oracle)', async () => {
    await register('oracle@example.com');
    const res = await request(t.app)
      .post('/auth/login')
      .send({ email: 'oracle@example.com', password: 'wrong-password-entirely' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).not.toBe('email_unverified');
  });

  it('verify → login succeeds; /auth/me reports email_verified', async () => {
    await register('happy@example.com');
    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);

    const v = await request(t.app).post('/auth/verify').send({ token: raw });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('verified');

    const agent = request.agent(t.app);
    const login = await agent
      .post('/auth/login')
      .send({ email: 'happy@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('authenticated');
    expect(login.body.user.email_verified).toBe(true);

    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email_verified).toBe(true);
  });
});

describe('GET|POST /auth/verify — token validation', () => {
  it('GET variant with ?token= verifies too', async () => {
    await register('getv@example.com');
    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);
    const res = await request(t.app).get('/auth/verify').query({ token: raw });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');
  });

  it('double-click is idempotent: second consume → friendly already_verified', async () => {
    await register('twice@example.com');
    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);
    const first = await request(t.app).post('/auth/verify').send({ token: raw });
    expect(first.body.status).toBe('verified');
    const second = await request(t.app).post('/auth/verify').send({ token: raw });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('already_verified');
  });

  it('expired token → 400 token_expired', async () => {
    await register('stale@example.com');
    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);
    // Backdate: created_at moves too so ck_email_verif_expiry keeps holding.
    await pg.pool.query(
      `UPDATE email_verification_tokens
          SET created_at = now() - interval '48 hours',
              expires_at = now() - interval '24 hours'`,
    );
    const res = await request(t.app).post('/auth/verify').send({ token: raw });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('token_expired');
    const u = await pg.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users',
    );
    expect(u.rows[0]!.email_verified_at).toBeNull();
  });

  it('unknown / malformed tokens → 400 token_invalid (shape gate + lookup miss)', async () => {
    const bogus = 'A'.repeat(43); // right shape, wrong token
    const res = await request(t.app).post('/auth/verify').send({ token: bogus });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('token_invalid');

    const malformed = await request(t.app)
      .post('/auth/verify')
      .send({ token: 'short!' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('token_invalid');
  });

  it('a consumed token can NEVER verify a later (changed) address', async () => {
    // register → verify → login → change email → the OLD consumed token must
    // not stamp the NEW address (replay across an email change).
    await register('replay@example.com');
    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);
    await request(t.app).post('/auth/verify').send({ token: raw });

    const agent = request.agent(t.app);
    await agent
      .post('/auth/login')
      .send({ email: 'replay@example.com', password: PASSWORD });
    const patch = await agent
      .patch('/auth/me')
      .send({ email: 'replay-new@example.com', expected_version: 1 });
    expect(patch.status).toBe(200);
    // The email change reset the stamp…
    expect(patch.body.user.email_verified).toBe(false);
    // …and sent a fresh verification to the NEW address.
    await waitForMail(2);
    expect(sent[1]!.to).toBe('replay-new@example.com');

    // Replaying the consumed original token → invalid, user stays unverified.
    const res = await request(t.app).post('/auth/verify').send({ token: raw });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('token_invalid');
    const u = await pg.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users',
    );
    expect(u.rows[0]!.email_verified_at).toBeNull();

    // The fresh token for the new address DOES verify.
    const raw2 = tokenFrom(sent[1]!);
    const ok = await request(t.app).post('/auth/verify').send({ token: raw2 });
    expect(ok.body.status).toBe('verified');
  });
});

describe('POST /auth/verify/resend — anti-enumeration + cooldown + supersession', () => {
  it('returns the identical generic 200 for unknown, unverified, and verified emails', async () => {
    await register('known@example.com'); // unverified account
    await waitForMail(1);

    const unknown = await request(t.app)
      .post('/auth/verify/resend')
      .send({ email: 'nobody@example.com' });
    const known = await request(t.app)
      .post('/auth/verify/resend')
      .send({ email: 'known@example.com' });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    // SECURITY: byte-identical bodies — no user-enumeration signal.
    expect(unknown.body).toEqual(known.body);
    expect(unknown.body).toEqual({ status: 'ok' });
  });

  it('never emails an unknown or already-verified address', async () => {
    await register('done@example.com');
    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);
    await request(t.app).post('/auth/verify').send({ token: raw });

    await request(t.app)
      .post('/auth/verify/resend')
      .send({ email: 'nobody@example.com' });
    await request(t.app)
      .post('/auth/verify/resend')
      .send({ email: 'done@example.com' });
    // Give any (buggy) fire-and-forget send a tick to land, then assert none did.
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(1); // only the original register email
  });

  it('suppresses resend inside the per-user cooldown window', async () => {
    await register('cool@example.com');
    await waitForMail(1);
    // The register token was JUST issued → within the (60 s default) cooldown.
    const res = await request(t.app)
      .post('/auth/verify/resend')
      .send({ email: 'cool@example.com' });
    expect(res.status).toBe(200); // still the generic body
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(1); // no second email
  });

  it('past the cooldown: issues a fresh token and INVALIDATES the prior one', async () => {
    await register('fresh@example.com');
    await waitForMail(1);
    const oldRaw = tokenFrom(sent[0]!);
    // Age the prior token past the cooldown (DB-side, no sleeping).
    await pg.pool.query(
      `UPDATE email_verification_tokens SET created_at = now() - interval '10 minutes'`,
    );
    const res = await request(t.app)
      .post('/auth/verify/resend')
      .send({ email: 'fresh@example.com' });
    expect(res.status).toBe(200);
    await waitForMail(2);
    const newRaw = tokenFrom(sent[1]!);
    expect(newRaw).not.toBe(oldRaw);

    // Superseded token is dead …
    const oldTry = await request(t.app).post('/auth/verify').send({ token: oldRaw });
    expect(oldTry.status).toBe(400);
    expect(oldTry.body.error.code).toBe('token_invalid');
    // … the fresh one verifies.
    const newTry = await request(t.app).post('/auth/verify').send({ token: newRaw });
    expect(newTry.body.status).toBe('verified');
  });
});

describe('EMAIL_VERIFICATION_REQUIRED=false (operator kill-switch)', () => {
  it('register issues a session directly and unverified login succeeds; /me shows email_verified=false', async () => {
    const off = buildTestApp({
      connectionString: pg.connectionString,
      emailVerificationRequired: false,
    });
    installCaptureTransport();
    try {
      const agent = request.agent(off.app);
      const reg = await agent
        .post('/auth/register')
        .send({ email: 'off@example.com', password: PASSWORD });
      expect(reg.status).toBe(201);
      expect(reg.body.status).toBeUndefined(); // legacy shape
      expect(reg.headers['set-cookie']?.[0]).toMatch(/HttpOnly/i);

      const login = await agent
        .post('/auth/login')
        .send({ email: 'off@example.com', password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.status).toBe('authenticated');
      expect(login.body.user.email_verified).toBe(false);

      // The verification email still went out (opportunistic verify).
      await waitForMail(1);
      expect(sent[0]!.to).toBe('off@example.com');
    } finally {
      await teardownTestApp(off);
      installCaptureTransport();
    }
  });
});
