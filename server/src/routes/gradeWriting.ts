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

// Edge contract for POST /grade-writing. Validated here so malformed input is a
// clean 400 rather than a 502 from the proxy's own input parse, and so the body
// is .strict() — an unexpected field (e.g. an attacker probing `model` or a
// typo'd key) is rejected outright per the global input-validation posture.
//
//   * prompt     — REQUIRED. The grader needs the question the learner answered;
//                  grading a sample with no prompt is meaningless. Bounded 1..2000.
//   * sample     — REQUIRED. The learner's writing. Bounded 1..5000 (a TOPIK II
//                  Q54 essay is ~700 Korean chars; 5000 is generous head-room
//                  while still rejecting paste-bomb DoS input).
//   * rubric     — OPTIONAL, defaults to TOPIK II Q54 (the more general rubric).
//                  A *present but invalid* value is still a 400.
//   * targetLevel — OPTIONAL proficiency band hint (proficiency_level enum). An
//                  out-of-set value (e.g. 'L9') is a 400. Accepted at the edge
//                  for forward-compat but NOT forwarded to the proxy (the grader
//                  derives the level from the sample; see GradeInput).
const GradeSchema = z
  .object({
    prompt: z.string().min(1).max(2_000),
    sample: z.string().min(1).max(5_000),
    rubric: z.enum(['topik_ii_53', 'topik_ii_54']).default('topik_ii_54'),
    targetLevel: z.enum(['basic', 'L3', 'L4', 'L5+']).optional(),
  })
  .strict();

router.post(
  '/',
  requireAuth,
  expensiveLimiter(),
  validateBody(GradeSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof GradeSchema>;
      const proxy = getClaudeProxy();
      // Forward only the fields the proxy's GradeInput contract accepts —
      // targetLevel is an edge-only hint and is intentionally not passed through.
      const result = await proxy.gradeWriting(
        { prompt: body.prompt, sample: body.sample, rubric: body.rubric },
        {
          requestId: req.correlationId,
          userId: req.user?.id ?? null,
        },
      );
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
