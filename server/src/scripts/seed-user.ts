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
 *   SEED_USER_MARK_VERIFIED — 'true' to stamp email_verified_at at creation
 *                        (operator escape hatch: no email is sent, the login
 *                        gate is immediately satisfied). Default: unset —
 *                        a verification email is sent via the configured mail
 *                        transport (F-006); with no SMTP configured, the mock
 *                        transport logs the verify URL to the console, which
 *                        the operator can open directly.
 *   SEED_USER_ROLE      — 'user' or 'admin' (Phase 2.2 admin-role foundation).
 *                        Default: 'user'. Any other value is a hard failure
 *                        (fails loud, per the security stance below) rather
 *                        than silently seeding some unrecognized role.
 *
 * Idempotent: ON CONFLICT (email) DO NOTHING — EXCEPT for role. A re-run with
 * SEED_USER_ROLE=admin against an ALREADY-EXISTING account upgrades that
 * account's role to admin (ON CONFLICT ... DO UPDATE SET role = ... WHEN the
 * requested role is 'admin', a strict superset of the prior no-op). This is
 * the deliberate, documented choice over the alternative (report "exists,
 * role unchanged" and leave a would-be admin as a plain user): silently
 * leaving SEED_USER_ROLE=admin without effect is the more dangerous failure
 * mode for an operator running seed-admin.sh who reasonably expects "pass
 * admin, get admin" to hold on every run, idempotent or not. A run with
 * SEED_USER_ROLE=user (the default) NEVER downgrades an existing admin back
 * to user — that would be its own kind of surprising, destructive side
 * effect for a script whose header advertises pure idempotence; demoting an
 * admin is a deliberate separate action, not a seed-script side effect.
 * The password is NEVER rotated on conflict either way (use a dedicated
 * password-reset path for that).
 *
 * Security:
 *   - Never logs the password (only the email + a created/exists/upgraded
 *     verdict).
 *   - Fails loud (non-zero exit) on missing/short inputs, or an unrecognized
 *     SEED_USER_ROLE, rather than seeding a weak, partial, or ambiguously-
 *     privileged account.
 *   - Uses the same Argon2id hasher as /auth/register (no bespoke crypto).
 *   - The verification token is issued by the same hashed-at-rest machinery
 *     as /auth/register (auth/emailVerification.ts); the raw token is never
 *     printed here.
 */
import { hashPassword } from '../auth/passwords.js';
import { issueAndSendVerificationEmail } from '../auth/emailVerification.js';
import { query, closePool } from '../db/pool.js';
import { getLogger } from '../logging.js';

const MIN_PASSWORD_LEN = 12;
const VALID_ROLES = ['user', 'admin'] as const;
type SeedRole = (typeof VALID_ROLES)[number];

export function parseRole(raw: string | undefined): SeedRole {
  const value = (raw ?? 'user').trim().toLowerCase();
  if ((VALID_ROLES as readonly string[]).includes(value)) {
    return value as SeedRole;
  }
  throw new Error(
    `SEED_USER_ROLE must be one of ${VALID_ROLES.join('/')} (got: ${JSON.stringify(raw)})`,
  );
}

/** Exported for direct-call testing (tests/scripts/seed-user.test.ts) — not
 * invoked as a CLI import side effect (guarded below by require.main). */
export async function main(): Promise<void> {
  const log = getLogger();
  const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_USER_PASSWORD;
  const displayName = process.env.SEED_USER_DISPLAY_NAME?.trim() || null;
  const markVerified =
    (process.env.SEED_USER_MARK_VERIFIED ?? '').trim().toLowerCase() === 'true';
  const role = parseRole(process.env.SEED_USER_ROLE);

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
  // ON CONFLICT upgrades role to 'admin' when requested (see header) but
  // never downgrades an existing admin when role='user' is the (default)
  // request — GREATEST over the enum's implicit ordering ('user' < 'admin')
  // would work too, but an explicit CASE keeps the intent readable at the
  // SQL site rather than resting on ENUM declaration order.
  const { rows } = await query<{ id: number; role: SeedRole; xmax: string }>(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at, role)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END, $5::user_role)
     ON CONFLICT (email) DO UPDATE
       SET role = CASE WHEN $5::user_role = 'admin' THEN 'admin'::user_role ELSE users.role END
     RETURNING id, role::text AS role, xmax::text AS xmax`,
    [email, passwordHash, displayName, markVerified, role],
  );

  const row = rows[0];
  if (!row) throw new Error('seed-user: insert/upsert returned no rows');
  const userId = Number(row.id);
  // xmax = '0' on a fresh INSERT; a nonzero xmax means the ON CONFLICT DO
  // UPDATE branch fired (row already existed) — the standard Postgres tell
  // for "which arm of an upsert actually ran" without a second round-trip.
  const wasInsert = row.xmax === '0';

  if (wasInsert) {
    log.info({ userId, email, role: row.role }, 'seed-user: account created');
    // eslint-disable-next-line no-console
    console.error(
      `seed-user: created account for ${email} (id=${String(userId)}, role=${row.role})`,
    );
    if (markVerified) {
      // eslint-disable-next-line no-console
      console.error('seed-user: email pre-verified (SEED_USER_MARK_VERIFIED=true) — no email sent');
    } else {
      // F-006: same verification flow as /auth/register. Best-effort — the
      // account exists either way; the recovery paths are the login screen's
      // resend affordance or the EMAIL_VERIFICATION_REQUIRED=false kill-switch.
      try {
        await issueAndSendVerificationEmail(userId, email);
        // eslint-disable-next-line no-console
        console.error(`seed-user: verification email sent to ${email}`);
      } catch (mailErr) {
        log.error(
          { userId, err: (mailErr as Error).message },
          'seed-user: verification email send failed',
        );
        // eslint-disable-next-line no-console
        console.error(
          'seed-user: WARNING — verification email failed to send; use the ' +
            'login screen resend, or set EMAIL_VERIFICATION_REQUIRED=false',
        );
      }
    }
  } else {
    log.info({ userId, email, role: row.role }, 'seed-user: account already exists');
    // eslint-disable-next-line no-console
    console.error(
      role === 'admin'
        ? `seed-user: account for ${email} already exists — role upgraded to admin (password unchanged)`
        : `seed-user: account for ${email} already exists — no changes (role=${row.role})`,
    );
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
