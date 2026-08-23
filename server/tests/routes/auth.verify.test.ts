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
 *     login; POST only (the GET ?token= variant was removed — a live secret
 *     in a query string lands in access logs; the link now carries the token
 *     in the URL FRAGMENT, which never reaches any server);
 *   - expired token → token_expired; garbage/consumed/superseded → token_invalid;
 *   - replayed token cannot verify a LATER address (email change resets), and
 *     a token is BOUND to the address it attests — a live old-address token
 *     can never stamp a new address (fix-pass SF-1);
 *   - email change: stamp reset + supersession + fresh issue are ONE atomic
 *     transaction, and the send is cooldown-gated (fix-pass SF-1/S1);
 *   - resend: generic non-enumerating 200 in every case, per-user cooldown
 *     ATOMIC with issuance (a concurrent burst mints exactly once — SF-4/S2),
 *     supersedes prior tokens; concurrent issuance leaves exactly one live
 *     token (SF-3);
 *   - gate × MFA interplay: unverified stops BEFORE any challenge is minted;
 *     verified users get the untouched MFA flow (route S5);
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
import { issueVerificationToken } from '../../src/auth/emailVerification.js';

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
    // mfaRequired:false isolates the verification gate — post-verify login
    // must mint a session directly, not divert into MFA enrollment (now on by
    // default, audit §3.1). The verify×MFA interplay has its own app below.
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
    // SECURITY (fix-pass SF-2): the token rides the URL FRAGMENT — it must
    // never appear in a query string, where proxies/access logs would see it.
    expect(sent[0]!.text).toContain('/verify-email#token=');
    expect(sent[0]!.text).not.toContain('?token=');

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

