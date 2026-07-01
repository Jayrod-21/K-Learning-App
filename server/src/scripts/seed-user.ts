/**
 * seed-user CLI — provision the single application account (D3).
 *
 * Single-user deployment disables self-service registration
 * (REGISTRATION_ENABLED=false in prod) and seeds the one account here. The
 * account is created WITHOUT a TOTP factor; under mandatory MFA the first login
 * forces enrollment (the login route mints an 'enroll' challenge).
 *
 * Inputs (env):
 *   SEED_USER_EMAIL    — the account email (required).
 *   SEED_USER_PASSWORD — the account password (required, >= 12 chars to match the
 *                        register schema floor and the Argon2 input cap).
 *   SEED_USER_DISPLAY_NAME — optional display name.
 *
 * Idempotent: ON CONFLICT (email) DO NOTHING. Re-running reports "exists" and
 * does NOT rotate the password (use a dedicated password-reset path for that).
 *
 * Security:
 *   - Never logs the password (only the email + a created/exists verdict).
 *   - Fails loud (non-zero exit) on missing/short inputs rather than seeding a
 *     weak or partial account.
 *   - Uses the same Argon2id hasher as /auth/register (no bespoke crypto).
 */
import { hashPassword } from '../auth/passwords.js';
import { query, closePool } from '../db/pool.js';
import { getLogger } from '../logging.js';

const MIN_PASSWORD_LEN = 12;

async function main(): Promise<void> {
  const log = getLogger();
  const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_USER_PASSWORD;
  const displayName = process.env.SEED_USER_DISPLAY_NAME?.trim() || null;

  if (!email) {
    throw new Error('SEED_USER_EMAIL is required');
  }
  if (!password) {
    throw new Error('SEED_USER_PASSWORD is required');
  }
  if (password.length < MIN_PASSWORD_LEN) {
    throw new Error(`SEED_USER_PASSWORD must be at least ${MIN_PASSWORD_LEN} characters`);
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, passwordHash, displayName],
  );

  if (rows[0]) {
    log.info({ userId: rows[0].id, email }, 'seed-user: account created');
    // eslint-disable-next-line no-console
    console.error(`seed-user: created account for ${email} (id=${rows[0].id})`);
  } else {
    log.info({ email }, 'seed-user: account already exists (no-op)');
    // eslint-disable-next-line no-console
    console.error(`seed-user: account for ${email} already exists — no changes`);
  }
}

// Run only when invoked directly as a CLI (node ... seed-user.ts), NOT when the
// module is imported — importing this file must not execute DB I/O. Mirrors the
// entrypoint guard in src/index.ts.
if (require.main === module) {
  main()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`seed-user: FAILED — ${(err as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
