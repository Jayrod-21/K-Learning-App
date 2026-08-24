/**
 * /admin routes — admin-only operator surface (Phase 2.2 admin-role
 * foundation).
 *
 *   GET  /admin/users               → list users (SAFE fields only)
 *   GET  /admin/spend                → global daily spend-ceiling status (Phase 2.6)
 *   POST /admin/invites              → mint an invite code (Phase 2.3, D1)
 *   GET  /admin/invites              → list invite codes (safe view only)
 *   POST /admin/invites/:id/revoke   → revoke an invite code
 *
 * SECURITY (this whole router is a privileged surface):
 *   - AuthZ: every route is gated `[requireAuth, requireAdmin]`
 *     (middleware/auth.ts). requireAdmin reads `req.user.role` — the
 *     server-side session projection populated by requireAuth from
 *     `getActiveSession` (auth/sessions.ts, sourced from `users.role` in
 *     Postgres) — and NEVER a client-supplied claim (header/body/query). A
 *     non-admin session gets 403; no session gets 401.
 *   - Secret exposure: the SELECT list below is an explicit allow-list — it
 *     never names `password_hash` (or any other secret column). This is the
 *     single load-bearing line for that guarantee; a future column added to
 *     `users` is invisible here by construction until someone deliberately
 *     adds it to the list. The invite routes carry the SAME posture for
 *     `code_hash` — see auth/inviteCodes.ts's `SafeInviteView`, which is the
 *     only shape `GET /admin/invites` ever returns.
 *   - Timestamp minimization: `email_verified` is derived
 *     (`email_verified_at IS NOT NULL`) rather than exposing the raw
 *     timestamp, matching GET /auth/me's convention (routes/auth.ts).
 *   - Enumeration/cost: `ORDER BY id` + a fixed `LIMIT 200` bounds the
 *     response — this is a first-pass operator listing, not a paginated API;
 *     pagination is a follow-up if the user count outgrows one page.
 *   - Cost: no Claude, no external I/O — the standard cheap limiter suffices.
 *   - The raw invite code (`POST /admin/invites`'s `raw_code` field) is shown
 *     EXACTLY ONCE, in this response and nowhere else — it is never stored,
 *     never logged, and `GET /admin/invites` can never surface it again
 *     (auth/inviteCodes.ts stores only the SHA-256 hash). The issuing admin
 *     is responsible for relaying it to the invitee out-of-band.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAdmin, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/errors.js';
import { query } from '../db/pool.js';
import { getSpendCeilingStatus } from '../services/spendCeiling.js';
import {
  getInviteCodeById,
  issueInviteCode,
  listInviteCodes,
  revokeInviteCode,
} from '../auth/inviteCodes.js';

const router = Router();

const USERS_LIST_LIMIT = 200;

/**
 * GET /admin/users — list users with SAFE fields only.
 *
 * NEVER selects password_hash (or any other secret). id/email/role/
 * email_verified/created_at only — see the security comment above.
 */
router.get('/users', cheapLimiter(), requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await query<{
      id: number;
      email: string;
      role: 'user' | 'admin';
      email_verified: boolean;
      created_at: Date;
    }>(
      `SELECT id, email::text AS email, role::text AS role,
              (email_verified_at IS NOT NULL) AS email_verified, created_at
         FROM users
        WHERE deleted_at IS NULL
        ORDER BY id
        LIMIT $1`,
      [USERS_LIST_LIMIT],
    );
    res.status(200).json({ users: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/spend — global (all-users) daily spend-ceiling status
 * (Phase 2.6). Exact/uncached (getSpendCeilingStatus, unlike the
 * memoized assertUnderSpendCeiling gate) — an operator checking this needs
 * the real number, not a stale one. No secrets: dollar figures and the
 * configured ceiling only, nothing about individual users' calls.
 */
router.get('/spend', cheapLimiter(), requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const status = await getSpendCeilingStatus();
    res.status(200).json(status);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// Invite codes (Phase 2.3 — invite-only self-signup, D1). See
// auth/inviteCodes.ts for the token lifecycle + threat model.
// -----------------------------------------------------------------------------

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const IssueInviteSchema = z.object({
  email: z.string().email().regex(EMAIL_REGEX).max(254).optional(),
  expires_in_days: z.number().int().positive().max(3650).optional(),
  max_uses: z.number().int().positive().max(100_000).default(1),
  note: z.string().min(1).max(500).optional(),
});

/**
 * POST /admin/invites — mint a new invite code. The RAW code is returned
 * ONLY in this response body (`raw_code`) — see the router header's security
 * note. `issued_by_user_id` is always THIS admin's own id (`getUserId(req)`),
 * never client-suppliable, so the issuance audit trail can't be forged.
 */
router.post(
  '/invites',
  cheapLimiter(),
  requireAuth,
  requireAdmin,
  validateBody(IssueInviteSchema),
  async (req, res, next) => {
    try {
      const adminId = getUserId(req);
      const body = req.body as z.infer<typeof IssueInviteSchema>;
      const issued = await issueInviteCode({
        issuedByUserId: adminId,
        email: body.email,
        expiresInDays: body.expires_in_days,
        maxUses: body.max_uses,
        note: body.note,
      });
      req.log.info(
        { adminId, inviteId: issued.id, maxUses: issued.max_uses },
        'invite code issued',
      );
      const { rawCode, ...safeView } = issued;
      // raw_code rides ALONGSIDE the safe view, ONCE — never persisted or
      // logged (see the header note + auth/inviteCodes.ts's own docstring).
      res.status(201).json({ raw_code: rawCode, invite: safeView });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /admin/invites — list invite codes. Safe view only (`SafeInviteView`,
 * auth/inviteCodes.ts) — NEVER `code_hash`, NEVER a raw code.
 */
router.get('/invites', cheapLimiter(), requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const invites = await listInviteCodes();
    res.status(200).json({ invites });
  } catch (err) {
    next(err);
  }
});

/** :id is a positive integer (BIGINT identity) — coerced + validated so a
 *  garbage id is a 400, not a SQL cast error (routes sweep #3 posture,
 *  mirrors routes/images.ts's IdParamsSchema). */
const InviteIdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * POST /admin/invites/:id/revoke — admin kill switch. Idempotent
 * (`revokeInviteCode` gates on `revoked_at IS NULL`); 404 if the id doesn't
 * exist (including an already-revoked-and-then-deleted row, which cannot
 * actually happen today since nothing deletes invite_codes, but 404-on-
 * missing is the correct contract regardless), 200 with the updated safe
 * view otherwise — including on a redundant revoke of an already-revoked
 * code (still 200, `status` already reads 'revoked').
 */
router.post(
  '/invites/:id/revoke',
  cheapLimiter(),
  requireAuth,
  requireAdmin,
  validateParams(InviteIdParamsSchema),
  async (req, res, next) => {
    try {
      const adminId = getUserId(req);
      const { id } = (req as typeof req & {
        validatedParams: z.infer<typeof InviteIdParamsSchema>;
      }).validatedParams;

      await revokeInviteCode(id);

      // Re-read the safe view regardless of whether THIS call flipped it
      // (idempotent revoke) — a nonexistent id has no row to read, which is
      // exactly the 404 case.
      const invite = await getInviteCodeById(id);
      if (!invite) {
        throw new NotFoundError('invite code not found');
      }
      req.log.info({ adminId, inviteId: id }, 'invite code revoked');
      res.status(200).json({ invite });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
