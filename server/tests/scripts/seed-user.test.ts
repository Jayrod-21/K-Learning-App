/**
 * Integration tests for the seed-user CLI's SEED_USER_ROLE handling
 * (Phase 2.2 admin-role foundation — src/scripts/seed-user.ts).
 *
 * This is the actual privilege-granting mechanism behind Deploy/seed-admin.sh
 * (which sets SEED_USER_ROLE=admin), so the role logic is tested directly
 * against a real Postgres, not just exercised incidentally by an admin-route
 * test. `main()` is exported for direct-call testing (guarded off from the
 * CLI's `require.main` side effect); we drive it with env vars and a real DB
 * pool (via buildTestApp, which also wires the mock mail transport so the
 * verification-email send path never touches real SMTP), then read the row
 * back to assert on `role`.
 *
 * Coverage:
 *   - parseRole: default 'user' when unset, accepts 'user'/'admin', rejects
 *     anything else (case-insensitive input, case-sensitive-ish rejection of
 *     garbage) — a hard failure, not a silent fallback.
 *   - main(): fresh insert with no SEED_USER_ROLE -> role='user'; fresh
 *     insert with SEED_USER_ROLE=admin -> role='admin'.
 *   - Idempotence + the documented upgrade/no-downgrade asymmetry: re-running
 *     with role=admin against an existing plain-user row UPGRADES it;
 *     re-running with role=user (the default) against an existing admin row
 *     does NOT downgrade it. The password hash is untouched either way.
 *   - An invalid SEED_USER_ROLE throws before any DB write (no account is
 *     created).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { main as seedUserMain, parseRole } from '../../src/scripts/seed-user.js';

let pg: PgHandle;
let t: TestApp;

const BASE_ENV = { ...process.env };

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
  // Reset every SEED_USER_* var between tests so one test's env can never
  // leak into the next.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SEED_USER_')) delete process.env[key];
  }
});

afterAll(() => {
  process.env = { ...BASE_ENV };
});

function setSeedEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function roleFor(email: string): Promise<string | undefined> {
  const { rows } = await pg.pool.query<{ role: string }>(
    `SELECT role::text AS role FROM users WHERE email = $1`,
    [email],
  );
  return rows[0]?.role;
}

async function passwordHashFor(email: string): Promise<string | undefined> {
  const { rows } = await pg.pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE email = $1`,
    [email],
  );
  return rows[0]?.password_hash;
}

describe('parseRole', () => {
  it('defaults to user when unset', () => {
    expect(parseRole(undefined)).toBe('user');
  });

  it('accepts user and admin (case-insensitive, trimmed)', () => {
    expect(parseRole('user')).toBe('user');
    expect(parseRole('admin')).toBe('admin');
    expect(parseRole(' ADMIN ')).toBe('admin');
    expect(parseRole('User')).toBe('user');
  });

  it('rejects anything else', () => {
    expect(() => parseRole('superadmin')).toThrow(/SEED_USER_ROLE/);
    expect(() => parseRole('')).toThrow(/SEED_USER_ROLE/);
    expect(() => parseRole('root')).toThrow(/SEED_USER_ROLE/);
  });
});

describe('seed-user main() — SEED_USER_ROLE', () => {
  it('fresh account with no SEED_USER_ROLE -> role=user', async () => {
    const email = 'plain@example.com';
    setSeedEnv({
      SEED_USER_EMAIL: email,
      SEED_USER_PASSWORD: 'correct horse battery staple',
    });
    await seedUserMain();
    expect(await roleFor(email)).toBe('user');
  });

  it('fresh account with SEED_USER_ROLE=admin -> role=admin', async () => {
    const email = 'admin@example.com';
    setSeedEnv({
      SEED_USER_EMAIL: email,
      SEED_USER_PASSWORD: 'correct horse battery staple',
      SEED_USER_ROLE: 'admin',
    });
    await seedUserMain();
    expect(await roleFor(email)).toBe('admin');
  });

  it('re-run with role=admin UPGRADES an existing plain-user account', async () => {
    const email = 'upgrade-me@example.com';
    setSeedEnv({
      SEED_USER_EMAIL: email,
      SEED_USER_PASSWORD: 'correct horse battery staple',
    });
    await seedUserMain();
    expect(await roleFor(email)).toBe('user');
    const hashBefore = await passwordHashFor(email);

    setSeedEnv({
      SEED_USER_EMAIL: email,
      SEED_USER_PASSWORD: 'a completely different password!!',
      SEED_USER_ROLE: 'admin',
    });
    await seedUserMain();
    expect(await roleFor(email)).toBe('admin');
    // Password is never rotated on conflict, upgrade or not.
    expect(await passwordHashFor(email)).toBe(hashBefore);
  });

  it('re-run with role=user (default) does NOT downgrade an existing admin', async () => {
    const email = 'stay-admin@example.com';
    setSeedEnv({
      SEED_USER_EMAIL: email,
      SEED_USER_PASSWORD: 'correct horse battery staple',
      SEED_USER_ROLE: 'admin',
    });
    await seedUserMain();
    expect(await roleFor(email)).toBe('admin');

    setSeedEnv({
      SEED_USER_EMAIL: email,
      SEED_USER_PASSWORD: 'correct horse battery staple',
    });
    await seedUserMain();
    expect(await roleFor(email)).toBe('admin');
  });

  it('an invalid SEED_USER_ROLE throws and creates no account', async () => {
    const email = 'never-created@example.com';
    setSeedEnv({
      SEED_USER_EMAIL: email,
      SEED_USER_PASSWORD: 'correct horse battery staple',
      SEED_USER_ROLE: 'superadmin',
    });
    await expect(seedUserMain()).rejects.toThrow(/SEED_USER_ROLE/);
    expect(await roleFor(email)).toBeUndefined();
  });
});
