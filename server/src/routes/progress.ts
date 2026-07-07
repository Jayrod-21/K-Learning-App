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

/**
 * True only for a real calendar date (shape pre-checked by the regex below).
 * A regex alone admits 2026-02-30 / 2026-13-01 / 0000-01-01, which survive to
 * the `$2::date` cast in SQL and turn into a pg "date/time field value out of
 * range" 500 where a 400 belongs (routes sweep #2). Date.UTC round-trips the
 * components, so any overflow (month 13, Feb 30) changes them and is rejected.
 * Years < 100 are rejected too (Date.UTC maps them to 19xx, failing the
 * round-trip) — no legitimate study log predates 100 AD.
 */
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

const StudyLogBodySchema = z.object({
  minutes: z.number().nonnegative().max(24 * 60),
  activity: z.union([z.string().min(1).max(64), z.record(z.string(), z.unknown())]),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, { message: 'not a real calendar date' })
    .optional(),
});

/**
 * study_log.minutes_studied is NUMERIC(6,2) (migration 001) → hard column max
 * 9999.99. The per-request Zod cap (≤ 1440) bounds one write, but the upsert
 * ACCUMULATES — 7 max-size (or many retried) logs on one day overflow the
 * column, and once a day's row is near the cap every further legit study-log
 * that day 500s until midnight (routes sweep #1). Saturate at the column max
 * instead: 9999.99 minutes (~167 h) in one day is unreachable legitimately, so
 * clamping loses nothing real and keeps the row writable.
 */
const MINUTES_STUDIED_MAX = 9999.99;

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
             SET minutes_studied = LEAST(
                                     study_log.minutes_studied + EXCLUDED.minutes_studied,
                                     $5::numeric),
                 activities      = study_log.activities || EXCLUDED.activities,
                 version         = study_log.version + 1
           RETURNING id, minutes_studied`,
          [
            userId,
            body.date ?? null,
            body.minutes,
            JSON.stringify(activityEntry),
            MINUTES_STUDIED_MAX,
          ],
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
