/**
 * /ability routes (F-212 Phase 2) — the continuous, evidence-driven ability
 * estimate. SEPARATE from /diagnostic (F-011), whose snapshot pipeline stays
 * authoritative; this surface re-estimates from recent practice on demand.
 *
 * SECURITY: requireAuth on the whole router; userId is SERVER-BOUND via
 * getUserId (never client-supplied), and the service scopes every query to
 * it. cheapLimiter bounds the (CPU-light, DB-backed) estimation reads.
 */
import { Router } from 'express';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { estimateAbility } from '../services/ability/estimate.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /ability/estimate — one AbilityEstimate per diagnostic dimension
 * (DIMENSION_ORDER), each either a θ/SE/band/score or an insufficient marker.
 */
router.get('/estimate', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const estimates = await estimateAbility(userId);
    res.status(200).json({ estimates });
  } catch (err) {
    next(err);
  }
});

export default router;
