/**
 * Password-reset tokens (Phase 2.1, self-service account recovery). Mirrors
 * emailVerification.ts: opaque 32-byte tokens, SHA-256 hex at rest, atomic
 * single-use consume — plus the request cooldown and the reset email itself.
 *
 * Lifecycle:
 *   1. POST /auth/password-reset/request → look up the user by email (the
 *      route stays non-enumerating around this lookup — see auth.ts) and
 *      call `issueAndSendPasswordResetEmail`, which mints a raw token (which
 *      exists ONLY inside the sent email), stores its hash, and mails the
 *      reset link. Issuing supersedes every prior live token for the user
 *      (`invalidated_at`), so exactly one link is ever redeemable.
 *   2. The user opens `${CLIENT_ORIGIN}/reset-password#token=…` (URL
 *      FRAGMENT — the token never reaches any server/proxy log); the client
 *      reads `location.hash` and calls `POST /auth/password-reset/confirm`
 *      with the new password, which resolves through
 *      `consumePasswordResetToken`.
 *   3. Success = ONE transaction in the route handler: rowCount-gated
 *      consume + `users.password_hash` update + `revokeAllUserSessions`. A
 *      racing double-submit consumes at most once; the loser gets the same
 *      generic "expired or already used" failure as a stale token.
 *
 * Threat model (each defense in code below; mirrors SECURITY.md §19):
 *   - Token guessing: 32 CSPRNG bytes (256-bit) via `randomBytes`; a shape
 *     gate rejects noise before any DB work.
 *   - DB theft → usable links: only SHA-256 hashes at rest.
 *   - Timing oracle: `timingSafeEqual` over the hashes (defense-in-depth on
 *     top of the indexed hash lookup).
 *   - Replay: single-use `consumed_at` gate — a consumed or superseded token
 *     can never reset a password again.
 *   - Short blast radius: 1 HOUR expiry (vs. email-verification's 24h) — a
 *     reset token is a much higher-value credential than a verification
 *     token (it grants full account takeover, not just an address
 *     attestation), so its window is deliberately tight.
 *   - Mail-bombing: a per-user cooldown (`issuePasswordResetTokenIfCooldownClear`)
 *     gates re-issuance, atomic with the insert (same per-user row lock
 *     pattern as emailVerification's cooldown, so a concurrent burst mints
 *     at most once per window).
 *   - Enumeration: this module never reveals whether a user exists — that
 *     posture lives in the route (auth.ts), which always returns the same
 *     response regardless of lookup outcome. This module's functions all
 *     take an already-resolved `userId`.
 *   - Token in URLs/logs: the link carries the token in the URL FRAGMENT
 *     (`#token=`), which browsers never send on the wire.
 *   - Stolen-session persistence across a reset: consuming a token revokes
 *     EVERY live session for the user (in the same transaction as the
 *     password change) — a reset is a security event, and the legitimate
 *     user proves the new password by signing in again rather than being
 *     auto-logged-in.
 *   - Secrets in logs: the raw token is never logged here (see services/mail
 *     for the mock-transport exception, the documented dev escape hatch).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { clientQuerier, withTransaction, type Querier } from '../db/pool.js';
import { getMailTransport } from '../services/mail.js';

/** 32 random bytes → base64url; identical entropy to a session token. */
const TOKEN_BYTES = 32;

/** base64url alphabet, 32 bytes → 43 chars (no padding). Same pre-DB shape
 *  gate as sessions / emailVerification. */
const RAW_TOKEN_SHAPE = /^[A-Za-z0-9_-]{42,44}$/;

/**
 * A reset link is a much higher-value credential than an email-verification
 * link (it grants a full account takeover, not just an address attestation),
 * so its window is deliberately shorter than EMAIL_VERIFICATION_TOKEN_TTL_HOURS
 * (24h default). One hour bounds the window in which an intercepted email
 * (shared inbox, a stale tab, a forwarded message) remains exploitable.
 */
const PASSWORD_RESET_TOKEN_TTL_HOURS = 1;

/**
 * A short cooldown prevents an attacker from mail-bombing a victim's inbox by
 * repeatedly hitting the request endpoint. 60s mirrors
 * EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC's default.
 */
const PASSWORD_RESET_RESEND_COOLDOWN_SEC = 60;

export type ConsumeResetOutcome =
  | { outcome: 'valid'; userId: number }
  | { outcome: 'invalid' }
  | { outcome: 'expired' }
  | { outcome: 'consumed' };

function mintRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Serialize per-user token issuance: lock the user's row for the remainder of
 * the transaction, exactly like emailVerification's lockUserForIssuance. Every
 * issuance path calls this FIRST so a concurrent burst of requests for the
 * same user serializes instead of each minting a live token / each passing
 * the cooldown probe.
 */
