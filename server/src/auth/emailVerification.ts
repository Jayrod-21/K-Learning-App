/**
 * Email-verification tokens (F-006). Mirrors mfaChallenges.ts: opaque 32-byte
 * tokens, SHA-256 hex at rest, atomic single-use consume — plus the resend
 * supersession and the verification email itself.
 *
 * Lifecycle:
 *   1. Account creation (register / seed-user) or an email change →
 *      `issueVerificationToken` mints a raw token (which exists ONLY inside
 *      the sent email), stores its hash BOUND TO THE ADDRESS IT ATTESTS, and
 *      the caller mails the verify link. Issuing supersedes every prior live
 *      token for the user (`invalidated_at`), so exactly one link is ever
 *      redeemable — enforced under concurrency by a per-user row lock (see
 *      below), not just serial code order.
 *   2. The user opens `${CLIENT_ORIGIN}/verify-email#token=…` (URL FRAGMENT —
 *      the token never reaches any server/proxy log); the client reads
 *      `location.hash` and calls `POST /auth/verify`, which resolves through
 *      `consumeVerificationToken`.
 *   3. Success = ONE transaction: rowCount-gated consume + set
 *      `users.email_verified_at`. A racing double-click consumes at most once;
 *      the loser (and any later re-click) resolves to the friendly
 *      'already_verified' — verification is idempotent by design.
 *
 * Concurrency contract (fix-pass SF-3/SF-4): every issuance path starts its
 * transaction with `SELECT … FROM users WHERE id = $1 FOR UPDATE`. Two
 * concurrent issues for the same user therefore serialize: the loser blocks,
 * then its supersede UPDATE sees the winner's committed insert and stamps it —
 * so "exactly one live token per user" holds under concurrency, and the
 * cooldown probe in `issueVerificationTokenIfCooldownClear` is atomic with the
 * insert it gates (no check-then-act window for a resend burst).
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
 *   - Stale-address verification (fix-pass SF-1): each token row stores the
 *     `email` it was mailed to, and consume requires it to equal the user's
 *     CURRENT address. Even if a supersession were ever lost (crash between
 *     operations, code regression), a live token mailed to the OLD address can
 *     never stamp a NEW one — the binding, not the supersession, is the
 *     load-bearing defense.
 *   - Token in URLs/logs: the link carries the token in the URL FRAGMENT
 *     (`#token=`), which browsers never send on the wire — so nginx/proxy
 *     access logs and Referer headers never see it (fix-pass SF-2).
 *   - Privilege: a verification token confers NO session powers — consuming
 *     it only stamps `email_verified_at`. Login still requires password + MFA.
 *   - Secrets in logs: the raw token is never logged here (see services/mail
 *     for the mock-transport exception, which is the documented dev escape
 *     hatch when no relay is configured).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { clientQuerier, withTransaction, type Querier } from '../db/pool.js';
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
 * Serialize per-user token issuance: lock the user's row for the remainder of
 * the transaction. Every issuance path calls this FIRST so concurrent issues
 * (resend racing resend, resend racing an email change) queue instead of both
 * minting a live token / both passing the cooldown probe (SF-3/SF-4). The
 * lock is a no-op when the caller's transaction already holds it (e.g.
 * PATCH /auth/me's UPDATE of the same row).
 */
