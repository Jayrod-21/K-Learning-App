/**
 * /progress routes — study log, named metric snapshots, current values.
 *
 * All queries are parameterized and user-scoped: WHERE user_id = $userId,
 * never relying on client-supplied identifiers for ownership.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { ForbiddenError } from '../middleware/errors.js';

const router = Router();

router.use(requireAuth);

// Defense in depth: any body that names another user must 403.
// Mounted BEFORE the routes so it intercepts incoming requests, not 404s.
router.use((req, _res, next) => {
  const targetUser =
    typeof req.body === 'object' && req.body !== null
      ? (req.body as { user_id?: unknown }).user_id
      : undefined;
  if (targetUser !== undefined && targetUser !== req.user?.id) {
    next(new ForbiddenError('cannot operate on another user'));
    return;
  }
  next();
});

/**
 * GET /progress — latest value per metric for the current user.
 */
router.get('/', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // DISTINCT ON (metric_type) ordered by captured_at DESC returns the most
    // recent row per metric, in one round-trip.
    const { rows } = await query<{
      metric_type: string;
      value: unknown;
      captured_at: Date;
    }>(
      `SELECT DISTINCT ON (metric_type) metric_type, value, captured_at
         FROM user_progress
        WHERE user_id = $1
        ORDER BY metric_type, captured_at DESC`,
      [userId],
    );
    res.status(200).json({ metrics: rows });
  } catch (err) {
    next(err);
  }
});

const MetricParamsSchema = z.object({
  metricType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
});

const MetricBodySchema = z.object({
  value: z.union([z.string(), z.number(), z.record(z.string(), z.unknown())]),
});

/**
 * PUT /progress/:metricType — append a snapshot for a metric.
 * The user_progress table is append-only (ADR-001-aligned).
 */
router.put(
  '/:metricType',
  cheapLimiter(),
  validateParams(MetricParamsSchema),
  validateBody(MetricBodySchema),
  async (req, res, next) => {
    try {
      const params = (req as typeof req & {
        validatedParams: z.infer<typeof MetricParamsSchema>;
      }).validatedParams;
      const body = req.body as z.infer<typeof MetricBodySchema>;
      const userId = getUserId(req);
      const { rows } = await query<{ id: number; captured_at: Date }>(
        `INSERT INTO user_progress (user_id, metric_type, value)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id, captured_at`,
        [userId, params.metricType, JSON.stringify(body.value)],
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

const StudyLogBodySchema = z.object({
  minutes: z.number().nonnegative().max(24 * 60),
  activity: z.union([z.string().min(1).max(64), z.record(z.string(), z.unknown())]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post(
  '/study-log',
  cheapLimiter(),
  validateBody(StudyLogBodySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof StudyLogBodySchema>;
      const userId = getUserId(req);
      const activityEntry =
        typeof body.activity === 'string'
          ? { kind: body.activity, minutes: body.minutes }
          : { ...body.activity, minutes: body.minutes };

      // Upsert with append-to-array on conflict — preserves history of items
      // logged on the same day without overwriting the previous list.
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          id: number;
          minutes_studied: string;
        }>(
          `INSERT INTO study_log (user_id, study_date, minutes_studied, activities)
           VALUES ($1, COALESCE($2::date, current_date), $3, jsonb_build_array($4::jsonb))
           ON CONFLICT (user_id, study_date) DO UPDATE
             SET minutes_studied = study_log.minutes_studied + EXCLUDED.minutes_studied,
                 activities      = study_log.activities || EXCLUDED.activities,
                 version         = study_log.version + 1
           RETURNING id, minutes_studied`,
          [userId, body.date ?? null, body.minutes, JSON.stringify(activityEntry)],
        );
        return rows[0];
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
