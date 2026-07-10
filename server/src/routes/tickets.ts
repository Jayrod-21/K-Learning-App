/**
 * /tickets routes — in-app beta ticketing / feedback (F-023, beta-blocker).
 *
 * A beta user files a ticket (bug / concern / suggestion / request); everyone
 * in the beta sees the community feed ANONYMOUSLY and can comment. Every
 * endpoint is authenticated.
 *
 *   POST   /tickets               — file a ticket
 *   GET    /tickets/mine          — the caller's own tickets (with version,
 *                                   for PATCH's optimistic concurrency)
 *   GET    /tickets/community     — ALL tickets, author ANONYMIZED
 *   PATCH  /tickets/:id           — edit OWN ticket (title/body/status),
 *                                   optimistic concurrency via expected_version
 *   POST   /tickets/:id/comments  — add a timestamped comment to any ticket
 *   GET    /tickets/:id/comments  — a ticket's thread, authors anonymized
 *
 * Threat model (extends Repository/server/SECURITY.md §3 — Authorization):
 *   - AUTHOR ANONYMITY (the F-023 contract): community reads NEVER return
 *     user_id, email, or any author-identifying column. The only identity
 *     signal on the wire is `is_mine` / boolean flags computed against the
 *     CALLER's own id — which reveals nothing about anyone else. Grep-proof:
 *     no SELECT list in a community-facing query below contains user_id or a
 *     join to users.
 *   - IDOR on PATCH: the UPDATE (and the pre-read) is scoped `WHERE id = $id
 *     AND user_id = $sessionUserId`. A PATCH against another user's ticket
 *     yields 404 — identical in shape to "no such ticket", so ownership can't
 *     be probed. (Ticket EXISTENCE is deliberately public via /community, but
 *     ownership is not.)
 *   - Mass assignment: every body goes through a `.strict()` Zod schema —
 *     extra keys (e.g. `user_id`, `version`) are 400'd before SQL.
 *   - Lost-update: PATCH requires `expected_version`; the UPDATE re-checks
 *     `version = $expected` and a mismatch is 409 (conversations.ts protocol).
 *   - Resource-exhaustion: title/body/comment lengths are Zod-bounded AND
 *     CHECK-constrained in the schema (migration 048); ids and offsets are
 *     integer-bounded so a 20-digit id 400s instead of overflowing int8 into
 *     a pg 22003 → 500; every route sits behind cheapLimiter().
 *   - SQL injection: every query is parameterized; no string interpolation.
 *   - DB-error leakage: routes never echo raw error text; the central
 *     errorHandler returns generic 500s with correlation IDs only.
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
import { query } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

const TICKET_TYPE = z.enum(['bug', 'concern', 'suggestion', 'request']);
const TICKET_STATUS = z.enum(['open', 'in_progress', 'resolved', 'closed']);

// Ids (and OFFSETs) bind to BIGINT/int8 in pg. Without an upper bound,
// `Number.isInteger(1e20)` is true, so a 20-digit id passes Zod and overflows
// in pg (22003 → 500) where the contract everywhere else is 400/404 for a
// garbage id (routes sweep #3).
const MAX_ID = Number.MAX_SAFE_INTEGER;
// tickets.version is INTEGER (int4) — bound expected_version accordingly.
const INT4_MAX = 2_147_483_647;

const TicketIdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
  status: TICKET_STATUS.optional(),
  type: TICKET_TYPE.optional(),
});

/** The columns a ticket OWNER sees (includes version for PATCH). */
interface OwnTicketRow {
  id: number;
  type: string;
  title: string;
  body: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/* ---------- POST /tickets — file a ticket ---------- */

const CreateBodySchema = z
  .object({
    type: TICKET_TYPE,
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
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
      const { rows } = await query<OwnTicketRow>(
        `INSERT INTO tickets (user_id, type, title, body)
              VALUES ($1, $2, $3, $4)
           RETURNING id, type, title, body, status, version, created_at, updated_at`,
        [userId, body.type, body.title, body.body],
      );
      const ticket = rows[0];
      if (!ticket) throw new Error('tickets insert returned no rows');
      res.status(201).json({ ticket });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- GET /tickets/mine — the caller's own tickets ---------- */

router.get(
  '/mine',
  cheapLimiter(),
  validateQuery(ListQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof ListQuerySchema>;
      }).validatedQuery;
      const { rows } = await query<OwnTicketRow & { comment_count: number }>(
        // LEFT JOIN aggregate so a ticket with zero comments still returns
        // (comment_count = 0).
        `SELECT t.id, t.type, t.title, t.body, t.status, t.version,
                COALESCE(COUNT(c.id), 0)::int AS comment_count,
                t.created_at, t.updated_at
           FROM tickets t
           LEFT JOIN ticket_comments c ON c.ticket_id = t.id
          WHERE t.user_id = $1
            AND ($2::text IS NULL OR t.status = $2)
            AND ($3::text IS NULL OR t.type = $3)
          GROUP BY t.id
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT $4 OFFSET $5`,
        [userId, q.status ?? null, q.type ?? null, q.limit, q.offset],
      );
      res.status(200).json({ tickets: rows, limit: q.limit, offset: q.offset });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- GET /tickets/community — ALL tickets, anonymized ---------- */

router.get(
  '/community',
  cheapLimiter(),
  validateQuery(ListQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof ListQuerySchema>;
      }).validatedQuery;
      const { rows } = await query<{
        id: number;
        type: string;
        title: string;
        body: string;
        status: string;
        comment_count: number;
        is_mine: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        // ANONYMIZED (F-023): the SELECT list deliberately excludes user_id
        // and never joins users. `is_mine` compares against the CALLER's own
        // id — it exposes nothing about any other author.
        `SELECT t.id, t.type, t.title, t.body, t.status,
                COALESCE(COUNT(c.id), 0)::int AS comment_count,
                (t.user_id = $1)              AS is_mine,
                t.created_at, t.updated_at
           FROM tickets t
           LEFT JOIN ticket_comments c ON c.ticket_id = t.id
          WHERE ($2::text IS NULL OR t.status = $2)
            AND ($3::text IS NULL OR t.type = $3)
          GROUP BY t.id
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT $4 OFFSET $5`,
        [userId, q.status ?? null, q.type ?? null, q.limit, q.offset],
      );
      res.status(200).json({ tickets: rows, limit: q.limit, offset: q.offset });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- PATCH /tickets/:id — edit OWN ticket ---------- */

const PatchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(5000).optional(),
    status: TICKET_STATUS.optional(),
    expected_version: z.number().int().positive().max(INT4_MAX),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v).filter((k) => k !== 'expected_version').length > 0,
    { message: 'no fields supplied' },
  );

router.patch(
  '/:id',
  cheapLimiter(),
  validateParams(TicketIdParamsSchema),
  validateBody(PatchBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const ticketId = (req as typeof req & {
        validatedParams: z.infer<typeof TicketIdParamsSchema>;
      }).validatedParams.id;
      const body = req.body as z.infer<typeof PatchBodySchema>;

      // Ownership + freshness pre-read (conversations.ts protocol): a ticket
      // that isn't the caller's own reads as absent → 404 (no IDOR probe);
      // a stale expected_version → 409 so the client can refetch and retry.
      const pre = await query<{ version: number }>(
        `SELECT version FROM tickets WHERE id = $1 AND user_id = $2`,
        [ticketId, userId],
      );
      const current = pre.rows[0];
      if (!current) throw new NotFoundError('ticket not found');
      if (current.version !== body.expected_version) {
        throw new ConflictError('stale ticket version');
      }

      const setTitle = body.title !== undefined;
      const setBody = body.body !== undefined;
      const setStatus = body.status !== undefined;

      // The UPDATE re-checks version = $expected so a concurrent writer
      // between the pre-read and here still loses cleanly (rowCount 0 → 409).
      const { rows } = await query<OwnTicketRow>(
        `UPDATE tickets
            SET title   = CASE WHEN $4::boolean THEN $5::text ELSE title  END,
                body    = CASE WHEN $6::boolean THEN $7::text ELSE body   END,
                status  = CASE WHEN $8::boolean THEN $9::text ELSE status END,
                version = version + 1
          WHERE id = $1 AND user_id = $2 AND version = $3
        RETURNING id, type, title, body, status, version, created_at, updated_at`,
        [
          ticketId,
          userId,
          body.expected_version,
          setTitle,
          body.title ?? null,
          setBody,
          body.body ?? null,
          setStatus,
          body.status ?? null,
        ],
      );
      const ticket = rows[0];
      if (!ticket) throw new ConflictError('stale ticket version');
      res.status(200).json({ ticket });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- POST /tickets/:id/comments — comment on any ticket ---------- */

const CommentBodySchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
  })
  .strict();

router.post(
  '/:id/comments',
  cheapLimiter(),
  validateParams(TicketIdParamsSchema),
  validateBody(CommentBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const ticketId = (req as typeof req & {
        validatedParams: z.infer<typeof TicketIdParamsSchema>;
      }).validatedParams.id;
      const body = req.body as z.infer<typeof CommentBodySchema>;

      // Existence check + insert in ONE statement so a ticket deleted between
      // check and insert can't turn the FK violation into a 500. Any ticket
      // may be commented on — the community feed is a shared discussion
      // surface (F-023) — so no ownership filter here, only existence.
      const { rows } = await query<{
        id: number;
        body: string;
        created_at: Date;
      }>(
        `INSERT INTO ticket_comments (ticket_id, user_id, body)
              SELECT $1, $2, $3
               WHERE EXISTS (SELECT 1 FROM tickets WHERE id = $1)
           RETURNING id, body, created_at`,
        [ticketId, userId, body.body],
      );
      const comment = rows[0];
      if (!comment) throw new NotFoundError('ticket not found');
      res.status(201).json({ comment: { ...comment, is_mine: true } });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- GET /tickets/:id/comments — thread, anonymized ---------- */

const CommentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().nonnegative().max(MAX_ID).default(0),
});

router.get(
  '/:id/comments',
  cheapLimiter(),
  validateParams(TicketIdParamsSchema),
  validateQuery(CommentsQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const ticketId = (req as typeof req & {
        validatedParams: z.infer<typeof TicketIdParamsSchema>;
      }).validatedParams.id;
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof CommentsQuerySchema>;
      }).validatedQuery;

      // Comments are visible on ANY ticket (community surface), but a garbage
      // id is still a 404 rather than an empty 200 — the client must be able
      // to tell "no ticket" from "no comments yet".
      const exists = await query<{ id: number }>(
        `SELECT id FROM tickets WHERE id = $1`,
        [ticketId],
      );
      if (!exists.rows[0]) throw new NotFoundError('ticket not found');

      const { rows } = await query<{
        id: number;
        body: string;
        is_mine: boolean;
        created_at: Date;
      }>(
        // ANONYMIZED (F-023): no user_id, no users join. `is_mine` compares
        // against the caller only.
        `SELECT c.id, c.body,
                (c.user_id = $2) AS is_mine,
                c.created_at
           FROM ticket_comments c
          WHERE c.ticket_id = $1
          ORDER BY c.created_at, c.id
          LIMIT $3 OFFSET $4`,
        [ticketId, userId, q.limit, q.offset],
      );
      res.status(200).json({
        comments: rows,
        limit: q.limit,
        offset: q.offset,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
