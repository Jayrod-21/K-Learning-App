/**
 * POST /enrich — Claude enrichment for a lemma in context.
 *
 * Body shape mirrors B4's EnrichmentInput (camelCase). Auth required;
 * expensive bucket. Per-user/IP rate limiting at the Express layer is
 * complementary to B4's token-bucket per-route limit.
 *
 * Bar §"Concurrency & I/O": no DB transaction is open while we call out.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import { mapClaudeError } from '../middleware/errors.js';

const router = Router();

const EnrichSchema = z.object({
  lemma: z.string().min(1).max(64),
  sourceSentence: z.string().min(1).max(2_000),
  context: z.string().max(2_000).optional(),
  krdictGloss: z.string().max(2_000).optional(),
});

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
  validateBody(EnrichSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof EnrichSchema>;
      const proxy = getClaudeProxy();
      const result = await proxy.enrich(body, {
        requestId: req.correlationId,
        userId: req.user?.id ?? null,
      });
      res.status(200).json(result);
    } catch (err) {
      // F-124/F-094: route every Claude-proxy error through the shared,
      // whitelisted mapper (middleware/errors.ts) instead of forwarding the
      // raw `${code}: ${message}` — that used to leak upstream/provider text
      // straight to the client. mapClaudeError passes non-proxy errors
      // through unchanged, so they still fall to the generic opaque 500.
      next(mapClaudeError(err));
    }
  },
);

export default router;