async function lockUserForIssuance(userId: number, q: Querier): Promise<void> {
  await q(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
}

/**
 * Stamp `invalidated_at` on every live token for the user (audit-preserving
 * supersession, not a delete). Exposed for PATCH /auth/me: on an email change
 * the old-address tokens must die IN THE SAME TRANSACTION as the verified-
 * stamp reset, even when the issuance cooldown suppresses minting a fresh one.
 */
export async function supersedeVerificationTokens(
  userId: number,
  q: Querier,
): Promise<void> {
  await q(
    `UPDATE email_verification_tokens
        SET invalidated_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [userId],
  );
}

/** The shared supersede-then-insert body. Caller has already locked the user
 *  row. `email` is the address the link will be mailed to — stored on the row
 *  so consume can enforce the token↔address binding (SF-1). */
async function supersedeAndInsert(
  userId: number,
  email: string,
  q: Querier,
): Promise<{ raw: string }> {
  const cfg = loadConfig();
  const raw = mintRawToken();
  const tokenHash = hashToken(raw);
  await supersedeVerificationTokens(userId, q);
  await q(
    `INSERT INTO email_verification_tokens (user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4::int))`,
    [userId, email, tokenHash, cfg.EMAIL_VERIFICATION_TOKEN_TTL_HOURS],
  );
  return { raw };
}

/** Run `fn` inside the caller's transaction when `exec` is provided, else in
 *  a fresh one. The exec path is what lets PATCH /auth/me make the verified-
 *  stamp reset, supersession, and fresh issue ONE atomic unit (SF-1). */
async function inTransaction<T>(
  exec: Querier | undefined,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  if (exec) return fn(exec);
  return withTransaction((client) => fn(clientQuerier(client)));
}

/**
 * Issue a fresh verification token for `userId`, attesting `email`: lock the
 * user row, supersede every prior live token, insert the new hash — one
 * atomic, per-user-serialized unit. Returns the raw token — the ONLY copy
 * that will ever exist; the caller puts it in the email and drops it.
 *
 * Pass an `exec` (transaction-bound `Querier`) to run inside the caller's
 * transaction; otherwise the lock+supersede+insert run in their own.
 */
export async function issueVerificationToken(
  userId: number,
  email: string,
  exec?: Querier,
): Promise<{ raw: string }> {
  return inTransaction(exec, async (q) => {
    await lockUserForIssuance(userId, q);
    return supersedeAndInsert(userId, email, q);
  });
}

/**
 * Cooldown-gated issuance (the real mail-bomb gate — config
 * EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC): returns null WITHOUT touching any
 * token when the user's most recent token is younger than the cooldown,
 * otherwise supersedes + inserts exactly like `issueVerificationToken`.
 *
 * Atomic under concurrency (SF-4/route S2): the probe runs inside the same
 * transaction as the insert, AFTER the per-user row lock — a concurrent burst
 * of N resends serializes, the first mints, and the remaining N-1 observe its
 * fresh `created_at` and are suppressed. At most one email per user per
 * window, no matter how many IPs ask.
 */
export async function issueVerificationTokenIfCooldownClear(
  userId: number,
  email: string,
  exec?: Querier,
): Promise<{ raw: string } | null> {
  const cooldownSec = loadConfig().EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC;
  return inTransaction(exec, async (q) => {
    await lockUserForIssuance(userId, q);
    const { rows } = await q<{ within_cooldown: boolean | null }>(
      `SELECT max(created_at) > now() - make_interval(secs => $2::int)
              AS within_cooldown
         FROM email_verification_tokens
        WHERE user_id = $1`,
      [userId, cooldownSec],
    );
    if (rows[0]?.within_cooldown === true) return null;
    return supersedeAndInsert(userId, email, q);
  });
}

interface TokenRow {
  id: number;
  user_id: number;
  email: string;
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
 *                          a consumed token whose user is NOT currently
 *                          verified, OR a token whose attested address is no
 *                          longer the user's current email (SF-1: a link
 *                          mailed to an OLD address must never verify a NEW
 *                          one, even if its supersession was somehow lost).
 */
export async function consumeVerificationToken(raw: string): Promise<VerifyOutcome> {
  if (!raw || !RAW_TOKEN_SHAPE.test(raw)) return 'invalid';
  const tokenHash = hashToken(raw);
  return withTransaction<VerifyOutcome>(async (client) => {
    const tx = clientQuerier(client);
    const { rows } = await tx(
      `SELECT id, user_id, email::text AS email, token_hash, consumed_at,
              invalidated_at, (expires_at <= now()) AS expired
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
      `SELECT email::text AS email, email_verified_at FROM users
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [row.user_id],
    );
    const user = u.rows[0] as
      | { email: string; email_verified_at: Date | null }
      | undefined;
    if (!user) return 'invalid'; // deleted/vanished user — token is dead
    if (user.email_verified_at !== null) return 'already_verified';

    // Unverified user + a spent or superseded token: this token must not
    // verify anything (replay / stale link after a resend or email change).
    if (row.consumed_at !== null || row.invalidated_at !== null) return 'invalid';

    // Token↔address binding (SF-1): the token attests exactly the address it
    // was mailed to. If the account's email changed since issuance, this
    // token is dead REGARDLESS of supersession state — the atomicity of the
    // email-change transaction is belt, this check is braces. Both columns
    // are citext in the DB; compare case-folded to match.
    if (row.email.toLowerCase() !== user.email.toLowerCase()) return 'invalid';

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
 * Send the verification email carrying `raw` to `email`. Rejects on transport
 * failure — CALLERS MUST TREAT THIS AS BEST-EFFORT (a mail outage must never
 * fail a registration or profile save; the resend endpoint is the recovery
 * path) and catch+log accordingly. MUST be called AFTER any surrounding
 * transaction commits — no external I/O inside an open transaction (db/pool
 * bar), and a sent link whose token row rolled back would be dead on arrival.
 *
 * The token rides the URL FRAGMENT (`#token=`), not the query string:
 * fragments never leave the browser, so reverse-proxy/CDN access logs and
 * Referer headers can never capture a live token (fix-pass SF-2). The SPA's
 * /verify-email route reads `location.hash` and relays via POST.
 *
 * The email body contains NO user-supplied content (fixed copy + a link built
 * from CLIENT_ORIGIN and the server-minted token), so there is no injection
 * surface to escape.
 */
export async function sendVerificationEmail(email: string, raw: string): Promise<void> {
  const cfg = loadConfig();
  // CLIENT_ORIGIN is the SPA origin (same-origin deploy); /verify-email is the
  // client verify-landing route. Trailing slash normalized defensively.
  const base = cfg.CLIENT_ORIGIN.replace(/\/+$/, '');
  const url = `${base}/verify-email#token=${raw}`;
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

/**
 * Issue a token attesting `email` and send the verification email —
 * UNCONDITIONAL issuance (register / seed-user, where no prior token can
 * exist). Cooldown-gated paths (resend, email change) compose
 * `issueVerificationTokenIfCooldownClear` + `sendVerificationEmail` instead.
 */
export async function issueAndSendVerificationEmail(
  userId: number,
  email: string,
): Promise<void> {
  const { raw } = await issueVerificationToken(userId, email);
  await sendVerificationEmail(email, raw);
}
