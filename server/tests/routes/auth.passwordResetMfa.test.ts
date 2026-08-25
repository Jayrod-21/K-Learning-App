/**
 * Phase 2.4 MFA-hardening audit — MFA_AUDIT.md check 6: password reset does
 * NOT bypass MFA. Code-level reasoning already held (passwordReset.ts never
 * writes to user_totp and never mints a session on confirm), but no existing
 * test combined `mfaRequired: true` with a live password-reset round trip:
 * tests/routes/auth.passwordReset.test.ts intentionally runs with
 * mfaRequired:false (it says so explicitly — "the MFA suites" were supposed
 * to cover the interplay), and no MFA suite test actually does a password
 * reset. This file closes that gap end-to-end against a real Postgres.
 *
 * Builds the app with mfaRequired: true (mirrors auth.mfa.test.ts;
 * emailVerificationRequired: false isolates the MFA gate the same way that
 * suite does) and drives: enroll a confirmed TOTP factor -> request + consume
 * a password reset -> assert the confirm response mints NO session (no
 * auto-login) and the prior session is dead (proving the revoke fired) -> log
 * in with the NEW password and assert the response is an MFA CHALLENGE, never
 * a session -> complete that challenge with the pre-existing (untouched) TOTP
 * factor, proving the reset neither bypassed nor disturbed the MFA gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generate as otplibGenerate } from 'otplib';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { hashPassword } from '../../src/auth/passwords.js';
import { generateTotp } from '../../src/auth/totp.js';
import { decryptSecret } from '../../src/crypto/encryption.js';
import { _setMailTransportForTesting, type MailMessage } from '../../src/services/mail.js';

/** RFC 6238 step (seconds), matching PERIOD_SECONDS in src/auth/totp.ts. */
const STEP_SECONDS = 30;

/**
 * Mint the TOTP code for the NEXT time-step — same reasoning as
 * auth.mfa.test.ts's nextStepCode: the enrollment confirm seeded
 * `last_used_step` at the confirming step, so a login replaying that SAME
 * step would be (correctly) rejected by the monotonic replay guard. A
 * next-step code is inside the route's +-1 window and strictly greater than
 * the seeded step, so a healthy post-reset login MUST accept it.
 */
async function nextStepCode(secret: string): Promise<string> {
  const epochSeconds = Math.floor(Date.now() / 1000) + STEP_SECONDS;
  return otplibGenerate({ secret, epoch: epochSeconds });
}

let pg: PgHandle;
let t: TestApp;

const EMAIL = 'mfa-pwreset@example.com';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a whole new passphrase entirely';

/** Every message the capture transport "sent" since the last beforeEach. */
let sent: MailMessage[] = [];

/** Extract the raw reset token from a captured email's text body. */
function tokenFrom(msg: MailMessage): string {
  const m = /token=([A-Za-z0-9_-]+)/.exec(msg.text);
  expect(m, 'reset email must contain a token link').not.toBeNull();
  return m![1]!;
}

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
  // emailVerificationRequired:false isolates the MFA gate — same rationale as
  // auth.mfa.test.ts: this suite drives the enrollment branch via /auth/login
  // and must not also trip the F-006 email-verification block.
  t = buildTestApp({
    connectionString: pg.connectionString,
    mfaRequired: true,
    emailVerificationRequired: false,
  });
  installCaptureTransport();
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE mfa_login_challenges, user_recovery_codes, user_totp, password_reset_tokens, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
  sent = [];
  installCaptureTransport();
});

/** Seed the single account directly (registration may be gated in real deploys). */
async function seedUser(): Promise<number> {
  const hash = await hashPassword(PASSWORD);
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [EMAIL, hash],
  );
  return Number(rows[0]!.id);
}

/**
 * Drive a full enrollment from a fresh login: login -> enrollment_required ->
 * enroll -> confirm. Mirrors auth.mfa.test.ts's enrollFromLogin. Returns the
 * authenticated agent + user id.
 */