describe('POST /auth/verify — token validation', () => {
  it('the GET ?token= variant is GONE (a live secret must never ride a query string)', async () => {
    // Fix-pass SF-2 / route N1: GET /auth/verify?token= put the raw token in
    // request lines that nginx access logs retain. The route was removed; the
    // only consume path is the POST body relay from the SPA's fragment read.
    await register('noget@example.com');
    await waitForMail(1);
    const raw = tokenFrom(sent[0]!);
    const res = await request(t.app).get('/auth/verify').query({ token: raw });
    expect(res.status).toBe(404);
    // The token was NOT consumed by the rejected GET…
    const ok = await request(t.app).post('/auth/verify').send({ token: raw });
    expect(ok.body.status).toBe('verified');
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
    // Age the register-time token past the resend cooldown so the email
    // change's fresh send is not suppressed (fix-pass S1: the change path
    // honors the same per-user cooldown as resend).
    await pg.pool.query(
      `UPDATE email_verification_tokens SET created_at = now() - interval '10 minutes'`,
    );
    const patch = await agent
      .patch('/auth/me')
      .send({ email: 'replay-new@example.com', expected_version: 1 });
    expect(patch.status).toBe(200);
    // The email change reset the stamp…
    expect(patch.body.user.email_verified).toBe(false);
    // …and sent a fresh verification to the NEW address.
    await waitForMail(2);
    expect(sent[1]!.to).toBe('replay-new@example.com');
    // SF-1: the fresh token row is BOUND to the address it attests.
    const bound = await pg.pool.query<{ email: string }>(
      `SELECT email::text AS email FROM email_verification_tokens
        WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    expect(bound.rows).toHaveLength(1);
    expect(bound.rows[0]!.email).toBe('replay-new@example.com');

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

  it('a LIVE token mailed to the OLD address can never verify a NEW one, even if its supersession is lost (SF-1 binding)', async () => {
    // The crash-window invariant: PATCH /me runs stamp-reset + supersession +
    // fresh issue in ONE transaction, so a live old-address token "should"
    // be impossible. This test assumes the worst anyway — it RESURRECTS the
    // old token (simulating a lost supersession / code regression) and proves
    // the token↔address binding still refuses to stamp the new address.
    await register('bind@example.com');
    await waitForMail(1);
    const oldRaw = tokenFrom(sent[0]!); // live, unconsumed, mailed to the OLD address

    // Verify via a bypass stamp so login works, then change the email.
    await pg.pool.query(`UPDATE users SET email_verified_at = now()`);
    const agent = request.agent(t.app);
    await agent
      .post('/auth/login')
      .send({ email: 'bind@example.com', password: PASSWORD });
    const patch = await agent
      .patch('/auth/me')
      .send({ email: 'bind-new@example.com', expected_version: 1 });
    expect(patch.status).toBe(200);
    expect(patch.body.user.email_verified).toBe(false);

    // Simulate the lost supersession: resurrect the old-address token.
    await pg.pool.query(
      `UPDATE email_verification_tokens
          SET invalidated_at = NULL, consumed_at = NULL
        WHERE email = 'bind@example.com'`,
    );

    // It is live, unconsumed, unexpired — and must STILL be refused, because
    // it attests an address the account no longer has.
    const res = await request(t.app).post('/auth/verify').send({ token: oldRaw });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('token_invalid');
    const u = await pg.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users',
    );
    expect(u.rows[0]!.email_verified_at).toBeNull();
  });
});

describe('PATCH /auth/me email change — cooldown + atomic supersession (S1/SF-1)', () => {
  it('rapid email flips send at most ONE email per cooldown window (no authenticated mail-bomb)', async () => {
    await register('flip@example.com');
    await waitForMail(1);
    await pg.pool.query(`UPDATE users SET email_verified_at = now()`);
    const agent = request.agent(t.app);
    await agent
      .post('/auth/login')
      .send({ email: 'flip@example.com', password: PASSWORD });

    // Age the register token so the FIRST change is allowed to send…
    await pg.pool.query(
      `UPDATE email_verification_tokens SET created_at = now() - interval '10 minutes'`,
    );
    const first = await agent
      .patch('/auth/me')
      .send({ email: 'victim@example.com', expected_version: 1 });
    expect(first.status).toBe(200);
    await waitForMail(2);
    expect(sent[1]!.to).toBe('victim@example.com');

    // …then flip again immediately: INSIDE the cooldown → no send, no token.
    const second = await agent
      .patch('/auth/me')
      .send({ email: 'flip@example.com', expected_version: 2 });
    expect(second.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(2); // register + first change only

    // Atomic supersession held even for the suppressed change: the token for
    // the abandoned 'victim' address is dead, and NO live token exists.
    const live = await pg.pool.query(
      `SELECT 1 FROM email_verification_tokens
        WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    expect(live.rows).toHaveLength(0);

    // The suppressed change still reset the stamp (never skipped).
    const u = await pg.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users',
    );
    expect(u.rows[0]!.email_verified_at).toBeNull();

    // And the first-change token cannot verify anything anymore (superseded +
    // bound to an address the account no longer has).
    const victimRaw = tokenFrom(sent[1]!);
    const replay = await request(t.app).post('/auth/verify').send({ token: victimRaw });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('token_invalid');
  });
});

