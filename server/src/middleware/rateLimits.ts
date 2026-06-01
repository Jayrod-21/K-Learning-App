/**
 * Rate limiting.
 *
 * Three buckets:
 *   - auth:       per-IP, low ceiling (login/register brute force)
 *   - cheap:      per-IP, generous ceiling (define, health, list endpoints)
 *   - expensive:  per-user when authenticated, otherwise per-IP, low ceiling
 *                 (enrich, grade-writing, lemmatize — all upstream calls)
 *
 * Bar §"Security": separate buckets for cheap vs expensive, per-IP AND per-user
 * (the expensive bucket keys on `req.user.id` when present so a logged-in user
 * gets a fair share even from behind NAT).
 */
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { loadConfig } from '../config/index.js';

function ipKey(req: Request): string {
  // Trust the right-most X-Forwarded-For only when a reverse proxy is configured
  // upstream. Default to req.ip (Express respects `trust proxy`).
  return req.ip ?? 'unknown';
}

function userOrIpKey(req: Request): string {
  return req.user?.id ? `u:${req.user.id}` : `ip:${ipKey(req)}`;
}

// The actual rate-limit instances (each owns an in-memory hit store), built
// lazily on first request and swappable via resetLimiters().
let _cheap: RateLimitRequestHandler | null = null;
let _expensive: RateLimitRequestHandler | null = null;
let _auth: RateLimitRequestHandler | null = null;

function buildCheap(): RateLimitRequestHandler {
  const cfg = loadConfig();
  return rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_CHEAP_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false, creationStack: false },
    keyGenerator: ipKey,
    message: { error: { code: 'rate_limited', message: 'too many requests' } },
  });
}

function buildExpensive(): RateLimitRequestHandler {
  const cfg = loadConfig();
  return rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_EXPENSIVE_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false, creationStack: false },
    keyGenerator: userOrIpKey,
    message: { error: { code: 'rate_limited', message: 'too many requests' } },
  });
}

function buildAuth(): RateLimitRequestHandler {
  const cfg = loadConfig();
  return rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_AUTH_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false, creationStack: false },
    keyGenerator: ipKey,
    // Don't count successful logins toward the limit — only failures matter
    // for brute-force defense.
    skipSuccessfulRequests: true,
    message: { error: { code: 'rate_limited', message: 'too many auth attempts' } },
  });
}

/**
 * Each accessor returns a STABLE wrapper that delegates to the current limiter
 * instance. Routes capture this wrapper at import time
 * (`router.post('/login', authLimiter(), …)`), so it must NOT close over a
 * specific limiter instance — otherwise `resetLimiters()` (which swaps the
 * instance to get a fresh hit store) could never take effect on mounted routes.
 *
 * The instance is built on the accessor's FIRST call (route-import / app-init
 * time — NOT inside a request handler, which express-rate-limit forbids:
 * ERR_ERL_CREATED_IN_REQUEST_HANDLER). resetLimiters() drops the instances; the
 * next request through the wrapper rebuilds via `ensure*` below, which runs in
 * the handler — so those rebuild paths set `creationStack:false` to suppress the
 * (here-intentional) in-handler-creation validation. In prod the accessor builds
 * once at import and the rebuild path is never hit.
 */
function ensureCheap(): RateLimitRequestHandler {
  return (_cheap ??= buildCheap());
}
function ensureExpensive(): RateLimitRequestHandler {
  return (_expensive ??= buildExpensive());
}
function ensureAuth(): RateLimitRequestHandler {
  return (_auth ??= buildAuth());
}

export function cheapLimiter(): RequestHandler {
  ensureCheap(); // build now (app-init), not in the handler
  return (req: Request, res: Response, next: NextFunction) => ensureCheap()(req, res, next);
}

export function expensiveLimiter(): RequestHandler {
  ensureExpensive();
  return (req: Request, res: Response, next: NextFunction) => ensureExpensive()(req, res, next);
}

export function authLimiter(): RequestHandler {
  ensureAuth();
  return (req: Request, res: Response, next: NextFunction) => ensureAuth()(req, res, next);
}

/** Reset limiter instances (drops their in-memory hit stores) — test-only. */
export function resetLimiters(): void {
  _cheap = null;
  _expensive = null;
  _auth = null;
}
