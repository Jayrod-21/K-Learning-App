/**
 * /reading routes — TTMIK/Iyagi/TOPIK source content (read-only).
 *
 * Reading passages and lesson/episode bodies come from the corpus tables
 * (migration 004). User-state writes go through dedicated endpoints (study log).
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

const ListQuerySchema = z.object({
  corpus: z.enum(['ttmik', 'iyagi']),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

router.get(
  '/units',
  cheapLimiter(),
  validateQuery(ListQuerySchema),
  async (req, res, next) => {
    try {
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof ListQuerySchema>;
      }).validatedQuery;
      if (q.corpus === 'ttmik') {
        const { rows } = await query(
          `SELECT id, lesson_level, lesson_number, title
             FROM ttmik_lessons
            ORDER BY lesson_level, lesson_number
            LIMIT $1 OFFSET $2`,
          [q.limit, q.offset],
        );
        res.status(200).json({ units: rows });
        return;
      }
      const { rows } = await query(
        `SELECT id, episode_number, title, hosts
           FROM iyagi_episodes
          ORDER BY episode_number
          LIMIT $1 OFFSET $2`,
        [q.limit, q.offset],
      );
      res.status(200).json({ units: rows });
    } catch (err) {
      next(err);
    }
  },
);

const UnitParamsSchema = z.object({
  corpus: z.enum(['ttmik', 'iyagi']),
  unitId: z.coerce.number().int().positive(),
});

router.get(
  '/units/:corpus/:unitId/sentences',
  cheapLimiter(),
  validateParams(UnitParamsSchema),
  async (req, res, next) => {
    try {
      const p = (req as typeof req & {
        validatedParams: z.infer<typeof UnitParamsSchema>;
      }).validatedParams;
      if (p.corpus === 'ttmik') {
        const { rows } = await query(
          `SELECT id, ordinal, korean, english, romanization, speaker, is_dialog
             FROM ttmik_sentences
            WHERE lesson_id = $1
            ORDER BY ordinal`,
          [p.unitId],
        );
        if (rows.length === 0) throw new NotFoundError('lesson not found or empty');
        res.status(200).json({ corpus: 'ttmik', unit_id: p.unitId, sentences: rows });
        return;
      }
      const { rows } = await query(
        `SELECT id, ordinal, korean, english, romanization, speaker, is_dialog
           FROM iyagi_sentences
          WHERE episode_id = $1
          ORDER BY ordinal`,
        [p.unitId],
      );
      if (rows.length === 0) throw new NotFoundError('episode not found or empty');
      res.status(200).json({ corpus: 'iyagi', unit_id: p.unitId, sentences: rows });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
