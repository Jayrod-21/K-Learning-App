/**
 * /vocab/lists routes — user-curated collections of vocab words, grammar
 * patterns, and hanja characters (migration 049 — F-048/F-060/F-061,
 * supersedes B-013).
 *
 * Powers the Review screen "Lists" tab (Pass 3) and the lists-first
 * flashcards landing (F-060). Every endpoint is authenticated; every read is
 * scoped to `req.user.id` (no list-id leak).
 *
 *   GET    /vocab/lists                       — paginated index of user's lists
 *   POST   /vocab/lists                       — create a list (optional vocab seed)
 *   GET    /vocab/lists/:id                   — list detail + first N items,
 *                                               each joined to its target entity
 *   PATCH  /vocab/lists/:id                   — rename / re-kind
 *   DELETE /vocab/lists/:id                   — soft delete
 *   POST   /vocab/lists/:id/entries           — append items; body is EITHER
 *                                               `entry_ids` (legacy, vocab) OR
 *                                               `items: [{type, id}]` where type
 *                                               ∈ vocab|grammar|hanja
 *   DELETE /vocab/lists/:id/entries/:entryId  — remove one item; `?type=`
 *                                               selects the target type
 *                                               (default vocab, back-compat)
 *
 * Membership model (migration 049): `vocab_list_entries` carries a target XOR
 * — exactly one of entry_id / kgiu_entry_id / hanja_character_id is set per
 * row (mirrors the vocab_cards pattern; the vocab column keeps its 012 name
 * `entry_id` — 049 is an add-only expand, see the migration header).
 * Per-target uniqueness (the 012 UNIQUE for vocab, partial UNIQUE indexes for
 * grammar/hanja) makes a duplicate add a 409. `vocab_lists.kind` stays an advisory
 * display hint — the API does not force memberships to match it (a 'vocab'
 * list may hold the odd hanja; 'mixed' exists for deliberate cross-track
 * lists).
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
 *     list-membership API, cascade-delete corpus rows. The grammar/hanja FKs
 *     (049) are CASCADE, but they point AT reference tables — a membership
 *     write can never delete a kgiu_entries / hanja_characters row.
 *   - Type confusion: the item `type` is a closed Zod enum mapped to a fixed
 *     column name server-side — the client can never name a column. Target
 *     ids are validated against the RIGHT table before insert, so a grammar
 *     id can't be smuggled into the vocab column (and vice versa).
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
import { sourceUploadFenceSql } from '../db/corpusFences.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

const LIST_KIND = z.enum(['vocab', 'grammar', 'hanja', 'mixed']);

/** Item target types a list can hold (migration 049 XOR columns). */
const ITEM_TYPE = z.enum(['vocab', 'grammar', 'hanja']);
type ItemType = z.infer<typeof ITEM_TYPE>;

/**
 * type → vocab_list_entries target column. Server-owned map — the client
 * selects a KEY of this object via the closed ITEM_TYPE enum; it can never
 * supply a column name (threat model §type confusion).
 */
const TARGET_COLUMN: Record<ItemType, string> = {
  vocab: 'entry_id', // 012's name, kept by 049 (add-only expand — no rename)
  grammar: 'kgiu_entry_id',
  hanja: 'hanja_character_id',
};

/** type → referenced table for existence validation. Server-owned. */
const TARGET_TABLE: Record<ItemType, string> = {
  vocab: 'vocab_entries',
  grammar: 'kgiu_entries',
  hanja: 'hanja_characters',
};

// Ids (and OFFSETs) bind to BIGINT/int8 in pg. Without an upper bound,
// `Number.isInteger(1e20)` is true, so a 20-digit id passes Zod and overflows
// in pg (22003 → 500) where the contract everywhere else is 400/404 for a
// garbage id (routes sweep #3). MAX_SAFE_INTEGER is the largest value a JS
// number can even represent faithfully, and is far below the int8 max.
const MAX_ID = Number.MAX_SAFE_INTEGER;

const ListIdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
});

const ListEntryParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
  entryId: z.coerce.number().int().positive().max(MAX_ID),
});

/* ---------- GET /vocab/lists — index ---------- */

const IndexQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
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
      .array(z.coerce.number().int().positive().max(MAX_ID))
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
                  -- F-108 fence (fixpass b8 B-3): an id pointing at a row
                  -- EXTRACTED from someone else's book upload is skipped
                  -- exactly like a nonexistent id — otherwise seeding it here
                  -- exfiltrates the row's content through this user's own
                  -- list detail. Shared fragment: db/corpusFences.ts.
                 WHERE EXISTS (
                          SELECT 1 FROM vocab_entries v
                           WHERE v.id = s.entry_id
                             AND ${sourceUploadFenceSql('v.source_upload_id', '$3')}
                       )
                   AND NOT EXISTS (
                          SELECT 1 FROM vocab_list_entries x
                           WHERE x.list_id = $1 AND x.entry_id = s.entry_id
                       )
                RETURNING 1
             )
             SELECT COUNT(*)::text AS count FROM ins`,
            [list.id, uniqueSeeds, userId],
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
  entry_offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
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

      // One row per membership, LEFT JOINed to whichever target entity the
      // XOR column points at (049). `entry_id` stays the client-facing name
      // for the target id (back-compat with the pre-049 vocab-only shape);
      // `item_type` discriminates which joined columns are populated.
      const entriesResult = await query<{
        entry_id: number;
        item_type: ItemType;
        position: number;
        added_at: Date;
        korean: string | null;
        english: string | null;
        proficiency: string | null;
        // F-112: the vocab entry's corpus example sentence, JOINed so a list-
        // study card back (and this detail view) are complete offline — the
        // KRDICT drawer was the only way to see an example before, on demand
        // only. NULL for grammar/hanja rows (v is NULL there) and for a vocab
        // entry whose corpus row simply has no example on file.
        example_korean: string | null;
        example_english: string | null;
        pattern: string | null;
        title_en: string | null;
        hanja_char: string | null;
        hanja_sound: string | null;
        hanja_gloss_en: string | null;
        hanja_level: string | null;
      }>(
        `SELECT COALESCE(e.entry_id, e.kgiu_entry_id, e.hanja_character_id)
                  AS entry_id,
                CASE WHEN e.entry_id      IS NOT NULL THEN 'vocab'
                     WHEN e.kgiu_entry_id IS NOT NULL THEN 'grammar'
                     ELSE 'hanja' END AS item_type,
                e.position,
                e.added_at,
                v.korean,
                v.english,
                v.proficiency::text AS proficiency,
                v.example_korean,
                v.example_english,
                g.pattern,
                g.title_en,
                h.char  AS hanja_char,
                h.sound AS hanja_sound,
                h.gloss_en AS hanja_gloss_en,
                h.level AS hanja_level
           FROM vocab_list_entries e
           LEFT JOIN vocab_entries    v ON v.id = e.entry_id
           LEFT JOIN kgiu_entries     g ON g.id = e.kgiu_entry_id
           LEFT JOIN hanja_characters h ON h.id = e.hanja_character_id
          WHERE e.list_id = $1
          ORDER BY e.position, e.added_at, e.id
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

const AppendItemSchema = z
  .object({
    type: ITEM_TYPE,
    id: z.coerce.number().int().positive().max(MAX_ID),
  })
  .strict();

