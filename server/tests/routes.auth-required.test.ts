/**
 * Auth-required smoke tests for every protected route.
 *
 * SECURITY INVARIANT: every mounted route that is NOT on the explicit public
 * allowlist must reject an unauthenticated request (401/403) — never serve a
 * protected response (2xx), and never 404 (a 404 would mean the route the test
 * thinks it is probing does not actually exist, i.e. the test is lying to
 * itself).
 *
 * WHY ENUMERATE THE ROUTER STACK (audit §3.2): the previous version listed 11
 * paths by hand and accepted `[401, 404]`. That combination is a false-
 * confidence trap — a newly-mounted protected route is simply never probed,
 * and a typo'd path 404s and "passes". This version walks the actual Express
 * router stack, so EVERY mounted route is covered automatically (a future
 * route mounted without `requireAuth` fails this test the moment it lands), and
 * drops 404 from the accepted set so a route the enumerator claims exists must
 * actually answer with an auth rejection.
 *
 * The public allowlist is the SMALL, deliberately-maintained exception set —
 * routes that must answer without a session (health, the pre-auth stretch of
 * the auth flow). Adding a genuinely public route is a conscious edit here;
 * everything else is protected by default, which is the safe direction. If a
 * new public route is added and NOT listed here, this test fails loudly (it
 * will see a non-401/403 status) — that failure is the prompt to consciously
 * decide the route is meant to be public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startPostgres, stopPostgres, type PgHandle } from './helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from './helpers/app.js';
import { resetLimiters } from '../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

// ── Router-stack enumeration (Express 4) ─────────────────────────────────────

interface MountedRoute {
  method: string;
  path: string;
}

/**
 * Reconstruct the literal mount prefix of a sub-router `Layer` from its
 * `regexp`. This app mounts every router at a STATIC prefix
 * (`app.use('/vocab', router)` — no params in the mount path), so the regexp is
 * always the fixed `^\/<prefix>\/?(?=\/|$)` shape and the prefix parse is
 * deterministic. Returns '' for the app-level fast-slash layer.
 */
