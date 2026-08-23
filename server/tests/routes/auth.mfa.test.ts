/**
 * Integration tests for the Pass Login TOTP 2FA flow (PASS_LOGIN_CONTRACT B9).
 *
 * Spins up a real Postgres via testcontainers and walks the full two-step login
 * + enrollment + recovery + lockout + challenge lifecycle. The app is built with
 * `mfaRequired: true` so the mandatory-MFA branches are exercised (the legacy
 * direct-session tests live in tests/auth.test.ts with mfaRequired off).
 *
 * TOTP codes are produced server-side via the same otplib wrapper the route
 * verifies against — no real authenticator app or wall-clock coupling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { generate as otplibGenerate } from 'otplib';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { hashPassword } from '../../src/auth/passwords.js';
import { generateTotp } from '../../src/auth/totp.js';

/** RFC 6238 step (seconds), matching PERIOD_SECONDS in src/auth/totp.ts. */
const STEP_SECONDS = 30;

/**
 * Mint the TOTP code for the NEXT time-step. The confirm step seeds
 * `last_used_step` with the confirming step; a login replaying the SAME step is
 * (correctly) rejected by the monotonic guard. A next-step code is BOTH inside
 * the route's ±1 acceptance window AND strictly greater than the seeded step, so
 * a healthy login MUST accept it — letting the happy-path test assert a hard 200
 * instead of "200-or-rejected". `epoch` is Unix SECONDS (otplib @otplib/totp).
 */
async function nextStepCode(secret: string): Promise<string> {
  const epochSeconds = Math.floor(Date.now() / 1000) + STEP_SECONDS;
  return otplibGenerate({ secret, epoch: epochSeconds });
}

let pg: PgHandle;
let t: TestApp;

const EMAIL = 'mfa@example.com';
const PASSWORD = 'correct horse battery staple';

