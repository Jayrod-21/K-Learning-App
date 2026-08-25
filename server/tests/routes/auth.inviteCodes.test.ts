/**
 * Phase 2.3 — invite-only self-signup (D1): `POST /auth/register`'s invite
 * gate, end-to-end against real Postgres (testcontainer).
 *
 * The suite runs with `emailVerificationRequired: false, mfaRequired: false`
 * so a successful register mints a session directly (the legacy `{user}`
 * shape) — the gate/MFA interplay is covered by auth.verify.test.ts /
 * auth.mfa.test.ts and is orthogonal to what this file proves: the invite
 * gate itself, and above all its ATOMICITY with the users INSERT.
 *
 * Invite codes are minted directly via `issueInviteCode`
 * (src/auth/inviteCodes.ts) rather than through `POST /admin/invites` — this
 * file is about the REGISTER side of the contract (routes/admin.test.ts
 * already covers the admin-issuance HTTP surface); seeding directly keeps
 * these tests from needing an authenticated admin session just to get a raw
 * code.
 *
 * Covers, per the Phase 2.3 security contract:
 *   - INVITE_REQUIRED=true: no code -> 403 invite_required; a bogus code ->
 *     403 invite_invalid; a valid code succeeds, increments `uses`, and
 *     writes an invite_redemptions row; a single-use code's 2nd registration
 *     -> 403 invite_invalid; an email-bound code redeemed with a different
 *     email -> 403 invite_invalid.
 *   - THE CRITICAL TEST: a duplicate-email registration attempt with an
 *     otherwise-valid code fails with 409 (ConflictError) AND the code is
 *     NOT burned (`uses` unchanged) — the whole point of running the consume
 *     inside the SAME transaction as the users INSERT (see
 *     routes/auth.ts's register handler + auth/inviteCodes.ts's
 *     consumeInviteCode docstring).
 *   - INVITE_REQUIRED=false (default): registering with no code still works
 *     unchanged — the regression guard for the pre-existing behavior every
 *     other route suite depends on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { issueInviteCode } from '../../src/auth/inviteCodes.js';

const PASSWORD = 'correct horse battery staple';
const FAKE_HASH = `$argon2id$${'x'.repeat(70)}`;

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({
    connectionString: pg.connectionString,
    emailVerificationRequired: false,
    mfaRequired: false,
    registrationEnabled: true,
    inviteRequired: true,
  });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    `TRUNCATE TABLE invite_redemptions, invite_codes, sessions, users RESTART IDENTITY CASCADE`,
  );
  resetLimiters();
});

/** Seed the admin whose id fills invite_codes.issued_by_user_id — the FK
 *  target only, no admin-role/session machinery needed for these tests. */
async function seedAdmin(email = 'admin@test.dev'): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

async function usesOf(id: number): Promise<number> {
  const { rows } = await pg.pool.query<{ uses: number }>(
    `SELECT uses FROM invite_codes WHERE id = $1`,
    [id],
  );
  return rows[0]!.uses;
}

async function redemptionCount(inviteCodeId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM invite_redemptions WHERE invite_code_id = $1`,
    [inviteCodeId],
  );
  return Number(rows[0]!.n);
}

async function userCount(email: string): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM users WHERE email = $1`,
    [email],
  );
  return Number(rows[0]!.n);
}

