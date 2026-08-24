/**
 * Phase 2.1 — self-service password reset: end-to-end route tests against a
 * real Postgres (testcontainer) with the MOCK mail transport captured
 * in-process. NO real SMTP is ever touched (buildTestApp clears SMTP_HOST and
 * resets the transport; this file installs a capture transport on top).
 *
 * The suite runs with `emailVerificationRequired: false, mfaRequired: false`
 * so registration mints a session directly and login is single-step — the
 * gate/MFA interplay is covered by auth.verify.test.ts / the MFA suites and
 * is orthogonal to what this file is proving. NOTE: registration still sends
 * an OPPORTUNISTIC verification email even with the gate off (see auth.ts's
 * register handler) — every `register()` call below therefore adds ONE
 * captured message before any password-reset call runs; tests track the
 * capture-array length rather than assuming index 0 is the reset email.
 *
 * Covers, per the Phase 2.1 security contract:
 *   - request: identical generic 200 for an existing vs. unknown email (no
 *     enumeration signal), a token IS issued + emailed for the existing
 *     account and NONE for the unknown one (asserted via the DB);
 *   - confirm: resets the password (old password fails login, new succeeds)
 *     AND revokes every existing session in the SAME operation — a
 *     pre-existing session cookie is dead after reset;
 *   - single-use: a second confirm with the same token fails (generic
 *     token_invalid, no auto-login, no further session/password mutation);
 *   - expired token → typed token_expired, password untouched;
 *   - request cooldown: a rapid second request for the same account inside
 *     the window mints no second token / sends no second email;
 *   - the raw token is hashed at rest and rides the URL FRAGMENT, never a
 *     query string.
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
const NEW_PASSWORD = 'a whole new passphrase entirely';

let pg: PgHandle;
let t: TestApp;
/** Every message the capture transport "sent" since the last beforeEach. */
let sent: MailMessage[] = [];

/** Extract the raw reset token from a captured email's text body. */
function tokenFrom(msg: MailMessage): string {
  const m = /token=([A-Za-z0-9_-]+)/.exec(msg.text);
  expect(m, 'reset email must contain a token link').not.toBeNull();
  return m![1]!;
}

/** Wait until `sent` has grown past `prevLen`, then return the first NEW
 *  message (index `prevLen`). Used instead of a fixed index because
 *  registration opportunistically sends its own (unrelated) verification
 *  email first — see the file header. */
