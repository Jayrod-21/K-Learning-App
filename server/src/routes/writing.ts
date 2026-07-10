/**
 * /writing routes — Writing prompt bank + per-day grade series (F-014) +
 * on-demand prompt GENERATION (F-027 Today tile / F-073 Writing page).
 *
 * Flow:
 *   GET  /writing/prompts?rubric=        → the active TOPIK II prompt bank
 *                                          (Writing screen; replaces the
 *                                          client's hardcoded WRITING_TASKS list)
 *   GET  /writing/prompts/random?rubric= → ONE random active prompt for the
 *                                          rubric (B-027: the list endpoint is
 *                                          deterministic and the client pinned
 *                                          index 0, so every visit opened the
 *                                          same prompt)
 *   GET  /writing/series?days=           → daily normalized grade series (F-017)
 *   POST /writing/generate               → Claude authors ONE fresh writing
 *                                          prompt (TOPIK Q53/Q54-style or a
 *                                          general free-write). EPHEMERAL:
 *                                          returned inline, never persisted —
 *                                          the response persists later via
 *                                          /grade-writing's writing_attempts.
 *
 * The attempts themselves are WRITTEN by POST /grade-writing (a persist
 * side-effect of a successful grade — see gradeWriting.ts); this module's
 * bank/series endpoints only read, and /generate writes nothing.
 *
 * SECURITY:
 *   - requireAuth on the whole router; cheapLimiter on the read routes (single
 *     indexed SELECTs). /generate is a PAID upstream call → expensiveLimiter
 *     (per-user burst) PLUS the proxy's own per-route per-minute limiter.
 *   - IDOR: /series is scoped to `getUserId(req)` — never a client-supplied
 *     id. /prompts is shared reference data (no ownership to scope);
 *     /generate persists nothing, so there is nothing to own.
 *   - Input validation at the boundary via zod (rubric enum, days 1..90;
 *     /generate's body is `.strict()` with closed enums — NO free text rides
 *     this route, so its prompt-injection surface is nil); every query is
 *     parameterized.
 *   - CLAUDE FAILURE → 502 UpstreamError via mapClaudeError; upstream
 *     status/detail is never forwarded to the wire (SECURITY.md §13.7).
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError, UpstreamError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';

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

/** DB row → wire DTO (shared by /prompts and /prompts/random). */
function toPromptDTO(r: PromptRow): WritingPromptDTO {
  return {
    id: Number(r.id),
    promptKr: r.prompt_kr,
    promptEn: r.prompt_en,
    level: r.level,
    rubric: r.rubric,
    estMinutes: r.est_minutes,
  };
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
      const prompts: WritingPromptDTO[] = rows.map(toPromptDTO);
      res.status(200).json({ prompts });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /writing/prompts/random — one random active prompt for a rubric (B-027)
// ---------------------------------------------------------------------------

// Unlike /prompts, `rubric` is REQUIRED here: a random pick only makes sense
// within one question type (Q53 memos and Q54 essays are graded on different
// rubrics and lengths). Missing or invalid → 400 at the boundary.
const RandomPromptQuerySchema = z.object({
  rubric: WritingRubricSchema,
});

/**
 * GET /writing/prompts/random?rubric=topik_ii_53|topik_ii_54
 *
 * B-027: /prompts returns a deterministic ascending-id list and the Writing
 * screen always opens index 0, so every visit served the SAME prompt. This
 * endpoint moves the pick server-side: one uniformly random ACTIVE prompt for
 * the requested rubric per call (`ORDER BY random() LIMIT 1` — the active
 * pool is single-digit rows per rubric, so the scan is trivial). Same
 * active+tagged predicates and wire DTO as /prompts; the deterministic list
 * endpoint is kept unchanged for back-compat.
 *
 * Empty pool (e.g. an operator retired every prompt of a rubric) → 404, never
 * a 200 with a null body the client can't render.
 */
router.get(
  '/prompts/random',
  cheapLimiter(),
  validateQuery(RandomPromptQuerySchema),
  async (req, res, next) => {
    try {
      const q = (
        req as typeof req & {
          validatedQuery: z.infer<typeof RandomPromptQuerySchema>;
        }
      ).validatedQuery;
      const { rows } = await query<PromptRow>(
        `SELECT id, prompt_kr, prompt_en, level::text AS level, rubric, est_minutes
           FROM writing_prompts
          WHERE is_active
            AND rubric = $1
          ORDER BY random()
          LIMIT 1`,
        [q.rubric],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError('no active prompts for this rubric');
      }
      res.status(200).json({ prompt: toPromptDTO(row) });
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

// ---------------------------------------------------------------------------
// POST /writing/generate — Claude authors one writing prompt (F-027 / F-073)
// ---------------------------------------------------------------------------

/**
 * Body contract. `.strict()` rejects unknown keys (probing `model` or a typo'd
 * key fails loud). Both fields are closed enums — no free text enters this
 * route. The refine pins `rubric` to TOPIK mode: a general free-write has no
 * rubric, so a rubric alongside mode='general' is a client bug surfaced as a
 * 400, never silently ignored.
 */
const GenerateBodySchema = z
  .object({
    mode: z.enum(['topik', 'general']),
    rubric: WritingRubricSchema.optional(),
  })
  .strict()
  .refine((b) => b.mode === 'topik' || b.rubric === undefined, {
    message: 'rubric is only valid with mode=topik',
  });

/**
 * POST /writing/generate — generate ONE fresh writing prompt via Claude.
 *
 *   { mode: 'topik', rubric?: 'topik_ii_53' | 'topik_ii_54' } → a TOPIK II
 *     Q53/Q54-style task (rubric defaults to Q54, mirroring /grade-writing).
 *   { mode: 'general' } → a general free-write prompt.
 *
 * Returns 200 { prompt: { promptKr, promptEn, lengthHint, mode, rubric } }.
 * NOTHING is persisted (deliberate: a prompt is consumed the moment the
 * learner starts writing; the response persists later via writing_attempts).
 * The proxy Zod-validates the model output (WritingPromptResultSchema) — a
 * malformed model reply is a 502, never a malformed 200. Cache/usage rows are
 * written by the proxy under route 'generate_writing_prompt' (migration 053).
 */
router.post(
  '/generate',
  expensiveLimiter(),
  validateBody(GenerateBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof GenerateBodySchema>;
      // TOPIK mode defaults to the more general Q54 rubric (same default as
      // /grade-writing); the rubric echo below reflects what was actually used.
      const rubric = body.mode === 'topik' ? (body.rubric ?? 'topik_ii_54') : undefined;

      const proxy = getClaudeProxy();
      const { result } = await proxy.generateWritingPrompt(
        { mode: body.mode, ...(rubric !== undefined ? { rubric } : {}) },
        { ...(req.correlationId !== undefined ? { requestId: req.correlationId } : {}), userId },
      );

      res.status(200).json({
        prompt: {
          promptKr: result.promptKr,
          promptEn: result.promptEn,
          lengthHint: result.lengthHint ?? null,
          mode: body.mode,
          rubric: rubric ?? null,
        },
      });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/**
 * Map a Claude proxy error (carries httpStatus/code) to a 502 UpstreamError.
 * Mirrors grammarDrill.ts / diagnostic.ts / images.ts mapClaudeError — we never
 * forward the upstream status or provider-specific details to the wire
 * (SECURITY.md §13.7). Non-proxy errors pass through unchanged.
 */
function mapClaudeError(err: unknown): unknown {
  if (err && typeof err === 'object' && 'httpStatus' in err) {
    const code = (err as { code?: string }).code ?? 'upstream_error';
    const message = (err as { message?: string }).message ?? 'claude error';
    return new UpstreamError(`${code}: ${message}`);
  }
  return err;
}

export default router;
