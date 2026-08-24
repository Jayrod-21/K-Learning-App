/**
 * requireAuth middleware.
 *
 * Reads the session cookie, validates it, attaches `req.user` and `req.session`,
 * and either calls next or returns 401. Per ADR-002 — opaque server-side tokens,
 * not JWTs.
 */
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from '../config/index.js';
import { getActiveSession } from '../auth/sessions.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cfg = loadConfig();
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const raw = cookies[cfg.SESSION_COOKIE_NAME];
    if (!raw) {
      next(new UnauthorizedError('missing session'));
      return;
    }
    const active = await getActiveSession(raw);
    if (!active) {
      next(new UnauthorizedError('invalid or expired session'));
      return;
    }
    req.user = active.user;
    req.session = { id: active.session.id, user_id: active.session.user_id };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * requireAdmin middleware (Phase 2.2 — admin-role foundation).
 *
 * MUST be composed AFTER requireAuth in a route's middleware chain (e.g.
 * `[requireAuth, requireAdmin]`) so `req.user` is already populated. It never
 * assumes that ordering was respected, though: if `req.user` is missing it
 * treats the request as unauthenticated (401), the same defense-in-depth
 * posture `getUserId` takes below — a route mounted without requireAuth
 * fails safe at the boundary instead of leaking past an admin gate.
 *
 * SECURITY INVARIANT: role comes ONLY from `req.user.role`, which is the
 * server-side session projection populated by requireAuth from
 * `getActiveSession` (auth/sessions.ts, itself sourced from `users.role` in
 * Postgres). This middleware never reads a role from client input — no
 * header, body, or query param is ever consulted — so a client cannot
 * self-escalate by sending e.g. `X-Role: admin` or `{ role: 'admin' }`.
 */
export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    next(new UnauthorizedError('authentication required'));
    return;
  }
  if (req.user.role !== 'admin') {
    next(new ForbiddenError('admin privileges required'));
    return;
  }
  next();
}

/**
 * Type-safe accessor for the authenticated user's id.
 *
 * Replaces the ``req.user!.id`` non-null-assertion pattern that was spread
 * across the route files (REVIEW_B3 SF4). If a route handler somehow runs
 * without ``requireAuth`` having populated ``req.user`` first, this raises
 * an ``UnauthorizedError`` with a clear message instead of crashing on a
 * ``Cannot read property 'id' of undefined`` deep inside a SQL builder.
 *
 * Compile-time benefit: the return type is ``number``, not ``number | undefined``,
 * so call-sites don't need ``!`` and a future route mounted without
 * ``requireAuth`` fails at the boundary rather than at the call site.
 */
export function getUserId(req: Request): number {
  const id = req.user?.id;
  if (id === undefined || id === null) {
    throw new UnauthorizedError('authenticated user required');
  }
  return id;
}