async function lockUserForIssuance(userId: number, q: Querier): Promise<void> {
  await q(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
}

/** Stamp `invalidated_at` on every live token for the user (audit-preserving
 *  supersession, not a delete). */
async function supersedeResetTokens(userId: number, q: Querier): Promise<void> {
  await q(
    `UPDATE password_reset_tokens
        SET invalidated_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [userId],
  );
}

/** The shared supersede-then-insert body. Caller has already locked the user
 *  row. */
async function supersedeAndInsert(
  userId: number,
  q: Querier,
): Promise<{ raw: string }> {
  const raw = mintRawToken();
  const tokenHash = hashToken(raw);
  await supersedeResetTokens(userId, q);
  await q(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3::int))`,
    [userId, tokenHash, PASSWORD_RESET_TOKEN_TTL_HOURS],
  );
  return { raw };
}

/** Run `fn` inside the caller's transaction when `exec` is provided, else in
 *  a fresh one. */
async function inTransaction<T>(
  exec: Querier | undefined,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  if (exec) return fn(exec);
  return withTransaction((client) => fn(clientQuerier(client)));
}

/**
 * Issue a fresh reset token for `userId`, unconditionally: lock the user row,
 * supersede every prior live token, insert the new hash — one atomic,
 * per-user-serialized unit. Returns the raw token — the ONLY copy that will
 * ever exist; the caller puts it in the email and drops it.
 */
export async function issuePasswordResetToken(
  userId: number,
  exec?: Querier,
): Promise<{ raw: string }> {
  return inTransaction(exec, async (q) => {
    await lockUserForIssuance(userId, q);
    return supersedeAndInsert(userId, q);
  });
}

/**
 * Cooldown-gated issuance (the real mail-bomb gate): returns null WITHOUT
 * touching any token when the user's most recent token is younger than
 * PASSWORD_RESET_RESEND_COOLDOWN_SEC, otherwise supersedes + inserts exactly
 * like `issuePasswordResetToken`.
 *
 * Atomic under concurrency: the probe runs inside the same transaction as the
 * insert, AFTER the per-user row lock — a concurrent burst of N requests
 * serializes, the first mints, and the remaining N-1 observe its fresh
 * `created_at` and are suppressed.
 */
export async function issuePasswordResetTokenIfCooldownClear(
  userId: number,
  exec?: Querier,
): Promise<{ raw: string } | null> {
  return inTransaction(exec, async (q) => {
    await lockUserForIssuance(userId, q);
    const { rows } = await q<{ within_cooldown: boolean | null }>(
      `SELECT max(created_at) > now() - make_interval(secs => $2::int)
              AS within_cooldown
         FROM password_reset_tokens
        WHERE user_id = $1`,
      [userId, PASSWORD_RESET_RESEND_COOLDOWN_SEC],
    );
    if (rows[0]?.within_cooldown === true) return null;
    return supersedeAndInsert(userId, q);
  });
}

interface TokenRow {
  id: number;
  user_id: number;
  token_hash: string;
}

/**
 * Resolve + atomically consume a presented raw token, ALL inside the
 * transaction the caller supplies via `q` (there is no self-contained
 * "own transaction" default — unlike `consumeVerificationToken`, the confirm
 * route MUST run this in the SAME transaction as the `users.password_hash`
 * write and `revokeAllUserSessions`, so a crash between them can never leave
 * a burned token with an unchanged password, or a changed password with a
 * still-live token). The caller is responsible for wrapping the call in
 * `withTransaction` and rolling back on any outcome other than `'valid'`.
 *
 * Outcomes:
 *   - `{ outcome: 'valid', userId }` — this call consumed the token
 *     (rowCount-gated single-use UPDATE won the race). The caller must now
 *     update `users.password_hash` for `userId` and revoke every session,
 *     in the SAME transaction.
 *   - `{ outcome: 'expired' }`  — token matched but its window passed. Safe
 *     to disclose: only reachable by someone already HOLDING the token, and
 *     it enables a "link expired — request a new one" UX.
 *   - `{ outcome: 'consumed' }` — token matched but was already used or
 *     superseded by a fresher request (includes the losing side of a
 *     concurrent double-submit race). Same disclosure reasoning as 'expired'.
 *   - `{ outcome: 'invalid' }`  — unknown/malformed token, or a token whose
 *     user has vanished (soft-deleted) since issuance.
 */
export async function consumePasswordResetToken(
  raw: string,
  q: Querier,
): Promise<ConsumeResetOutcome> {
  if (!raw || !RAW_TOKEN_SHAPE.test(raw)) return { outcome: 'invalid' };
  const tokenHash = hashToken(raw);
  const { rows } = await q<TokenRow>(
    `SELECT id, user_id, token_hash
       FROM password_reset_tokens
      WHERE token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return { outcome: 'invalid' };

  // Constant-time hash comparison (defense-in-depth; the indexed lookup
  // already matched byte-for-byte).
  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { outcome: 'invalid' };

  const u = await q<{ id: number }>(
    `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [row.user_id],
  );
  if (!u.rows[0]) return { outcome: 'invalid' }; // deleted/vanished user

  // Atomic single-use consume: consumed_at, invalidated_at, AND expires_at
  // are ALL re-checked in THIS statement's WHERE — not just at the SELECT
  // above. A pre-check-then-UPDATE would leave a TOCTOU window: a concurrent
  // supersede (a fresh request for the same user, `supersedeResetTokens`) or
  // an expiry that lands between the SELECT and the UPDATE could otherwise
  // still be raced through. Folding all three conditions into the UPDATE
  // means the moment a token is superseded, expires, or is consumed, the
  // very statement that would consume it stops matching — there is no gap.
  // A racing concurrent confirm of the SAME token serializes here too:
  // exactly one caller flips consumed_at (rowCount 1) and proceeds to change
  // the password; every other caller (a true double-submit, OR one that lost
  // to a fresher issuance/expiry) sees rowCount 0.
  const consumed = await q(
    `UPDATE password_reset_tokens
        SET consumed_at = now()
      WHERE id = $1
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
        AND expires_at > now()`,
    [row.id],
  );
  if (consumed.rowCount === 1) return { outcome: 'valid', userId: row.user_id };

  // The UPDATE's WHERE didn't match — the consume decision above is already
  // final; this is classification-only, for the route's expired-vs-invalid
  // disclosure split (safe: both are reachable only by someone already
  // HOLDING the token — see docstring). Re-read rather than trust the
  // pre-UPDATE `row`/`row.expired` snapshot, since the reason for the miss
  // may have changed between the SELECT and the UPDATE.
  const { rows: post } = await q<{ expired: boolean }>(
    `SELECT (expires_at <= now()) AS expired
       FROM password_reset_tokens
      WHERE id = $1`,
    [row.id],
  );
  if (post[0]?.expired) return { outcome: 'expired' };
  return { outcome: 'consumed' };
}

/**
 * Send the password-reset email carrying `raw` to `email`. Rejects on
 * transport failure — CALLERS MUST TREAT THIS AS BEST-EFFORT (see
 * emailVerification's sendVerificationEmail for the same contract) and catch
 * + log accordingly. MUST be called AFTER any surrounding transaction
 * commits — no external I/O inside an open transaction, and a sent link whose
 * token row rolled back would be dead on arrival.
 *
 * The token rides the URL FRAGMENT (`#token=`), not the query string:
 * fragments never leave the browser, so reverse-proxy/CDN access logs and
 * Referer headers can never capture a live token. The SPA's /reset-password
 * route reads `location.hash` and relays via POST.
 *
 * The email body contains NO user-supplied content (fixed copy + a link built
 * from CLIENT_ORIGIN and the server-minted token), so there is no injection
 * surface to escape.
 */
export async function sendPasswordResetEmail(email: string, raw: string): Promise<void> {
  const cfg = loadConfig();
  const base = cfg.CLIENT_ORIGIN.replace(/\/+$/, '');
  const url = `${base}/reset-password#token=${raw}`;
  await getMailTransport().sendMail({
    to: email,
    subject: 'Reset your password — Korean Master',
    text:
      `We received a request to reset the password for your Korean Master account.\n\n` +
      `Choose a new password by opening the link below:\n\n` +
      `${url}\n\n` +
      `The link can be used once and expires in ${String(PASSWORD_RESET_TOKEN_TTL_HOURS)} hour. ` +
      `If you did not request this, you can safely ignore this email — your password will not change.`,
    html:
      `<p>We received a request to reset the password for your <strong>Korean Master</strong> account.</p>` +
      `<p><a href="${url}">Choose a new password</a></p>` +
      `<p style="color:#666;font-size:13px">The link can be used once and expires in ` +
      `${String(PASSWORD_RESET_TOKEN_TTL_HOURS)} hour. If you did not request this, you can safely ` +
      `ignore this email — your password will not change.</p>`,
  });
}

/**
 * Issue a cooldown-gated token for `userId` and send the reset email —
 * the composed operation the request route calls once it has resolved a
 * user for the submitted email. Silently no-ops the send (but still returns)
 * when the cooldown suppresses issuance, matching
 * issueVerificationTokenIfCooldownClear + sendVerificationEmail's split so
 * the caller can log the cooldown case distinctly from an actual send.
 */
export async function issueAndSendPasswordResetEmail(
  userId: number,
  email: string,
): Promise<{ sent: boolean }> {
  const minted = await issuePasswordResetTokenIfCooldownClear(userId);
  if (!minted) return { sent: false };
  await sendPasswordResetEmail(email, minted.raw);
  return { sent: true };
}
