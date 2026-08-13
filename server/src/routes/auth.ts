/**
 * Auth routes.
 *
 *   POST  /auth/register       — create a user; session OR verification-required (F-006)
 *   POST  /auth/login          — verify password, issue a session
 *   POST  /auth/logout         — revoke current session, clear cookie
 *   GET   /auth/me             — describe the current user
 *   PATCH /auth/me             — update display_name / email / phone (Pass 3)
 *   POST  /auth/verify         — consume an email-verification token (F-006)
 *   POST  /auth/verify/resend  — re-issue the verification email (F-006)
 *
 * Threat model (SECURITY.md):
 *   - Credential stuffing: rate-limited per-IP via authLimiter.
 *   - Username enumeration: identical timing & error shape on bad-email vs
 *     bad-password (we always run a verify, even against a dummy hash).
 *   - Session fixation: any login always issues a NEW session row; we don't
 *     reuse cookies. (Caller may have an existing valid cookie — we just mint
 *     a new one and the old one stays valid until its expiry.)
 *   - Privilege escalation: registration cannot set arbitrary fields (Zod
 *     schema only accepts {email, password, display_name?}); PATCH /me's Zod
 *     schema is .strict() — extra keys (`role`, `is_admin`, …) are 400'd.
 *   - Email verification (F-006, SECURITY.md §19): registration and email
 *     changes issue a hashed, single-use, 24h-expiring token (see
 *     auth/emailVerification.ts for the token threat model) and email a
 *     verify link. With EMAIL_VERIFICATION_REQUIRED (default ON), an
 *     unverified account cannot complete a password login — the gate runs
 *     AFTER password verification (so it cannot be used to probe another
 *     account's verification status) and BEFORE any MFA challenge or session
 *     issue (so the TOTP/recovery/forced-enroll machinery is never entered
 *     unverified and is otherwise untouched). /auth/verify and
 *     /auth/verify/resend return fixed, non-enumerating shapes.
 *   - Email-change hijack: PATCH /me lets an authenticated user swap
 *     `users.email` directly. Defenses:
 *       (a) requiring an authenticated session (cookie was already issued to
 *           the prior email — an attacker without the session cookie can't
 *           pivot);
 *       (b) `authLimiter` rate-limiting the endpoint (same brute-force
 *           bucket as login);
 *       (c) WARN-level audit log on every email change (correlation id +
 *           user id + new domain only — never the new local part, to keep
 *           PII out of logs);
 *       (d) F-006: the change RESETS email_verified_at (the stamp attests the
 *           OLD address), supersedes outstanding tokens, and issues a fresh
 *           token for the NEW address — all in ONE transaction (fix-pass
 *           SF-1: no crash window can leave a live old-address token behind;
 *           and each token is bound to the address it attests, so a stale
 *           one is dead at consume regardless). The fresh send is gated by
 *           the same per-user cooldown as resend (fix-pass S1: an
 *           authenticated session cannot mail-bomb arbitrary addresses by
 *           flipping the email in a loop). The current session is kept (a
 *           typo'd address can still be corrected); the next login is gated.
 *   - Account-takeover via session token leak persisting across email change:
 *     out of scope here. The "log me out everywhere" SQL (ADR-002 §"Open
 *     questions") is the recovery path; the Settings UI will surface it when
 *     password change ships.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from '../middleware/errors.js';
import { validateBody } from '../middleware/validate.js';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { authLimiter, cheapLimiter } from '../middleware/rateLimits.js';
import { hashPassword, safeDummyVerify, verifyPassword } from '../auth/passwords.js';
import {
  clearSessionCookie,
  getActiveSession,
  issueSession,
  revokeSessionById,
  setSessionCookie,
} from '../auth/sessions.js';
import {
  buildOtpauthUri,
  generateSecret as generateTotpSecret,
  verifyTotp,
} from '../auth/totp.js';
import { generateRecoveryCodes, hashRecoveryCode } from '../auth/recoveryCodes.js';
import {
  consumeVerificationToken,
  issueAndSendVerificationEmail,
  issueVerificationTokenIfCooldownClear,
  sendVerificationEmail,
  supersedeVerificationTokens,
} from '../auth/emailVerification.js';
import {
  bumpChallengeAttempts,
  consumeChallenge,
  getActiveChallenge,
  issueChallenge,
} from '../auth/mfaChallenges.js';
import { encryptSecret, decryptSecret } from '../crypto/encryption.js';
import { loadConfig } from '../config/index.js';
import { query, withTransaction, clientQuerier, type Querier } from '../db/pool.js';

const router = Router();

/**
 * Internal sentinel: thrown inside the recovery-code spend transaction when the
 * challenge consume loses a concurrency race, so the surrounding `withTransaction`
 * rolls the recovery spend back (SF1). Never escapes the route handler.
 */
class ChallengeAlreadyConsumed extends Error {
  constructor() {
    super('challenge already consumed');
    this.name = 'ChallengeAlreadyConsumed';
  }
}

// -----------------------------------------------------------------------------
// MFA shared types + helpers (Pass Login). The route handlers below compose
// these; the heavy crypto / token logic lives in ../auth/{totp,recoveryCodes,
// mfaChallenges} and ../crypto/encryption so this file stays a thin orchestrator.
// -----------------------------------------------------------------------------

/** Confirmed-factor state for a user, loaded once per code-verify. */
interface ConfirmedTotpRow {
  user_id: number;
  secret_encrypted: string;
  last_used_step: string | null; // BIGINT comes back as string from pg.
  failed_attempts: number;
  locked_until: Date | null;
}

/**
 * Send a fixed-shape error body and status. Used for the MFA endpoints where the
 * contract pins extra fields (e.g. `retry_after`) that the generic error handler
 * would nest under `error.details`. NEVER echoes server-internal detail —
 * `code` is from a closed set and `message` is a fixed human string.
 */
function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

/**
 * Look up the user's CONFIRMED TOTP factor (confirmed_at IS NOT NULL). Returns
 * null when the user has no factor or only a pending (unconfirmed) one.
 */
