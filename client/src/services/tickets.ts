/**
 * /tickets — F-023 in-app beta ticketing/feedback client wrappers.
 *
 * Talks to `server/src/routes/tickets.ts` (already deployed — see that
 * file's header for the full endpoint contract + server-side threat model).
 * This module is the wire↔domain boundary: every response comes back
 * snake_case (`comment_count`, `created_at`, `is_mine`, …) and is mapped
 * here into the camelCase shapes `types/domain.ts` declares — mirrors
 * `services/uploads.ts`'s `toBookUpload` convention.
 *
 * Threat model (client half — the server owns the real defenses; see
 * routes/tickets.ts's header for the full enumeration):
 *   - Author anonymity (F-023, the whole point of this feature): NONE of
 *     the wire shapes this module reads carry a `user_id`/email field —
 *     `CommunityTicketWire`/`TicketCommentWire` only have `is_mine`, a
 *     caller-relative boolean the server computes against the CALLER's own
 *     id. There is no field here a consumer could reach for to render an
 *     author even by accident; the anonymity contract is a type-level
 *     guarantee, not just a UI convention.
 *   - Optimistic concurrency: `patchTicket` requires `expectedVersion`; a
 *     409 (stale) surfaces as `ApiError({status: 409})`. Callers must
 *     refetch the fresh row via `fetchTicket` (the id-addressed read — no
 *     list filter or pagination window can hide it) and let the user retry
 *     against the fresh version — see `Tickets.tsx`'s recovery UX.
 *   - IDOR: a PATCH against a ticket that isn't the caller's own 404s
 *     server-side (identical shape to "doesn't exist" — routes/tickets.ts).
 *     This module does not special-case that; it surfaces as `ApiError`.
 *   - CSRF: every state-changing call rides the shared axios instance's
 *     `SameSite=Strict` session cookie (services/api.ts) — no separate
 *     defense needed here.
 *   - Abort: every call takes an optional `AbortSignal` so the page can
 *     cancel in-flight list/comment loads on unmount, tab-switch, or a
 *     filter change — mirrors every other service in this app.
 */
import { api } from './api';
import type {
  CommunityTicket,
  CreateTicketBody,
  OwnTicket,
  PatchTicketBody,
  TicketComment,
  TicketDetailResult,
  TicketListQuery,
  TicketStatus,
  TicketType,
} from '../types/domain';

/** Wire shape of a ticket the CALLER owns — `GET /tickets/mine`, and the
 *  POST/PATCH response envelope (routes/tickets.ts `OwnTicketRow`). */
interface OwnTicketWire {
  /** `tickets.id` is a Postgres `bigint`; node-postgres serializes bigint as a
   *  JSON string, so the wire value arrives as `"1"`, NOT `1`. The mapper below
   *  coerces to the domain's `number`. Typing this honestly (not `number`) is
   *  what forces that coercion — the previous `number` lie let `"1" === 1`
   *  comparisons silently fail in the detail view ("we couldn't find that
   *  ticket" for every ticket). */
  id: number | string;
  type: TicketType;
  title: string;
  body: string;
  status: TicketStatus;
  version: number;
  /** F-127 — the app path this ticket was filed from, or `null`. */
  source_page: string | null;
  /** Absent on the POST/PATCH response (a fresh/just-edited ticket has no
   *  comments yet to count); present on `/mine` rows. */
  comment_count?: number;
  created_at: string;
  updated_at: string;
}

/** Wire shape of a `GET /tickets/community` row — ANONYMIZED, see module header. */
interface CommunityTicketWire {
  /** Postgres `bigint` → JSON string on the wire; coerced to `number` by the
   *  mapper. See `OwnTicketWire.id`. */
  id: number | string;
  type: TicketType;
  title: string;
  body: string;
  status: TicketStatus;
  /** F-127 — same contract as `OwnTicketWire.source_page`. */
  source_page: string | null;
  comment_count: number;
  is_mine: boolean;
  created_at: string;
  updated_at: string;
}

/** Wire shape of one comment — ANONYMIZED, see module header. */
interface TicketCommentWire {
  /** Postgres `bigint` → JSON string on the wire; coerced to `number` by the
   *  mapper. See `OwnTicketWire.id`. */
  id: number | string;
  body: string;
  is_mine: boolean;
  created_at: string;
}

interface TicketEnvelope {
  ticket: OwnTicketWire;
}
interface MineListEnvelope {
  tickets: OwnTicketWire[];
  limit: number;
  offset: number;
}
interface CommunityListEnvelope {
  tickets: CommunityTicketWire[];
  limit: number;
  offset: number;
}
interface CommentEnvelope {
  comment: TicketCommentWire;
}
interface CommentsListEnvelope {
  comments: TicketCommentWire[];
  limit: number;
  offset: number;
}

function toOwnTicket(wire: OwnTicketWire): OwnTicket {
  return {
    // bigint arrives as a string — normalize to number (see OwnTicketWire.id).
    id: Number(wire.id),
    type: wire.type,
    title: wire.title,
    body: wire.body,
    status: wire.status,
    version: wire.version,
    sourcePage: wire.source_page,
    commentCount: wire.comment_count ?? 0,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
  };
}

function toCommunityTicket(wire: CommunityTicketWire): CommunityTicket {
  return {
    // bigint arrives as a string — normalize to number (see OwnTicketWire.id).
    id: Number(wire.id),
    type: wire.type,
    title: wire.title,
    body: wire.body,
    status: wire.status,
    sourcePage: wire.source_page,
    commentCount: wire.comment_count,
    isMine: wire.is_mine,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
  };
}

