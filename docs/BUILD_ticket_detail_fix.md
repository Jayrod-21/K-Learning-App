# BUILD — Ticket detail "not found" fix (beta)

## Bug

A just-filed ticket showed "We couldn't find that ticket." when the user
opened it. Root cause: there was no `GET /tickets/:id` detail endpoint. The
client built the detail view by finding the ticket in the already-fetched
`mine`/`community` lists. Both lists are FILTERED by the board's status/type
filter, so when they reloaded (navigation / re-render), a just-created ticket
whose status or type didn't match the active filter was absent, and the
detail lookup returned null. The optimistic `onFiled` prepend into `mine`
didn't survive a filtered reload.

## Fix — a real id-addressed detail read

### Server — `server/src/routes/tickets.ts`

Added `GET /tickets/:id`, registered AFTER `/mine` and `/community` (Express
matches literal paths in registration order, so those win over this param
route). It returns ONE ticket by id:

- **Caller's own ticket → full OWNER shape**, the exact SELECT list of
  `/tickets/mine` (with `version`, `source_page`, `comment_count`). `version`
  is the PATCH optimistic-concurrency token and the client's edit-rights
  signal. Ownership is enforced in SQL (`WHERE id = $1 AND user_id = $2`),
  never inferred from anything client-supplied.
- **Anyone else's ticket → ANONYMIZED community shape**, the exact SELECT
  list of `/tickets/community` (no `user_id`, no `users` join, no `version`;
  `is_mine` only, always false on this branch). Preserves the F-023 author
  anonymity contract.
- **Missing id → 404** (`not_found`), never 403 — there is no "exists but
  forbidden" state on a community-visible board, and the shape matches every
  other absent-resource response in the file. Parameterized; the id param
  goes through the existing `TicketIdParamsSchema` (bounded so a 20-digit id
  400s instead of overflowing pg int8 into a 500).

**Security posture:** reading another user's ticket by id is allowed BY
DESIGN (the board is community-visible) — what must never leak is author
identity, and the non-owner branch returns exactly what `/community` already
shows. Not an IDOR: ticket existence and content are already public via
`/community`; ownership is not probeable (a non-owner gets the same
anonymized view whether or not the ticket is theirs-that-they-can-edit,
because the owner branch already claimed every editable row).

### Client — `Tickets.tsx`, `services/tickets.ts`, `types/domain.ts`

- New `TicketDetailResult` union (`types/domain.ts`) mirrors the server's
  ownership decision as a checked discriminated union
  (`{kind:'own', ticket:OwnTicket} | {kind:'community', ticket:CommunityTicket}`).
- New `fetchTicket(id, signal)` service (`services/tickets.ts`) hits
  `GET /tickets/:id` and discriminates on `version` presence in the wire
  response.
- `Tickets.tsx` detail view now FETCHES the ticket by id (`loadDetail` →
  `fetchTicket`) with its own `AbortController`, cleared/aborted on every
  ticket-id change. The cached `mine`/`community` rows remain an
  instant-render fast path, but the view no longer DEPENDS on list
  membership. `canEdit` is derived from the server's owner-vs-anonymized
  decision (owner fetch OR `/mine` membership), never a client guess. A 404
  is treated as an answer ("no such ticket" → honest not-found card), not a
  retry-able error.
- The 409 stale-write recovery (`refetchOwnTicket`) now re-reads via
  `fetchTicket` too — id-addressed, so no board filter or list pagination
  window can hide the row it needs.
- `onTicketUpdated` also patches the id-addressed `detail` state so a
  successful save / 409 recovery lands on the authoritative row.

## Tests

**Server** (`server/tests/routes/tickets.test.ts`): `GET /tickets/:id`
unauthenticated → 401; overflow id → 400; own ticket → owner shape (version
+ source_page + comment_count, no identity columns); just-filed ticket
readable by id even when a filtered `/mine` excludes it (the regression);
another user's ticket → anonymized shape (is_mine=false, no version,
`assertAnonymized` over the whole payload); missing id → 404.

**Client** (`client/src/pages/Tickets.test.tsx`): file → open a ticket absent
from both filtered lists still renders detail (must FAIL if reverted to the
list-only lookup); detail loads under an active status filter that excludes
it from `/mine`; another user's ticket opened by id renders view-only; the
existing 409-recovery test rewired to route both the detail open and the
recovery refetch through `fetchTicket`.

## Gates

- Client: `npm run lint` 0, `tsc -p tsconfig.app.json --noEmit` 0, full
  `vitest run` 2238 passed / 0 failed, `vite build` OK.
- Server: `npm ci` + `npm run typecheck` 0, `vitest run
  tests/routes/tickets.test.ts` 41 passed (testcontainer).

No migration — the `tickets` table already exists; this is a read-only new
route over existing columns.
