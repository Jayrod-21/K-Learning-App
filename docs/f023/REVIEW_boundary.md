# F-023 Ticketing — Boundary + Trust/Anonymity Review

**Scope:** `client/src/services/tickets.ts`, `client/src/types/domain.ts` (Ticket*
section), `client/src/App.tsx` (`/tickets` route), `client/src/pages/Settings.tsx`
+ `.css` + `.test.tsx` (Beta feedback entry tile). Read for context:
`server/src/routes/tickets.ts` (backend contract + threat model), and
`client/src/pages/Tickets.tsx` (necessary to verify the isMine/edit-rights claim,
since that logic lives on the consuming page, not the boundary files).

**Reviewer:** independent, did not write this code. Report-only — no code
modified.

## Verdict

**PASS.** This is a well-engineered, honest boundary. The anonymity contract is
enforced at the type level (not just by convention), edit rights are never
inferred from `isMine`, the wire↔domain mapping is fully typed with no `any`,
and the Settings entry point is a clean, minimal, correctly-tested addition.

**Blockers: 0. Should-fix: 0. Nits: 2. Praise: 4.**

Explicit anonymity verdict: **PASS.** No author-identifying field exists on
any community-facing client type (`CommunityTicket`, `TicketComment`), the
server SELECTs backing them carry no `user_id`/join to `users`, and the only
identity signal (`isMine`) is a caller-relative boolean that cannot be used to
derive or spoof edit rights — confirmed at the actual consumption site
(`Tickets.tsx`), where `canEdit` is computed strictly from membership in the
`GET /tickets/mine` result, never from `isMine`.

## Anonymity / trust checklist

| Check | Verdict | Evidence |
|---|---|---|
| Author-leak (types carry no author field) | **PASS** | `CommunityTicket` (domain.ts:2307–2318) and `TicketComment` (domain.ts:2334–2339) have no `userId`/`email`/author field of any kind — only `id, type, title, body, status, commentCount, isMine, createdAt, updatedAt` / `id, body, isMine, createdAt`. Wire counterparts `CommunityTicketWire`/`TicketCommentWire` (tickets.ts:63–81) mirror this exactly. Grep across all F-023 client files for `user_id`/`userId`/`author`/`username` turns up zero hits inside ticket code (only unrelated `NotifPrefs.channel.email` matches). |
| `isMine` ≠ edit-privilege | **PASS** | `Tickets.tsx:977`: `canEdit={mineDetail !== null}` — `mineDetail` is the row found by id in the already-fetched `GET /tickets/mine` array (line 947), which is the only source of a `version` field. `isMine` is used exactly once, purely for display (`showsAsMine` → a "Yours" `Pill`, line 560/658–662) and is explicitly type-guarded off `canEdit` (`!canEdit && 'isMine' in ticket && ticket.isMine`) so it can never fire concurrently with real edit rights. The edit `<form>` is gated on `canEdit`, not `isMine` (line 665). Module header (Tickets.tsx:41–44) states the invariant explicitly and the code matches it. |
| Boundary narrowing (no `any`, schemas match) | **PASS** | `services/tickets.ts` has zero `any`/`as any`/`<any>` anywhere. Every wire interface (`OwnTicketWire`, `CommunityTicketWire`, `TicketCommentWire`, and the 5 envelope types) is explicitly declared and mapped through `toOwnTicket`/`toCommunityTicket`/`toComment`. Bodies sent match the server's `.strict()` Zod schemas 1:1: `CreateBodySchema{type,title,body}` ↔ `createTicket`'s POST body; `PatchBodySchema{title?,body?,status?,expected_version}` ↔ `patchTicket`'s conditionally-built body; `CommentBodySchema{body}` ↔ `addTicketComment`. `expectedVersion` is a required (non-optional) field on `PatchTicketBody` (domain.ts:2326–2331) and is threaded to `expected_version` on every PATCH (tickets.ts:204). |
| Entry point (Settings tile + route) wired cleanly | **PASS** | `App.tsx:146` adds `<Route path="tickets" element={<Tickets />} />` inside the existing `RequireAuth`+`Shell` subtree (correctly auth-gated, no new top-level route). `Settings.tsx` diff vs `rebuild` is a single additive `SettingsGroup` block (25 lines) + one `useNavigate` import — no edits to any other Settings group. `Settings.test.tsx` genuinely asserts navigation: it renders a real two-route tree (`/settings` + a `/tickets` probe), clicks the button, and asserts `tickets-probe` mounted (`Settings.test.tsx:1738–1756`) — not a mocked `navigate` call. `/Beta feedback/` was also added to the existing "collapsed by default" sweep test. |

