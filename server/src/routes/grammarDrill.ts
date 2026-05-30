/**
 * /grammar-drill routes — grammar PRODUCTION drills (Pass 9, Grammar DrillPanel).
 *
 * Flow:
 *   POST /grammar-drill                    → generate a drill (type by rotation),
 *                                            persist the attempt, return the
 *                                            answer-stripped item
 *   POST /grammar-drill/:attemptId/submit  → score the learner's answer, update
 *                                            the row, reveal the reference model
 *
 * SECURITY (see SECURITY.md §17 — generation answer-stripping + scoring IDOR/
 * single-shot are the load-bearing properties of this pass):
 *   - ANSWER-STRIPPING: the generated item is persisted WITH its reference model
 *     answer (item JSONB, server-only) but the generation RESPONSE strips
 *     referenceModelKr/En (DrillItemPublic). The learner never sees the model
 *     answer until AFTER they submit — mirrors the diagnostic's correct-answer
 *     stripping. A leak here would turn a production drill into a copy exercise.
 *   - IDOR: the submit handler loads the attempt scoped to (id, user_id). Another
 *     user's attemptId → 404 (not 403 — don't confirm existence).
 *   - SCORED-ONCE (concurrent double-submit): the scoring UPDATE is gated on
 *     `scored_at IS NULL`. A single `UPDATE … WHERE scored_at IS NULL` is itself
 *     atomic — Postgres serializes racers on the row write-lock, so at most one
 *     matches the predicate (rowCount 1) and the loser sees rowCount 0 → 409. The
 *     Claude call happens BEFORE the gating UPDATE, but the row only flips to
 *     scored once; the loser's (paid) call is discarded, not written.
 *   - CLAUDE-FAIL LEAVES NO HALF-STATE: generation does the Claude call BEFORE the
 *     INSERT, so a 502 writes no attempt row. Submit does the Claude call, then
 *     the single-shot UPDATE — a 502 leaves the row UNSCORED (scored_at stays
 *     NULL) so the learner can retry; nothing partial is persisted.
 *   - COST: both routes are behind expensiveLimiter() (per-user burst) AND the
 *     proxy's own per-route per-minute limiter; the input caps bound prompt size
 *     and the injection surface (pattern/answer text is sanitized in the proxy).
 *   - INJECTION VIA PATTERN/ANSWER TEXT: the proxy wraps every free-text field in
 *     <user_input> + runs the marker/control-char sanitizer; the prompt treats it
 *     as data. This route does not concatenate user text into SQL (parameterized)
 *     or into the prompt directly.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { ConflictError, NotFoundError, UpstreamError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import type { DrillType, GrammarDrillItem } from '../services/claudeProxy.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Drill-type rotation
// ---------------------------------------------------------------------------

/** The rotation order. A pattern with no history starts at the first entry; a
 *  pattern with history advances to the LEAST-recently-used type. Deterministic
 *  — no RNG, so a test can pin the sequence. */
const DRILL_TYPE_ORDER: readonly DrillType[] = ['transformation', 'cloze', 'conversation'];

/**
 * Pick the next drill type for (user, pattern) from recent history.
 *
 * Rule: query the ≤3 most-recent attempts (newest first) and choose the type
 * that is LEAST-recently used — i.e. the first type in DRILL_TYPE_ORDER that
 * does NOT appear among the recent types, falling back to the type used longest
 * ago when all three appear. No history → 'transformation' (the first type).
 *
 * Concretely, given recent types newest→oldest:
 *   []                              → transformation   (no history)
 *   [transformation]                → cloze            (first unused in order)
 *   [cloze, transformation]         → conversation     (first unused in order)
 *   [conversation, cloze, transformation]
 *                                   → transformation   (all used; least-recent)
 * This yields the transformation → cloze → conversation → transformation cycle.
 */
function pickDrillType(recentNewestFirst: readonly DrillType[]): DrillType {
  // First type in the canonical order that hasn't appeared recently.
  for (const t of DRILL_TYPE_ORDER) {
    if (!recentNewestFirst.includes(t)) return t;
  }
  // All three appear in the recent window → pick the least-recently used, which
  // is the LAST element of the newest-first list (the oldest of the recent ≤3).
  const leastRecent = recentNewestFirst[recentNewestFirst.length - 1];
  return leastRecent ?? DRILL_TYPE_ORDER[0]!;
}

// ---------------------------------------------------------------------------
// DTOs + answer-stripping
// ---------------------------------------------------------------------------