beforeAll(async () => {
  pg = await startPostgres();
  // emailVerificationRequired:false isolates the MFA gate — this suite drives
  // the enrollment branch via /auth/login and must not also trip the F-006
  // email-verification block (now on by default, audit §3.1).
  t = buildTestApp({
    connectionString: pg.connectionString,
    mfaRequired: true,
    emailVerificationRequired: false,
  });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE mfa_login_challenges, user_recovery_codes, user_totp, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
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

/** Read the live secret for a user's confirmed-or-pending factor (test helper). */
async function decryptedSecret(userId: number): Promise<string> {
  const { rows } = await pg.pool.query<{ secret_encrypted: string }>(
    `SELECT secret_encrypted FROM user_totp WHERE user_id = $1`,
    [userId],
  );
  // Decrypt via the app's own module so the test key path matches the app.
  const { decryptSecret } = await import('../../src/crypto/encryption.js');
  return decryptSecret(rows[0]!.secret_encrypted);
}

/**
 * Drive a full enrollment from a fresh login: login → enrollment_required →
 * enroll → confirm. Returns the authenticated agent + recovery codes.
 */
async function enrollFromLogin(): Promise<{
  agent: ReturnType<typeof request.agent>;
  userId: number;
  recoveryCodes: string[];
}> {
  const userId = await seedUser();
  const agent = request.agent(t.app);

  const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
  expect(login.status).toBe(200);
  expect(login.body.status).toBe('enrollment_required');
  const challengeToken = login.body.challenge_token as string;
  expect(challengeToken).toBeTruthy();
  // No session cookie at the enrollment step.
  expect(login.headers['set-cookie']).toBeUndefined();

  const enroll = await agent.post('/auth/mfa/enroll').send({ challenge_token: challengeToken });
  expect(enroll.status).toBe(200);
  expect(enroll.body.secret).toBeTruthy();
  expect(enroll.body.otpauth_uri).toContain('otpauth://totp/');

  const code = await generateTotp(enroll.body.secret as string);
  const confirm = await agent
    .post('/auth/mfa/confirm')
    .send({ challenge_token: challengeToken, code });
  expect(confirm.status).toBe(200);
  expect(confirm.body.status).toBe('authenticated');
  expect(Array.isArray(confirm.body.recovery_codes)).toBe(true);
  expect(confirm.body.recovery_codes.length).toBeGreaterThan(0);
  // Session issued on confirm.
  expect(confirm.headers['set-cookie']).toBeDefined();

  return { agent, userId, recoveryCodes: confirm.body.recovery_codes as string[] };
}

describe('enroll → confirm → login(totp) full lifecycle', () => {
  it('forces enrollment on first login, then logs in with a TOTP code', async () => {
    const { userId } = await enrollFromLogin();

    // A fresh login now demands an mfa code (confirmed factor exists).
    const agent2 = request.agent(t.app);
    const login = await agent2.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('mfa_required');
    expect(login.headers['set-cookie']).toBeUndefined();
    const challengeToken = login.body.challenge_token as string;

    // SF3: use a NEXT-STEP code so the monotonic replay guard cannot reject it
    // (the confirm seeded last_used_step at the confirming step). A next-step code
    // is both inside the route's ±1 window AND strictly greater than the seeded
    // step, so a healthy flow MUST authenticate. This makes the assertion HARD —
    // a replay-guard off-by-one or any flow regression now fails the test instead
    // of hiding in an "else" branch.
    const secret = await decryptedSecret(userId);
    const code = await nextStepCode(secret);
    const verify = await agent2.post('/auth/login/totp').send({ challenge_token: challengeToken, code });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('authenticated');
    expect(verify.headers['set-cookie']).toBeDefined();
    expect(verify.body.user.id).toBe(userId);

    // The served step is recorded as the new replay high-water-mark (the guard
    // advanced past the confirm step).
    const { rows } = await pg.pool.query<{ last_used_step: string | null }>(
      `SELECT last_used_step FROM user_totp WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]!.last_used_step).not.toBeNull();
  });
});

describe('POST /auth/login branching', () => {
  it('returns enrollment_required when the user has no confirmed TOTP', async () => {
    await seedUser();
    const res = await request(t.app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('enrollment_required');
    expect(res.body.challenge_token).toBeTruthy();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns mfa_required once a confirmed TOTP exists', async () => {
    await enrollFromLogin();
    const res = await request(t.app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('mfa_required');
  });

  it('still 401s on a wrong password (before any branch)', async () => {
    await seedUser();
    const res = await request(t.app).post('/auth/login').send({ email: EMAIL, password: 'wrong password here' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('replay guard (monotonic step)', () => {
  it('rejects the same TOTP code used twice', async () => {
    const userId = await seedUser();
    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const challengeToken = login.body.challenge_token as string;
    const enroll = await agent.post('/auth/mfa/enroll').send({ challenge_token: challengeToken });
    const secret = enroll.body.secret as string;
    const code = await generateTotp(secret);
    await agent.post('/auth/mfa/confirm').send({ challenge_token: challengeToken, code });

    // The code used to confirm seeded last_used_step. A fresh login that submits
    // the SAME code must be rejected by the replay guard.
    const agent2 = request.agent(t.app);
    const login2 = await agent2.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const chal2 = login2.body.challenge_token as string;
    const replay = await agent2.post('/auth/login/totp').send({ challenge_token: chal2, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('invalid_code');
    // Confirm last_used_step is set (the guard has a high-water mark).
    const { rows } = await pg.pool.query<{ last_used_step: string | null }>(
      `SELECT last_used_step FROM user_totp WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]!.last_used_step).not.toBeNull();
  });
});

describe('recovery codes', () => {
  it('logs in with a recovery code, then rejects its reuse and decrements the count', async () => {
    const { recoveryCodes } = await enrollFromLogin();
    const oneCode = recoveryCodes[0]!;

    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const challengeToken = login.body.challenge_token as string;
    const ok = await agent.post('/auth/login/totp').send({ challenge_token: challengeToken, code: oneCode });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('authenticated');

    // Reuse the same recovery code on a new challenge → rejected.
    const agent2 = request.agent(t.app);
    const login2 = await agent2.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const chal2 = login2.body.challenge_token as string;
    const reuse = await agent2.post('/auth/login/totp').send({ challenge_token: chal2, code: oneCode });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('invalid_code');

    // Remaining count dropped by exactly one.
    const status = await agent.get('/auth/mfa/status');
    expect(status.status).toBe(200);
    expect(status.body.recovery_codes_remaining).toBe(recoveryCodes.length - 1);
  });
});

describe('concurrency (no double-spend / no recovery-set desync)', () => {
  // SF1: two concurrent /login/totp carry the SAME challenge but TWO DIFFERENT
  // valid recovery codes. The recovery spend and the challenge consume must be
  // atomic together: exactly one request gets a session, exactly one code is
  // spent, and the loser's code is rolled back to UNUSED (not burned for nothing).
  it('racing two distinct recovery codes on one challenge spends exactly one code and issues exactly one session', async () => {
    const { userId, recoveryCodes } = await enrollFromLogin();
    expect(recoveryCodes.length).toBeGreaterThanOrEqual(2);
    const codeA = recoveryCodes[0]!;
    const codeB = recoveryCodes[1]!;

    // One login → one challenge, then fire both submits at that single challenge.
    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const challengeToken = login.body.challenge_token as string;

    const [resA, resB] = await Promise.all([
      request(t.app).post('/auth/login/totp').send({ challenge_token: challengeToken, code: codeA }),
      request(t.app).post('/auth/login/totp').send({ challenge_token: challengeToken, code: codeB }),
    ]);

    // Exactly one 200 (a session) and one 401 challenge_invalid (the consume loser).
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 401]);
    const winner = resA.status === 200 ? resA : resB;
    const loser = resA.status === 200 ? resB : resA;
    expect(winner.body.status).toBe('authenticated');
    expect(winner.headers['set-cookie']).toBeDefined();
    expect(loser.body.error.code).toBe('challenge_invalid');

    // Exactly ONE recovery code is spent — the loser's code rolled back to unused.
    const { rows } = await pg.pool.query<{ used: string; unused: string }>(
      `SELECT count(*) FILTER (WHERE used_at IS NOT NULL)::text AS used,
              count(*) FILTER (WHERE used_at IS NULL)::text AS unused
         FROM user_recovery_codes WHERE user_id = $1`,
      [userId],
    );
    expect(Number(rows[0]!.used)).toBe(1);
    expect(Number(rows[0]!.unused)).toBe(recoveryCodes.length - 1);

    // The loser's code is STILL usable on a fresh challenge (proof it wasn't burned).
    const loserCode = winner === resA ? codeB : codeA;
    const agent2 = request.agent(t.app);
    const login2 = await agent2.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const chal2 = login2.body.challenge_token as string;
    const retry = await agent2.post('/auth/login/totp').send({ challenge_token: chal2, code: loserCode });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('authenticated');
  });

  // SF2: two concurrent /mfa/confirm on the SAME enroll challenge. Only the
  // request that WINS the `confirmed_at IS NULL` flip may issue recovery codes;
  // the loser must NOT re-issue. The shown codes MUST match the stored hashes so
  // the user is never handed codes that fail at login.
  it('racing two confirms on one enroll challenge persists exactly the winner’s recovery codes', async () => {
    const userId = await seedUser();
    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(login.body.status).toBe('enrollment_required');
    const challengeToken = login.body.challenge_token as string;

    const enroll = await agent.post('/auth/mfa/enroll').send({ challenge_token: challengeToken });
    const secret = enroll.body.secret as string;
    const code = await generateTotp(secret);

    const [resA, resB] = await Promise.all([
      request(t.app).post('/auth/mfa/confirm').send({ challenge_token: challengeToken, code }),
      request(t.app).post('/auth/mfa/confirm').send({ challenge_token: challengeToken, code }),
    ]);

    // Exactly one winner (authenticated + recovery codes); the loser is rejected
    // with NO session and NO codes. The race is legitimately non-deterministic
    // about WHICH rejection the loser hits — both are correct and leak nothing:
    //   - 401 challenge_invalid: it saw the pending row but lost the
    //     `confirmed_at IS NULL` UPDATE flip (auth.ts:~597).
    //   - 400 no_pending_enrollment: its SELECT ran AFTER the winner flipped
    //     `confirmed_at`, so it never saw a pending row (auth.ts:814).
    // Assert the invariant (one 200 winner, one rejected loser with no codes),
    // not one specific loser status — pinning a single code makes this flaky.
    const winner = resA.status === 200 ? resA : resB;
    const loser = resA.status === 200 ? resB : resA;
    expect(winner.status).toBe(200);
    expect([400, 401]).toContain(loser.status);
    expect(winner.body.status).toBe('authenticated');
    expect(Array.isArray(winner.body.recovery_codes)).toBe(true);
    expect(['challenge_invalid', 'no_pending_enrollment']).toContain(
      loser.body.error.code,
    );
    expect(loser.body.recovery_codes).toBeUndefined();

    // The codes SHOWN to the winner are exactly the codes STORED — log in with
    // every one of them to prove the shown set is the live set (no desync).
    const shown = winner.body.recovery_codes as string[];
    const { rows } = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    expect(Number(rows[0]!.n)).toBe(shown.length);

    for (const recoveryCode of shown) {
      const a = request.agent(t.app);
      const lg = await a.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
      const ch = lg.body.challenge_token as string;
      const ok = await a.post('/auth/login/totp').send({ challenge_token: ch, code: recoveryCode });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('authenticated');
    }
  });
});

