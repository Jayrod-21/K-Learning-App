/**
 * GET /krdict/search?q=&limit=&offset= — paginated KRDICT dictionary search.
 *
 * The Resources "Dictionary" tab is search-first over the full 53,978-row
 * KRDICT corpus (migration 003) — too large to scroll, so the client always
 * supplies a query and pages the results with `offset` + the `total` count.
 *
 * Match model — "headword first, definitions as fallback":
 *   - A row matches when its `headword` starts with the term (prefix), OR the
 *     term appears as a substring of the Korean or English definition. Prefix
 *     on headword is the primary intent ("type 먹 → 먹다, 먹이, …"); the
 *     definition fallback lets an English-only searcher find a word by gloss
 *     ("type eat → 먹다"). Ranking puts headword-prefix matches first.
 *   - Metacharacters in the term are escaped (escapeLikePattern) so `%`/`_`
 *     match literally and an all-wildcard term can't scan the whole table.
 *
 * Sits alongside GET /define (exact-headword tap lookup). Both share the SAME
 * availability cache (krdictAvailable) so there is one information_schema probe
 * budget and one migration-003-rollback degradation path — if the tables aren't
 * present we return an honest 503, not a 500. Read-only, auth-required, cheap
 * limiter; the only SQL inputs are bound parameters.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { escapeLikePattern } from '../db/like.js';
import {
  krdictAvailable,
  markKrdictUnavailable,
  isUndefinedTableError,
} from './define.js';

const router = Router();
router.use(requireAuth);

const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

interface KrdictSearchRow {
  id: number;
  headword: string;
  part_of_speech: string | null;
  definition_korean: string | null;
  definition_english: string | null;
  total: string;
}

router.get(
  '/search',
  cheapLimiter(),
  validateQuery(SearchQuerySchema),
  async (req, res, next) => {
    try {
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof SearchQuerySchema> }
      ).validatedQuery;

      if (!(await krdictAvailable())) {
        // Migration 003 not applied — honest 503 rather than a 500 (mirrors
        // GET /define exactly).
        res.status(503).json({
          error: {
            code: 'krdict_unavailable',
            message: 'KRDICT tables are not present. Run migration 003 (B2).',
          },
          correlationId: req.correlationId,
        });
        return;
      }

      // Two operands from one term: a prefix pattern (`term%`) for the headword
      // and a substring pattern (`%term%`) for the definition fallback. Both are
      // escaped then bound as parameters — no interpolation of user input.
      const escaped = escapeLikePattern(q.q);
      const prefixPattern = `${escaped}%`;
      const substringPattern = `%${escaped}%`;

      let rows: KrdictSearchRow[];
      try {
        const result = await query<KrdictSearchRow>(
          // ORDER BY puts headword-prefix matches ahead of definition-only
          // matches, then by id for a stable page. COUNT(*) OVER () carries the
          // total matching count so the client paginates in one round-trip.
          `SELECT id, headword, part_of_speech,
                  definition_korean, definition_english,
                  COUNT(*) OVER ()::text AS total
             FROM krdict_entries
            WHERE headword           ILIKE $1 ESCAPE '\\'
               OR definition_korean  ILIKE $2 ESCAPE '\\'
               OR definition_english ILIKE $2 ESCAPE '\\'
            ORDER BY (headword ILIKE $1 ESCAPE '\\') DESC, id ASC
            LIMIT $3 OFFSET $4`,
          [prefixPattern, substringPattern, q.limit, q.offset],
        );
        rows = result.rows;
      } catch (err) {
        // Cache symmetry on rollback (FU-NF-5): if the krdict tables were
        // dropped underneath the availability cache, mark it not-ready so the
        // NEXT request degrades cleanly to 503. This first request still
        // surfaces as 500 (we rethrow).
        if (isUndefinedTableError(err)) {
          markKrdictUnavailable();
        }
        throw err;
      }

      // COUNT(*) OVER () is identical on every row; an empty page (no matches,
      // or offset past the end) yields no rows → total 0.
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      // pg returns BIGINT (id) as a string; the DTO documents id as a JSON
      // number. KRDICT ids are well within Number.MAX_SAFE_INTEGER. The per-row
      // window `total` is surfaced once at the top level, not on each entry.
      const entries = rows.map(({ total: _total, ...rest }) => ({
        ...rest,
        id: Number(rest.id),
      }));

      res.status(200).json({ q: q.q, entries, total, limit: q.limit, offset: q.offset });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