async function waitForNextMail(prevLen: number): Promise<MailMessage> {
  await vi.waitFor(() => {
    expect(sent.length).toBeGreaterThan(prevLen);
  });
  return sent[prevLen]!;
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
  t = buildTestApp({
    connectionString: pg.connectionString,
    emailVerificationRequired: false,
    mfaRequired: false,
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

/** Register a user and return an authenticated supertest agent (gates off →
 *  register mints a session directly). Registration synchronously awaits its
 *  own opportunistic verification-email send before responding, so `sent`
 *  reliably has exactly one entry by the time this resolves. */
async function register(email: string): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(t.app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

async function requestReset(email: string): Promise<request.Response> {
  return request(t.app).post('/auth/password-reset/request').send({ email });
}

async function confirmReset(token: string, password: string): Promise<request.Response> {
  return request(t.app)
    .post('/auth/password-reset/confirm')
    .send({ token, password });
}

describe('POST /auth/password-reset/request — non-enumeration + issuance', () => {
  it('returns the identical generic 200 for an existing and an unknown email', async () => {
    await register('known@example.com');

    const known = await requestReset('known@example.com');
    const unknown = await requestReset('nobody@example.com');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    // SECURITY: byte-identical bodies — no user-enumeration signal.
    expect(known.body).toEqual(unknown.body);
    expect(known.body.status).toBe('ok');
  });

  it('issues + emails a hashed token for an existing account, and issues nothing for an unknown one', async () => {
    await register('exists@example.com');
    const before = sent.length;

    await requestReset('exists@example.com');
    const msg = await waitForNextMail(before);
    expect(msg.to).toBe('exists@example.com');
    const raw = tokenFrom(msg);

    // SECURITY: the link rides the URL FRAGMENT, never a query string.
    expect(msg.text).toContain('/reset-password#token=');
    expect(msg.text).not.toContain('?token=');

    // Hashed at rest: the raw token must NOT appear in the DB; the stored
    // hash must be SHA-256 hex.
    const { rows } = await pg.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM password_reset_tokens',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.token_hash).not.toContain(raw);

    const afterFirst = sent.length;
    await requestReset('nobody@example.com');
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(afterFirst); // no email, no token for the unknown address
    const stillOne = await pg.pool.query('SELECT 1 FROM password_reset_tokens');
    expect(stillOne.rows).toHaveLength(1);
  });

  it('suppresses a second request inside the per-user cooldown window', async () => {
    await register('cool@example.com');
    const before = sent.length;

    await requestReset('cool@example.com');
    await waitForNextMail(before);
    const afterFirst = sent.length;

    // Immediately request again — still within the (60s default) cooldown.
    const second = await requestReset('cool@example.com');
    expect(second.status).toBe(200); // still the generic body

    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(afterFirst); // no second email
    const tokens = await pg.pool.query('SELECT 1 FROM password_reset_tokens');
    expect(tokens.rows).toHaveLength(1); // no second token
  });

  it('is bounded by the cheap per-IP bucket (BLOCKER fix: authLimiter would never count this always-200 route)', async () => {
    // This route always returns 200 (non-enumeration, see file header), so
    // authLimiter's skipSuccessfulRequests would never count a single
    // request toward the per-IP ceiling — a real, unlimited-volume mail-bomb
    // / enumeration-by-volume surface. It now mounts cheapLimiter, which
    // counts ALL requests per-IP regardless of status. RATE_LIMIT_CHEAP_MAX
    // is 120 in the test env — same pattern as the /logout flood test.
    let got429 = false;
    for (let i = 0; i < 130; i++) {
      const res = await requestReset('flood-target@example.com');
      expect(res.status === 200 || res.status === 429).toBe(true);
      if (res.status === 429) {
        expect(res.body.error.code).toBe('rate_limited');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('past the cooldown: issues a fresh token and invalidates the prior one', async () => {
    await register('fresh@example.com');
    const before = sent.length;
    await requestReset('fresh@example.com');
    const firstMsg = await waitForNextMail(before);
    const oldRaw = tokenFrom(firstMsg);

    // Age the prior token past the cooldown (DB-side, no sleeping).
    await pg.pool.query(
      `UPDATE password_reset_tokens SET created_at = now() - interval '10 minutes'`,
    );
    const afterFirst = sent.length;
    await requestReset('fresh@example.com');
    const secondMsg = await waitForNextMail(afterFirst);
    const newRaw = tokenFrom(secondMsg);
    expect(newRaw).not.toBe(oldRaw);

    // The superseded token is dead; the fresh one is live.
    const oldTry = await confirmReset(oldRaw, 'irrelevant-password-value-12');
    expect(oldTry.status).toBe(400);
    expect(oldTry.body.error.code).toBe('token_invalid');

    const live = await pg.pool.query(
      `SELECT 1 FROM password_reset_tokens
        WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    expect(live.rows).toHaveLength(1);
  });
});

describe('POST /auth/password-reset/confirm — reset + session revoke + single-use', () => {
  it('resets the password (old fails, new works) and revokes every existing session', async () => {
    const agent = await register('reset@example.com');
    // The register call above already authenticated `agent` (gates off) —
    // this cookie must be dead after the reset below.
    const before = sent.length;

    await requestReset('reset@example.com');
    const msg = await waitForNextMail(before);
    const raw = tokenFrom(msg);

    const confirm = await confirmReset(raw, NEW_PASSWORD);
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('reset');
    // No auto-login — the response carries no session cookie.
    expect(confirm.headers['set-cookie']).toBeUndefined();

    // The pre-reset session cookie is dead.
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(401);

    // Old password no longer works…
    const oldLogin = await request(t.app)
      .post('/auth/login')
      .send({ email: 'reset@example.com', password: PASSWORD });
    expect(oldLogin.status).toBe(401);

    // …the new one does.
    const newLogin = await request(t.app)
      .post('/auth/login')
      .send({ email: 'reset@example.com', password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.status).toBe('authenticated');
  });

  it('is single-use: a second confirm with the same token fails', async () => {
    await register('twice@example.com');
    const before = sent.length;
    await requestReset('twice@example.com');
    const msg = await waitForNextMail(before);
    const raw = tokenFrom(msg);

    const first = await confirmReset(raw, NEW_PASSWORD);
    expect(first.status).toBe(200);

    const second = await confirmReset(raw, 'yet-another-password-value');
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('token_invalid');

    // The first confirm's password change is the one that stuck — the
    // replay must not have overwritten it again.
    const login = await request(t.app)
      .post('/auth/login')
      .send({ email: 'twice@example.com', password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('expired token → 400 token_expired, password untouched', async () => {
    await register('stale@example.com');
    const before = sent.length;
    await requestReset('stale@example.com');
    const msg = await waitForNextMail(before);
    const raw = tokenFrom(msg);

    // Backdate: created_at moves too so ck_password_reset_expiry keeps holding.
    await pg.pool.query(
      `UPDATE password_reset_tokens
          SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'`,
    );
    const res = await confirmReset(raw, NEW_PASSWORD);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('token_expired');

    // The original password still works — nothing changed.
    const login = await request(t.app)
      .post('/auth/login')
      .send({ email: 'stale@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('an invalidated (superseded) token cannot be consumed; the superseding token still can', async () => {
    await register('superseded@example.com');
    const before = sent.length;
    await requestReset('superseded@example.com');
    const firstMsg = await waitForNextMail(before);
    const tokenA = tokenFrom(firstMsg);

    // Bypass the cooldown (DB-side, no sleeping) so a second request mints a
    // REAL second token, which supersedes the first via
    // `supersedeResetTokens` (stamps token A's `invalidated_at`).
    await pg.pool.query(
      `UPDATE password_reset_tokens SET created_at = now() - interval '10 minutes'`,
    );
    const afterFirst = sent.length;
    await requestReset('superseded@example.com');
    const secondMsg = await waitForNextMail(afterFirst);
    const tokenB = tokenFrom(secondMsg);
    expect(tokenB).not.toBe(tokenA);

    // SECURITY: the atomic consume UPDATE's WHERE gates on
    // `invalidated_at IS NULL` (not just `consumed_at IS NULL`) — token A is
    // invalidated (superseded), never consumed, and must still be rejected.
    const failA = await confirmReset(tokenA, NEW_PASSWORD);
    expect(failA.status).toBe(400);
    expect(failA.body.error.code).toBe('token_invalid');

    // The surviving, superseding token still works.
    const okB = await confirmReset(tokenB, NEW_PASSWORD);
    expect(okB.status).toBe(200);
    expect(okB.body.status).toBe('reset');

    const login = await request(t.app)
      .post('/auth/login')
      .send({ email: 'superseded@example.com', password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('unknown / malformed tokens → 400 token_invalid (shape gate + lookup miss)', async () => {
    const bogus = 'A'.repeat(43); // right shape, wrong token
    const res = await confirmReset(bogus, NEW_PASSWORD);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('token_invalid');

    const malformed = await confirmReset('short!', NEW_PASSWORD);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('token_invalid');
  });

  it('rejects a too-short replacement password (same floor as registration) without burning the token', async () => {
    await register('short@example.com');
    const before = sent.length;
    await requestReset('short@example.com');
    const msg = await waitForNextMail(before);
    const raw = tokenFrom(msg);

    const res = await confirmReset(raw, 'tooshort');
    expect(res.status).toBe(400);

    // The token must still be live — a rejected body must not burn it.
    const live = await pg.pool.query(
      `SELECT 1 FROM password_reset_tokens
        WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    expect(live.rows).toHaveLength(1);

    // And it can still be used with a valid password afterward.
    const ok = await confirmReset(raw, NEW_PASSWORD);
    expect(ok.status).toBe(200);
  });
});
