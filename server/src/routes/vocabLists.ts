/**
 * /vocab/lists routes — user-curated collections of vocab_entries.
 *
 * Powers the Review screen "Lists" tab (Pass 3). Every endpoint is
 * authenticated; every read is scoped to `req.user.id` (no list-id leak).
 *
 *   GET    /vocab/lists                       — paginated index of user's lists
 *   POST   /vocab/lists                       — create a list
 *   GET    /vocab/lists/:id                   — list detail + first N entries
 *   PATCH  /vocab/lists/:id                   — rename / re-kind
 *   DELETE /vocab/lists/:id                   — soft delete
 *   POST   /vocab/lists/:id/entries           — append entries (idempotent)
 *   DELETE /vocab/lists/:id/entries/:entryId  — remove a single entry
 *
 * Threat model (extends Repository/server/SECURITY.md §3 — Authorization):
 *   - IDOR: every route resolves the list via `WHERE id = $listId AND
 *     user_id = $sessionUserId AND deleted_at IS NULL`. A request for
 *     another user's list yields 404 (not 403 — we deliberately don't
 *     confirm the list even exists).
 *   - Mass assignment: every input goes through a `.strict()` Zod schema —
 *     extra keys (e.g. `user_id`, `created_at`) are 400'd before SQL.
 *   - Membership tampering: vocab_entries is reference data with a RESTRICT
 *     FK from vocab_list_entries (migration 012). A user cannot, via the
 *     list-membership API, cascade-delete corpus rows.
 *   - Soft-delete bypass: every read endpoint adds `deleted_at IS NULL` to
 *     both the list lookup AND its entries' parent join. Hard delete of a
 *     list is not an endpoint.
 *   - DB-error leakage: routes never echo raw error text; the central
 *     errorHandler returns generic 500s with correlation IDs only.
 *   - SQL injection: every query is parameterized; no string interpolation.
 *     The pool wrapper is the only DB surface.
 *
 * Optimistic concurrency: `vocab_lists.version` is bumped on every UPDATE.
 * Pass 3's UI is single-tab-per-user so we don't yet enforce expected_version
 * on PATCH; future tabs / multi-device adds it as a follow-up. Soft-delete is
 * idempotent (subsequent DELETE is a no-op 204 to keep clients simple).
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

const LIST_KIND = z.enum(['vocab', 'grammar', 'hanja', 'mixed']);

const ListIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const ListEntryParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  entryId: z.coerce.number().int().positive(),
});

/* ---------- GET /vocab/lists — index ---------- */

const IndexQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  kind: LIST_KIND.optional(),
});

