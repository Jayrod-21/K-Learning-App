/**
 * Email-verification tokens (F-006). Mirrors mfaChallenges.ts: opaque 32-byte
 * tokens, SHA-256 hex at rest, atomic single-use consume — plus the resend
 * supersession and the verification email itself.
 *
 * Lifecycle:
 *   1. Account creation (register / seed-user) or an email change →
 *      `issueAndSendVerificationEmail` mints a raw token (which exists ONLY
 *      inside the sent email), stores its hash, and mails the verify link.
 *      Issuing supersedes every prior live token for the user
 *      (`invalidated_at`), so exactly one link is ever redeemable.
 *   2. The user opens `${CLIENT_ORIGIN}/verify-email?token=…`; the client
 *      calls `/auth/verify`, which resolves through `consumeVerificationToken`.
 *   3. Success = ONE transaction: rowCount-gated consume + set
 *      `users.email_verified_at`. A racing double-click consumes at most once;
 *      the loser (and any later re-click) resolves to the friendly
 *      'already_verified' — verification is idempotent by design.
 *
 * Threat model (each defense in code below; summary in SECURITY.md §19):
 *   - Token guessing: 32 CSPRNG bytes (256-bit) via `randomBytes`; a shape
 *     gate rejects noise before any DB work.
 *   - DB theft → usable links: only SHA-256 hashes at rest.
 *   - Timing oracle: `timingSafeEqual` over the hashes (defense-in-depth on
 *     top of the indexed hash lookup).
 *   - Replay: single-use `consumed_at` gate; a consumed token can never verify
 *     a DIFFERENT (later) address — the consume path re-checks the user's
 *     current verified state and treats consumed+unverified as invalid.
 *   - Privilege: a verification token confers NO session powers — consuming
 *     it only stamps `email_verified_at`. Login still requires password + MFA.
 *   - Secrets in logs: the raw token is never logged here (see services/mail
 *     for the mock-transport exception, which is the documented dev escape
 *     hatch when no relay is configured).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { clientQuerier, query, withTransaction, type Querier } from '../db/pool.js';
import { getMailTransport } from '../services/mail.js';

/** 32 random bytes → base64url; identical entropy to a session token. */
const TOKEN_BYTES = 32;

/** base64url alphabet, 32 bytes → 43 chars (no padding). Same pre-DB shape
 *  gate as sessions / mfaChallenges. */
const RAW_TOKEN_SHAPE = /^[A-Za-z0-9_-]{42,44}$/;

export type VerifyOutcome = 'verified' | 'already_verified' | 'expired' | 'invalid';

function mintRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Issue a fresh verification token for `userId`: supersede every prior live
 * token (audit-preserving `invalidated_at`, not a delete) and insert the new
 * hash, atomically. Returns the raw token — the ONLY copy that will ever
 * exist; the caller puts it in the email and drops it.
 *
 * Pass an `exec` (transaction-bound `Querier`) to run inside the caller's
 * transaction; otherwise the supersede+insert run in their own.
 */
export async function issueVerificationToken(
  userId: number,
  exec?: Querier,
): Promise<{ raw: string }> {
  const cfg = loadConfig();
  const raw = mintRawToken();
  const tokenHash = hashToken(raw);
  const run = async (q: Querier): Promise<void> => {
    // Supersede prior live tokens FIRST so there is never a moment with two
    // redeemable links (resend contract: the newest link is the only link).
    await q(
      `UPDATE email_verification_tokens
          SET invalidated_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [userId],
    );
    await q(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(hours => $3::int))`,
      [userId, tokenHash, cfg.EMAIL_VERIFICATION_TOKEN_TTL_HOURS],
    );
  };
  if (exec) {
    await run(exec);
  } else {
    await withTransaction((client) => run(clientQuerier(client)));
  }
  return { raw };
}

/**
 * Seconds since this user's most recent token was issued, or null when none
 * exists. The resend endpoint's per-user cooldown probe (the real mail-bomb
 * gate — see config EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC).
 */
export async function secondsSinceLastToken(userId: number): Promise<number | null> {
  const { rows } = await query<{ secs: string | null }>(
    `SELECT floor(extract(epoch FROM (now() - max(created_at))))::text AS secs
       FROM email_verification_tokens
      WHERE user_id = $1`,
    [userId],
  );
  const secs = rows[0]?.secs;
  return secs === null || secs === undefined ? null : Number(secs);
}

interface TokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  expired: boolean;
}

