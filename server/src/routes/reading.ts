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

/**
 * A reading-unit row as the corpus queries project it. The window
 * `total` rides on every row (TEXT, since pg returns BIGINT) and is
 * stripped before the unit reaches the client. Corpus-specific columns
 * are optional because one row shape serves both queries.
 */
interface UnitRow {
  id: number;
  title: string;
  total: string;
  lesson_level?: number;
  lesson_number?: number;
  episode_number?: number;
  hosts?: string[];
}

/**
 * Build the `/reading/units` envelope: lift the window `total` to the top
 * level (once, not per-row) and strip it off each unit so the client DTO
 * carries only unit metadata. An empty page yields total 0 — the picker
 * then shows a single empty page rather than an undefined count.
 */
function unitsEnvelope(corpus: 'ttmik' | 'iyagi', rows: UnitRow[]) {
  const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
  const units = rows.map(({ total: _total, ...unit }) => unit);
  return { corpus, total, units };
}

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
      // `COUNT(*) OVER ()::text AS total` carries the full corpus size on
      // every row so the picker paginates in one round-trip — the same
      // window-count idiom the vocab/krdict browse routes use. The count is
      // a TEXT cast (pg returns BIGINT) and stripped from each unit below;
      // an empty page (offset past the end) yields no rows → total 0.
      if (q.corpus === 'ttmik') {
        const { rows } = await query<UnitRow>(
          `SELECT id, lesson_level, lesson_number, title,
                  COUNT(*) OVER ()::text AS total
             FROM ttmik_lessons
            ORDER BY lesson_level, lesson_number
            LIMIT $1 OFFSET $2`,
          [q.limit, q.offset],
        );
        res.status(200).json(unitsEnvelope('ttmik', rows));
        return;
      }
      const { rows } = await query<UnitRow>(
        `SELECT id, episode_number, title, hosts,
                COUNT(*) OVER ()::text AS total
           FROM iyagi_episodes
          ORDER BY episode_number
          LIMIT $1 OFFSET $2`,
        [q.limit, q.offset],
      );
      res.status(200).json(unitsEnvelope('iyagi', rows));
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