// EITHER the legacy vocab-only shape (`entry_ids`) OR the 049 typed shape
// (`items`) — exactly one. Legacy requests behave exactly as before the
// widening (every id targets vocab_entries), so pre-049 clients keep working.
const AppendBodySchema = z
  .object({
    entry_ids: z
      .array(z.coerce.number().int().positive().max(MAX_ID))
      .min(1)
      .max(200)
      .optional(),
    items: z.array(AppendItemSchema).min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.entry_ids === undefined) !== (v.items === undefined), {
    message: 'supply exactly one of entry_ids or items',
  });

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

      // Normalize both accepted shapes to a typed item list, deduplicated by
      // (type, id) pair — vocab #7 and grammar #7 are distinct targets and
      // may coexist in one request/list.
      const requested: Array<{ type: ItemType; id: number }> =
        body.items ?? (body.entry_ids ?? []).map((id) => ({ type: 'vocab' as const, id }));
      const seen = new Set<string>();
      const uniqueItems = requested.filter((it) => {
        const key = `${it.type}:${it.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const idsOf = (t: ItemType): number[] =>
        uniqueItems.filter((it) => it.type === t).map((it) => it.id);
      const vocabIds = idsOf('vocab');
      const grammarIds = idsOf('grammar');
      const hanjaIds = idsOf('hanja');

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

        // Validate every requested target exists in ITS OWN table — surface
        // the missing ids in the response so the client can react. (The FK
        // would 23503 the INSERT below; that's a worse UX than naming the
        // ids inline.) Per-type validation is also the type-confusion guard:
        // a grammar id is never checked against vocab_entries.
        for (const t of ITEM_TYPE.options) {
          const ids = idsOf(t);
          if (ids.length === 0) continue;
          // TARGET_TABLE is a server-owned closed map keyed by the Zod enum —
          // not client input (see threat model §type confusion).
          // F-108 fence (fixpass b8 B-3): vocab_entries AND kgiu_entries can
          // carry rows EXTRACTED from a private book upload — an id pointing
          // at another user's extracted row must validate exactly like a
          // nonexistent id (404), or this check is an existence oracle and
          // the list detail an exfiltration path (this was the only route
          // leaking extracted KGIU content). hanja_characters has no
          // source_upload_id column — nothing extracted ever lands there.
          // Shared fragment: db/corpusFences.ts.
          const fenced = t !== 'hanja';
          const valid = await client.query<{ id: string }>(
            fenced
              ? `SELECT id FROM ${TARGET_TABLE[t]}
                  WHERE id = ANY($1::bigint[])
                    AND ${sourceUploadFenceSql('source_upload_id', '$2')}`
              : `SELECT id FROM ${TARGET_TABLE[t]} WHERE id = ANY($1::bigint[])`,
            fenced ? [ids, userId] : [ids],
          );
          const validSet = new Set<number>(valid.rows.map((r) => Number(r.id)));
          const invalidIds = ids.filter((id) => !validSet.has(id));
          if (invalidIds.length > 0) {
            throw new NotFoundError(
              `${t} entries not found: ${invalidIds.slice(0, 10).join(',')}`,
            );
          }
        }

        // Detect duplicate memberships BEFORE INSERT so we can return 409 —
        // required by the contract ("409 on duplicate add"). The ON CONFLICT
        // DO NOTHING approach would silently skip; that's not what the design
        // wants ("show the user we couldn't add it because it's already
        // there"). The per-target partial UNIQUE indexes (049) back this up
        // at the DB level against races.
        const existing = await client.query<{ t: ItemType; target_id: string }>(
          `SELECT CASE WHEN entry_id      IS NOT NULL THEN 'vocab'
                       WHEN kgiu_entry_id IS NOT NULL THEN 'grammar'
                       ELSE 'hanja' END AS t,
                  COALESCE(entry_id, kgiu_entry_id, hanja_character_id)
                    AS target_id
             FROM vocab_list_entries
            WHERE list_id = $1
              AND (entry_id           = ANY($2::bigint[])
                OR kgiu_entry_id      = ANY($3::bigint[])
                OR hanja_character_id = ANY($4::bigint[]))`,
          [listId, vocabIds, grammarIds, hanjaIds],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          const dups = existing.rows.map((r) => `${r.t}:${r.target_id}`);
          throw new ConflictError(
            `items already in list: ${dups.slice(0, 10).join(',')}`,
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

        // One INSERT for the whole batch: parallel type[]/id[] arrays are
        // fanned out by unnest, and the type routes each id into its XOR
        // column. Positions follow the client-supplied order.
        const inserted = await client.query<{
          entry_id: string;
          item_type: ItemType;
          position: number;
          added_at: Date;
        }>(
          `INSERT INTO vocab_list_entries
                  (list_id, entry_id, kgiu_entry_id, hanja_character_id, position)
                SELECT $1,
                       CASE WHEN s.t = 'vocab'   THEN s.target_id END,
                       CASE WHEN s.t = 'grammar' THEN s.target_id END,
                       CASE WHEN s.t = 'hanja'   THEN s.target_id END,
                       $4 + (s.ord - 1)::int
                  FROM unnest($2::text[], $3::bigint[])
                       WITH ORDINALITY AS s(t, target_id, ord)
             RETURNING COALESCE(entry_id, kgiu_entry_id, hanja_character_id)
                         AS entry_id,
                       CASE WHEN entry_id      IS NOT NULL THEN 'vocab'
                            WHEN kgiu_entry_id IS NOT NULL THEN 'grammar'
                            ELSE 'hanja' END AS item_type,
                       position, added_at`,
          [
            listId,
            uniqueItems.map((it) => it.type),
            uniqueItems.map((it) => it.id),
            basePosition,
          ],
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
          item_type: r.item_type,
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

// `?type=` selects which XOR column the id addresses. Defaults to 'vocab' so
// pre-049 clients (which only ever removed vocab memberships) are unchanged.
const RemoveQuerySchema = z.object({
  type: ITEM_TYPE.default('vocab'),
});

router.delete(
  '/:id/entries/:entryId',
  cheapLimiter(),
  validateParams(ListEntryParamsSchema),
  validateQuery(RemoveQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id: listId, entryId } = (req as typeof req & {
        validatedParams: z.infer<typeof ListEntryParamsSchema>;
      }).validatedParams;
      const itemType = (req as typeof req & {
        validatedQuery: z.infer<typeof RemoveQuerySchema>;
      }).validatedQuery.type;

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
        // TARGET_COLUMN is a server-owned closed map keyed by the Zod enum —
        // not client input (see threat model §type confusion).
        const del = await client.query(
          `DELETE FROM vocab_list_entries
            WHERE list_id = $1 AND ${TARGET_COLUMN[itemType]} = $2`,
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

/* ---------- F-113: per-list due-aware study queue + bulk seed ---------- */

const ListDueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

/**
 * GET /vocab/lists/:id/cards/due — the due-aware twin of `GET /vocab/cards/
 * due`, scoped to one list. Only the list's VOCAB memberships participate
 * (`e.entry_id IS NOT NULL`) — grammar/hanja list items have their own
 * banked-card lifecycle (`POST /grammar/bank`, hanja's card-seed route) that
 * doesn't share a target id space with `vocab_cards`, so folding them into
 * this vocab-only queue would require resolving a SEPARATE user-owned bank
 * row per membership; today's client only ever studies vocab lists (F-091's
 * own notes: "no UI can put a non-vocab item in a list yet"), so this stays
 * vocab-scoped rather than speculatively wiring paths nothing calls yet.
 *
 * The wire shape is byte-identical to `GET /vocab/cards/due` (same column
 * names, no grammar_* columns since a vocab-only card can never carry them)
 * so the client's existing `normalizeDueCard`/`dueCardToStudyCard` adapters
 * work unmodified — one queue implementation, reused.
 */
router.get(
  '/:id/cards/due',
  cheapLimiter(),
  validateParams(ListIdParamsSchema),
  validateQuery(ListDueQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const listId = (req as typeof req & {
        validatedParams: z.infer<typeof ListIdParamsSchema>;
      }).validatedParams.id;
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof ListDueQuerySchema>;
      }).validatedQuery;

      // Ownership first — 404 whether the list is missing or belongs to
      // someone else (same posture as every other route in this file).
      const owner = await query<{ id: number }>(
        `SELECT id
           FROM vocab_lists
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [listId, userId],
      );
      if (owner.rowCount === 0) throw new NotFoundError('vocab list not found');

      const { rows } = await query<{
        id: number;
        face: string;
        due_at: Date;
        stability: string;
        difficulty: string;
        fsrs_state: string;
        version: number;
        vocab_entry_id: number | null;
        grammar_entry_id: number | null;
        source_sentence_id: number | null;
        topik_item_id: number | null;
        vocab_korean: string | null;
        vocab_english: string | null;
        vocab_example_korean: string | null;
        vocab_example_english: string | null;
        vocab_source_book: string | null;
        total: string;
      }>(
        `SELECT c.id, c.face, c.due_at, c.stability, c.difficulty, c.fsrs_state, c.version,
                c.vocab_entry_id, c.grammar_entry_id, c.source_sentence_id, c.topik_item_id,
                ve.korean          AS vocab_korean,
                ve.english         AS vocab_english,
                ve.example_korean  AS vocab_example_korean,
                ve.example_english AS vocab_example_english,
                ve.source_book     AS vocab_source_book,
                COUNT(*) OVER ()::text AS total
           FROM vocab_list_entries le
           JOIN vocab_cards   c  ON c.vocab_entry_id = le.entry_id
           JOIN vocab_entries ve ON ve.id = c.vocab_entry_id
          WHERE le.list_id = $1
            AND le.entry_id IS NOT NULL
            AND c.user_id = $2
            AND c.face = 'recognition'
            AND c.deleted_at IS NULL
            AND c.suspended_at IS NULL
            AND c.due_at <= now()
          ORDER BY c.due_at
          LIMIT $3`,
        [listId, userId, q.limit],
      );
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      const cards = rows.map(({ total: _total, ...c }) => ({
        ...c,
        id: Number(c.id),
        vocab_entry_id: c.vocab_entry_id === null ? null : Number(c.vocab_entry_id),
        grammar_entry_id: c.grammar_entry_id === null ? null : Number(c.grammar_entry_id),
        source_sentence_id:
          c.source_sentence_id === null ? null : Number(c.source_sentence_id),
        topik_item_id: c.topik_item_id === null ? null : Number(c.topik_item_id),
      }));
      res.status(200).json({ cards, total });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /vocab/lists/:id/cards/seed — bulk "add all to review": idempotently
 * seeds a recognition card (`due_at = now()`, immediately studyable) for
 * every VOCAB entry in the list that doesn't already have one for this user.
 *
 * Idempotency (fix-pass follow-up to the original NOT-EXISTS-gated version,
 * server-review SHOULD-FIX #1): backed by a real DB-level guarantee now —
 * migration 065's partial UNIQUE index `uq_vocab_cards_user_vocab_recognition`
 * ON (user_id, vocab_entry_id) WHERE face = 'recognition' AND vocab_entry_id
 * IS NOT NULL AND deleted_at IS NULL, mirroring the existing
 * `uq_vocab_cards_user_grammar_production` (020) / `uq_vocab_cards_user_hanja_
 * face` (050) precedent. `ON CONFLICT ... DO NOTHING` is atomic across
 * concurrent transactions (unlike a bare NOT-EXISTS-then-INSERT under READ
 * COMMITTED), so two truly concurrent seed calls for the same
 * (user_id, vocab_entry_id) — whether same-list double-tap or racing
 * `POST /vocab/cards/init` / `POST /vocab/entries/:id/bank` for a
 * list-member entry — can no longer both insert. `POST /vocab/cards/init`
 * itself is intentionally NOT touched here (out of scope for this PR; still
 * NOT-EXISTS-gated) — it becomes safe to harden the same way once someone
 * ports its INSERT to the same ON CONFLICT target, but the index alone
 * already closes THIS route's exposure and backstops init's races too.
 * The per-list `FOR UPDATE` lock is kept — it still serializes the realistic
 * same-list double-tap case before either statement reaches the index.
 * Scoped to `entry_id IS NOT NULL` (the vocab leg) for the same reason the
 * due-queue route above is vocab-only.
 */
router.post(
  '/:id/cards/seed',
  cheapLimiter(),
  validateParams(ListIdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const listId = (req as typeof req & {
        validatedParams: z.infer<typeof ListIdParamsSchema>;
      }).validatedParams.id;

      const inserted = await withTransaction(async (client) => {
        const owner = await client.query<{ id: number }>(
          `SELECT id
             FROM vocab_lists
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            FOR UPDATE`,
          [listId, userId],
        );
        if (owner.rowCount === 0) throw new NotFoundError('vocab list not found');

        const { rows } = await client.query<{ inserted: number }>(
          `WITH ins AS (
              INSERT INTO vocab_cards (
                  user_id, face, vocab_entry_id, proficiency, due_at)
              SELECT $2, 'recognition'::card_face, le.entry_id,
                     COALESCE(v.proficiency, 'L3'::proficiency_level), now()
                FROM vocab_list_entries le
                JOIN vocab_entries v ON v.id = le.entry_id
               WHERE le.list_id = $1
                 AND le.entry_id IS NOT NULL
              ON CONFLICT (user_id, vocab_entry_id)
                  WHERE face = 'recognition'
                    AND vocab_entry_id IS NOT NULL
                    AND deleted_at IS NULL
              DO NOTHING
              RETURNING 1
           )
           SELECT COUNT(*)::int AS inserted FROM ins`,
          [listId, userId],
        );
        return rows[0]!.inserted;
      });
      res.status(201).json({ inserted });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