describe('account lockout (B-LOCK)', () => {
  it('locks the account after TOTP_MAX_FAILED_ATTEMPTS bad codes and 423s', async () => {
    await enrollFromLogin();
    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const challengeToken = login.body.challenge_token as string;

    let locked = false;
    // Default TOTP_MAX_FAILED_ATTEMPTS = 5; loop comfortably past it.
    for (let i = 0; i < 8; i += 1) {
      // Reset the failures-only IP limiter so the lockout (not the rate limit) is
      // what trips. (resetLimiters clears the per-IP bucket.)
      resetLimiters();
      const res = await agent
        .post('/auth/login/totp')
        .send({ challenge_token: challengeToken, code: '000000' });
      if (res.status === 423) {
        expect(res.body.error.code).toBe('account_locked');
        expect(typeof res.body.error.retry_after).toBe('number');
        locked = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(locked).toBe(true);
  });
});

describe('challenge single-use / expiry / purpose', () => {
  it('rejects a consumed challenge on a second verify', async () => {
    const { recoveryCodes } = await enrollFromLogin();
    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const challengeToken = login.body.challenge_token as string;
    const first = await agent
      .post('/auth/login/totp')
      .send({ challenge_token: challengeToken, code: recoveryCodes[0]! });
    expect(first.status).toBe(200);
    // The challenge is now consumed — reusing it fails even with a valid code.
    const second = await agent
      .post('/auth/login/totp')
      .send({ challenge_token: challengeToken, code: recoveryCodes[1]! });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('challenge_invalid');
  });

  it('rejects a wrong-purpose token (enroll token at the totp endpoint)', async () => {
    await seedUser();
    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    // This is an 'enroll'-purpose challenge.
    const enrollToken = login.body.challenge_token as string;
    const res = await agent.post('/auth/login/totp').send({ challenge_token: enrollToken, code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('challenge_invalid');
  });

  it('rejects an expired challenge', async () => {
    await enrollFromLogin();
    const agent = request.agent(t.app);
    const login = await agent.post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const challengeToken = login.body.challenge_token as string;
    // Force-expire every active challenge. We age BOTH created_at and
    // expires_at backwards so the row stays consistent with the born-valid
    // invariant ck_mfa_chal_expiry (expires_at > created_at, mirroring
    // sessions' ck_sessions_expires_after_issue). The route's active-lookup
    // predicate is `expires_at > now()`, so an expires_at of now()-1min is
    // already expired regardless of created_at. (Setting only expires_at into
    // the past would violate the CHECK — that constraint is a genuine
    // data-integrity invariant, not a bug, so we simulate expiry the way it
    // actually happens: the clock moves forward past a still-ordered window.)
    await pg.pool.query(
      `UPDATE mfa_login_challenges
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 minute'`,
    );
    const res = await agent.post('/auth/login/totp').send({ challenge_token: challengeToken, code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('challenge_invalid');
  });
});

describe('registration gating', () => {
  it('returns 403 registration_closed when REGISTRATION_ENABLED=false', async () => {
    const closed = buildTestApp({
      connectionString: pg.connectionString,
      mfaRequired: true,
      emailVerificationRequired: false,
      registrationEnabled: false,
    });
    try {
      const res = await request(closed.app)
        .post('/auth/register')
        .send({ email: 'new@example.com', password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('registration_closed');
    } finally {
      await teardownTestApp(closed);
    }
    // Rebuild the shared app so the rest of the suite keeps the default config.
    // emailVerificationRequired:false isolates the MFA gate — this suite drives
    // the enrollment branch via /auth/login and must not also trip the F-006
    // email-verification block (now on by default, audit §3.1).
    t = buildTestApp({
      connectionString: pg.connectionString,
      mfaRequired: true,
      emailVerificationRequired: false,
    });
  });
});

describe('encryption at rest', () => {
  it('stores the TOTP secret encrypted (not plaintext base32) and round-trips', async () => {
    const { userId } = await enrollFromLogin();
    const { rows } = await pg.pool.query<{ secret_encrypted: string }>(
      `SELECT secret_encrypted FROM user_totp WHERE user_id = $1`,
      [userId],
    );
    const stored = rows[0]!.secret_encrypted;
    // Stored value is base64 of iv|tag|ct — never a readable base32 secret.
    expect(stored).not.toMatch(/^[A-Z2-7]+=*$/);
    const secret = await decryptedSecret(userId);
    expect(secret).toMatch(/^[A-Z2-7]+=*$/); // decrypt yields the base32 secret
  });
});

describe('re-enroll via session + password', () => {
  it('rotates the secret and issues new recovery codes (keeps the session)', async () => {
    const { agent, userId, recoveryCodes } = await enrollFromLogin();
    const before = await decryptedSecret(userId);

    const enroll = await agent.post('/auth/mfa/enroll').send({ password: PASSWORD });
    expect(enroll.status).toBe(200);
    const newSecret = enroll.body.secret as string;
    expect(newSecret).not.toBe(before);

    const code = await generateTotp(newSecret);
    const confirm = await agent.post('/auth/mfa/confirm').send({ password: PASSWORD, code });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('updated');
    expect(Array.isArray(confirm.body.recovery_codes)).toBe(true);
    // New recovery set is different from the old one.
    expect(confirm.body.recovery_codes[0]).not.toBe(recoveryCodes[0]);

    // The rotated secret is live.
    const after = await decryptedSecret(userId);
    expect(after).toBe(newSecret);
    expect(after).not.toBe(before);

    // Wrong password is rejected at re-enroll.
    const bad = await agent.post('/auth/mfa/enroll').send({ password: 'not the password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_credentials');
  });
});

describe('GET /auth/mfa/status', () => {
  it('requires auth', async () => {
    const res = await request(t.app).get('/auth/mfa/status');
    expect(res.status).toBe(401);
  });

  it('reports enabled + remaining recovery count once enrolled', async () => {
    const { agent, recoveryCodes } = await enrollFromLogin();
    const res = await agent.get('/auth/mfa/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.recovery_codes_remaining).toBe(recoveryCodes.length);
  });
});

describe('POST /auth/mfa/recovery-codes/regenerate', () => {
  it('re-auths with the password and issues a fresh set', async () => {
    const { agent, recoveryCodes } = await enrollFromLogin();
    const res = await agent.post('/auth/mfa/recovery-codes/regenerate').send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.recovery_codes.length).toBe(recoveryCodes.length);
    expect(res.body.recovery_codes[0]).not.toBe(recoveryCodes[0]);

    const bad = await agent.post('/auth/mfa/recovery-codes/regenerate').send({ password: 'nope nope nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_credentials');
  });
});
