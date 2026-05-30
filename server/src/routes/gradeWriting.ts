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

// Mirror the proxy's GradeInput contract exactly: `rubric` is a required TOPIK
// rubric enum, not a free string. (A loose/absent rubric used to pass edge
// validation here and then get rejected by the proxy's own input parse as a
// 502 — validate it at the edge instead so a bad rubric is a clean 400.)
const GradeSchema = z.object({
  prompt: z.string().min(1).max(2_000).optional(),
  sample: z.string().min(1).max(16_000),
  rubric: z.enum(['topik_ii_53', 'topik_ii_54']),
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
