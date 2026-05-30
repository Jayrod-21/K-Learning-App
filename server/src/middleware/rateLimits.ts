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
import type { Request } from 'express';
import { loadConfig } from '../config/index.js';

function ipKey(req: Request): string {
  // Trust the right-most X-Forwarded-For only when a reverse proxy is configured
  // upstream. Default to req.ip (Express respects `trust proxy`).
  return req.ip ?? 'unknown';
}

function userOrIpKey(req: Request): string {
  return req.user?.id ? `u:${req.user.id}` : `ip:${ipKey(req)}`;
}

let _cheap: RateLimitRequestHandler | null = null;
let _expensive: RateLimitRequestHandler | null = null;
let _auth: RateLimitRequestHandler | null = null;

export function cheapLimiter(): RateLimitRequestHandler {
  if (_cheap) return _cheap;
  const cfg = loadConfig();
  _cheap = rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_CHEAP_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    keyGenerator: ipKey,
    message: { error: { code: 'rate_limited', message: 'too many requests' } },
  });
  return _cheap;
}

export function expensiveLimiter(): RateLimitRequestHandler {
  if (_expensive) return _expensive;
  const cfg = loadConfig();
  _expensive = rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_EXPENSIVE_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    keyGenerator: userOrIpKey,
    message: { error: { code: 'rate_limited', message: 'too many requests' } },
  });
  return _expensive;
}

export function authLimiter(): RateLimitRequestHandler {
  if (_auth) return _auth;
  const cfg = loadConfig();
  _auth = rateLimit({
    windowMs: cfg.RATE_LIMIT_WINDOW_MS,
    max: cfg.RATE_LIMIT_AUTH_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    keyGenerator: ipKey,
    // Don't count successful logins toward the limit — only failures matter
    // for brute-force defense.
    skipSuccessfulRequests: true,
    message: { error: { code: 'rate_limited', message: 'too many auth attempts' } },
  });
  return _auth;
}

/** Reset cached limiters — test-only. */
export function resetLimiters(): void {
  _cheap = null;
  _expensive = null;
  _auth = null;
}