describe('POST /auth/register — INVITE_REQUIRED=true', () => {
  it('no code -> 403 invite_required, before any account is created', async () => {
    const res = await request(t.app)
      .post('/auth/register')
      .send({ email: 'nocode@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invite_required');
    expect(await userCount('nocode@example.com')).toBe(0);
  });

  it('an empty-string code is treated the same as missing -> 403 invite_required', async () => {
    const res = await request(t.app)
      .post('/auth/register')
      .send({ email: 'emptycode@example.com', password: PASSWORD, invite_code: '' });
    // Zod's .min(1) on invite_code rejects an empty string as a 400 body
    // shape error before the handler even runs — still a rejection, never
    // registration.
    expect([400, 403]).toContain(res.status);
    expect(await userCount('emptycode@example.com')).toBe(0);
  });

  it('a bogus (never-issued) code -> 403 invite_invalid', async () => {
    const res = await request(t.app).post('/auth/register').send({
      email: 'bogus@example.com',
      password: PASSWORD,
      invite_code: 'not-a-real-code-at-all-00000000000000000000',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invite_invalid');
    expect(await userCount('bogus@example.com')).toBe(0);
  });

  it('a valid code succeeds, increments uses, and writes an invite_redemptions row', async () => {
    const adminId = await seedAdmin();
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 1 });

    const res = await request(t.app).post('/auth/register').send({
      email: 'valid@example.com',
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('valid@example.com');
    // Legacy direct-session path (both gates off) mints a cookie.
    expect(res.headers['set-cookie']).toBeDefined();

    expect(await usesOf(issued.id)).toBe(1);
    expect(await redemptionCount(issued.id)).toBe(1);
    const { rows } = await pg.pool.query<{ user_id: number }>(
      `SELECT user_id FROM invite_redemptions WHERE invite_code_id = $1`,
      [issued.id],
    );
    expect(rows[0]!.user_id).toBe(res.body.user.id);
  });

  it('a single-use code cannot register a 2nd account -> 403 invite_invalid, uses stays at 1', async () => {
    const adminId = await seedAdmin();
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 1 });

    const first = await request(t.app).post('/auth/register').send({
      email: 'first@example.com',
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(first.status).toBe(201);

    const second = await request(t.app).post('/auth/register').send({
      email: 'second@example.com',
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('invite_invalid');
    expect(await usesOf(issued.id)).toBe(1);
    expect(await userCount('second@example.com')).toBe(0);
  });

  it('an email-bound code redeemed with a different email -> 403 invite_invalid, not burned', async () => {
    const adminId = await seedAdmin();
    const issued = await issueInviteCode({
      issuedByUserId: adminId,
      email: 'bound@example.com',
    });

    const res = await request(t.app).post('/auth/register').send({
      email: 'someone-else@example.com',
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invite_invalid');
    expect(await usesOf(issued.id)).toBe(0);
    expect(await userCount('someone-else@example.com')).toBe(0);

    // The SAME code still works for the address it's actually bound to.
    const ok = await request(t.app).post('/auth/register').send({
      email: 'bound@example.com',
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(ok.status).toBe(201);
    expect(await usesOf(issued.id)).toBe(1);
  });

  // ---------------------------------------------------------------------
  // THE CRITICAL TEST — atomicity of the consume with the users INSERT.
  // ---------------------------------------------------------------------
  it('a duplicate-email registration with a valid code fails 409 AND does NOT burn the code (rollback un-burns it)', async () => {
    const adminId = await seedAdmin();
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 5 });
    const email = 'dup@example.com';

    // First registration succeeds and legitimately consumes one use.
    const first = await request(t.app).post('/auth/register').send({
      email,
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(first.status).toBe(201);
    expect(await usesOf(issued.id)).toBe(1);

    // A SECOND registration attempt reusing the SAME email (now a 23505
    // unique_violation on users.email) but a FRESH, still-valid invite code
    // use (maxUses=5, only 1 spent so far). If the consume were NOT atomic
    // with the users INSERT, this failed attempt would still increment
    // `uses` to 2 even though no new account was created — burning a use
    // for nothing. The transaction must roll the consume back with the
    // failed INSERT.
    const second = await request(t.app).post('/auth/register').send({
      email,
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(second.status).toBe(409);

    // THE ASSERTION: uses is still 1, not 2 — the failed attempt's consume
    // was rolled back together with the failed INSERT.
    expect(await usesOf(issued.id)).toBe(1);
    // Still only ONE redemption row (the first, successful registration).
    expect(await redemptionCount(issued.id)).toBe(1);
    expect(await userCount(email)).toBe(1);

    // Proof the code remains genuinely usable: a THIRD attempt with a fresh
    // email succeeds and takes `uses` to 2 (the legitimately next use, not
    // a phantom burn from the failed duplicate-email attempt above).
    const third = await request(t.app).post('/auth/register').send({
      email: 'dup-retry@example.com',
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(third.status).toBe(201);
    expect(await usesOf(issued.id)).toBe(2);
  });
});

describe('POST /auth/register — INVITE_REQUIRED=false (default) — regression guard', () => {
  let openApp: TestApp;

  beforeAll(async () => {
    openApp = buildTestApp({
      connectionString: pg.connectionString,
      emailVerificationRequired: false,
      mfaRequired: false,
      registrationEnabled: true,
      // inviteRequired omitted -> defaults false.
    });
  });

  afterAll(async () => {
    await teardownTestApp(openApp);
    // Rebuild the shared suite app so any test file order after this one
    // (or a future test appended below) keeps the INVITE_REQUIRED=true
    // config this file's other describe blocks rely on.
    t = buildTestApp({
      connectionString: pg.connectionString,
      emailVerificationRequired: false,
      mfaRequired: false,
      registrationEnabled: true,
      inviteRequired: true,
    });
  });

  it('registers successfully with NO invite code — the pre-existing behavior is unchanged', async () => {
    const res = await request(openApp.app)
      .post('/auth/register')
      .send({ email: 'open-registration@example.com', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('open-registration@example.com');
    expect(await userCount('open-registration@example.com')).toBe(1);
  });

  it('a provided invite code is simply ignored (never consumed) when the gate is off', async () => {
    const adminId = await seedAdmin('admin-open@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 1 });

    const res = await request(openApp.app).post('/auth/register').send({
      email: 'ignored-code@example.com',
      password: PASSWORD,
      invite_code: issued.rawCode,
    });
    expect(res.status).toBe(201);
    // Not consumed — the code is still fully available.
    expect(await usesOf(issued.id)).toBe(0);
    expect(await redemptionCount(issued.id)).toBe(0);
  });
});
