/**
 * POST /grade-writing — TOPIK-rubric writing grader (proxied to B4).
 *
 * Body fields mirror B4's GradeInputSchema.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import { UpstreamError } from '../middleware/errors.js';

const router = Router();

const GradeSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  sample: z.string().min(1).max(5_000),
  rubric: z.string().min(1).max(64).optional(),
  targetLevel: z.enum(['L3', 'L4', 'L5+']).optional(),
});

router.post(
  '/',
  requireAuth,
  expensiveLimiter(),
  validateBody(GradeSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof GradeSchema>;
      const proxy = getClaudeProxy();
      const result = await proxy.gradeWriting(body, {
        requestId: req.correlationId,
        userId: req.user?.id ?? null,
      });
      res.status(200).json(result);
    } catch (err) {
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
