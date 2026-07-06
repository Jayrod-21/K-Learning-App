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

/**
 * A 429 body carrying a PRECISE `retry_after` — whole seconds until THIS client's
 * window resets, read from `req.rateLimit.resetTime` (F-UP-004; falls back to the
 * full window if it's somehow unavailable, and never reports < 1s). Returned as a
 * `message` FUNCTION so express-rate-limit evaluates it per-rejection with the
 * populated `req.rateLimit`. Applied to EVERY limiter so any 429 feeds the
 * client's `ApiError.retryAfter` / Writing "try again in N s" branch (F-UP-005).
 */
function rateLimitedMessage(code: string, message: string, windowMs: number) {
  return (req: Request): unknown => {
    const resetTime = (
      req as Request & { rateLimit?: { resetTime?: Date } }
    ).rateLimit?.resetTime;
    const ms =
      resetTime instanceof Date ? resetTime.getTime() - Date.now() : windowMs;
    // Floor at 1s (not 0): even if the window just reset, advertise a >= 1s wait
    // so a client honouring retry_after doesn't immediately re-hammer the route.
    const retryAfter = Math.max(1, Math.ceil(ms / 1000));
    return { error: { code, message, retry_after: retryAfter } };
  };
}

// The actual rate-limit instances (each owns an in-memory hit store), built
// lazily on first request and swappable via resetLimiters().
let _cheap: RateLimitRequestHandler | null = null;
let _expensive: RateLimitRequestHandler | null = null;
let _auth: RateLimitRequestHandler | null = null;
let _media: RateLimitRequestHandler | null = null;

function buildCheap(): RateLimitRequestHandler {
  const cfg = loadConfig();
  return rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_CHEAP_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false, creationStack: false },
    keyGenerator: ipKey,
    message: rateLimitedMessage(
      'rate_limited',
      'too many requests',
      cfg.RATE_LIMIT_WINDOW_MS,
    ),
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
    // B-016 / F-UP-004: a 429 from an expensive route (grade-writing, lemmatize,
    // enrich, diagnostic gen) carries a precise retry_after that the client's
    // ApiError.retryAfter / Writing "try again in N s" branch consumes.
    message: rateLimitedMessage(
      'rate_limited',
      'too many requests',
      cfg.RATE_LIMIT_WINDOW_MS,
    ),
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
    message: rateLimitedMessage(
      'rate_limited',
      'too many auth attempts',
      cfg.RATE_LIMIT_WINDOW_MS,
    ),
  });
}

// Audio/Range streaming: its own, higher, per-user bucket so an active listening
// session (many partial-content requests) cannot exhaust the shared cheap per-IP
// bucket and 429 the user's unrelated JSON calls (F-012 review R1).
function buildMedia(): RateLimitRequestHandler {
  const cfg = loadConfig();
  return rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_MEDIA_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false, creationStack: false },
    keyGenerator: userOrIpKey,
    message: rateLimitedMessage(
      'rate_limited',
      'too many requests',
      cfg.RATE_LIMIT_WINDOW_MS,
    ),
  });
}

/**
 * Each accessor returns a STABLE wrapper that delegates to the current limiter
 * instance. Routes capture this wrapper at import time
 * (`router.post('/login', authLimiter(), …)`), so it must NOT close over a
 * specific limiter instance — otherwise `resetLimiters()` (which swaps the
 * instance to get a fresh hit store) could never take effect on mounted routes.
 *
 * The instance is built lazily on the FIRST REQUEST through the wrapper (via the
 * `ensure*` accessors below) — NOT at route-import/app-init time. Building at
 * import would call loadConfig() before the process env is configured (which
 * breaks tests that set env in buildTestApp, after the static route imports).
 * Because construction now always happens inside a request handler — which
 * express-rate-limit otherwise forbids (ERR_ERL_CREATED_IN_REQUEST_HANDLER) —
 * buildCheap/Expensive/Auth set `creationStack:false` to suppress that
 * (here-intentional) validation. resetLimiters() drops the instances; the next
 * request rebuilds them with the current config.
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
function ensureMedia(): RateLimitRequestHandler {
  return (_media ??= buildMedia());
}

export function cheapLimiter(): RequestHandler {
  // Lazy: the limiter (and its loadConfig() call) is resolved on the FIRST
  // REQUEST, not at import. Route files call this at module scope, so an eager
  // build here would run loadConfig() before the process env is configured
  // (e.g. in tests, before buildTestApp sets it). buildCheap sets
  // validate.creationStack:false, so in-handler construction is safe.
  return (req: Request, res: Response, next: NextFunction) => ensureCheap()(req, res, next);
}

export function expensiveLimiter(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => ensureExpensive()(req, res, next);
}

export function authLimiter(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => ensureAuth()(req, res, next);
}

/** Higher, per-user bucket for audio/Range streaming (config RATE_LIMIT_MEDIA_MAX). */
export function mediaLimiter(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => ensureMedia()(req, res, next);
}

/** Reset limiter instances (drops their in-memory hit stores) — test-only. */
export function resetLimiters(): void {
  _cheap = null;
  _expensive = null;
  _auth = null;
  _media = null;
}