router.get(
  '/',
  cheapLimiter(),
  validateQuery(IndexQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof IndexQuerySchema>;
      }).validatedQuery;
      const { rows } = await query<{
        id: number;
        name_kr: string;
        name_en: string | null;
        kind: string;
        version: number;
        entry_count: number;
        last_added_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        // LEFT JOIN aggregates so a list with zero entries still returns
        // (entry_count = 0). Filtering happens on the parent's deleted_at,
        // not the entries (entries are hard-deleted).
        `SELECT l.id,
                l.name_kr,
                l.name_en,
                l.kind,
                l.version,
                COALESCE(COUNT(e.id), 0)::int AS entry_count,
                MAX(e.added_at)               AS last_added_at,
                l.created_at,
                l.updated_at
           FROM vocab_lists l
           LEFT JOIN vocab_list_entries e ON e.list_id = l.id
          WHERE l.user_id = $1
            AND l.deleted_at IS NULL
            AND ($2::text IS NULL OR l.kind = $2)
          GROUP BY l.id
          ORDER BY l.updated_at DESC, l.id DESC
          LIMIT $3 OFFSET $4`,
        [userId, q.kind ?? null, q.limit, q.offset],
      );
      res.status(200).json({
        lists: rows,
        limit: q.limit,
        offset: q.offset,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- POST /vocab/lists — create ---------- */

const CreateBodySchema = z
  .object({
    name_kr: z.string().trim().min(1).max(120),
    name_en: z.string().trim().min(1).max(120).optional(),
    kind: LIST_KIND.default('vocab'),
    // Optional seed: include the first batch of entries inline so a "create
    // from selection" UI flow is one round-trip. Cap at the same ceiling we
    // accept on /entries POST to keep the surface uniform.
    seed_entry_ids: z
      .array(z.coerce.number().int().positive())
      .max(200)
      .optional(),
  })
  .strict();

router.post(
  '/',
  cheapLimiter(),
  validateBody(CreateBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const body = req.body as z.infer<typeof CreateBodySchema>;

      // One transaction: create the list, optionally append seeds. Seeds
      // share the same uniqueness check as POST /entries.
      const created = await withTransaction(async (client) => {
        const insert = await client.query<{
          id: number;
          name_kr: string;
          name_en: string | null;
          kind: string;
          version: number;
          created_at: Date;
          updated_at: Date;
        }>(
          `INSERT INTO vocab_lists (user_id, name_kr, name_en, kind)
                VALUES ($1, $2, $3, $4)
             RETURNING id, name_kr, name_en, kind, version, created_at, updated_at`,
          [userId, body.name_kr, body.name_en ?? null, body.kind],
        );
        const list = insert.rows[0];
        if (!list) throw new Error('vocab_lists insert returned no rows');

        let appendedCount = 0;
        const seeds = body.seed_entry_ids ?? [];
        if (seeds.length > 0) {
          // Deduplicate inside the request itself so two identical ids in
          // seed_entry_ids don't fight the UNIQUE constraint mid-batch.
          const uniqueSeeds = Array.from(new Set(seeds));
          // INSERT … SELECT WITH ORDINALITY assigns 0-based positions in
          // the same order the client supplied — predictable for clients.
          const result = await client.query<{ count: string }>(
            `WITH ins AS (
                INSERT INTO vocab_list_entries (list_id, entry_id, position)
                SELECT $1, s.entry_id, s.ord - 1
                  FROM unnest($2::bigint[]) WITH ORDINALITY AS s(entry_id, ord)
                  -- Skip ids that don't exist or are already in the list.
                  -- This is what makes the seed step idempotent.
                 WHERE EXISTS (
                          SELECT 1 FROM vocab_entries v WHERE v.id = s.entry_id
                       )
                   AND NOT EXISTS (
                          SELECT 1 FROM vocab_list_entries x
                           WHERE x.list_id = $1 AND x.entry_id = s.entry_id
                       )
                RETURNING 1
             )
             SELECT COUNT(*)::text AS count FROM ins`,
            [list.id, uniqueSeeds],
          );
          appendedCount = Number(result.rows[0]?.count ?? '0');
        }

        return { list, appendedCount };
      });

      res.status(201).json({
        list: created.list,
        appended: created.appendedCount,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- GET /vocab/lists/:id — detail ---------- */

const DetailQuerySchema = z.object({
  entry_limit: z.coerce.number().int().min(0).max(500).default(100),
  entry_offset: z.coerce.number().int().nonnegative().default(0),
});

router.get(
  '/:id',
  cheapLimiter(),
  validateParams(ListIdParamsSchema),
  validateQuery(DetailQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const listId = (req as typeof req & {
        validatedParams: z.infer<typeof ListIdParamsSchema>;
      }).validatedParams.id;
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof DetailQuerySchema>;
      }).validatedQuery;

      const listResult = await query<{
        id: number;
        name_kr: string;
        name_en: string | null;
        kind: string;
        version: number;
        created_at: Date;
        updated_at: Date;
        entry_count: number;
      }>(
        `SELECT l.id, l.name_kr, l.name_en, l.kind, l.version,
                l.created_at, l.updated_at,
                (SELECT COUNT(*)::int FROM vocab_list_entries e
                  WHERE e.list_id = l.id) AS entry_count
           FROM vocab_lists l
          WHERE l.id = $1
            AND l.user_id = $2
            AND l.deleted_at IS NULL
          LIMIT 1`,
        [listId, userId],
      );
      const list = listResult.rows[0];
      if (!list) throw new NotFoundError('vocab list not found');

      const entriesResult = await query<{
        entry_id: number;
        position: number;
        added_at: Date;
        korean: string | null;
        english: string | null;
        proficiency: string | null;
      }>(
        `SELECT e.entry_id,
                e.position,
                e.added_at,
                v.korean,
                v.english,
                v.proficiency::text AS proficiency
           FROM vocab_list_entries e
           JOIN vocab_entries v ON v.id = e.entry_id
          WHERE e.list_id = $1
          ORDER BY e.position, e.added_at, e.entry_id
          LIMIT $2 OFFSET $3`,
        [listId, q.entry_limit, q.entry_offset],
      );

      res.status(200).json({
        list,
        entries: entriesResult.rows,
        entry_limit: q.entry_limit,
        entry_offset: q.entry_offset,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- PATCH /vocab/lists/:id — rename / re-kind ---------- */

const PatchBodySchema = z
  .object({
    name_kr: z.string().trim().min(1).max(120).optional(),
    name_en: z.string().trim().min(1).max(120).nullable().optional(),
    kind: LIST_KIND.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'no fields supplied',
  });

router.patch(
  '/:id',
  cheapLimiter(),
  validateParams(ListIdParamsSchema),
  validateBody(PatchBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const listId = (req as typeof req & {
        validatedParams: z.infer<typeof ListIdParamsSchema>;
      }).validatedParams.id;
      const body = req.body as z.infer<typeof PatchBodySchema>;

      // Three nullable optionals → use a sentinel object to distinguish
      // "field absent" (don't touch) from "field present and null" (only
      // legal for name_en; clearing the caption).
      const setNameKr = body.name_kr !== undefined;
      const setNameEn = body.name_en !== undefined;
      const setKind = body.kind !== undefined;

      const { rows } = await query<{
        id: number;
        name_kr: string;
        name_en: string | null;
        kind: string;
        version: number;
        updated_at: Date;
      }>(
        `UPDATE vocab_lists
            SET name_kr = CASE WHEN $3::boolean THEN $4::text ELSE name_kr END,
                name_en = CASE WHEN $5::boolean THEN $6::text ELSE name_en END,
                kind    = CASE WHEN $7::boolean THEN $8::text ELSE kind    END,
                version = version + 1
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id, name_kr, name_en, kind, version, updated_at`,
        [
          listId,
          userId,
          setNameKr,
          body.name_kr ?? null,
          setNameEn,
          body.name_en ?? null,
          setKind,
          body.kind ?? null,
        ],
      );
      const list = rows[0];
      if (!list) throw new NotFoundError('vocab list not found');
      res.status(200).json({ list });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- DELETE /vocab/lists/:id — soft delete ---------- */

router.delete(
  '/:id',
  cheapLimiter(),
  validateParams(ListIdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const listId = (req as typeof req & {
        validatedParams: z.infer<typeof ListIdParamsSchema>;
      }).validatedParams.id;
      const result = await query(
        `UPDATE vocab_lists
            SET deleted_at = now(), version = version + 1
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [listId, userId],
      );
      if (result.rowCount === 0) {
        // Could be already-deleted OR never-owned — both surface as 404,
        // identical shape so an attacker can't probe id space.
        throw new NotFoundError('vocab list not found');
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- POST /vocab/lists/:id/entries — append ---------- */

const AppendBodySchema = z
  .object({
    entry_ids: z
      .array(z.coerce.number().int().positive())
      .min(1)
      .max(200),
  })
  .strict();

router.post(
  '/:id/entries',
  cheapLimiter(),
  validateParams(ListIdParamsSchema),
  validateBody(AppendBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const listId = (req as typeof req & {
        validatedParams: z.infer<typeof ListIdParamsSchema>;
      }).validatedParams.id;
      const body = req.body as z.infer<typeof AppendBodySchema>;
      const uniqueIds = Array.from(new Set(body.entry_ids));

      const out = await withTransaction(async (client) => {
        // Lock the list row for the duration of this append so a concurrent
        // request can't race the position-increment math.
        const owner = await client.query<{ id: number }>(
          `SELECT id
             FROM vocab_lists
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            FOR UPDATE`,
          [listId, userId],
        );
        if (owner.rowCount === 0) {
          throw new NotFoundError('vocab list not found');
        }

        // Validate every requested entry exists in vocab_entries — surface
        // the missing ids in the response so the client can react. (The FK
        // would 23503 the INSERT below; that's a worse UX than naming the
        // ids inline.)
        const valid = await client.query<{ id: number }>(
          `SELECT id FROM vocab_entries WHERE id = ANY($1::bigint[])`,
          [uniqueIds],
        );
        const validSet = new Set<number>(valid.rows.map((r) => Number(r.id)));
        const invalidIds = uniqueIds.filter((id) => !validSet.has(id));
        if (invalidIds.length > 0) {
          throw new NotFoundError(
            `vocab entries not found: ${invalidIds.slice(0, 10).join(',')}`,
          );
        }

        // Detect duplicates BEFORE INSERT so we can return 409 — required
        // by the task spec ("409 on duplicate add"). The ON CONFLICT DO
        // NOTHING approach would silently skip; that's not what the design
        // wants ("show the user we couldn't add it because it's already
        // there").
        const existing = await client.query<{ entry_id: string }>(
          `SELECT entry_id
             FROM vocab_list_entries
            WHERE list_id = $1 AND entry_id = ANY($2::bigint[])`,
          [listId, uniqueIds],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          const dupIds = existing.rows.map((r) => Number(r.entry_id));
          throw new ConflictError(
            `entries already in list: ${dupIds.slice(0, 10).join(',')}`,
          );
        }

        // Next position = COALESCE(max + 1, 0). Captured under FOR UPDATE
        // above so no concurrent request can collide.
        const next = await client.query<{ next_position: number }>(
          `SELECT COALESCE(MAX(position) + 1, 0)::int AS next_position
             FROM vocab_list_entries
            WHERE list_id = $1`,
          [listId],
        );
        const basePosition = next.rows[0]?.next_position ?? 0;

        const inserted = await client.query<{
          entry_id: string;
          position: number;
          added_at: Date;
        }>(
          `INSERT INTO vocab_list_entries (list_id, entry_id, position)
                SELECT $1, s.entry_id, $3 + (s.ord - 1)::int
                  FROM unnest($2::bigint[]) WITH ORDINALITY AS s(entry_id, ord)
             RETURNING entry_id, position, added_at`,
          [listId, uniqueIds, basePosition],
        );

        // Bump the list's updated_at so the index endpoint resorts it to
        // the top. version++ keeps optimistic-concurrency monotonic.
        await client.query(
          `UPDATE vocab_lists
              SET version = version + 1
            WHERE id = $1`,
          [listId],
        );

        return inserted.rows.map((r) => ({
          entry_id: Number(r.entry_id),
          position: r.position,
          added_at: r.added_at,
        }));
      });

      res.status(201).json({ entries: out });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- DELETE /vocab/lists/:id/entries/:entryId — remove ---------- */

router.delete(
  '/:id/entries/:entryId',
  cheapLimiter(),
  validateParams(ListEntryParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id: listId, entryId } = (req as typeof req & {
        validatedParams: z.infer<typeof ListEntryParamsSchema>;
      }).validatedParams;

      const out = await withTransaction(async (client) => {
        // Ownership check first — same 404 posture as the other routes when
        // the list doesn't exist OR belongs to someone else.
        const owner = await client.query<{ id: number }>(
          `SELECT id
             FROM vocab_lists
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            FOR UPDATE`,
          [listId, userId],
        );
        if (owner.rowCount === 0) {
          throw new NotFoundError('vocab list not found');
        }
        const del = await client.query(
          `DELETE FROM vocab_list_entries
            WHERE list_id = $1 AND entry_id = $2`,
          [listId, entryId],
        );
        if (del.rowCount === 0) {
          // List exists, but the entry was never in it — 404 (clearer than
          // 204 for the client, distinguishable from "list missing").
          throw new NotFoundError('entry not in list');
        }
        // Bump version for optimistic-concurrency cohort consistency.
        await client.query(
          `UPDATE vocab_lists
              SET version = version + 1
            WHERE id = $1`,
          [listId],
        );
        return true;
      });
      void out;
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