## Detailed findings

### PRAISE

1. **Type-level anonymity, not just convention** — `types/domain.ts:2265–2274`
   and `services/tickets.ts:11–19` both state the invariant in prose, and the
   types back it up structurally: there is no field on `CommunityTicket` or
   `TicketComment` a future screen could reach for to render an author even by
   accident. This is the correct way to enforce this kind of contract (compare
   to the diagnostic/mock-test answer-stripping pattern already established
   elsewhere in `domain.ts`, e.g. `DiagnosticLiveItem`/`TopikMockChoice` —
   same discipline, consistently applied).

2. **`canEdit` derivation is provably correct, not just documented** —
   `Tickets.tsx:947–951,977`: both `/mine` and `/community` are fetched
   unconditionally on mount, so `canEdit` is never a stale/optimistic guess —
   it reflects the server's actual answer to "is this the caller's own
   ticket" at the moment of render. The one-line comment at 949–950 explains
   why `mine` wins when a ticket appears in both lists (only that copy
   carries `version`).

3. **409 optimistic-concurrency recovery matches the documented contract
   exactly** — `Tickets.tsx:591–643`: client-side also refuses to PATCH with
   an empty diff (mirrors the server's `.refine()` at
   `routes/tickets.ts:214–218`), and the 409 path pulls a fresh row, resets
   the draft, and surfaces a `role="status"` conflict notice rather than
   silently discarding the user's edit or blindly retrying.

4. **F-127/F-110 ticket references are accurate** — cross-checked against
   `BUGS_AND_FEATURES.md`: F-127 (`App.tsx:145`, `Settings.tsx:1243`) is
   indeed "Global entry point (FAB) for the beta ticketing page" (line 1371),
   correctly framed as a discoverability follow-up, not a blocker. F-110 is
   an unrelated grammar-drill-history ticket (`domain.ts:1455,1474`) and does
   not appear anywhere in the F-023 client code — no stray/confused
   reference.

### NIT

1. **`services/tickets.ts` has no unit test of its own in this diff's scope**
   (coverage instead lives in `Tickets.test.tsx`, which exercises the service
   indirectly through the page). Given the mapping functions are pure and
   trivial, this is a nit, not a gap that changes the verdict — but a direct
   `toCommunityTicket`/`toComment` unit test would make a future wire-shape
   regression (e.g. someone adding `user_id` to the server SELECT) fail
   closer to the boundary than to the page.

2. **No runtime schema validation at the client boundary** (`api.get<T>`/
   `api.post<T>` trust the generic `T` — a server bug that started including
   `user_id` on `/tickets/community` would flow through
   `toCommunityTicket`/`toComment` silently since those functions only *pick*
   named fields, they don't assert the wire object's shape). This is
   pre-existing, deliberate, and documented app-wide policy (`domain.ts:16–20`:
   "No runtime zod validation... the type IS the contract"), consistently
   applied to every other service in the codebase — flagging only so it's on
   record that the anonymity contract's last line of defense is still "the
   server behaves," not "the client would catch it," should that policy ever
   be revisited for this specific feature given how much anonymity matters
   here.

## Files reviewed

- `/home/jared-williams/projects/9b. Korean Master/client/src/services/tickets.ts`
- `/home/jared-williams/projects/9b. Korean Master/client/src/types/domain.ts` (lines 2265–2348)
- `/home/jared-williams/projects/9b. Korean Master/client/src/App.tsx`
- `/home/jared-williams/projects/9b. Korean Master/client/src/pages/Settings.tsx`
- `/home/jared-williams/projects/9b. Korean Master/client/src/pages/Settings.css`
- `/home/jared-williams/projects/9b. Korean Master/client/src/pages/Settings.test.tsx`
- `/home/jared-williams/projects/9b. Korean Master/server/src/routes/tickets.ts` (context, unchanged in this diff)
- `/home/jared-williams/projects/9b. Korean Master/client/src/pages/Tickets.tsx` (context, necessary to verify the isMine/edit-rights claim)
