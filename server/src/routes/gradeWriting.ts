/**
 * POST /grade-writing — writing grader (proxied to B4): two TOPIK II
 * rubrics plus a general `free_write` rubric (056/F-117).
 *
 * Body fields mirror B4's GradeInputSchema, plus an edge-only `promptId`
 * (F-014). On a successful grade the route persists a writing_attempts row
 * (best-effort — see the persist block) which feeds GET /writing/series and
 * GET /writing/attempts (F-106).
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import { mapClaudeError } from '../middleware/errors.js';
import { query } from '../db/pool.js';
import { getLogger } from '../logging.js';

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
//   * rubric     — OPTIONAL, defaults to TOPIK II Q54 (the more general TOPIK
//                  rubric). A *present but invalid* value is still a 400. As
//                  of migration 056 (F-117) also accepts `free_write` — a
//                  real rubric for a Claude-generated open-topic sample,
//                  instead of borrowing Q54's rubric as an ill-fitting stand-in.
//   * targetLevel — OPTIONAL proficiency band hint (proficiency_level enum). An
//                  out-of-set value (e.g. 'L9') is a 400. Accepted at the edge
//                  for forward-compat but NOT forwarded to the proxy (the grader
//                  derives the level from the sample; see GradeInput).
//   * promptId   — OPTIONAL (F-014). The writing_prompts row the learner picked;
//                  stored as the persisted attempt's soft prompt link, never
//                  forwarded to the grader. A non-integer / non-positive value
//                  is a 400; a WELL-FORMED id that doesn't exist merely fails
//                  the best-effort persist (FK violation → logged, grade still
//                  returned) — an attacker probing ids learns nothing.
const GradeSchema = z
  .object({
    prompt: z.string().min(1).max(2_000),
    sample: z.string().min(1).max(5_000),
    // Mirrors the DB CHECK (ck_writing_attempts_rubric, widened by migration
    // 056/F-117 to add free_write alongside the two TOPIK II rubrics).
    rubric: z.enum(['topik_ii_53', 'topik_ii_54', 'free_write']).default('topik_ii_54'),
    targetLevel: z.enum(['basic', 'L3', 'L4', 'L5+']).optional(),
    // writing_prompts.id is BIGINT; ids are identity-generated well below
    // 2^53, so a JS-safe-integer cap rejects garbage without ever rejecting a
    // real id.
    promptId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

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

      // F-014: persist the successful grade as a writing_attempts row (feeds
      // GET /writing/series + a future history screen). BEST-EFFORT: the grade
      // already cost a Claude call, so a persist failure (down DB, FK violation
      // on a stale promptId) must never fail the response — log with the
      // correlation id and continue. An out-of-contract totalScore is clamped
      // below (with a warn) rather than left to trip the range CHECK, so a
      // systematic grader-contract violation cannot silently lose every row.
      // Stamped with the SESSION user (getUserId), never a client id (no IDOR).
      try {
        const grade = result.result;
        // The grader contract types scores as `number`; the columns are
        // INTEGER. Round here so a fractional score becomes a clean insert
        // instead of a text-to-int cast error from pg. Floor at 1: the schema
        // only pins maxTotal positive, so a contract-valid 0.4 would round to
        // 0 and trip ck_writing_attempts_max_total_positive — silently
        // dropping the attempt from the F-017 series on EVERY such grade
        // (services sweep #8). Warn when normalization changed the value so
        // the contract violation is observable.
        const maxTotal = Math.max(1, Math.round(grade.maxTotal));
        if (maxTotal !== grade.maxTotal) {
          getLogger().warn(
            {
              correlationId: req.correlationId,
              rawMaxTotal: grade.maxTotal,
              persistedMaxTotal: maxTotal,
            },
            'grade-writing: grader returned an out-of-contract maxTotal — normalized for persist',
          );
        }
        const rawTotalScore = Math.round(grade.totalScore);
        // ck_writing_attempts_total_in_range requires total_score in
        // [0, max_total]. GradeResultSchema only pins totalScore nonnegative —
        // no cross-field totalScore <= maxTotal refinement (deliberate: a
        // refinement would fail the whole paid grade). So an out-of-contract
        // grader score (e.g. 31/30) would trip the CHECK and silently drop the
        // attempt on EVERY such grade. Clamp instead, and warn with the raw
        // values so the contract violation is observable. The grade RESPONSE
        // is untouched — only the persisted history row is normalized.
        const totalScore = Math.min(Math.max(rawTotalScore, 0), maxTotal);
        if (totalScore !== rawTotalScore) {
          getLogger().warn(
            {
              correlationId: req.correlationId,
              rawTotalScore: grade.totalScore,
              rawMaxTotal: grade.maxTotal,
              persistedTotalScore: totalScore,
            },
            'grade-writing: grader returned an out-of-contract totalScore — clamped to [0, maxTotal] for persist',
          );
        }
        await query(
          `INSERT INTO writing_attempts
              (user_id, prompt_id, rubric, prompt_kr, sample,
               total_score, max_total, estimated_level, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            getUserId(req),
            body.promptId ?? null,
            body.rubric,
            body.prompt,
            body.sample,
            totalScore,
            maxTotal,
            grade.estimatedLevel,
            JSON.stringify(grade),
          ],
        );
      } catch (persistErr) {
        getLogger().error(
          { err: persistErr, correlationId: req.correlationId },
          'grade-writing: attempt persist failed — returning the grade anyway',
        );
      }

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