async function getConfirmedTotp(userId: number): Promise<ConfirmedTotpRow | null> {
  const { rows } = await query<ConfirmedTotpRow>(
    `SELECT user_id, secret_encrypted, last_used_step, failed_attempts, locked_until
       FROM user_totp
      WHERE user_id = $1 AND confirmed_at IS NOT NULL
      LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** True iff the user has a confirmed TOTP factor (cheap existence probe). */
async function hasConfirmedTotp(userId: number): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
}

/** Count this user's unused recovery codes (for /mfa/status + responses). */
async function countUnusedRecoveryCodes(userId: number): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM user_recovery_codes
      WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Issue a fresh recovery-code set: delete the prior UNUSED codes (used ones are
 * kept for audit) and insert the new hashes. Returns the plaintext set to
 * surface ONCE.
 *
 * Pass an `exec` (transaction-bound `Querier`) to run the delete+insert inside
 * the caller's transaction — the confirm path does this so the shown codes and
 * the stored hashes can NEVER desync under a concurrency race (SF2): the codes
 * are issued on the SAME connection that won the `confirmed_at IS NULL` gate, so
 * a losing concurrent confirm never reaches this and never overwrites the
 * winner's set. With no `exec`, the operation runs in its own transaction.
 */
async function issueRecoveryCodes(
  userId: number,
  count: number,
  exec?: Querier,
): Promise<string[]> {
  const { plaintext, hashes } = generateRecoveryCodes(count);
  const run = async (q: Querier): Promise<void> => {
    await q(
      `DELETE FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    // Single multi-row insert via unnest keeps it one round-trip and one
    // statement (so the UNIQUE constraint is checked atomically for the set).
    await q(
      `INSERT INTO user_recovery_codes (user_id, code_hash)
       SELECT $1, h FROM unnest($2::text[]) AS h`,
      [userId, hashes],
    );
  };
  if (exec) {
    await run(exec);
  } else {
    await withTransaction((client) => run(clientQuerier(client)));
  }
  return plaintext;
}

/**
 * Conditional `requireAuth` for the enroll/confirm dual-auth endpoints.
 *
 * The forced-enrollment login path presents a `challenge_token` and is, by
 * definition, NOT yet authenticated — applying requireAuth unconditionally would
 * 401 it. The Settings re-enroll path presents a session (+ password) and MUST be
 * authenticated. We branch on the presence of a `challenge_token` in the raw
 * (already JSON-parsed) body: challenge present → skip auth; absent → requireAuth.
 *
 * Security note: this gate decides ONLY whether to populate req.user. The actual
 * authorization is in resolveEnrollAuth — a request that claims neither a valid
 * challenge nor a valid session+password is rejected there. A request that sends
 * BOTH is shape-rejected by the Zod `.refine` (exactly one). So a forged/empty
 * challenge_token here just skips requireAuth and then fails challenge lookup.
 */
function conditionalRequireAuth(
  req: Request,
  res: Response,
  next: import('express').NextFunction,
): void {
  const body = (req.body ?? {}) as { challenge_token?: unknown };
  if (typeof body.challenge_token === 'string' && body.challenge_token.length > 0) {
    next();
    return;
  }
  void requireAuth(req, res, next);
}

/** The public user payload — the SAME fields GET /auth/me returns. */
interface PublicUser {
  id: number;
  email: string;
  display_name: string | null;
  phone: string | null;
  version: number;
  /** F-006: drives the client's "verify your email" banner. Derived
   *  (email_verified_at IS NOT NULL) — the timestamp itself is not exposed. */
  email_verified: boolean;
}

/**
 * Finalize a successful login: refresh last_login_at, mint a session, set the
 * cookie, and return the public user payload. Shared by the legacy direct-login
 * branch and the post-MFA branches so the session-issue path is identical.
 *
 * Returns the FULL public shape (same fields as GET /auth/me): the client's
 * LoginResponse type declares `display_name`/`phone`/`version`, and returning
 * only {id,email} left post-login consumers of `.version` with `undefined`
 * until the next /auth/me probe (client-contracts sweep #16). The row is
 * re-read (and the soft-delete recheck applied) BEFORE the session is minted,
 * so an account deleted mid-login cannot receive a fresh session.
 */
