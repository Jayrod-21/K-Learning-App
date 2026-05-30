/**
 * /grammar routes — user grammar bank + KGIU corpus search.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';

const router = Router();
router.use(requireAuth);

/* ---------- KGIU corpus (read-only) ---------- */

const KgiuSearchQuerySchema = z.object({
  q: z.string().min(1).max(64).optional(),
  corpus: z
    .enum(['kgiu_beginner', 'kgiu_intermediate', 'kgiu_advanced'])
    .optional(),
  proficiency: z.enum(['basic', 'L3', 'L4', 'L5+']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

router.get(
  '/kgiu',
  cheapLimiter(),
  validateQuery(KgiuSearchQuerySchema),
  async (req, res, next) => {
    try {
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof KgiuSearchQuerySchema>;
      }).validatedQuery;
      const { rows } = await query(
        `SELECT id, corpus, source_id, pattern, title_en, category, proficiency,
                unit, source_pages
           FROM kgiu_entries
          WHERE entry_type = 'grammar'
            AND ($1::corpus IS NULL OR corpus = $1::corpus)
            AND ($2::proficiency_level IS NULL OR proficiency = $2::proficiency_level)
            AND ($3::text IS NULL OR pattern = $3)
          ORDER BY id
          LIMIT $4 OFFSET $5`,
        [q.corpus ?? null, q.proficiency ?? null, q.q ?? null, q.limit, q.offset],
      );
      res.status(200).json({ entries: rows });
    } catch (err) {
      next(err);
    }
  },
);

const KgiuIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

router.get(
  '/kgiu/:id',
  cheapLimiter(),
  validateParams(KgiuIdParamsSchema),
  async (req, res, next) => {
    try {
      const id = (req as typeof req & {
        validatedParams: z.infer<typeof KgiuIdParamsSchema>;
      }).validatedParams.id;
      const { rows } = await query(
        `SELECT id, corpus, source_id, pattern, title_en, category, proficiency,
                explanation, formation_rules, examples, dialogues, vocabulary,
                tips, compare_with, exercises, cultural_notes, source_pages
           FROM kgiu_entries
          WHERE id = $1
          LIMIT 1`,
        [id],
      );
      if (rows.length === 0) throw new NotFoundError('kgiu entry not found');
      res.status(200).json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- User grammar bank ---------- */

const BankBodySchema = z.object({
  pattern_key: z.string().regex(/^GR-[a-z0-9_-]{1,64}$/),
  pattern_display: z.string().min(1).max(120),
  summary_en: z.string().min(1).max(240),
  proficiency: z.enum(['basic', 'L3', 'L4', 'L5+']),
  category: z.string().min(1).max(40),
  register: z
    .enum(['반말', '해요체', '합쇼체', '문어체', '하오체', '하게체'])
    .optional(),
  discovered_via: z
    .enum([
      'manual',
      'reading_highlight',
      'listening_highlight',
      'topik_item',
      'diagnostic',
      'conversation',
      'import',
    ])
    .default('manual'),
  notes: z.record(z.string(), z.unknown()).default({}),
});

router.post('/bank', cheapLimiter(), validateBody(BankBodySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof BankBodySchema>;
    const userId = getUserId(req);
    const { rows } = await query<{ id: number }>(
      `INSERT INTO grammar_entries (
          user_id, pattern_key, pattern_display, summary_en,
          proficiency, category, register, notes, discovered_via)
       VALUES ($1,$2,$3,$4,$5::proficiency_level,$6,$7::register_level,$8::jsonb,$9)
       ON CONFLICT (user_id, pattern_key)
         DO UPDATE SET pattern_display = EXCLUDED.pattern_display,
                       summary_en     = EXCLUDED.summary_en,
                       proficiency    = EXCLUDED.proficiency,
                       category       = EXCLUDED.category,
                       register       = EXCLUDED.register,
                       notes          = EXCLUDED.notes,
                       version        = grammar_entries.version + 1
       RETURNING id`,
      [
        userId,
        body.pattern_key,
        body.pattern_display,
        body.summary_en,
        body.proficiency,
        body.category,
        body.register ?? null,
        JSON.stringify(body.notes),
        body.discovered_via,
      ],
    );
    res.status(201).json({ id: rows[0]!.id });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      next(new ConflictError('grammar entry conflict'));
      return;
    }
    next(err);
  }
});

router.get('/bank', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query(
      `SELECT id, pattern_key, pattern_display, summary_en, proficiency,
              category, register, discovered_via, created_at
         FROM grammar_entries
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [userId],
    );
    res.status(200).json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

/* ---------- AI-assisted highlight → pattern identification ---------- */

const IdentifySchema = z.object({
  highlightSpan: z.string().min(1).max(120),
  fullSentence: z.string().min(1).max(2_000),
  contextHint: z.string().max(500).optional(),
});

/**
 * POST /grammar/identify — pattern recognition via B4. The "drag-to-highlight"
 * flow from DESIGN_SPEC: send span + sentence, get back a canonical pattern
 * mapping that the client can bank.
 */
router.post(
  '/identify',
  expensiveLimiter(),
  validateBody(IdentifySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof IdentifySchema>;
      const proxy = getClaudeProxy();
      const out = await proxy.recognizeGrammarPattern(body, {
        requestId: req.correlationId,
        userId: req.user?.id ?? null,
      });
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
