/**
 * GET /define?word=… — KRDICT lookup.
 *
 * Queries the KRDICT tables owned by B2 (migration 003). We treat their
 * table names as a stable interface; if B2 renames anything, we update
 * the queries here, not the rest of the codebase.
 *
 * Auth: required. Rate limit: cheap (DB lookup, no upstream cost).
 *
 * If the KRDICT tables don't exist yet (B2 hasn't shipped), we return a
 * clear "not configured" 503 instead of a 500.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';

const router = Router();

const DefineQuerySchema = z.object({
  word: z.string().min(1).max(64),
});

interface KrdictRow {
  id: number;
  headword: string;
  part_of_speech: string | null;
  // First-sense definitions are denormalized onto krdict_entries (ADR-015 §D5);
  // the multi-sense / example rows live in the krdict_senses / krdict_examples
  // tables, not as jsonb columns here.
  definition_korean: string | null;
  definition_english: string | null;
}

/**
 * Cache the existence check with a TTL so we don't probe `information_schema`
 * on every request, BUT also so a freshly-deployed B2 (migration 003 just
 * applied) becomes visible WITHOUT a server restart. The previous version
 * memoized once-forever and required an operator restart. See REVIEW_B3 SF5.
 *
 * 5 minutes is the right ballpark: short enough that "we just ran the
 * migration" doesn't need ops to restart anything, long enough that a busy
 * tap-a-word session isn't hammering information_schema.
 *
 * Cache symmetry on rollback (FU-NF-5): the cache is also marked
 * ``ready=false`` if a query against ``krdict_entries`` raises Postgres
 * error 42P01 (undefined_table). Without that, a migration-003 rollback
 * during the 5-minute TTL produces a stream of 500s instead of degrading
 * to a clean 503. The FIRST request after the rollback still observes 500
 * (the cache was already primed and the route attempted the SELECT) —
 * subsequent requests within the window now return 503.
 */
const KRDICT_READY_TTL_MS = 5 * 60 * 1000;
const PG_UNDEFINED_TABLE = '42P01';
let _krdictReady: { ready: boolean; checkedAt: number } | null = null;

/**
 * Whether the KRDICT tables (migration 003) are present. Memoized with a TTL —
 * see the block comment above. Exported so the sibling /krdict/search route
 * reuses the SAME availability cache (one information_schema probe budget, one
 * rollback-invalidation path) instead of duplicating it.
 */
export async function krdictAvailable(): Promise<boolean> {
  const now = Date.now();
  if (_krdictReady && now - _krdictReady.checkedAt < KRDICT_READY_TTL_MS) {
    return _krdictReady.ready;
  }
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'krdict_entries'
     ) AS exists`,
  );
  const ready = rows[0]?.exists === true;
  _krdictReady = { ready, checkedAt: now };
  return ready;
}

export function resetKrdictReadyCache(): void {
  _krdictReady = null;
}

/**
 * Mark the cache as ``not ready`` immediately — used when a query against
 * the krdict tables fails with Postgres error 42P01 (undefined_table),
 * which means the table was dropped (e.g. migration 003 rolled back)
 * after the cache memoized ``ready=true``. Without this, the cache would
 * keep returning ``true`` until the TTL expired and every request would
 * 500. Marking ``ready=false`` lets the next request degrade cleanly to
 * 503 ``krdict_unavailable``.
 */
export function markKrdictUnavailable(): void {
  _krdictReady = { ready: false, checkedAt: Date.now() };
}

/** Best-effort detection of "undefined_table" from a pg query error. */
export function isUndefinedTableError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  );
}

router.get(
  '/',
  requireAuth,
  cheapLimiter(),
  validateQuery(DefineQuerySchema),
  async (req, res, next) => {
    try {
      const word = (
        req as typeof req & { validatedQuery: z.infer<typeof DefineQuerySchema> }
      ).validatedQuery.word;

      if (!(await krdictAvailable())) {
        // B2 hasn't shipped yet. Return an honest 503 rather than 500.
        res.status(503).json({
          error: {
            code: 'krdict_unavailable',
            message: 'KRDICT tables are not present. Run migration 003 (B2).',
          },
          correlationId: req.correlationId,
        });
        return;
      }

      let rows: KrdictRow[];
      try {
        const result = await query<KrdictRow>(
          `SELECT id, headword, part_of_speech, definition_korean, definition_english
             FROM krdict_entries
            WHERE headword = $1
            ORDER BY id ASC
            LIMIT 10`,
          [word],
        );
        rows = result.rows;
      } catch (err) {
        // Cache symmetry on rollback (FU-NF-5): if the krdict tables have
        // been dropped underneath the availability cache, mark the cache
        // ``not ready`` so subsequent requests within the TTL window
        // degrade cleanly to 503 instead of all 500ing. We still rethrow
        // here so this first request surfaces as a 500 — the cache fix
        // takes effect on the NEXT request.
        if (isUndefinedTableError(err)) {
          markKrdictUnavailable();
        }
        throw err;
      }
      if (rows.length === 0) {
        // Keep the message constant — echoing the raw input back in error
        // strings is unhelpful for log triage and slightly preferable not
        // to do. The actual query word is available in the correlation
        // log already.
        throw new NotFoundError('no dictionary entry for requested word');
      }
      // pg returns BIGINT columns as strings to avoid silent precision loss.
      // The /define DTO documents `id` as a JSON number, so coerce here. KRDICT
      // entry ids are well within Number.MAX_SAFE_INTEGER (a few hundred k rows).
      const entries = rows.map((r) => ({ ...r, id: Number(r.id) }));
      res.status(200).json({ word, entries });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
