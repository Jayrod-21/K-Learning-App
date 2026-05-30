/**
 * Auth routes.
 *
 *   POST  /auth/register    — create a user, issue a session
 *   POST  /auth/login       — verify password, issue a session
 *   POST  /auth/logout      — revoke current session, clear cookie
 *   GET   /auth/me          — describe the current user
 *   PATCH /auth/me          — update display_name / email / phone (Pass 3)
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
 *   - Email-change-without-verification: PATCH /me lets an authenticated user
 *     swap their `users.email` directly. Email verification is deferred
 *     (Repository/client/SECURITY.md §"Deferred"). We compensate by:
 *       (a) requiring an authenticated session (cookie was already issued to
 *           the prior email — an attacker without the session cookie can't
 *           pivot);
 *       (b) `authLimiter` rate-limiting the endpoint (same brute-force
 *           bucket as login);
 *       (c) WARN-level audit log on every email change (correlation id +
 *           user id + new domain only — never the new local part, to keep
 *           PII out of logs).
 *     A full verification flow (verify-link + cooldown + revoke-other-
 *     sessions) lands when email_verification ships.
 *   - Account-takeover via session token leak persisting across email change:
 *     out of scope here. The "log me out everywhere" SQL (ADR-002 §"Open
 *     questions") is the recovery path; the Settings UI will surface it when
 *     password change ships.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from '../middleware/errors.js';
import { validateBody } from '../middleware/validate.js';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimits.js';
import { hashPassword, safeDummyVerify, verifyPassword } from '../auth/passwords.js';
import {
  clearSessionCookie,
  issueSession,
  revokeSessionById,
  setSessionCookie,
} from '../auth/sessions.js';
import { query } from '../db/pool.js';

const router = Router();

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
        userId = r.id;
      } catch (err) {
        // 23505 = unique_violation. Surface a deliberately vague conflict;
        // do NOT leak which field collided.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError('account already exists');
        }
        throw err;
      }
      const { raw, record } = await issueSession(userId, {
        userAgent: req.header('user-agent') ?? undefined,
        ipAddress: req.ip ?? undefined,
      });
      setSessionCookie(res, raw, record.expires_at);
      req.log.info({ userId }, 'user registered');
      res.status(201).json({ user: { id: userId, email: body.email.toLowerCase() } });
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
      }>(
        `SELECT id, password_hash, deleted_at
           FROM users
          WHERE email = $1
          LIMIT 1`,
        [email],
      );
      const user = rows[0];
      // CRITICAL: same shape and approximately same timing whether email
      // exists or not. We run verifyPassword either way.
      if (!user || user.deleted_at) {
        await safeDummyVerify();
        throw new UnauthorizedError('invalid credentials');
      }
      const ok = await verifyPassword(user.password_hash, body.password);
      if (!ok) {
        throw new UnauthorizedError('invalid credentials');
      }
      const { raw, record } = await issueSession(user.id, {
        userAgent: req.header('user-agent') ?? undefined,
        ipAddress: req.ip ?? undefined,
      });
      // Record successful login (forensic timeline).
      await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
      setSessionCookie(res, raw, record.expires_at);
      req.log.info({ userId: user.id }, 'login success');
      res.status(200).json({ user: { id: user.id, email } });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    if (req.session) {
      await revokeSessionById(req.session.id, 'user_logout');
    }
    clearSessionCookie(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/me — current user profile.
 *
 * Pass 3 extends the response shape with `display_name` and `phone` so the
 * Settings → Profile group can hydrate without a second round-trip. The
 * existing shape (`{ user: { id, email } }`) is preserved as a strict
 * superset — clients that ignored extra fields continue to work.
 */
router.get('/me', requireAuth, async (req, res, next) => {
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
    }>(
      `SELECT id, email::text AS email, display_name, phone, version
         FROM users
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [userId],
    );
    const user = rows[0];
    if (!user) {
      // Session points at a soft-deleted or vanished user — surface as 401
      // (their session shouldn't be trusted), not 500.
      throw new UnauthorizedError('user no longer exists');
    }
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
    // channel, which the Bar §1 explicitly forbids.
    expected_version: z.number().int().positive(),
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

      let updated;
      try {
        const result = await query<{
          id: number;
          email: string;
          display_name: string | null;
          phone: string | null;
          version: number;
        }>(
          `UPDATE users
              SET display_name = COALESCE($2, display_name),
                  email        = COALESCE($3::citext, email),
                  phone        = COALESCE($4, phone),
                  version      = version + 1
            WHERE id = $1 AND deleted_at IS NULL AND version = $5
            RETURNING id, email::text AS email, display_name, phone, version`,
          [
            userId,
            body.display_name ?? null,
            newEmail ?? null,
            body.phone ?? null,
            body.expected_version,
          ],
        );
        updated = result.rows[0];
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
      if (newEmail && newEmail !== beforeEmail.toLowerCase()) {
        const beforeDomain = beforeEmail.split('@')[1] ?? 'unknown';
        const afterDomain = newEmail.split('@')[1] ?? 'unknown';
        req.log.warn(
          {
            userId,
            event: 'profile_email_changed',
            beforeDomain,
            afterDomain,
          },
          'user changed account email (verification deferred)',
        );
      }

      res.status(200).json({ user: updated });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
