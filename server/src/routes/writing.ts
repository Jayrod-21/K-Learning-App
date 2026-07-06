/**
 * /writing routes — Writing prompt bank + per-day grade series (F-014).
 *
 * Flow:
 *   GET /writing/prompts?rubric= → the active TOPIK II prompt bank (Writing
 *                                  screen; replaces the client's hardcoded
 *                                  WRITING_TASKS list)
 *   GET /writing/series?days=    → daily normalized grade series (F-017 chart)
 *
 * The attempts themselves are WRITTEN by POST /grade-writing (a persist
 * side-effect of a successful grade — see gradeWriting.ts); this module only
 * reads.
 *
 * SECURITY:
 *   - requireAuth on the whole router; cheapLimiter per route (both endpoints
 *     are single indexed SELECTs — no upstream calls).
 *   - IDOR: /series is scoped to `getUserId(req)` — never a client-supplied
 *     id. /prompts is shared reference data (no ownership to scope).
 *   - Input validation at the boundary via zod (rubric enum, days 1..90);
 *     every query is parameterized.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /writing/prompts — the active, rubric-tagged prompt bank
// ---------------------------------------------------------------------------

/** The two TOPIK II writing rubrics the grader accepts (mirrors the DB CHECK). */
const WritingRubricSchema = z.enum(['topik_ii_53', 'topik_ii_54']);
type WritingRubric = z.infer<typeof WritingRubricSchema>;

// `rubric` is optional: the Writing screen fetches per rubric tab, but an
// unfiltered call returns the whole active bank (both tabs in one round trip).
// A present-but-invalid value is a 400 at the boundary, never a silent
// empty-list. `.strict()` is deliberately NOT used on query schemas here —
// unknown query params are ignored elsewhere in the app (validateQuery
// replaces req.query with the parsed subset), and this matches /topik/series.
const PromptsQuerySchema = z.object({
  rubric: WritingRubricSchema.optional(),
});

interface PromptRow {
  id: string; // BIGINT arrives as string from pg
  prompt_kr: string;
  prompt_en: string | null;
  level: string;
  rubric: WritingRubric;
  est_minutes: number | null;
}

/** Wire shape — LOCKED by DESIGN_F014 §"API contract" (client mirrors it). */
interface WritingPromptDTO {
  id: number;
  promptKr: string;
  promptEn: string | null;
  level: string;
  rubric: WritingRubric;
  estMinutes: number | null;
}

/**
 * GET /writing/prompts?rubric=topik_ii_53|topik_ii_54
 *
 * Active prompts only, and only rubric-tagged rows — the retired pre-F-014
 * register-drill rows are both inactive AND untagged (migration 038), so the
 * two predicates are belt-and-braces: even if an operator re-activated a
 * legacy row, it could never surface here with a NULL rubric the DTO cannot
 * carry. Stable ascending-id order so the screen's prompt rotation is
 * deterministic across fetches.
 */
router.get(
  '/prompts',
  cheapLimiter(),
  validateQuery(PromptsQuerySchema),
  async (req, res, next) => {
    try {
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof PromptsQuerySchema> }
      ).validatedQuery;
      const { rows } = await query<PromptRow>(
        `SELECT id, prompt_kr, prompt_en, level::text AS level, rubric, est_minutes
           FROM writing_prompts
          WHERE is_active
            AND rubric IS NOT NULL
            AND ($1::text IS NULL OR rubric = $1)
          ORDER BY id`,
        [q.rubric ?? null],
      );
      const prompts: WritingPromptDTO[] = rows.map((r) => ({
        id: Number(r.id),
        promptKr: r.prompt_kr,
        promptEn: r.prompt_en,
        level: r.level,
        rubric: r.rubric,
        estMinutes: r.est_minutes,
      }));
      res.status(200).json({ prompts });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /writing/series — daily normalized grade series (F-017)
// ---------------------------------------------------------------------------

// Same rolling window as /topik/series: 1..90 days, default 30. Out-of-range
// 400s at the boundary (ValidationError).
const SeriesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

interface SeriesRow {
  date: string;
  value: number;
}

/**
 * GET /writing/series?days=1..90(def 30) — daily Writing score series.
 *
 * Buckets the caller's writing_attempts by UTC day over the last `days` and
 * returns per-day `round(avg(total_score * 100.0 / max_total))` — each attempt
 * NORMALIZED to a percentage BEFORE averaging, so a Q53 (out of 30) and a Q54
 * (out of 50) graded the same day are comparable and the client's LineChart
 * keeps its fixed 0-100 axis (DESIGN_F014 contract: metric 'score', unit '%').
 * Days without an attempt have no point (the chart draws gaps, not zeroes);
 * points are ascending by date.
 *
 * User-scoped to `getUserId(req)` — never a client-supplied id (no IDOR).
 * Bucketing pins `AT TIME ZONE 'UTC'` so the day boundary is stable regardless
 * of the DB session TimeZone GUC (same rationale as /topik/series). Backed by
 * ix_writing_attempts_user_graded (user_id, graded_at DESC).
 */
router.get(
  '/series',
  cheapLimiter(),
  validateQuery(SeriesQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof SeriesQuerySchema> }
      ).validatedQuery;
      const { rows } = await query<SeriesRow>(
        `SELECT to_char((graded_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
                round(avg(total_score * 100.0 / max_total))::int AS value
           FROM writing_attempts
          WHERE user_id = $1
            AND graded_at > now() - make_interval(days => $2)
          GROUP BY (graded_at AT TIME ZONE 'UTC')::date
          ORDER BY (graded_at AT TIME ZONE 'UTC')::date`,
        [userId, q.days],
      );
      res.status(200).json({
        series: {
          metric: 'score',
          unit: '%',
          points: rows.map((r) => ({ date: r.date, value: r.value })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