/** The public view of a generated drill: the full item MINUS the reference model
 *  answer (referenceModelKr/En). This is what the generation response carries. */
type DrillItemPublic = Omit<GrammarDrillItem, 'referenceModelKr' | 'referenceModelEn'>;

/** Strip the reference model answer from a generated item for the wire. The two
 *  reference fields are common to every union member, so a structural omit is
 *  type-safe across all three drill types. */
function toPublicItem(item: GrammarDrillItem): DrillItemPublic {
  const { referenceModelKr: _kr, referenceModelEn: _en, ...pub } = item;
  void _kr;
  void _en;
  return pub;
}

/**
 * Reconstruct the rendered task text from a stored item, by type. This is the
 * grading context the scorer sees (the learner's view of the task), built from
 * the SAME stored item we generated — never from client input.
 */
function promptTextFor(item: GrammarDrillItem): string {
  switch (item.type) {
    case 'transformation':
      return item.sourceKr;
    case 'cloze':
      return `${item.context}\n${item.seedKr}`;
    case 'conversation':
      return `${item.scenario}\n${item.promptKr}`;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GenBodySchema = z
  .object({
    patternKey: z.string().trim().min(1).max(120),
    patternDisplay: z.string().trim().min(1).max(120),
    meaning: z.string().trim().min(1).max(300).optional(),
    exampleKr: z.string().trim().min(1).max(500).optional(),
    exampleEn: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const SubmitParamsSchema = z.object({
  attemptId: z.coerce.number().int().positive(),
});

const SubmitBodySchema = z
  .object({
    answer: z.string().trim().min(1).max(600),
  })
  .strict();

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface AttemptRow {
  id: string;
  drill_type: DrillType;
  pattern_display: string;
  item: GrammarDrillItem;
  scored_at: Date | null;
}

// ---------------------------------------------------------------------------
// POST /grammar-drill — generate a drill (type by rotation), persist, strip ref.
// ---------------------------------------------------------------------------

router.post('/', expensiveLimiter(), validateBody(GenBodySchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as z.infer<typeof GenBodySchema>;

    // 1. Pick the drill type from recent history (rotation). Read the ≤3 most
    //    recent attempts for THIS user + pattern, newest first.
    const { rows: histRows } = await query<{ drill_type: DrillType }>(
      `SELECT drill_type
         FROM grammar_drill_attempts
        WHERE user_id = $1 AND pattern_key = $2
        ORDER BY created_at DESC
        LIMIT 3`,
      [userId, body.patternKey],
    );
    const drillType = pickDrillType(histRows.map((r) => r.drill_type));

    // 2. Generate via Claude BEFORE any INSERT — a Claude failure must write no
    //    attempt row (no half-state). Maps to a 502 below.
    const proxy = getClaudeProxy();
    const { result: item } = await proxy.generateGrammarDrill(
      {
        patternKey: body.patternKey,
        patternDisplay: body.patternDisplay,
        ...(body.meaning !== undefined ? { meaning: body.meaning } : {}),
        ...(body.exampleKr !== undefined ? { exampleKr: body.exampleKr } : {}),
        ...(body.exampleEn !== undefined ? { exampleEn: body.exampleEn } : {}),
        drillType,
      },
      { ...(req.correlationId !== undefined ? { requestId: req.correlationId } : {}), userId },
    );

    // 3. Defensive invariant: the generated item's `type` MUST equal the type we
    //    requested. The tool input_schema is built per requested type and the
    //    discriminated-union parse rejects a foreign shape, so a mismatch is a
    //    server-side invariant violation (prompt/schema drift), not a user error —
    //    fail LOUDLY rather than silently desync the persisted drill_type from the
    //    rotation history that drives type selection.
    if (item.type !== drillType) {
      throw new Error(
        `grammar drill type invariant violated: requested ${drillType}, model returned ${item.type}`,
      );
    }

    // 4. Persist the FULL item (incl. reference model) as the attempt. drill_type
    //    is the SERVER-CHOSEN requested type (authoritative; === item.type per the
    //    assertion above) — it is the canonical column the rotation history and the
    //    submit-time task reconstruction read, so it must reflect the server's
    //    decision, never a value sourced from model output.
    const { rows: insRows } = await query<{ id: string }>(
      `INSERT INTO grammar_drill_attempts
         (user_id, pattern_key, pattern_display, drill_type, item)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id::text AS id`,
      [userId, body.patternKey, body.patternDisplay, drillType, JSON.stringify(item)],
    );
    const attemptId = Number(insRows[0]!.id);

    // 5. Respond with the answer-STRIPPED item (reference model removed).
    res.status(201).json({ attemptId, item: toPublicItem(item) });
  } catch (err) {
    next(mapClaudeError(err));
  }
});

// ---------------------------------------------------------------------------
// POST /grammar-drill/:attemptId/submit — score the answer, reveal the reference.
// ---------------------------------------------------------------------------

router.post(
  '/:attemptId/submit',
  expensiveLimiter(),
  validateParams(SubmitParamsSchema),
  validateBody(SubmitBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { attemptId } = (req as typeof req & {
        validatedParams: z.infer<typeof SubmitParamsSchema>;
      }).validatedParams;
      const { answer } = req.body as z.infer<typeof SubmitBodySchema>;

      // 1. Load the attempt user-scoped. Not theirs / missing → 404 (IDOR
      //    defense; don't confirm existence). Already scored → 409.
      const { rows } = await query<AttemptRow>(
        `SELECT id::text AS id, drill_type, pattern_display, item, scored_at
           FROM grammar_drill_attempts
          WHERE id = $1 AND user_id = $2`,
        [attemptId, userId],
      );
      const attempt = rows[0];
      if (!attempt) {
        throw new NotFoundError('grammar drill attempt not found');
      }
      if (attempt.scored_at !== null) {
        throw new ConflictError('grammar drill attempt already scored');
      }

      // 2. Reconstruct the rendered task text from the STORED item (never client
      //    input) and pull the reference model the scorer compares against.
      const item = attempt.item;
      const promptText = promptTextFor(item);

      // 3. Score via Claude. A failure leaves the row UNSCORED (we have not
      //    written anything yet) so the learner may retry — maps to 502 below.
      const proxy = getClaudeProxy();
      const { result: scored } = await proxy.scoreGrammarDrill(
        {
          drillType: attempt.drill_type,
          patternDisplay: attempt.pattern_display,
          promptText,
          referenceModelKr: item.referenceModelKr,
          userAnswer: answer,
        },
        { ...(req.correlationId !== undefined ? { requestId: req.correlationId } : {}), userId },
      );

      // 4. Single-shot UPDATE gated on `scored_at IS NULL`. A single UPDATE …
      //    WHERE scored_at IS NULL is itself atomic: Postgres serializes the two
      //    racers on the row write-lock the UPDATE takes, so AT MOST ONE matches
      //    the predicate (rowCount 1) and the loser sees rowCount 0 → 409. There
      //    is nothing to compute under a lock here (the score is already in hand
      //    from the Claude call above), so — unlike diagnostic.ts, whose FOR
      //    UPDATE read is load-bearing because it derives θ/the pending item
      //    under the lock — a separate lock-read would be a redundant round-trip.
      //    The rowCount gate is the authoritative single-shot guard; the cheap
      //    pre-check above (step 1) only spares the already-scored common case a
      //    Claude call, it is NOT relied upon for correctness. The loser's Claude
      //    call is simply discarded (paid-but-unused, bounded by the limiter).
      const feedback = {
        summary: scored.summary,
        usesPattern: scored.usesPattern,
        corrections: scored.corrections,
      };
      const upd = await query(
        `UPDATE grammar_drill_attempts
            SET user_answer = $3,
                score       = $4,
                verdict     = $5,
                feedback    = $6::jsonb,
                scored_at   = now()
          WHERE id = $1 AND user_id = $2 AND scored_at IS NULL`,
        [
          attemptId,
          userId,
          answer,
          scored.score,
          scored.verdict,
          JSON.stringify(feedback),
        ],
      );
      if (upd.rowCount !== 1) {
        // A concurrent submit won the race and flipped scored_at first (or the
        // row vanished). Either way this attempt is already scored → 409.
        throw new ConflictError('grammar drill attempt already scored');
      }

      // 5. Reveal the reference model answer NOW (post-submit). The score block
      //    carries the full feedback + the model answer the learner can compare.
      res.status(200).json({
        score: scored.score,
        verdict: scored.verdict,
        usesPattern: scored.usesPattern,
        summary: scored.summary,
        corrections: scored.corrections,
        referenceModelKr: item.referenceModelKr,
        referenceModelEn: item.referenceModelEn,
      });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/**
 * Map a Claude proxy error (carries httpStatus/code) to a 502 UpstreamError.
 * Mirrors diagnostic.ts / images.ts mapClaudeError — we never forward the
 * upstream status or provider-specific details to the wire (SECURITY.md §13.7).
 * Non-proxy errors (NotFound/Conflict/etc.) pass through unchanged.
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
