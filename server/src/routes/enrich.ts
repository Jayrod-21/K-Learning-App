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
import { expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import { UpstreamError } from '../middleware/errors.js';

const router = Router();

const EnrichSchema = z.object({
  lemma: z.string().min(1).max(64),
  sourceSentence: z.string().min(1).max(2_000),
  context: z.string().max(2_000).optional(),
  krdictGloss: z.string().max(2_000).optional(),
});

router.post(
  '/',
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
      // Map B4 errors to our generic upstream error so the client sees a
      // consistent shape. The B4 module already typed them; we re-wrap
      // anything we don't recognize.
      if (err && typeof err === 'object' && 'httpStatus' in err) {
        const status = (err as { httpStatus?: number }).httpStatus ?? 502;
        const code = (err as { code?: string }).code ?? 'upstream_error';
        const message = (err as { message?: string }).message ?? 'claude error';
        next(new UpstreamError(`${code}: ${message}`, { status }));
        return;
      }
      next(err);
    }
  },
);

export default router;
