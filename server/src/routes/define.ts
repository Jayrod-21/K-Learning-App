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
import { getUserId, requireAuth } from '../middleware/auth.js';
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
  /**
   * Phase 2.8 gloss overlay: true when `definition_english` above is the
   * CALLER'S OWN `user_gloss_overrides` row rather than the shared corpus
   * default — WordPopover's "Edit definition" affordance uses this to
   * decide whether to offer Reset. Computed server-side
   * (`ugo.gloss IS NOT NULL`); never a client-supplied flag.
   */
  overridden: boolean;
}

/** One example sentence as the wire DTO carries it. */
interface DefineExample {
  korean: string;
  english: string | null;
}

/** Example row as the batched lookup projects it (entry_id is a BIGINT
 *  IDENTITY → the int8 parser returns a number). */
interface KrdictExampleRow {
  entry_id: number;
  korean: string;
  english: string | null;
}

/**
 * Max example sentences returned per entry. The popover shows one primary
 * example plus a short drawer; KRDICT can carry dozens per headword and the
 * client has no way to page them, so cap at the source.
 */
const EXAMPLES_PER_ENTRY = 5;

/**
 * Batched example lookup for a set of entry ids: krdict_examples hangs off
 * krdict_senses, so join through and keep sense/example order. One query for
 * the whole entry page (no per-entry N+1); ROW_NUMBER caps each entry at
 * EXAMPLES_PER_ENTRY.
 *
 * Degrades gracefully: a half-rolled-back migration 003 (entries present but
 * senses/examples dropped) yields entries WITHOUT examples rather than
 * failing the whole lookup — examples are additive enrichment on the
 * definition. Any other DB error still propagates (fail loud).
 */
async function fetchExamplesByEntry(
  entryIds: number[],
): Promise<Map<number, DefineExample[]>> {
  const byEntry = new Map<number, DefineExample[]>();
  if (entryIds.length === 0) return byEntry;
  try {
    const { rows } = await query<KrdictExampleRow>(
      `SELECT entry_id, korean, english
         FROM (
           SELECT s.krdict_entry_id AS entry_id, e.korean, e.english,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.krdict_entry_id
                    ORDER BY s.sense_index, e.example_index
                  ) AS rn
             FROM krdict_examples e
             JOIN krdict_senses s ON s.id = e.krdict_sense_id
            WHERE s.krdict_entry_id = ANY($1::bigint[])
         ) ranked
        WHERE rn <= $2
        ORDER BY entry_id, rn`,
      [entryIds, EXAMPLES_PER_ENTRY],
    );
    for (const row of rows) {
      const id = Number(row.entry_id);
      const list = byEntry.get(id);
      const example: DefineExample = { korean: row.korean, english: row.english };
      if (list) list.push(example);
      else byEntry.set(id, [example]);
    }
  } catch (err) {
    if (!isUndefinedTableError(err)) throw err;
  }
  return byEntry;
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
  // F-UP-018 (rate-limit ordering): the per-IP cheap limiter runs BEFORE
  // requireAuth so an unauthenticated flood (each request = a session-table
  // lookup when a cookie is presented) is rate-limited too. Keying is per-IP
  // either way (`ipKey`), so authed behavior is unchanged.
  cheapLimiter(),
  requireAuth,
  validateQuery(DefineQuerySchema),
  async (req, res, next) => {
    try {
      const word = (
        req as typeof req & { validatedQuery: z.infer<typeof DefineQuerySchema> }
      ).validatedQuery.word;
      // Phase 2.8 gloss overlay — this route runs requireAuth (above) before
      // the handler, so req.user is always populated here.
      const userId = getUserId(req);

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
        // Phase 2.8 gloss overlay: LEFT JOIN the caller's own override on
        // (user_id, lemma=headword) — the SAME headword the entry itself
        // carries (already NFC at rest, per the corpus-normalization audit
        // behind this feature), so no per-row normalization is needed here.
        // This is the "tap anything" surface the WordPopover edit
        // affordance targets: `definition_english` is COALESCEd (override
        // wins) and `overridden` tells the client whether Reset should show.
        const result = await query<KrdictRow>(
          `SELECT ke.id, ke.headword, ke.part_of_speech, ke.definition_korean,
                  COALESCE(ugo.gloss, ke.definition_english) AS definition_english,
                  (ugo.gloss IS NOT NULL) AS overridden
             FROM krdict_entries ke
             LEFT JOIN user_gloss_overrides ugo
                    ON ugo.user_id = $2 AND ugo.lemma = ke.headword
            WHERE ke.headword = $1
            ORDER BY ke.id ASC
            LIMIT 10`,
          [word, userId],
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
      // BIGINT ids arrive as safe-integer numbers via the int8 parser
      // (db/pool.ts); Number() is an identity op kept as the DTO-boundary
      // normalization (the /define DTO documents `id` as a JSON number).
      //
      // Examples ride each entry (B-002): the popover's primary example +
      // "More examples" drawer come from krdict_examples, which the previous
      // version never queried — so the client structurally could not show one.
      // An entry with no loaded examples carries an empty array (B-011: the
      // KRDICT example tables may be present but unloaded).
      const ids = rows.map((r) => Number(r.id));
      const examplesByEntry = await fetchExamplesByEntry(ids);
      const entries = rows.map((r) => {
        const id = Number(r.id);
        return { ...r, id, examples: examplesByEntry.get(id) ?? [] };
      });
      res.status(200).json({ word, entries });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