/**
 * Resolve + consume a presented raw token. All branches inside ONE
 * transaction so the consume gate and the `email_verified_at` stamp can never
 * desync (a crash between them would strand a burned token).
 *
 * Outcomes:
 *   - 'verified'         — this call consumed the token and stamped the user.
 *   - 'already_verified' — the user is verified (double-click, replay after
 *                          success, or verified via a different token). A
 *                          friendly success, not an error.
 *   - 'expired'          — token matched but its window passed. Disclosing
 *                          expired-vs-invalid is safe: both are only reachable
 *                          by someone already HOLDING the token, and it
 *                          enables the "link expired — resend" UX.
 *   - 'invalid'          — unknown/malformed/superseded token, deleted user,
 *                          or a consumed token whose user is NOT currently
 *                          verified (e.g. replay of an old token after an
 *                          email change reset the stamp — it must never verify
 *                          the NEW address).
 */
export async function consumeVerificationToken(raw: string): Promise<VerifyOutcome> {
  if (!raw || !RAW_TOKEN_SHAPE.test(raw)) return 'invalid';
  const tokenHash = hashToken(raw);
  return withTransaction<VerifyOutcome>(async (client) => {
    const tx = clientQuerier(client);
    const { rows } = await tx(
      `SELECT id, user_id, token_hash, consumed_at, invalidated_at,
              (expires_at <= now()) AS expired
         FROM email_verification_tokens
        WHERE token_hash = $1
        LIMIT 1`,
      [tokenHash],
    );
    const row = rows[0] as TokenRow | undefined;
    if (!row) return 'invalid';

    // Constant-time hash comparison (defense-in-depth; the indexed lookup
    // already matched byte-for-byte, this removes any residual comparison-
    // timing signal and satisfies the "never string-compare secrets" rule).
    const a = Buffer.from(row.token_hash, 'hex');
    const b = Buffer.from(tokenHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid';

    const u = await tx(
      `SELECT email_verified_at FROM users
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [row.user_id],
    );
    const user = u.rows[0] as { email_verified_at: Date | null } | undefined;
    if (!user) return 'invalid'; // deleted/vanished user — token is dead
    if (user.email_verified_at !== null) return 'already_verified';

    // Unverified user + a spent or superseded token: this token must not
    // verify anything (replay / stale link after a resend or email change).
    if (row.consumed_at !== null || row.invalidated_at !== null) return 'invalid';
    if (row.expired) return 'expired';

    // Atomic single-use consume. A racing concurrent verify serializes here:
    // exactly one caller flips consumed_at (rowCount 1) and stamps the user;
    // the loser sees rowCount 0 — by then the winner's stamp makes
    // 'already_verified' the truthful answer.
    const consumed = await tx(
      `UPDATE email_verification_tokens
          SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL`,
      [row.id],
    );
    if (consumed.rowCount !== 1) return 'already_verified';

    // COALESCE keeps this idempotent-safe even against a concurrent verify
    // via a different token — the FIRST stamp wins and is never overwritten.
    await tx(
      `UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1`,
      [row.user_id],
    );
    return 'verified';
  });
}

/**
 * Issue a token and send the verification email to `email`.
 *
 * Rejects on transport failure — CALLERS MUST TREAT THIS AS BEST-EFFORT for
 * account creation (a mail outage must never fail a registration; the resend
 * endpoint is the recovery path) and catch+log accordingly.
 *
 * The email body contains NO user-supplied content (fixed copy + a link built
 * from CLIENT_ORIGIN and the server-minted token), so there is no injection
 * surface to escape.
 */
export async function issueAndSendVerificationEmail(
  userId: number,
  email: string,
): Promise<void> {
  const cfg = loadConfig();
  const { raw } = await issueVerificationToken(userId);
  // CLIENT_ORIGIN is the SPA origin (same-origin deploy); /verify-email is the
  // client verify-landing route. Trailing slash normalized defensively.
  const base = cfg.CLIENT_ORIGIN.replace(/\/+$/, '');
  const url = `${base}/verify-email?token=${raw}`;
  const ttlHours = cfg.EMAIL_VERIFICATION_TOKEN_TTL_HOURS;
  await getMailTransport().sendMail({
    to: email,
    subject: 'Verify your email — Korean Master',
    text:
      `Confirm this email address for your Korean Master account by opening the link below:\n\n` +
      `${url}\n\n` +
      `The link can be used once and expires in ${String(ttlHours)} hours. ` +
      `If you did not create this account, you can safely ignore this email.`,
    html:
      `<p>Confirm this email address for your <strong>Korean Master</strong> account:</p>` +
      `<p><a href="${url}">Verify my email</a></p>` +
      `<p style="color:#666;font-size:13px">The link can be used once and expires in ` +
      `${String(ttlHours)} hours. If you did not create this account, you can safely ` +
      `ignore this email.</p>`,
  });
}