async function finishLogin(
  req: Request,
  res: Response,
  user: { id: number; email: string },
): Promise<PublicUser> {
  const { rows } = await query<{
    id: string;
    email: string;
    display_name: string | null;
    phone: string | null;
    version: number;
    email_verified: boolean;
  }>(
    `SELECT id, email::text AS email, display_name, phone, version,
            (email_verified_at IS NOT NULL) AS email_verified
       FROM users
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [user.id],
  );
  const row = rows[0];
  if (!row) {
    // Vanished/soft-deleted between the caller's check and here — same
    // opaque message as a failed credential check (no enumeration signal).
    throw new UnauthorizedError('invalid credentials');
  }
  const { raw, record } = await issueSession(user.id, {
    userAgent: req.header('user-agent') ?? undefined,
    ipAddress: req.ip ?? undefined,
  });
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  setSessionCookie(res, raw, record.expires_at);
  // pg returns BIGINT as a string; the user DTO contract is a JSON number.
  return { ...row, id: Number(row.id) };
}

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// OWASP: ≥12 chars, allow paste-friendly diceware. Upper bound bounds
// argon2 input cost.
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

// Phone validation: shape only — strict E.164 normalization is the client's
// job. Allowed alphabet matches the DB ck_users_phone_shape CHECK exactly so a
// payload that passes Zod also passes the DB constraint (no surprise 500 from
// constraint violation that Zod could have caught at the boundary).
const PHONE_REGEX = /^[+0-9 ()-]+$/;
const PHONE_MIN = 7;
const PHONE_MAX = 32;

const RegisterSchema = z.object({
  email: z.string().email().regex(EMAIL_REGEX).max(254),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  display_name: z.string().min(1).max(80).optional(),
});

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(PASSWORD_MAX),
});

router.post(
  '/register',
  authLimiter(),
  validateBody(RegisterSchema),
  async (req, res, next) => {
    try {
      // Registration gate (PASS_LOGIN_CONTRACT B6): a single-user deployment
      // disables self-signup (REGISTRATION_ENABLED=false) and provisions the one
      // account via the seed-user CLI. Reject BEFORE any DB work so a closed
      // registration costs nothing and leaks nothing about existing accounts.
      // Fixed code `registration_closed` per the contract (not the generic
      // ForbiddenError `forbidden` code) so the client error table can map it.
      const cfg = loadConfig();
      if (!cfg.REGISTRATION_ENABLED) {
        sendError(res, 403, 'registration_closed', 'registration is closed');
        return;
      }
      const body = req.body as z.infer<typeof RegisterSchema>;
      const passwordHash = await hashPassword(body.password);
      let userId: number;
      try {
        const { rows } = await query<{ id: number }>(
          `INSERT INTO users (email, password_hash, display_name)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [body.email.toLowerCase(), passwordHash, body.display_name ?? null],
        );
        const r = rows[0];
        if (!r) throw new Error('register insert returned no rows');
        // pg returns BIGINT as a string; the user DTO contract is a JSON number.
        userId = Number(r.id);
      } catch (err) {
        // 23505 = unique_violation. Surface a deliberately vague conflict;
        // do NOT leak which field collided.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError('account already exists');
        }
        throw err;
      }
      const email = body.email.toLowerCase();

      // F-006: issue the verification token + send the email. BEST-EFFORT —
      // a mail outage must never fail the registration (the account exists;
      // /auth/verify/resend is the recovery path). The raw token lives only
      // inside the email; nothing here logs it.
      try {
        await issueAndSendVerificationEmail(userId, email);
      } catch (mailErr) {
        req.log.error(
          { userId, err: (mailErr as Error).message },
          'verification email send failed (registration still succeeded)',
        );
      }

      if (cfg.EMAIL_VERIFICATION_REQUIRED) {
        // Verification-gated deployments do NOT mint a session at register:
        // the login gate would reject this account anyway, and handing an
        // unverified browser a session would contradict it. The client shows
        // the "check your email" screen off this typed status.
        req.log.info({ userId }, 'user registered — email verification pending');
        res.status(201).json({
          status: 'verification_required',
          user: { id: userId, email },
        });
        return;
      }

      // Legacy / gate-off: the original direct-session behavior, unchanged.
      const { raw, record } = await issueSession(userId, {
        userAgent: req.header('user-agent') ?? undefined,
        ipAddress: req.ip ?? undefined,
      });
      setSessionCookie(res, raw, record.expires_at);
      req.log.info({ userId }, 'user registered');
      res.status(201).json({ user: { id: userId, email } });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/login',
  authLimiter(),
  validateBody(LoginSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof LoginSchema>;
      const email = body.email.toLowerCase();
      const { rows } = await query<{
        id: number;
        password_hash: string;
        deleted_at: Date | null;
        email_verified_at: Date | null;
      }>(
        `SELECT id, password_hash, deleted_at, email_verified_at
           FROM users
          WHERE email = $1
          LIMIT 1`,
        [email],
      );
      const row = rows[0];
      // CRITICAL: same shape and approximately same timing whether email
      // exists or not. We run verifyPassword either way.
      if (!row || row.deleted_at) {
        await safeDummyVerify();
        throw new UnauthorizedError('invalid credentials');
      }
      // pg returns BIGINT as a string; the user DTO contract is a JSON number.
      const user = { ...row, id: Number(row.id) };
      const ok = await verifyPassword(user.password_hash, body.password);
      if (!ok) {
        throw new UnauthorizedError('invalid credentials');
      }

      // F-006 login gate: an unverified account cannot proceed to MFA or a
      // session. Placement is security-load-bearing:
      //   - AFTER password verification — verification status is disclosed
      //     ONLY to a caller holding valid credentials (no enumeration /
      //     status-probing oracle; wrong password stays the generic 401).
      //   - BEFORE the MFA branches — the TOTP/recovery/forced-enroll paths
      //     are simply never entered unverified, so nothing about the MFA
      //     machinery is weakened or special-cased, and verified users'
      //     logins are byte-identical to before.
      // Typed code (not a generic failure) so the client can render the
      // "verify your email" state with a resend affordance. Config-toggleable:
      // EMAIL_VERIFICATION_REQUIRED=false is the operator kill-switch if mail
      // delivery breaks — with it off this block is a no-op.
      if (loadConfig().EMAIL_VERIFICATION_REQUIRED && row.email_verified_at === null) {
        req.log.info({ userId: user.id }, 'login blocked — email unverified');
        sendError(res, 403, 'email_unverified', 'email address not verified');
        return;
      }

      // Password verified — branch on the user's TOTP state (PASS_LOGIN_CONTRACT
      // B6, D1/D2). The password step NEVER issues a session directly when MFA is
      // in play; it issues a short-lived, single-use pending challenge and the
      // client must complete the second step. No session cookie is set here in
      // the MFA branches.
      const cfg = loadConfig();
      const confirmed = await hasConfirmedTotp(user.id);

      if (confirmed) {
        // Step 2 will be a TOTP code (or a recovery code).
        const { raw } = await issueChallenge(user.id, 'totp', cfg.MFA_CHALLENGE_TTL_SEC);
        req.log.info({ userId: user.id }, 'login step 1 ok — mfa required');
        res.status(200).json({
          status: 'mfa_required',
          challenge_token: raw,
          expires_in: cfg.MFA_CHALLENGE_TTL_SEC,
        });
        return;
      }

      if (cfg.MFA_REQUIRED) {
        // Mandatory MFA, no confirmed factor → force enrollment before any
        // session is issued. Step 2 is enroll + confirm.
        const { raw } = await issueChallenge(user.id, 'enroll', cfg.MFA_CHALLENGE_TTL_SEC);
        req.log.info({ userId: user.id }, 'login step 1 ok — enrollment required');
        res.status(200).json({
          status: 'enrollment_required',
          challenge_token: raw,
          expires_in: cfg.MFA_CHALLENGE_TTL_SEC,
        });
        return;
      }

      // Legacy / MFA-disabled path: issue the full session immediately (the old
      // single-step behavior). Gated behind MFA_REQUIRED=false.
      const publicUser = await finishLogin(req, res, { id: user.id, email });
      req.log.info({ userId: user.id }, 'login success (no mfa)');
      res.status(200).json({ status: 'authenticated', user: publicUser });
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------------------
// POST /auth/login/totp — second login step (PASS_LOGIN_CONTRACT B6).
//
// body { challenge_token, code }. `code` is EITHER a 6-digit TOTP OR a recovery
// code. Order of operations is security-critical:
//   1. resolve the challenge → user (a 'totp'-purpose, unconsumed, unexpired
//      challenge is the ONLY thing that authorizes this step — the password is
//      not re-checked here);
//   2. per-account lockout check (B-LOCK) → 423 if locked;
//   3. try TOTP (with monotonic replay guard), then recovery code;
//   4. success → consume the challenge atomically, reset lockout counters, set
//      last_used_step (TOTP), issue the session;
//   5. failure → bump counters, lock on the Nth failure, 401 (or 423 if locked).
// -----------------------------------------------------------------------------
const LoginTotpSchema = z.object({
  challenge_token: z.string().min(1).max(128),
  // Accept TOTP (6 digits) OR a recovery code (alnum + dashes/space, bounded).
  // The shape is permissive on purpose — the verify paths discriminate. Bounding
  // the length keeps a hostile payload from ballooning the hash input.
  code: z.string().min(1).max(64),
});

router.post(
  '/login/totp',
  authLimiter(),
  validateBody(LoginTotpSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof LoginTotpSchema>;
      const cfg = loadConfig();

      const challenge = await getActiveChallenge(body.challenge_token, 'totp');
      if (!challenge) {
        // Unknown / expired / consumed / wrong-purpose token. One opaque code.
        sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
        return;
      }
      const userId = challenge.user_id;

      const totp = await getConfirmedTotp(userId);
      if (!totp) {
        // The challenge says 'totp' but no confirmed factor exists — a state
        // that should be impossible (login only mints a 'totp' challenge when a
        // factor is confirmed). Treat as an invalid challenge, never a 500.
        sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
        return;
      }

      // B-LOCK: per-account lockout. Reject before spending any verify effort.
      if (totp.locked_until && totp.locked_until.getTime() > Date.now()) {
        const retryAfter = Math.ceil((totp.locked_until.getTime() - Date.now()) / 1000);
        sendError(res, 423, 'account_locked', 'too many attempts; try again later', {
          retry_after: retryAfter,
        });
        return;
      }

      const lastStep = totp.last_used_step === null ? -1 : Number(totp.last_used_step);

      // --- Attempt 1: TOTP code with monotonic replay guard. ---
      let authed = false;
      let matchedStep: number | null = null;
      try {
        const secret = decryptSecret(totp.secret_encrypted);
        const result = await verifyTotp(secret, body.code);
        if (result.ok && result.step !== null && result.step > lastStep) {
          authed = true;
          matchedStep = result.step;
        }
        // result.ok but step <= lastStep → replayed code: leave authed false so
        // it falls through to the failure path (NOT a recovery-code attempt with
        // a TOTP value, which can't match a recovery hash anyway).
      } catch (cryptoErr) {
        // Decryption failure (tampered/garbled secret at rest). Never trust an
        // unverified secret — log and fall through to the failure path; do NOT
        // 500 (that would leak that the stored secret is the problem).
        req.log.error({ userId, err: 'totp_secret_decrypt_failed' }, 'totp decrypt failed');
        void cryptoErr;
      }

      // --- Attempt 2: recovery code (only if TOTP didn't already authorize). ---
      //
      // SECURITY/UX (SF1): the recovery-code spend and the challenge consume must
      // succeed-or-fail TOGETHER. If they were independent atomic gates, two
      // concurrent submits carrying two DIFFERENT valid recovery codes against the
      // SAME challenge would each spend their code, but only one could win the
      // consume — the loser would have permanently burned a one-time code for no
      // session. We bind the spend and the consume into ONE transaction (recovery
      // path only): if the consume loses the race, the transaction rolls back and
      // the code is un-spent. The TOTP path spends nothing, so it consumes outside
      // a transaction as before.
      //
      // A WRONG code is NOT consumed (the spend's rowCount-0 gate leaves it unused)
      // and does NOT consume the challenge — bumpChallengeAttempts tracks the retry,
      // preserving the retry-on-typo UX within the 5-minute challenge window.
      let recoverySpent = false;
      let consumedViaRecovery = false;
      if (!authed) {
        const codeHash = hashRecoveryCode(body.code);
        try {
          recoverySpent = await withTransaction(async (client) => {
            const tx = clientQuerier(client);
            // Atomic single-use spend scoped to THIS user; the rowCount gate means
            // a racing double-submit spends the code at most once.
            const spend = await tx(
              `UPDATE user_recovery_codes
                  SET used_at = now()
                WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
              [userId, codeHash],
            );
            if (spend.rowCount !== 1) return false; // not a valid unused code
            // Consume the challenge on the SAME connection. If the consume loses
            // the race, throw so the surrounding transaction rolls the spend back.
            const consumed = await consumeChallenge(challenge.id, tx);
            if (!consumed) throw new ChallengeAlreadyConsumed();
            return true;
          });
        } catch (txErr) {
          if (txErr instanceof ChallengeAlreadyConsumed) {
            // The racing winner already issued a session; our spend rolled back so
            // the code remains unused. Surface invalid-challenge to the loser.
            sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
            return;
          }
          throw txErr;
        }
        if (recoverySpent) {
          authed = true;
          consumedViaRecovery = true;
        }
      }

      if (!authed) {
        // Failure: bump the per-challenge and per-account counters, lock on the
        // Nth consecutive failure. We re-read failed_attempts via the UPDATE so
        // the lock decision uses the post-increment value atomically.
        await bumpChallengeAttempts(challenge.id);
        const locked = await query<{ failed_attempts: number; locked_until: Date | null }>(
          `UPDATE user_totp
              SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE
                    WHEN failed_attempts + 1 >= $2
                    THEN now() + make_interval(mins => $3::int)
                    ELSE locked_until
                  END
            WHERE user_id = $1
            RETURNING failed_attempts, locked_until`,
          [userId, cfg.TOTP_MAX_FAILED_ATTEMPTS, cfg.TOTP_LOCKOUT_MINUTES],
        );
        const row = locked.rows[0];
        if (row?.locked_until && row.locked_until.getTime() > Date.now()) {
          const retryAfter = Math.ceil((row.locked_until.getTime() - Date.now()) / 1000);
          req.log.warn({ userId }, 'account locked after failed totp attempts');
          sendError(res, 423, 'account_locked', 'too many attempts; try again later', {
            retry_after: retryAfter,
          });
          return;
        }
        sendError(res, 401, 'invalid_code', 'that code did not match');
        return;
      }

      // --- Success: consume the challenge atomically (single-use). ---
      // The recovery path already consumed the challenge inside its transaction
      // (atomically with the spend); only the TOTP path consumes here.
      if (!consumedViaRecovery) {
        const consumed = await consumeChallenge(challenge.id);
        if (!consumed) {
          // A concurrent submit already consumed this challenge. The TOTP path
          // spent nothing, so there is no credential to roll back — surface an
          // invalid-challenge to the loser (no session, no replay).
          sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
          return;
        }
      }

      // Reset lockout counters and advance the replay high-water-mark (TOTP path
      // only; a recovery-code success does not change the TOTP step).
      if (matchedStep !== null) {
        await query(
          `UPDATE user_totp
              SET failed_attempts = 0, locked_until = NULL, last_used_step = $2
            WHERE user_id = $1`,
          [userId, matchedStep],
        );
      } else {
        await query(
          `UPDATE user_totp SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
          [userId],
        );
      }

      // Load the public user fields for the response.
      const u = await query<{ id: number; email: string }>(
        `SELECT id, email::text AS email FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [userId],
      );
      const userRow = u.rows[0];
      if (!userRow) {
        sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
        return;
      }
      // pg returns BIGINT as a string; the user DTO contract is a JSON number.
      const publicUser = await finishLogin(req, res, { ...userRow, id: Number(userRow.id) });
      req.log.info(
        { userId, via: recoverySpent ? 'recovery_code' : 'totp' },
        'login step 2 ok — authenticated',
      );
      res.status(200).json({ status: 'authenticated', user: publicUser });
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------------------
// MFA enroll / confirm dual-auth (PASS_LOGIN_CONTRACT B6).
//
// Both endpoints accept EITHER:
//   (a) a 'enroll'-purpose challenge_token (the forced-enrollment login path), OR
//   (b) a full session (requireAuth) + password re-auth (the Settings re-enroll
//       path).
// resolveEnrollAuth resolves to the user id under whichever mode the request
// presents, and returns the challenge id when mode (a) so confirm can consume it.
// -----------------------------------------------------------------------------
interface EnrollAuth {
  userId: number;
  /** Set in the challenge mode (a); confirm consumes it. null in session mode (b). */
  challengeId: number | null;
}

/**
 * Resolve enroll/confirm auth. Returns the EnrollAuth on success, or null after
 * having already sent the appropriate error response (caller just returns).
 */
async function resolveEnrollAuth(
  req: Request,
  res: Response,
  challengeToken: string | undefined,
  password: string | undefined,
): Promise<EnrollAuth | null> {
  // Mode (a): challenge token (forced-enrollment login). Takes precedence when
  // present so an unauthenticated user can complete first-time enrollment.
  if (challengeToken) {
    const challenge = await getActiveChallenge(challengeToken, 'enroll');
    if (!challenge) {
      sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
      return null;
    }
    return { userId: challenge.user_id, challengeId: challenge.id };
  }

  // Mode (b): session + password re-auth (Settings re-enroll). requireAuth has
  // already populated req.user for this branch (the route chains requireAuth
  // conditionally — see the handler). Re-verify the password as a step-up.
  if (!req.user) {
    sendError(res, 401, 'unauthorized', 'authentication required');
    return null;
  }
  if (!password) {
    sendError(res, 400, 'password_required', 'password re-authentication required');
    return null;
  }
  const userId = req.user.id;
  const { rows } = await query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) {
    sendError(res, 401, 'unauthorized', 'authentication required');
    return null;
  }
  const ok = await verifyPassword(row.password_hash, password);
  if (!ok) {
    sendError(res, 401, 'invalid_credentials', 'invalid credentials');
    return null;
  }
  return { userId, challengeId: null };
}

const EnrollSchema = z
  .object({
    challenge_token: z.string().min(1).max(128).optional(),
    password: z.string().min(1).max(256).optional(),
  })
  .refine((v) => Boolean(v.challenge_token) !== Boolean(v.password), {
    message: 'provide exactly one of challenge_token or password',
  });

/**
 * POST /auth/mfa/enroll — generate a PENDING secret (UPSERT user_totp with
 * confirmed_at=NULL, counters reset) and return the otpauth URI + secret for the
 * client to render a QR / show for manual entry. Does NOT confirm, does NOT
 * consume the challenge, does NOT issue a session. The secret is live only after
 * /auth/mfa/confirm. requireAuth runs only when no challenge_token is presented
 * (session re-enroll); we model that by chaining a conditional auth shim.
 */
router.post(
  '/mfa/enroll',
  authLimiter(),
  conditionalRequireAuth,
  validateBody(EnrollSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof EnrollSchema>;
      const auth = await resolveEnrollAuth(req, res, body.challenge_token, body.password);
      if (!auth) return;

      const secret = generateTotpSecret();
      const encrypted = encryptSecret(secret);

      // The otpauth label is the user's email. Load it (we may not have it on
      // req.user in the challenge path).
      const u = await query<{ email: string }>(
        `SELECT email::text AS email FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [auth.userId],
      );
      const email = u.rows[0]?.email;
      if (!email) {
        sendError(res, 401, 'unauthorized', 'authentication required');
        return;
      }

      // UPSERT: a re-enroll OVERWRITES the prior row, resetting confirmed_at to
      // NULL (the new secret is pending) and clearing lockout/replay state so the
      // new factor starts clean. Until confirm, the OLD factor (if any) is gone —
      // this is the documented re-enroll behavior (mandatory MFA, no disable).
      await query(
        `INSERT INTO user_totp (user_id, secret_encrypted, confirmed_at,
                                last_used_step, failed_attempts, locked_until)
         VALUES ($1, $2, NULL, NULL, 0, NULL)
         ON CONFLICT (user_id) DO UPDATE
           SET secret_encrypted = EXCLUDED.secret_encrypted,
               confirmed_at = NULL,
               last_used_step = NULL,
               failed_attempts = 0,
               locked_until = NULL`,
        [auth.userId, encrypted],
      );

      const otpauthUri = buildOtpauthUri(secret, email);
      req.log.info({ userId: auth.userId }, 'mfa enrollment secret issued');
      // secret is returned for manual entry; the client renders the QR from the
      // URI. Both are shown to the enrolling user only.
      res.status(200).json({ otpauth_uri: otpauthUri, secret });
    } catch (err) {
      next(err);
    }
  },
);

const ConfirmSchema = z
  .object({
    challenge_token: z.string().min(1).max(128).optional(),
    password: z.string().min(1).max(256).optional(),
    code: z.string().min(1).max(16),
  })
  .refine((v) => Boolean(v.challenge_token) !== Boolean(v.password), {
    message: 'provide exactly one of challenge_token or password',
  });

/**
 * POST /auth/mfa/confirm — verify `code` against the PENDING secret, mark the
 * factor confirmed, mint recovery codes, and (challenge path) consume the
 * challenge + issue the session. Same dual-auth as enroll.
 */
router.post(
  '/mfa/confirm',
  authLimiter(),
  conditionalRequireAuth,
  validateBody(ConfirmSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof ConfirmSchema>;
      const cfg = loadConfig();
      const auth = await resolveEnrollAuth(req, res, body.challenge_token, body.password);
      if (!auth) return;

      // Load the PENDING secret (confirmed_at IS NULL). If there isn't one, the
      // client skipped enroll or already confirmed — reject as a no-op.
      const pending = await query<{ secret_encrypted: string }>(
        `SELECT secret_encrypted FROM user_totp
          WHERE user_id = $1 AND confirmed_at IS NULL LIMIT 1`,
        [auth.userId],
      );
      const pendingRow = pending.rows[0];
      if (!pendingRow) {
        sendError(res, 400, 'no_pending_enrollment', 'no pending enrollment to confirm');
        return;
      }

      let matchedStep: number | null = null;
      try {
        const secret = decryptSecret(pendingRow.secret_encrypted);
        const result = await verifyTotp(secret, body.code);
        if (result.ok && result.step !== null) matchedStep = result.step;
      } catch (cryptoErr) {
        req.log.error({ userId: auth.userId, err: 'pending_secret_decrypt_failed' }, 'confirm decrypt failed');
        void cryptoErr;
      }
      if (matchedStep === null) {
        // Bad code on confirm. No per-account lockout here (it's the enrolling
        // user proving possession), but the IP authLimiter still bounds attempts.
        sendError(res, 400, 'invalid_code', 'that code did not match');
        return;
      }

      // SECURITY (SF2): the `confirmed_at IS NULL` UPDATE is the serialization
      // point for confirm. Two concurrent confirms on the same pending secret both
      // verify the code, but only ONE flips confirmed_at (rowCount === 1); the
      // loser is a no-op. We bind that gate, the recovery-code issue, and (challenge
      // path) the challenge consume into ONE transaction so ONLY the winner issues
      // recovery codes — otherwise the loser's DELETE+insert could overwrite the
      // winner's stored hashes while the winner shows its own plaintext, leaving the
      // user holding codes that fail at login. The loser issues nothing and bails.
      const challengeId = auth.challengeId;
      let confirmResult: { recoveryCodes: string[] } | null;
      try {
        confirmResult = await withTransaction<{ recoveryCodes: string[] } | null>(
          async (client) => {
            const tx = clientQuerier(client);
            // Mark confirmed + seed the replay guard with the confirming step (so
            // the very code used to confirm cannot also be replayed to log in).
            const flip = await tx(
              `UPDATE user_totp
                  SET confirmed_at = now(), last_used_step = $2,
                      failed_attempts = 0, locked_until = NULL
                WHERE user_id = $1 AND confirmed_at IS NULL`,
              [auth.userId, matchedStep],
            );
            if (flip.rowCount !== 1) {
              // A concurrent confirm already flipped confirmed_at. This request is
              // a no-op (nothing written yet) — do NOT re-issue recovery codes
              // (that is the desync this fix prevents). Commit the empty txn.
              return null;
            }
            // Fresh recovery codes (deletes prior unused, inserts new). Shown ONCE.
            const codes = await issueRecoveryCodes(auth.userId, cfg.RECOVERY_CODE_COUNT, tx);
            if (challengeId !== null) {
              // Challenge (forced-enrollment login) path: consume on the SAME
              // connection so the consume + confirmed_at flip + issue commit
              // together. If the consume loses (defensive — the confirmed_at flip
              // already serializes the two confirms), throw to ROLL BACK the flip
              // and the issue rather than commit a confirmed factor with no session.
              const consumed = await consumeChallenge(challengeId, tx);
              if (!consumed) throw new ChallengeAlreadyConsumed();
            }
            return { recoveryCodes: codes };
          },
        );
      } catch (txErr) {
        if (txErr instanceof ChallengeAlreadyConsumed) {
          sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
          return;
        }
        throw txErr;
      }

      if (!confirmResult) {
        // We lost the confirm race; the winner already issued codes (and, on the
        // challenge path, will issue the session). Surface invalid-challenge.
        sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
        return;
      }
      const recoveryCodes = confirmResult.recoveryCodes;

      if (challengeId !== null) {
        // Challenge (forced-enrollment login) path: issue the session.
        const u = await query<{ id: number; email: string }>(
          `SELECT id, email::text AS email FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [auth.userId],
        );
        const userRow = u.rows[0];
        if (!userRow) {
          sendError(res, 401, 'challenge_invalid', 'sign-in challenge is invalid or expired');
          return;
        }
        // pg returns BIGINT as a string; the user DTO contract is a JSON number.
        const publicUser = await finishLogin(req, res, { ...userRow, id: Number(userRow.id) });
        req.log.info({ userId: auth.userId }, 'mfa enrollment confirmed — authenticated');
        res.status(200).json({
          status: 'authenticated',
          user: publicUser,
          recovery_codes: recoveryCodes,
        });
        return;
      }

      // Session (Settings re-enroll) path: keep the current session. We do NOT
      // revoke other sessions here — the user re-authenticated with their
      // password and is mid-session; rotating the secret does not invalidate the
      // session cookie, and forcing a re-login on every device for a routine
      // "new phone" rotation is hostile UX. (A future "log out everywhere" lives
      // in Settings when password-change ships — documented in SECURITY.md §18.)
      req.log.info({ userId: auth.userId }, 'mfa re-enrollment confirmed (session path)');
      res.status(200).json({ status: 'updated', recovery_codes: recoveryCodes });
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------------------
// POST /auth/mfa/recovery-codes/regenerate — requireAuth + password re-auth.
// Deletes the prior unused codes and issues a fresh set, shown ONCE.
// -----------------------------------------------------------------------------
const RegenerateSchema = z.object({ password: z.string().min(1).max(256) });

router.post(
  '/mfa/recovery-codes/regenerate',
  authLimiter(),
  requireAuth,
  validateBody(RegenerateSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof RegenerateSchema>;
      const { rows } = await query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [userId],
      );
      const row = rows[0];
      if (!row) {
        sendError(res, 401, 'unauthorized', 'authentication required');
        return;
      }
      const ok = await verifyPassword(row.password_hash, body.password);
      if (!ok) {
        sendError(res, 401, 'invalid_credentials', 'invalid credentials');
        return;
      }
      const cfg = loadConfig();
      const recoveryCodes = await issueRecoveryCodes(userId, cfg.RECOVERY_CODE_COUNT);
      req.log.info({ userId }, 'recovery codes regenerated');
      res.status(200).json({ recovery_codes: recoveryCodes });
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------------------
// GET /auth/mfa/status — requireAuth. For the Settings 2FA section.
// -----------------------------------------------------------------------------
router.get('/mfa/status', authLimiter(), requireAuth, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const enabled = await hasConfirmedTotp(userId);
    const remaining = await countUnusedRecoveryCodes(userId);
    res.status(200).json({ enabled, recovery_codes_remaining: remaining });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// Email verification (F-006). See auth/emailVerification.ts for the token
// lifecycle + threat model; SECURITY.md §19 for the summary.
// -----------------------------------------------------------------------------

/**
 * Verify handler — POST only. The emailed link carries the token in the URL
 * FRAGMENT (`/verify-email#token=…`), which never leaves the browser; the SPA
 * reads `location.hash` and relays it here as a POST body. There is
 * deliberately NO GET `?token=` variant: a live secret in a query string
 * lands in reverse-proxy/CDN access logs and browser history sync (fix-pass
 * SF-2 / route N1) — the GET convenience route this feature briefly shipped
 * was removed for exactly that reason. Consuming is idempotent-safe: an
 * already-verified user gets a friendly success, never an error
 * (double-click = still fine).
 *
 * Limiter: authLimiter — it counts FAILED responses only, which is exactly
 * the brute-force signal here (a flood of bad tokens 400s and starves; a
 * legitimate double-click succeeds and is never throttled).
 */
async function handleVerify(req: Request, res: Response, rawToken: unknown): Promise<void> {
  // Shape gate at the boundary (defense-in-depth over the Zod body schema).
  if (typeof rawToken !== 'string' || rawToken.length === 0 || rawToken.length > 128) {
    sendError(res, 400, 'token_invalid', 'that verification link is not valid');
    return;
  }
  const outcome = await consumeVerificationToken(rawToken);
  switch (outcome) {
    case 'verified':
      req.log.info({ event: 'email_verified' }, 'email verification consumed');
      res.status(200).json({ status: 'verified' });
      return;
    case 'already_verified':
      // Friendly idempotent success — re-clicking a used link is not an error.
      res.status(200).json({ status: 'already_verified' });
      return;
    case 'expired':
      // Safe to disclose: only reachable while HOLDING the token; enables the
      // "link expired — request a new one" UX.
      sendError(res, 400, 'token_expired', 'that verification link has expired');
      return;
    case 'invalid':
      sendError(res, 400, 'token_invalid', 'that verification link is not valid');
      return;
  }
}

const VerifyBodySchema = z.object({ token: z.string().min(1).max(128) });

router.post(
  '/verify',
  authLimiter(),
  validateBody(VerifyBodySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof VerifyBodySchema>;
      await handleVerify(req, res, body.token);
    } catch (err) {
      next(err);
    }
  },
);

const ResendSchema = z.object({ email: z.string().email().max(254) });

/**
 * POST /auth/verify/resend — re-issue the verification email.
 *
 * NO USER ENUMERATION: the response is a fixed 200 {status:'ok'} in EVERY
 * case — unknown email, already-verified account, cooldown suppression, and
 * the actual send all look identical to the caller. The mail work runs
 * fire-and-forget AFTER the response so response timing cannot oracle
 * account existence either. (The residual signal — one extra indexed SELECT
 * on the exists path — is sub-millisecond noise behind network jitter.)
 *
 * Abuse posture: cheapLimiter bounds the per-IP request rate (the auth
 * limiter's skipSuccessfulRequests would never count an always-200 route),
 * and the per-USER DB cooldown (EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC) is
 * the real mail-bomb gate. The cooldown check is ATOMIC with the token
 * insert it gates — `issueVerificationTokenIfCooldownClear` probes inside
 * the same per-user-locked transaction (fix-pass S2/SF-4) — so a concurrent
 * burst of resends serializes and exactly one mints: at most one email per
 * account per cooldown window, no matter how many IPs ask.
 */
router.post(
  '/verify/resend',
  cheapLimiter(),
  validateBody(ResendSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof ResendSchema>;
      const email = body.email.toLowerCase();
      const { rows } = await query<{ id: string; email_verified_at: Date | null }>(
        `SELECT id, email_verified_at
           FROM users
          WHERE email = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [email],
      );
      const row = rows[0];
      // Fixed generic response FIRST (anti-enumeration, see header) …
      res.status(200).json({ status: 'ok' });
      // … then the best-effort issue+send, detached from the response path.
      // The cooldown decision lives INSIDE issueVerificationTokenIfCooldownClear
      // (atomic with the insert), never in a pre-response probe — which also
      // keeps the response timing identical whether or not a send happens.
      if (row && row.email_verified_at === null) {
        // pg returns BIGINT as a string.
        const userId = Number(row.id);
        const log = req.log;
        void (async () => {
          const minted = await issueVerificationTokenIfCooldownClear(userId, email);
          if (!minted) {
            log.info(
              { userId, event: 'verify_resend_cooldown' },
              'resend suppressed by cooldown',
            );
            return;
          }
          await sendVerificationEmail(email, minted.raw);
        })().catch((mailErr: unknown) => {
          log.error(
            { userId, err: (mailErr as Error).message },
            'verification email resend failed',
          );
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

// F-201: logout is IDEMPOTENT and always succeeds — a failed or repeated
// logout must never strand a usable session on the client.
//   - No requireAuth: a retry after a successful-but-response-lost logout
//     presents an already-revoked cookie; 401-ing that retry told the client
//     "logout failed" when the server row was already clean. Instead the
//     handler resolves the cookie's session best-effort and revokes it when
//     it is still live (getActiveSession → revokeSessionById, both no-ops on
//     a revoked/expired/absent session).
//   - The cookie is cleared and 204 returned even when the DB revoke hits a
//     transient error: the browser must stop presenting the token either
//     way. The un-revoked row is logged loudly and dies via expiry/idle
//     timeout; a client retry (cookie now gone) is a clean 204 no-op.
//   - IDOR-safe: the only session that can be revoked is the one the
//     presented cookie's token hashes to — no caller-supplied id exists.
// Rate limiting (F-UP-018 heritage): the route previously relied on
// authLimiter counting its 401s (skipSuccessfulRequests) to bound
// bogus-cookie floods (one session lookup each). Now that every request
// succeeds, that bucket would never count — so logout moves to cheapLimiter,
// which counts ALL requests per-IP. Legitimate logouts (roughly one per
// session) sit far below the cheap ceiling.
router.post('/logout', cheapLimiter(), async (req, res) => {
  try {
    const cfg = loadConfig();
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const raw = cookies[cfg.SESSION_COOKIE_NAME];
    if (raw) {
      const active = await getActiveSession(raw);
      if (active) {
        await revokeSessionById(active.session.id, 'user_logout');
      }
    }
  } catch (err) {
    // Transient DB failure — the cookie still gets cleared below so the
    // browser cannot keep presenting the token; the row expires on its own.
    req.log.error(
      { err: (err as Error).message },
      'logout: session revoke failed — cookie cleared anyway, row will expire',
    );
  }
  clearSessionCookie(res);
  res.status(204).send();
});

/**
 * GET /auth/me — current user profile.
 *
 * Pass 3 extends the response shape with `display_name` and `phone` so the
 * Settings → Profile group can hydrate without a second round-trip. The
 * existing shape (`{ user: { id, email } }`) is preserved as a strict
 * superset — clients that ignored extra fields continue to work.
 */
router.get('/me', authLimiter(), requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      // Defensive — requireAuth would have errored, but TS doesn't know that.
      throw new ValidationError('no user on request');
    }
    const userId = getUserId(req);
    const { rows } = await query<{
      id: number;
      email: string;
      display_name: string | null;
      phone: string | null;
      version: number;
      email_verified: boolean;
    }>(
      `SELECT id, email::text AS email, display_name, phone, version,
              (email_verified_at IS NOT NULL) AS email_verified
         FROM users
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    if (!row) {
      // Session points at a soft-deleted or vanished user — surface as 401
      // (their session shouldn't be trusted), not 500.
      throw new UnauthorizedError('user no longer exists');
    }
    // pg returns BIGINT as a string; the user DTO contract is a JSON number.
    const user = { ...row, id: Number(row.id) };
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
});

const PatchMeSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80).optional(),
    email: z.string().email().regex(EMAIL_REGEX).max(254).optional(),
    phone: z
      .string()
      .trim()
      .min(PHONE_MIN)
      .max(PHONE_MAX)
      .regex(PHONE_REGEX)
      .optional(),
    // Optimistic-concurrency snapshot. Required: a client that doesn't carry
    // a version is asking for last-writer-wins on the canonical recovery
    // channel, which the Bar §1 explicitly forbids. Bounded to INT4 (the
    // users.version column type) so an absurd value 400s instead of
    // overflowing in pg (routes sweep #3).
    expected_version: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v).filter((k) => k !== 'expected_version').length > 0,
    {
      message: 'no profile fields supplied',
    },
  );

/**
 * PATCH /auth/me — update one or more profile fields (display_name, email,
 * phone). Pass 3 / Settings → Profile group.
 *
 * Limiter choice: `authLimiter` (same per-IP bucket as login). Justification:
 * a malicious or compromised cookie holder rotating email/phone in a tight
 * loop is the same class of abuse as credential stuffing — it should starve
 * on the same per-IP allowance. Adding a separate `profileLimiter` would
 * fragment our rate-limit posture without buying anything (the Settings UI
 * issues at most one PATCH per save click). Revisit if the audit log shows a
 * legitimate user being throttled.
 *
 * Idempotency: a PATCH that doesn't change any value is a 200 with the
 * unchanged row. We don't bump `users.version` if every supplied field equals
 * the current value — the `updated_at` trigger only fires on actual UPDATE,
 * and we issue UPDATE unconditionally to keep the code one-pathed. (The DB
 * trigger fires on every UPDATE regardless of whether values changed; that's
 * acceptable noise for a Settings save.)
 *
 * Optimistic concurrency: the body MUST carry `expected_version`. The UPDATE
 * gates on `version = $expected`; mismatch returns 409 with the current row
 * so the client can rebase its buffer and retry. Bar §1 mandates this for
 * any row a user might edit; email is the canonical recovery channel and
 * absolutely qualifies. The 409 path is the documented retry primitive — a
 * legitimate concurrent save (e.g. browser tab + mobile both editing the
 * profile) lands as one success + one 409 + one client-rebase + retry.
 */
router.patch(
  '/me',
  authLimiter(),
  requireAuth,
  validateBody(PatchMeSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof PatchMeSchema>;
      const newEmail = body.email?.toLowerCase();

      // Capture the prior email so the audit log can record "old → new"
      // without a second SELECT after the UPDATE.
      const before = await query<{ email: string }>(
        `SELECT email::text AS email
           FROM users
          WHERE id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [userId],
      );
      const beforeEmail = before.rows[0]?.email;
      if (!beforeEmail) {
        throw new UnauthorizedError('user no longer exists');
      }

      // F-006 fix-pass SF-1/S1: the profile UPDATE (which resets
      // email_verified_at on an actual change), the supersession of the now-
      // stale old-address tokens, and the cooldown-gated fresh issue all run
      // in ONE transaction. A crash/failure anywhere rolls the whole unit
      // back — there is no window where the stamp is reset but a live
      // old-address token survives (and each token is additionally BOUND to
      // the address it attests, so even a resurrected stale token cannot
      // verify the new address). The mail send stays OUTSIDE the transaction
      // (no external I/O inside an open tx — db/pool bar) and is best-effort.
      let updated;
      let mintedRaw: string | null = null;
      let emailChanged = false;
      try {
        const txResult = await withTransaction(async (client) => {
          const tx = clientQuerier(client);
          const result = await tx<{
            id: number;
            email: string;
            display_name: string | null;
            phone: string | null;
            version: number;
            email_verified: boolean;
          }>(
            // F-006: an actual email CHANGE resets email_verified_at — the stamp
            // attests the OLD address; keeping it would let an unverified new
            // address inherit verified status. SET expressions read the
            // pre-update row, so the CASE compares against the OLD email.
            `UPDATE users
                SET display_name = COALESCE($2, display_name),
                    email        = COALESCE($3::citext, email),
                    phone        = COALESCE($4, phone),
                    email_verified_at = CASE
                      WHEN $3::citext IS NOT NULL AND $3::citext IS DISTINCT FROM email
                      THEN NULL
                      ELSE email_verified_at
                    END,
                    version      = version + 1
              WHERE id = $1 AND deleted_at IS NULL AND version = $5
              RETURNING id, email::text AS email, display_name, phone, version,
                        (email_verified_at IS NOT NULL) AS email_verified`,
            [
              userId,
              body.display_name ?? null,
              newEmail ?? null,
              body.phone ?? null,
              body.expected_version,
            ],
          );
          const row = result.rows[0];
          if (!row) return { row: undefined, raw: null, changed: false };
          const changed =
            newEmail !== undefined && newEmail !== beforeEmail.toLowerCase();
          let raw: string | null = null;
          if (changed) {
            // Old-address tokens must die IN THIS TRANSACTION even when the
            // cooldown suppresses a fresh issue — they attest an address the
            // account no longer has.
            await supersedeVerificationTokens(userId, tx);
            // Cooldown-gated (fix-pass S1): an authenticated session flipping
            // the email in a loop gets at most one send per cooldown window —
            // same per-user gate as /auth/verify/resend, same table probe,
            // atomic with the insert. Suppressed ⇒ the resend endpoint is the
            // recovery path once the window passes.
            const minted = await issueVerificationTokenIfCooldownClear(
              userId,
              newEmail,
              tx,
            );
            raw = minted?.raw ?? null;
          }
          return { row, raw, changed };
        });
        updated = txResult.row;
        mintedRaw = txResult.raw;
        emailChanged = txResult.changed;
      } catch (err) {
        // 23505 = unique_violation. Identical posture to register: vague
        // conflict, don't leak which field collided (only email is UNIQUE
        // today, but state that in code via the message — not by inferring
        // from the error text).
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError('email already in use');
        }
        throw err;
      }
      if (!updated) {
        // Row exists (we just selected it) but the version no longer
        // matches: a concurrent writer beat us. Surface as 409 so the
        // client refetches and retries against the new snapshot. Note we
        // must re-check existence — a race against soft-delete is possible.
        const check = await query<{ version: number }>(
          `SELECT version FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [userId],
        );
        if (check.rows.length === 0) {
          throw new UnauthorizedError('user no longer exists');
        }
        throw new ConflictError('stale user version');
      }

      // Audit: WARN on email change. We log only the domain (right of @),
      // never the local part — the local part is PII (per
      // Repository/server/SECURITY.md §4.1). Correlation id is already on
      // the child logger via correlationMiddleware.
      if (emailChanged && newEmail) {
        const beforeDomain = beforeEmail.split('@')[1] ?? 'unknown';
        const afterDomain = newEmail.split('@')[1] ?? 'unknown';
        req.log.warn(
          {
            userId,
            event: 'profile_email_changed',
            beforeDomain,
            afterDomain,
          },
          'user changed account email (verification reset — F-006)',
        );
        // F-006: verify the NEW address. The token was minted inside the
        // profile transaction above; only the SEND happens here, after
        // commit. Best-effort (the profile change already committed; resend
        // is the recovery path) and the session is deliberately untouched —
        // the user can still fix a typo'd address.
        if (mintedRaw !== null) {
          try {
            await sendVerificationEmail(newEmail, mintedRaw);
          } catch (mailErr) {
            req.log.error(
              { userId, err: (mailErr as Error).message },
              'verification email send failed after email change',
            );
          }
        } else {
          // Cooldown-suppressed (fix-pass S1). The stamp is reset and the old
          // tokens are dead; the user requests a fresh link via resend once
          // the window passes.
          req.log.info(
            { userId, event: 'verify_resend_cooldown' },
            'email-change verification send suppressed by cooldown',
          );
        }
      }

      // pg returns BIGINT as a string; the user DTO contract is a JSON number.
      res.status(200).json({ user: { ...updated, id: Number(updated.id) } });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
