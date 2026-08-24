/**
 * /admin routes — admin-only operator surface (Phase 2.2 admin-role
 * foundation).
 *
 *   GET /admin/users → list users (SAFE fields only)
 *   GET /admin/spend → global daily spend-ceiling status (Phase 2.6)
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
 *     adds it to the list.
 *   - Timestamp minimization: `email_verified` is derived
 *     (`email_verified_at IS NOT NULL`) rather than exposing the raw
 *     timestamp, matching GET /auth/me's convention (routes/auth.ts).
 *   - Enumeration/cost: `ORDER BY id` + a fixed `LIMIT 200` bounds the
 *     response — this is a first-pass operator listing, not a paginated API;
 *     pagination is a follow-up if the user count outgrows one page.
 *   - Cost: no Claude, no external I/O — the standard cheap limiter suffices.
 */
import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { query } from '../db/pool.js';
import { getSpendCeilingStatus } from '../services/spendCeiling.js';

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

export default router;
