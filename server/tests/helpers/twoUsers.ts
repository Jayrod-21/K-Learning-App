/**
 * Two-user isolation harness (Phase 2.10).
 *
 * Small, reusable helper for cross-user isolation suites: register two
 * distinct, fully-authenticated users via the REAL auth flow (registerUser
 * already drives register → verify → login → MFA enroll/confirm, adaptive to
 * however the test app under test is configured — see helpers/seed.ts), and
 * assert a uniform "B cannot reach A's thing" denial.
 *
 * `expectDenied` accepts 404 OR 403 — the codebase's documented convention
 * (see RECON_server.md / the isolation audit behind this harness) is a
 * UNIFORM 404 on almost every cross-user miss ("don't confirm existence to a
 * non-owner"), but a small number of routes use 403 (e.g. admin-gated
 * routes) — accepting either keeps this helper usable everywhere while still
 * treating 2xx and 500 as hard failures: a 500 would mean the request nearly
 * succeeded (a downstream error after passing the ownership gate, or an
 * unhandled exception) and must never be mistaken for "denied".
 */
import type { Pool } from 'pg';
import type { Express } from 'express';
import type { Response } from 'supertest';
import { registerUser, type RegisteredAgent } from './seed.js';

export interface TwoUsers {
  a: RegisteredAgent;
  b: RegisteredAgent;
}

/** Register two distinct, fully-authenticated users (A and B). */
export async function twoUsers(app: Express, pool: Pool): Promise<TwoUsers> {
  const a = await registerUser(app, pool);
  const b = await registerUser(app, pool);
  return { a, b };
}

/**
 * Assert a cross-user request was DENIED: status is 404 or 403, never 2xx
 * and never 500. Use for every "B reaches A's resource" assertion so every
 * isolation test in the suite applies the identical bar.
 */
export function expectDenied(res: Response): void {
  if (res.status !== 404 && res.status !== 403) {
    throw new Error(
      `expectDenied: expected 404 or 403, got ${String(res.status)} — body: ${JSON.stringify(res.body)}`,
    );
  }
}
