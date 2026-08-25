/**
 * Integration tests for the mfa-reset CLI's core (Phase 2.4 MFA-hardening
 * audit — MFA_AUDIT.md check 5: "no test file exercises mfa-reset.ts", the
 * operator escape hatch for a TOTAL lockout — lost authenticator AND lost
 * recovery codes).
 *
 * `resetMfaForEmail` is exported from src/scripts/mfa-reset.ts for direct-call
 * testing (`main()` is now a thin CLI wrapper around it — env/argv parsing,
 * logging, exit — guarded off from the require.main side effect, same shape
 * as tests/scripts/seed-user.test.ts's `main`). We drive it directly against
 * a real Postgres (via buildTestApp, which also wires the fixed test
 * TOTP_SECRET_ENC_KEY so a seeded encrypted secret round-trips
 * deterministically), seeding TOTP + recovery-code + session rows by hand and
 * reading the DB back to assert on the reset's actual effect.
 *
 * Coverage:
 *   - full reset: TOTP factor row gone, recovery-code rows gone, every live
 *     session revoked (row survives with revoked_at set, not deleted) — the
 *     user row itself is untouched.
 *   - idempotent / no-factor case: a user with nothing to clear still
 *     succeeds and still revokes sessions (no throw).
 *   - unknown email: throws (fails loud, per the module's documented
 *     security stance) and touches no other row for the seeded user.
 *   - isolation: resetting user A never touches user B's totp / recovery
 *     codes / sessions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { resetMfaForEmail } from '../../src/scripts/mfa-reset.js';
import { hashPassword } from '../../src/auth/passwords.js';
import { encryptSecret } from '../../src/crypto/encryption.js';
import { generateSecret } from '../../src/auth/totp.js';
import { generateRecoveryCodes } from '../../src/auth/recoveryCodes.js';
import { issueSession } from '../../src/auth/sessions.js';

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
    `TRUNCATE TABLE user_recovery_codes, user_totp, sessions, users RESTART IDENTITY CASCADE`,
  );
});

let _emailCounter = 0;
function nextEmail(): string {
  _emailCounter += 1;
  return `mfareset${_emailCounter}@example.com`;
}

async function seedUser(email: string): Promise<number> {
  const hash = await hashPassword('correct horse battery staple');
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, hash],
  );
  return Number(rows[0]!.id);
}

/** Seed a confirmed TOTP factor for `userId` — same shape enrollment-confirm leaves. */
async function seedTotp(userId: number): Promise<void> {
  const secret = generateSecret();
  await pg.pool.query(
    `INSERT INTO user_totp (user_id, secret_encrypted, confirmed_at, last_used_step)
     VALUES ($1, $2, now(), 100)`,
    [userId, encryptSecret(secret)],
  );
}

async function seedRecoveryCodes(userId: number, n: number): Promise<void> {
  const { hashes } = generateRecoveryCodes(n);
  for (const hash of hashes) {
    await pg.pool.query(
      `INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
      [userId, hash],
    );
  }
}

async function seedSession(userId: number): Promise<void> {
  await issueSession(userId, {});
}

async function totpExists(userId: number): Promise<boolean> {
  const { rows } = await pg.pool.query(`SELECT 1 FROM user_totp WHERE user_id = $1`, [userId]);
  return rows.length > 0;
}

async function recoveryCodeCount(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM user_recovery_codes WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]!.n);
}

async function liveSessionCount(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return Number(rows[0]!.n);
}

async function totalSessionCount(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sessions WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]!.n);
}

async function userExists(userId: number): Promise<boolean> {
  const { rows } = await pg.pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  return rows.length > 0;
}

describe('resetMfaForEmail', () => {
  it('clears the TOTP factor + recovery codes and revokes every live session — the user row survives', async () => {
    const email = nextEmail();
    const userId = await seedUser(email);
    await seedTotp(userId);
    await seedRecoveryCodes(userId, 5);
    await seedSession(userId);
    await seedSession(userId);

    expect(await totpExists(userId)).toBe(true);
    expect(await recoveryCodeCount(userId)).toBe(5);
    expect(await liveSessionCount(userId)).toBe(2);

    const result = await resetMfaForEmail(email);
    expect(result).toEqual({ userId });

    expect(await totpExists(userId)).toBe(false);
    expect(await recoveryCodeCount(userId)).toBe(0);
    expect(await liveSessionCount(userId)).toBe(0);
    // The session rows are REVOKED, not deleted — the ledger survives.
    expect(await totalSessionCount(userId)).toBe(2);
    expect(await userExists(userId)).toBe(true);
  });

  it('is idempotent for a user with no TOTP factor: succeeds (no throw) and still revokes sessions', async () => {
    const email = nextEmail();
    const userId = await seedUser(email);
    await seedSession(userId);
    expect(await totpExists(userId)).toBe(false);
    expect(await liveSessionCount(userId)).toBe(1);

    await expect(resetMfaForEmail(email)).resolves.toEqual({ userId });

    expect(await totpExists(userId)).toBe(false);
    expect(await recoveryCodeCount(userId)).toBe(0);
    expect(await liveSessionCount(userId)).toBe(0);
  });

  it('throws on an unknown email and leaves every other row untouched', async () => {
    const email = nextEmail();
    const userId = await seedUser(email);
    await seedTotp(userId);
    await seedRecoveryCodes(userId, 3);
    await seedSession(userId);

    await expect(resetMfaForEmail('nobody@example.com')).rejects.toThrow(
      /no account found for nobody@example\.com/,
    );

    // The failed reset must not have touched the (unrelated) seeded user.
    expect(await totpExists(userId)).toBe(true);
    expect(await recoveryCodeCount(userId)).toBe(3);
    expect(await liveSessionCount(userId)).toBe(1);
  });

  it('resetting user A does not affect user B (totp / recovery codes / sessions all isolated)', async () => {
    const emailA = nextEmail();
    const emailB = nextEmail();
    const userA = await seedUser(emailA);
    const userB = await seedUser(emailB);
    await seedTotp(userA);
    await seedTotp(userB);
    await seedRecoveryCodes(userA, 4);
    await seedRecoveryCodes(userB, 4);
    await seedSession(userA);
    await seedSession(userB);

    const result = await resetMfaForEmail(emailA);
    expect(result).toEqual({ userId: userA });

    expect(await totpExists(userA)).toBe(false);
    expect(await recoveryCodeCount(userA)).toBe(0);
    expect(await liveSessionCount(userA)).toBe(0);

    // User B is completely unaffected.
    expect(await totpExists(userB)).toBe(true);
    expect(await recoveryCodeCount(userB)).toBe(4);
    expect(await liveSessionCount(userB)).toBe(1);
  });
});