async function enrollFromLogin(): Promise<{
  agent: ReturnType<typeof request.agent>;
  userId: number;
}> {
  const userId = await seedUser();
  const agent = request.agent(t.app);

  const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
  expect(login.status).toBe(200);
  expect(login.body.status).toBe('enrollment_required');
  const challengeToken = login.body.challenge_token as string;
  expect(challengeToken).toBeTruthy();

  const enroll = await agent.post('/auth/mfa/enroll').send({ challenge_token: challengeToken });
  expect(enroll.status).toBe(200);
  const secret = enroll.body.secret as string;
  expect(secret).toBeTruthy();

  const code = await generateTotp(secret);
  const confirm = await agent
    .post('/auth/mfa/confirm')
    .send({ challenge_token: challengeToken, code });
  expect(confirm.status).toBe(200);
  expect(confirm.body.status).toBe('authenticated');
  expect(confirm.headers['set-cookie']).toBeDefined();

  return { agent, userId };
}

async function requestReset(email: string): Promise<request.Response> {
  return request(t.app).post('/auth/password-reset/request').send({ email });
}

async function confirmReset(token: string, password: string): Promise<request.Response> {
  return request(t.app).post('/auth/password-reset/confirm').send({ token, password });
}

describe('password reset does NOT bypass MFA (MFA_AUDIT.md check 6)', () => {
  it('revokes the prior session, mints no session on confirm, and the new password still requires MFA at login', async () => {
    const { agent, userId } = await enrollFromLogin();

    // The pre-reset session is live right now — sanity check before we kill it.
    const meBefore = await agent.get('/auth/me');
    expect(meBefore.status).toBe(200);

    const before = sent.length;
    await requestReset(EMAIL);
    const msg = await waitForNextMail(before);
    const token = tokenFrom(msg);

    const confirm = await confirmReset(token, NEW_PASSWORD);
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('reset');
    // No auto-login: the discriminant a successful authenticated response
    // carries ('authenticated' + a Set-Cookie session) is absent here.
    expect(confirm.body.status).not.toBe('authenticated');
    expect(confirm.headers['set-cookie']).toBeUndefined();

    // The reset revoked every prior session for this user — the pre-reset
    // cookie the enrollment step minted is now dead.
    const meAfter = await agent.get('/auth/me');
    expect(meAfter.status).toBe(401);

    // The old password no longer authenticates.
    const oldLogin = await request(t.app)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    expect(oldLogin.status).toBe(401);

    // THE invariant this test exists to prove: logging in with the NEW
    // password is an MFA CHALLENGE, never a session — a bypass would instead
    // return status:'authenticated' with a Set-Cookie header right here.
    const newLogin = await request(t.app)
      .post('/auth/login')
      .send({ email: EMAIL, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.status).toBe('mfa_required');
    expect(newLogin.body.status).not.toBe('authenticated');
    expect(newLogin.headers['set-cookie']).toBeUndefined();
    const challengeToken = newLogin.body.challenge_token as string;
    expect(challengeToken).toBeTruthy();

    // The reset did not disturb (or wipe) the TOTP factor either — completing
    // the SAME challenge with the pre-existing factor authenticates cleanly,
    // proving the gate is intact end-to-end, not merely "not auto-bypassed".
    const { rows } = await pg.pool.query<{ secret_encrypted: string }>(
      `SELECT secret_encrypted FROM user_totp WHERE user_id = $1`,
      [userId],
    );
    const secret = decryptSecret(rows[0]!.secret_encrypted);
    const code = await nextStepCode(secret);
    const verify = await agent
      .post('/auth/login/totp')
      .send({ challenge_token: challengeToken, code });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('authenticated');
    expect(verify.headers['set-cookie']).toBeDefined();
    expect(verify.body.user.id).toBe(userId);
  });
});
