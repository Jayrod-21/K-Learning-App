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
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, UpstreamError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import type { DrillType, DrillVerdict, GrammarDrillItem } from '../services/claudeProxy.js';
import { ratingFromVerdict } from '../services/grammarScheduler.js';
import {
  dueDelayMs,
  schedule,
  type CardFsrs,
  type FsrsStateName,
} from '../services/fsrs.js';

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
  // BIGINT id: bounded so a 20-digit id 400s at the boundary instead of
  // overflowing int8 in pg (22003 → 500; routes sweep #3).
  attemptId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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
  pattern_key: string;
  pattern_display: string;
  item: GrammarDrillItem;
  scored_at: Date | null;
}

/** The production card's FSRS columns we read before advancing it. NUMERIC
 *  columns (stability/difficulty) arrive as strings from `pg`; we Number() them
 *  at the call site before handing to the (numeric) scheduler. */
interface CardRow {
  id: string;
  fsrs_state: FsrsStateName;
  stability: string;
  difficulty: string;
  reps: number;
  lapses: number;
  version: number;
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
        `SELECT id::text AS id, drill_type, pattern_key, pattern_display, item, scored_at
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

      // 4. Persist the score AND advance the production FSRS card in ONE
      //    transaction (FU-NF-42). All-or-nothing: the score UPDATE, the
      //    grammar-entry auto-bank, the production-card upsert, the card UPDATE,
      //    and the card_reviews snapshot either ALL commit or ALL roll back. A
      //    scheduling bug therefore 500s the submit LOUDLY (mapped below) and
      //    never half-persists a score with no schedule — a deliberate decision
      //    (contract A3.6): correctness over best-effort. Scheduling is
      //    server-derived through the shared engine (services/fsrs.ts) — the
      //    same one the vocab review route uses (ADR-003 amendment 2026-07-02);
      //    this path additionally maps the Claude verdict → rating because a
      //    drill has no client self-rating step (services/grammarScheduler.ts).
      const feedback = {
        summary: scored.summary,
        usesPattern: scored.usesPattern,
        corrections: scored.corrections,
      };

      // Map the verdict to an FSRS rating up front (pure; needs no DB). The
      // schedule itself depends on the card's CURRENT state, resolved in-tx below.
      const rating = ratingFromVerdict(scored.verdict, scored.usesPattern);

      // The score column is INTEGER but the scorer contract types score as
      // `number` in [0,100] — a contract-valid fractional 87.5 would fail the
      // int cast in pg and roll back the WHOLE submit tx (score + auto-bank +
      // FSRS advance) AFTER the paid Claude call (services sweep #3). Round +
      // clamp before persisting, mirroring gradeWriting.ts; the response echoes
      // the persisted value so the UI and history can never disagree.
      const score = Math.min(100, Math.max(0, Math.round(scored.score)));

      const txOut = await withTransaction(async (client) => {
        // 4a. Single-shot scoring UPDATE gated on `scored_at IS NULL`. A single
        //     UPDATE … WHERE scored_at IS NULL is itself atomic: Postgres
        //     serializes the two racers on the row write-lock the UPDATE takes,
        //     so AT MOST ONE matches the predicate (rowCount 1) and the loser
        //     sees rowCount 0 → 409. The rowCount gate is the authoritative
        //     single-shot guard; the cheap pre-check (step 1) only spares the
        //     already-scored common case a Claude call, it is NOT relied upon for
        //     correctness. The loser's Claude call is simply discarded
        //     (paid-but-unused, bounded by the limiter). Because this UPDATE is
        //     the first write in the tx, a concurrent winner's COMMIT makes our
        //     predicate fail and we roll back the whole (empty-so-far) tx → 409;
        //     the scheduling writes below NEVER run for the loser.
        const upd = await client.query(
          `UPDATE grammar_drill_attempts
              SET user_answer = $3,
                  score       = $4,
                  verdict     = $5,
                  feedback    = $6::jsonb,
                  scored_at   = now()
            WHERE id = $1 AND user_id = $2 AND scored_at IS NULL`,
          [attemptId, userId, answer, score, scored.verdict, JSON.stringify(feedback)],
        );
        if (upd.rowCount !== 1) {
          // A concurrent submit won the race and flipped scored_at first (or the
          // row vanished). Either way this attempt is already scored → 409.
          throw new ConflictError('grammar drill attempt already scored');
        }

        // 4b. Auto-bank the grammar pattern (resolve-or-create the entry). On
        //     first INSERT, summary_en falls back to pattern_display (we have no
        //     real gloss from a drill); the DO UPDATE deliberately does NOT
        //     clobber summary_en so a previously banked, human-meaningful summary
        //     survives — it only bumps version so the row reflects renewed
        //     activity. Every column is user-scoped; pattern_key/_display come
        //     from the SERVER-stored attempt row, never from client input.
        //
        //     category = 'other': the contract's literal 'pattern' is NOT in
        //     ck_grammar_entries_category_known (migration 001) and would fail the
        //     CHECK; 'other' is that constraint's explicit catch-all and is the
        //     honest value for a drill auto-bank, which has no linguistic category
        //     signal. discovered_via = 'drill' is added to
        //     ck_grammar_entries_discovered_via_known by migration 020 (this
        //     feature). Both columns are CHECK-constrained backstops.
        const entryRes = await client.query<{ id: string }>(
          `INSERT INTO grammar_entries
             (user_id, pattern_key, pattern_display, summary_en, proficiency, category, discovered_via)
           VALUES ($1, $2, $3, $3, 'L3'::proficiency_level, 'other', 'drill')
           ON CONFLICT (user_id, pattern_key)
             DO UPDATE SET version = grammar_entries.version + 1
           RETURNING id::text AS id`,
          [userId, attempt.pattern_key, attempt.pattern_display],
        );
        const grammarEntryId = entryRes.rows[0]!.id;

        // 4c. Resolve-or-create the production card for this pattern. The partial
        //     unique index uq_vocab_cards_user_grammar_production (migration 020)
        //     guarantees at most one such row per (user, pattern); a concurrent
        //     racer that slips past the SELECT would hit a 23505 on the INSERT —
        //     but the scored-once gate in 4a already serializes submits per
        //     attempt, so this is a belt-and-suspenders invariant. Both queries
        //     are user-scoped (IDOR defense).
        const existingCard = await client.query<CardRow>(
          `SELECT id, fsrs_state, stability, difficulty, reps, lapses, version
             FROM vocab_cards
            WHERE user_id = $1
              AND grammar_entry_id = $2
              AND face = 'production'
              AND deleted_at IS NULL
            FOR UPDATE`,
          [userId, grammarEntryId],
        );

        let card: CardRow;
        if (existingCard.rowCount && existingCard.rowCount > 0) {
          card = existingCard.rows[0]!;
        } else {
          const insCard = await client.query<CardRow>(
            `INSERT INTO vocab_cards (user_id, face, grammar_entry_id, proficiency, due_at)
             VALUES ($1, 'production'::card_face, $2, 'L3'::proficiency_level, now())
             RETURNING id, fsrs_state, stability, difficulty, reps, lapses, version`,
            [userId, grammarEntryId],
          );
          card = insCard.rows[0]!;
        }

        // 4d. Compute the next FSRS state from the card's CURRENT state + rating.
        const current: CardFsrs = {
          state: card.fsrs_state,
          stability: Number(card.stability),
          difficulty: Number(card.difficulty),
          reps: card.reps,
          lapses: card.lapses,
        };
        const next = schedule(current, rating);

        // due_at: scheduled_days out, except minute-scale steps (scheduledDays
        // 0): a lapse (again) re-queues <1 min out and a hard learning step
        // ~6 min out, rather than immediately.
        // The policy lives in the shared engine so vocab reviews match exactly.
        const dueAt = new Date(Date.now() + dueDelayMs(next));

        // 4e. Advance the card (mirror vocab.ts review write). Optimistic version
        //     gate: low contention here (same tx, same user, FOR UPDATE row lock
        //     held) but the gate is kept for defense-in-depth and to match the
        //     vocab path's idiom. lapses += 1 only on a lapse.
        const cardUpd = await client.query<{ version: number }>(
          `UPDATE vocab_cards
              SET fsrs_state       = $3::fsrs_state,
                  stability        = $4,
                  difficulty       = $5,
                  elapsed_days     = 0,
                  scheduled_days   = $6,
                  reps             = reps + 1,
                  lapses           = lapses + CASE WHEN $7::fsrs_rating = 'again' THEN 1 ELSE 0 END,
                  last_reviewed_at = now(),
                  due_at           = $8,
                  version          = version + 1
            WHERE id = $1
              AND user_id = $2
              AND version = $9
              AND deleted_at IS NULL`,
          [
            card.id,
            userId,
            next.state,
            next.stability,
            next.difficulty,
            next.scheduledDays,
            rating,
            dueAt,
            card.version,
          ],
        );
        if (cardUpd.rowCount !== 1) {
          // The row was locked FOR UPDATE inside this tx, so the only way the
          // versioned UPDATE misses is a genuine concurrent advance — surface it
          // as a conflict (the whole tx rolls back; the score is not persisted).
          throw new ConflictError('grammar production card version is stale');
        }

        // 4f. Append the immutable review snapshot (before → after + rating).
        await client.query(
          `INSERT INTO card_reviews (
                card_id, user_id, rating,
                state_before, stability_before, difficulty_before, elapsed_days_before,
                state_after, stability_after, difficulty_after, scheduled_days_after,
                duration_ms)
            VALUES ($1,$2,$3::fsrs_rating,
                    $4::fsrs_state,$5,$6,$7,
                    $8::fsrs_state,$9,$10,$11,
                    $12)`,
          [
            card.id,
            userId,
            rating,
            current.state,
            current.stability,
            current.difficulty,
            // First-ever review has no elapsed history; -1 is the never-reviewed
            // sentinel (ck_card_reviews_elapsed_before_min allows >= -1).
            card.reps === 0 ? -1 : 0,
            next.state,
            next.stability,
            next.difficulty,
            next.scheduledDays,
            null,
          ],
        );

        return { dueAt, scheduledDays: next.scheduledDays };
      });

      // 5. Reveal the reference model answer NOW (post-submit) and surface the
      //    derived schedule so the client can show "next review in N days"
      //    (minute-scale when scheduledDays 0: <1 min again / ~6 min hard).
      //    Existing fields are unchanged.
      res.status(200).json({
        score,
        verdict: scored.verdict,
        usesPattern: scored.usesPattern,
        summary: scored.summary,
        corrections: scored.corrections,
        referenceModelKr: item.referenceModelKr,
        referenceModelEn: item.referenceModelEn,
        schedule: {
          rating,
          dueAt: txOut.dueAt.toISOString(),
          scheduledDays: txOut.scheduledDays,
        },
      });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

// ---------------------------------------------------------------------------
// GET /grammar-drill/attempts — paged, user-scoped practice history (F-110)
// ---------------------------------------------------------------------------

const AttemptsQuerySchema = z.object({
  // A personal practice-history feed never needs a huge page; 100 bounds a
  // runaway client the same way the KGIU browse's 400 ceiling bounds ITS
  // (much larger) corpus page. Mirrors the /vocab/entries + /grammar/kgiu
  // limit/offset paging shape.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

interface AttemptHistoryRow {
  id: string;
  pattern_key: string;
  pattern_display: string;
  drill_type: DrillType;
  user_answer: string;
  score: number;
  verdict: DrillVerdict;
  scored_at: Date;
  total: string;
}

router.get(
  '/attempts',
  cheapLimiter(),
  validateQuery(AttemptsQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof AttemptsQuerySchema>;
      }).validatedQuery;
      // SCORED attempts only (`scored_at IS NOT NULL`). Every drill
      // GENERATION writes a row (POST /grammar-drill), including ones the
      // learner Skips without ever submitting — those rows carry NULL
      // answer/score/verdict forever. A "practice history" that included
      // them would be mostly blank noise from skips rather than a record of
      // completed practice, so this mirrors the same exclusion
      // GET /grammar/series already applies to its own average (that
      // route's "unscored attempts never count" comment) — one consistent
      // definition of "counts as practice" across both reads.
      //
      // COUNT(*) OVER () mirrors GET /vocab/entries: the total rides along
      // on every row so the client can page without a second round-trip.
      const { rows } = await query<AttemptHistoryRow>(
        `SELECT id::text AS id, pattern_key, pattern_display, drill_type,
                user_answer, score, verdict, scored_at,
                COUNT(*) OVER ()::text AS total
           FROM grammar_drill_attempts
          WHERE user_id = $1 AND scored_at IS NOT NULL
          ORDER BY scored_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, q.limit, q.offset],
      );
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      // Strip the per-row window total from the attempt DTOs — it's surfaced
      // once at the top level, not repeated on every row.
      const attempts = rows.map(({ total: _total, ...rest }) => ({
        ...rest,
        id: Number(rest.id),
      }));
      res.status(200).json({ attempts, total, limit: q.limit, offset: q.offset });
    } catch (err) {
      next(err);
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