describe('issuance concurrency (SF-3/SF-4)', () => {
  it('two concurrent issues leave EXACTLY one live token (per-user serialization)', async () => {
    await register('race@example.com');
    await waitForMail(1);
    const { rows } = await pg.pool.query<{ id: string }>('SELECT id FROM users');
    const userId = Number(rows[0]!.id);

    // Fire the module API concurrently — the per-user row lock serializes the
    // supersede+insert pairs, so the loser supersedes the winner's token.
    await Promise.all([
      issueVerificationToken(userId, 'race@example.com'),
      issueVerificationToken(userId, 'race@example.com'),
    ]);

    const live = await pg.pool.query(
      `SELECT 1 FROM email_verification_tokens
        WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    expect(live.rows).toHaveLength(1);
    // All three issued rows exist (audit trail preserved) — two superseded.
    const all = await pg.pool.query('SELECT 1 FROM email_verification_tokens');
    expect(all.rows).toHaveLength(3);
  });

  it('a concurrent resend burst mints exactly ONE token / sends ONE email (atomic cooldown)', async () => {
    await register('burst@example.com');
    await waitForMail(1);
    // Age past the cooldown so the burst is eligible to send.
    await pg.pool.query(
      `UPDATE email_verification_tokens SET created_at = now() - interval '10 minutes'`,
    );

    const BURST = 5;
    const responses = await Promise.all(
      Array.from({ length: BURST }, () =>
        request(t.app).post('/auth/verify/resend').send({ email: 'burst@example.com' }),
      ),
    );
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: 'ok' }); // still non-enumerating
    }

    // The issue+send runs detached after each response; wait for the single
    // winner, then give any (buggy) extra sends a tick to land.
    await waitForMail(2);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(2); // register + exactly one resend

    const tokens = await pg.pool.query(
      `SELECT 1 FROM email_verification_tokens`,
    );
    expect(tokens.rows).toHaveLength(2); // register token + one resend token
    const live = await pg.pool.query(
      `SELECT 1 FROM email_verification_tokens
        WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    expect(live.rows).toHaveLength(1);
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

describe('gate × MFA interplay (route S5) — gate BEFORE any challenge, MFA untouched after', () => {
  it('unverified + correct password + MFA_REQUIRED → email_unverified with NO challenge minted; verified → normal enrollment flow', async () => {
    const mfaApp = buildTestApp({
      connectionString: pg.connectionString,
      emailVerificationRequired: true,
      mfaRequired: true,
    });
    installCaptureTransport();
    try {
      const reg = await request(mfaApp.app)
        .post('/auth/register')
        .send({ email: 'mfa@example.com', password: PASSWORD });
      expect(reg.status).toBe(201);
      expect(reg.body.status).toBe('verification_required');

      // Unverified + CORRECT password: the gate answers BEFORE the MFA
      // machinery — typed email_unverified, no challenge token in the body,
      // and no challenge row minted in the DB.
      const gated = await request(mfaApp.app)
        .post('/auth/login')
        .send({ email: 'mfa@example.com', password: PASSWORD });
      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe('email_unverified');
      expect(gated.body.challenge_token).toBeUndefined();
      const challenges = await pg.pool.query('SELECT 1 FROM mfa_login_challenges');
      expect(challenges.rows).toHaveLength(0);

      // Wrong password on the same unverified account stays the generic 401
      // (the gate cannot be used to probe verification status).
      const wrong = await request(mfaApp.app)
        .post('/auth/login')
        .send({ email: 'mfa@example.com', password: 'totally-wrong-password' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).not.toBe('email_unverified');

      // Verify → the untouched mandatory-MFA flow takes over: no confirmed
      // factor, so login answers enrollment_required WITH a challenge.
      await waitForMail(1);
      const raw = tokenFrom(sent[0]!);
      const v = await request(mfaApp.app).post('/auth/verify').send({ token: raw });
      expect(v.body.status).toBe('verified');

      const login = await request(mfaApp.app)
        .post('/auth/login')
        .send({ email: 'mfa@example.com', password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.status).toBe('enrollment_required');
      expect(typeof login.body.challenge_token).toBe('string');
      expect(login.headers['set-cookie']).toBeUndefined(); // still no session pre-MFA
      const minted = await pg.pool.query('SELECT 1 FROM mfa_login_challenges');
      expect(minted.rows).toHaveLength(1);
    } finally {
      await teardownTestApp(mfaApp);
      installCaptureTransport();
    }
  });
});

describe('EMAIL_VERIFICATION_REQUIRED=false (operator kill-switch)', () => {
  it('register issues a session directly and unverified login succeeds; /me shows email_verified=false', async () => {
    const off = buildTestApp({
      connectionString: pg.connectionString,
      emailVerificationRequired: false,
      // mfaRequired:false so this kill-switch test sees the legacy direct
      // session (register→session, unverified login succeeds) without the
      // now-default MFA enrollment gate (audit §3.1).
      mfaRequired: false,
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
