/**
 * mfa-reset CLI — operator-only TOTP recovery path.
 *
 * The recovery story for a total lockout (lost authenticator AND lost recovery
 * codes) is deliberately NOT in-app (mandatory MFA, no self-service disable): an
 * operator runs this CLI against the account, which removes the TOTP factor and
 * all recovery codes and revokes the user's live sessions. The user's NEXT login
 * then falls into the forced-enrollment path and re-enrolls a fresh factor.
 *
 * Input: the account email via the `MFA_RESET_EMAIL` env var OR the first CLI
 * argument (`node mfa-reset.js user@example.com`).
 *
 * Runs in ONE transaction so a partial reset (factor gone but codes/sessions
 * left) can never persist. Idempotent: resetting an account with no factor is a
 * no-op that still revokes sessions and reports cleanly.
 *
 * Security:
 *   - Operator-only: this is a shell CLI, not an endpoint. There is NO network
 *     auth here — possession of shell + DB access IS the authorization boundary.
 *   - Never logs secrets (there are none to log — it only deletes).
 *   - Fails loud on an unknown email rather than silently doing nothing, so an
 *     operator typo is caught.
 */
import { withTransaction, closePool, clientQuerier } from '../db/pool.js';
import { revokeAllUserSessions } from '../auth/sessions.js';
import { getLogger } from '../logging.js';

/**
 * The transactional core: clear `userId`'s TOTP factor + recovery codes and
 * revoke every live session, all in ONE transaction (so a partial reset can
 * never persist). Idempotent — a user with no factor is a no-op DELETE that
 * still revokes sessions. Throws on an unknown email (fails loud, per the
 * module's security stance) without touching any other user's rows.
 *
 * Exported for direct-call testing (tests/scripts/mfa-reset.test.ts) — `main`
 * below is a thin CLI wrapper around this.
 */
export async function resetMfaForEmail(email: string): Promise<{ userId: number }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [email],
    );
    const user = rows[0];
    if (!user) {
      throw new Error(`no account found for ${email}`);
    }
    const userId = user.id;

    await client.query(`DELETE FROM user_totp WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
    // Revoke every live session: a reset is a security event; force re-login so a
    // stale cookie cannot ride past the re-enrollment requirement. Runs on THIS
    // transaction's client (B-045) so it stays atomic with the deletes above,
    // reusing the shared helper instead of an inline copy.
    await revokeAllUserSessions(userId, 'mfa_reset', clientQuerier(client));

    return { userId };
  });
}

/** Exported for direct-call testing — not invoked as a CLI import side effect
 *  (guarded below by require.main), mirrors scripts/seed-user.ts's `main`. */
export async function main(): Promise<void> {
  const log = getLogger();
  const email = (process.env.MFA_RESET_EMAIL ?? process.argv[2])?.trim().toLowerCase();
  if (!email) {
    throw new Error('email required: set MFA_RESET_EMAIL or pass it as the first argument');
  }

  const { userId } = await resetMfaForEmail(email);

  log.info({ userId, email }, 'mfa-reset: factor + recovery codes cleared, sessions revoked');
  // eslint-disable-next-line no-console
  console.error(`mfa-reset: cleared TOTP + recovery codes and revoked sessions for ${email} (id=${userId})`);
}

// Run only when invoked directly as a CLI (node ... mfa-reset.ts), NOT when the
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
      console.error(`mfa-reset: FAILED — ${(err as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
