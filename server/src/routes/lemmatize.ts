/**
 * POST /lemmatize — proxies to the Kiwi service (B1).
 *
 * Authentication required (cookie session). Per-user rate limit via the
 * expensive bucket because each call costs CPU on the Kiwi side.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { LemmatizeRequestSchema, lemmatize } from '../services/kiwi.js';

const router = Router();

router.post(
  '/',
  // F-UP-018 (rate-limit ordering): `expensiveLimiter` keys per-USER when
  // authenticated (fair share behind NAT — see rateLimits.ts), so it MUST
  // stay after requireAuth. The per-IP cheap limiter in front bounds
  // unauthenticated floods (each request costs a session lookup when a
  // cookie is presented) that previously bypassed rate limiting entirely.
  cheapLimiter(),
  requireAuth,
  expensiveLimiter(),
  validateBody(LemmatizeRequestSchema),
  async (req, res, next) => {
    try {
      const out = await lemmatize(req.body, req.correlationId);
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