function mountPrefix(layer: { regexp: RegExp & { fast_slash?: boolean } }): string {
  if (layer.regexp.fast_slash) return '';
  // Express 4 static-mount source, e.g. `^\/vocab\/?(?=\/|$)` (escaped slashes).
  const m = /^\^\\\/(.*?)\\\/\?\(\?=/.exec(layer.regexp.source);
  if (!m?.[1]) return '';
  // Un-escape the `\/` the router uses for nested segments (e.g. `vocab\/lists`).
  return '/' + m[1].replace(/\\\//g, '/');
}

/** Walk `app._router.stack` and return every (method, fullPath) actually mounted. */
function enumerateRoutes(app: Express): MountedRoute[] {
  const out: MountedRoute[] = [];
  // Express 4 stores the mounted router stack on the private `_router`; there
  // is no public introspection API, so this is a deliberate internal reach.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack: any[] = (app as any)._router?.stack ?? [];
  for (const layer of stack) {
    if (layer.route) {
      const path = layer.route.path as string;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        out.push({ method: method.toUpperCase(), path });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const prefix = mountPrefix(layer);
      for (const inner of layer.handle.stack) {
        if (!inner.route) continue;
        const rel = inner.route.path as string;
        const full = (prefix + (rel === '/' ? '' : rel)) || '/';
        for (const method of Object.keys(inner.route.methods)) {
          if (method === '_all') continue;
          out.push({ method: method.toUpperCase(), path: full });
        }
      }
    }
  }
  return out;
}

/** Replace `:param` segments with a placeholder — the auth gate rejects before
 *  any route ever parses the value, so the placeholder is never inspected. */
function concretePath(path: string): string {
  return path.replace(/:[^/]+/g, '1');
}

// ── Public allowlist ─────────────────────────────────────────────────────────
//
// Routes that legitimately answer WITHOUT a session, keyed as `METHOD path`
// (the enumerated, param-templated form). Everything not listed is required to
// reject an unauthenticated request. Keep this minimal and justified.
const PUBLIC_ROUTES = new Set<string>([
  // Liveness — the load balancer probes it with no credentials.
  'GET /health',
  // The pre-auth stretch of the auth flow: these MUST work without a session,
  // because they are how a session is obtained (or discarded).
  'POST /auth/register',
  'POST /auth/login',
  'POST /auth/login/totp', // step 2, authenticated by the challenge token, not a cookie
  'POST /auth/verify', // email verification, authenticated by the emailed token
  'POST /auth/verify/resend', // request a fresh verification email
  'POST /auth/logout', // idempotent success even without a live session (F-201)
  // Account recovery (Phase 2.1) — pre-auth by design: a locked-out user has
  // no session. `request` is non-enumerating (always 200); `confirm` is
  // authenticated by the emailed reset token in the body, not a cookie.
  'POST /auth/password-reset/request',
  'POST /auth/password-reset/confirm',
  //
  // NOTE: /auth/mfa/enroll and /auth/mfa/confirm are deliberately NOT listed
  // here, even though they support a challenge-token path that bypasses the
  // session cookie. Their gate (`conditionalRequireAuth`, auth.ts:232-243)
  // only skips `requireAuth` when the request body carries a non-empty
  // `challenge_token`; the unauthenticated probe this suite sends (empty
  // body, no cookie) has none, so it falls through to the real `requireAuth`
  // and is rejected with 401 — identical to every other protected route.
  // They are therefore probed normally below, not allowlisted. The
  // challenge-token-authenticated path is a separate flow, exercised by
  // auth.mfa.test.ts.
]);

// ── The gate ─────────────────────────────────────────────────────────────────

describe('protected route auth gate (enumerated router stack)', () => {
  // Enumerated inside each test — the app is built in beforeAll, so the stack
  // is not walkable at describe-collection time.

  it('enumerates a plausible number of routes (guards against a broken walker)', () => {
    // If the stack walker silently returns nothing, every per-route assertion
    // below would vacuously pass — pin a floor so that regression is caught.
    expect(enumerateRoutes(t.app).length).toBeGreaterThan(120);
  });

  it('every enumerated route is unique (method+path)', () => {
    const keys = enumerateRoutes(t.app).map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rejects unauthenticated requests to every non-public route with 401/403', async () => {
    const routes = enumerateRoutes(t.app);
    const publicHit = new Set<string>();
    const failures: string[] = [];

    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      if (PUBLIC_ROUTES.has(key)) {
        publicHit.add(key);
        continue;
      }
      // Reset in-memory rate-limit hit stores before every probe. This suite
      // deliberately sends 150+ unauthenticated requests to every mounted
      // route in one `it`, several of which share a single per-IP
      // `authLimiter` budget (RATE_LIMIT_AUTH_MAX=5 in the test env) —
      // without this reset, probing enough of them in sequence trips 429 on
      // a later route, which would fail this test for a reason that has
      // nothing to do with that route's OWN auth gate. Each route's rejection
      // must be judged in isolation.
      resetLimiters();
      const url = concretePath(path);
      const res = await request(t.app)[method.toLowerCase() as 'get'](url);
      // Must be an auth rejection — NOT a leak (2xx), NOT a phantom (404),
      // NOT a validation bounce that runs before the auth check (400 would
      // mean auth is not the first gate on that route).
      if (res.status !== 401 && res.status !== 403) {
        failures.push(`${key} -> ${res.status}`);
        continue;
      }
      if (res.status === 401) {
        expect(res.body, `${key} should return a typed error body`).toHaveProperty('error');
      }
    }

    // Every allowlisted route must actually exist in the stack — a stale
    // allowlist entry (route renamed/removed) is itself a bug to surface.
    const staleAllowlist = [...PUBLIC_ROUTES].filter((k) => !publicHit.has(k));

    expect(
      failures,
      `Routes that did NOT reject an unauthenticated request (expected 401/403):\n${failures.join('\n')}`,
    ).toEqual([]);
    expect(
      staleAllowlist,
      `PUBLIC_ROUTES entries that are not mounted (stale allowlist):\n${staleAllowlist.join('\n')}`,
    ).toEqual([]);
  });
});