function toComment(wire: TicketCommentWire): TicketComment {
  return {
    // bigint arrives as a string — normalize to number (see OwnTicketWire.id).
    id: Number(wire.id),
    body: wire.body,
    isMine: wire.is_mine,
    createdAt: wire.created_at,
  };
}

/** Build the `{status, type, limit, offset}` query params, omitting absent ones. */
function listParams(
  q?: TicketListQuery,
): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (q?.status !== undefined) params.status = q.status;
  if (q?.type !== undefined) params.type = q.type;
  if (q?.limit !== undefined) params.limit = q.limit;
  if (q?.offset !== undefined) params.offset = q.offset;
  return params;
}

/**
 * POST /tickets — file a new ticket. `sourcePage` (camelCase, F-127) is
 * translated to the wire's `source_page` explicitly — unlike `type`/
 * `title`/`body` (case-invariant single words), it can't ride along
 * unchanged, and it's sent ONLY when present so an unset context reaches
 * the server as an absent key (genuine SQL NULL), never `''`.
 */
export async function createTicket(
  body: CreateTicketBody,
  signal?: AbortSignal,
): Promise<OwnTicket> {
  const wireBody: Record<string, unknown> = {
    type: body.type,
    title: body.title,
    body: body.body,
  };
  if (body.sourcePage !== undefined) wireBody.source_page = body.sourcePage;
  const res = await api.post<TicketEnvelope>(
    '/tickets',
    wireBody,
    signal !== undefined ? { signal } : undefined,
  );
  return toOwnTicket(res.ticket);
}

/** GET /tickets/mine — the caller's own tickets (carries `version` for PATCH). */
export async function listMyTickets(
  query?: TicketListQuery,
  signal?: AbortSignal,
): Promise<OwnTicket[]> {
  const res = await api.get<MineListEnvelope>('/tickets/mine', {
    params: listParams(query),
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.tickets.map(toOwnTicket);
}

/**
 * GET /tickets/:id — ONE ticket, addressed by id. The detail view's
 * authoritative read: unlike `/mine`/`/community`, no status/type filter or
 * pagination window can hide the row (the "file a ticket → open it → not
 * found" beta regression this endpoint exists to close).
 *
 * The response shape IS the server's ownership decision: the caller's own
 * ticket arrives in the owner shape (with `version` → edit rights), anyone
 * else's in the ANONYMIZED community shape (F-023 — `is_mine` only, never
 * an author). `version` presence is the wire discriminator; the returned
 * `kind` surfaces that decision to callers as a checked union instead of a
 * duck-typed guess at each call site. A missing id rejects with
 * `ApiError({status: 404})`.
 */
export async function fetchTicket(
  id: number,
  signal?: AbortSignal,
): Promise<TicketDetailResult> {
  const res = await api.get<{ ticket: OwnTicketWire | CommunityTicketWire }>(
    `/tickets/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
  const wire = res.ticket;
  return 'version' in wire
    ? { kind: 'own', ticket: toOwnTicket(wire) }
    : { kind: 'community', ticket: toCommunityTicket(wire) };
}

/** GET /tickets/community — every ticket, author ANONYMIZED. */
export async function listCommunityTickets(
  query?: TicketListQuery,
  signal?: AbortSignal,
): Promise<CommunityTicket[]> {
  const res = await api.get<CommunityListEnvelope>('/tickets/community', {
    params: listParams(query),
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.tickets.map(toCommunityTicket);
}

/**
 * PATCH /tickets/:id — edit OWN ticket (title/body/status).
 * `patch.expectedVersion` is REQUIRED (mirrors the server's
 * optimistic-concurrency gate); a stale value 409s as `ApiError` — the
 * caller must refetch the fresh row via `fetchTicket` and let the user
 * retry against the fresh version (see Tickets.tsx's recovery UX).
 */
export async function patchTicket(
  id: number,
  patch: PatchTicketBody,
  signal?: AbortSignal,
): Promise<OwnTicket> {
  const body: Record<string, unknown> = {
    expected_version: patch.expectedVersion,
  };
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.body !== undefined) body.body = patch.body;
  if (patch.status !== undefined) body.status = patch.status;
  const res = await api.patch<TicketEnvelope>(
    `/tickets/${String(id)}`,
    body,
    signal !== undefined ? { signal } : undefined,
  );
  return toOwnTicket(res.ticket);
}

/** POST /tickets/:id/comments — add a comment to ANY ticket (shared discussion surface). */
export async function addTicketComment(
  id: number,
  body: string,
  signal?: AbortSignal,
): Promise<TicketComment> {
  const res = await api.post<CommentEnvelope>(
    `/tickets/${String(id)}/comments`,
    { body },
    signal !== undefined ? { signal } : undefined,
  );
  return toComment(res.comment);
}

/** GET /tickets/:id/comments — a ticket's thread, oldest-first, ANONYMIZED. */
export async function listTicketComments(
  id: number,
  query?: Pick<TicketListQuery, 'limit' | 'offset'>,
  signal?: AbortSignal,
): Promise<TicketComment[]> {
  const res = await api.get<CommentsListEnvelope>(
    `/tickets/${String(id)}/comments`,
    {
      params: listParams(query),
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return res.comments.map(toComment);
}
