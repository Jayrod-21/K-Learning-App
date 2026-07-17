# Independent Review — Ticket Detail Fix, CLIENT half (`fix/ticket-detail-endpoint`)

Reviewer: independent senior reviewer (did not author this code). Scope: the client
half of the ticket-detail bug fix — the detail view now fetches by id via
`GET /tickets/:id` instead of resolving purely from the cached, filtered lists.
Diff reviewed: `git diff origin/rebuild...fix/ticket-detail-endpoint -- client/`
(4 files: `Tickets.tsx`, `Tickets.test.tsx`, `services/tickets.ts`, `types/domain.ts`).

---

## Summary verdict

**PASS — no blockers.** The bug is genuinely fixed and the regression test genuinely
proves it: with BOTH cached lists mocked empty, the detail renders (editable, owner
shape) solely from the mocked `fetchTicket`, and reverting to the old `mine.find`
lookup would fail the test at its first assertion. Edit rights are derived from the
server's owner-vs-anonymized response shape (verified against the server route — the
`'version' in wire` discriminator exactly mirrors the two SELECT lists in
`routes/tickets.ts:239-310`), never from a client guess. 404 renders an honest
not-found card, network errors render an ErrorCard with a working retry, abort
handling is disciplined on id-change and unmount, and the 409 recovery is rewired
end-to-end through `fetchTicket` with a non-tautological test. Two SHOULD-FIX items:
a narrow save-vs-in-flight-detail-fetch stale-overwrite race, and missing direct test
coverage for the detail view's 404/not-found and error/retry surfaces. Full gate
suite: **lint 0 errors, tsc 0 errors, vitest 128 files / 2238 tests, 0 failed.**

Findings: **0 BLOCKER · 2 SHOULD-FIX · 3 NIT · 4 PRAISE.**

---

## Bar checklist

| Bar item | Verdict | Evidence |
| --- | --- | --- |
| THE BUG is fixed: filing then opening renders detail even when the board filter excludes the row from `/tickets/mine` | **PASS** | `Tickets.tsx:1134-1157` (`loadDetail`), `:1238-1253` (fetched row is authoritative in render); regression tests `Tickets.test.tsx:473-505` and `:507-527` |
| Regression test exercises the empty-cached-lists case and fails if reverted to list-only lookup | **PASS** | `Tickets.test.tsx:480-481` mocks BOTH lists to `[]`; the row is reachable only via the `fetchTicket` mock (`:487`). On revert, `ticket` resolves `null` → the not-found card renders → `findByRole('textbox', {name: 'Title'})` (`:495-497`) times out and the `fetchTicket` call assertion (`:501-504`) fails. Not a tautology. |
| `canEdit` comes from the SERVER's owner-vs-anonymized shape, never a client guess | **PASS** | `canEdit={ownDetail !== null}` (`Tickets.tsx:1290`) where `ownDetail = fetchedOwn ?? mineDetail` (`:1252`) — both server-decided (`/tickets/:id` owner branch, `/mine` membership). Community `isMine` never grants edit. Wire discriminator `'version' in wire` (`services/tickets.ts:222-224`) matches the server exactly: the owner SELECT includes `version`, the community SELECT does not (`server/src/routes/tickets.ts:255-263`, `:294-300`). View-only test: `Tickets.test.tsx:529-552`. |
| No stuck states: 404 → honest not-found card; network error → error surface with retry; loading → spinner | **PASS (code); coverage gap (tests)** | 404 leaves `detailError` null so render falls through to the not-found card (`Tickets.tsx:1149-1154`, `:1282-1286`); non-404 sets `detailError` → `ErrorCard` with `onRetry={() => loadDetail(ticketId)}` (`:1275-1281`); `detailLoading` drives the spinner (`:1271`). `setDetailLoading(false)` runs on every non-aborted settle — no infinite spinner path found. But neither failure surface has a direct test — see F-2. |
| 409 recovery via `fetchTicket`: reloads fresh row + recovery notice + test asserts the new path | **PASS** | `refetchOwnTicket` (`Tickets.tsx:1026-1046`) calls `fetchTicket`, returns `null` on 404 and on a non-own shape, patches `mine` in place, rethrows other errors to the retry-able save error. Test (`Tickets.test.tsx:589-635`) asserts `fetchTicket` called exactly twice with the right id, the buffer replaced with the fresh title, and the notice shown — all of which fail against the old `listMyTickets` implementation. |
| AbortController cleanup on id-change/unmount; no setState-after-abort | **PASS** | Effect cleanup aborts on id change and unmount (`Tickets.tsx:1169-1171`); `loadDetail` aborts any prior in-flight fetch (`:1136-1137`); both `.then` and `.catch` bail on `ctrl.signal.aborted` and swallow `code === 'canceled'` (`:1142`, `:1147-1148`). A→B race: B's effect clears `detail` synchronously before fetching (`:1165`), A's controller is aborted, and the render-side `.ticket.id === ticketId` guard (`:1239`, `:1245`) is belt-and-braces. A's late response cannot render under B. `refetchOwnTicket` has its own controller + unmount abort (`:1025-1030`, `:1048-1052`). |
| Strict TS at the boundary | **PASS** | Typed wire envelope `api.get<{ ticket: OwnTicketWire \| CommunityTicketWire }>` narrowed via the `in` operator into the `TicketDetailResult` discriminated union (`services/tickets.ts:214-225`; `types/domain.ts:2615-2624`); conditional `{ signal }` spread respects `exactOptionalPropertyTypes`. `tsc --noEmit` clean. |
| No scope creep | **PASS** | Every hunk serves the id-addressed detail fetch, the 409 rewire, or their documentation. No unrelated behavior changed. |

---

## Findings

### BLOCKER
None.

### SHOULD-FIX

- **F-1 — Save completing while the initial detail fetch is in flight can be
  overwritten by the fetch's stale response.** `Tickets.tsx:1191-1201` +
  `:1134-1157`. `onTicketUpdated`'s `setDetail` guard is `prev !== null` — if the
  user opens a cached-in-`mine` ticket (instantly editable via the fast path),
  edits, and saves *before* the authoritative `GET /tickets/:id` resolves (slow
  network), the PATCH's updated row lands only in `mine` (`detail` is still
  `null`, so the guard skips), and the still-in-flight detail fetch then resolves
  with the **pre-save** row and stores it. Because `fetchedOwn` outranks
  `mineDetail` in the render (`:1252`), the view snaps back to the stale
  title/body/version and the edit buffer resets to it (`TicketDetail`'s
  `ownVersion` effect, `:710-714`); a subsequent save sends the stale
  `expectedVersion` → 409 → recovery refetch. Self-healing, and the window is
  narrow (requires save to outrun the detail fetch), so not a blocker — but it is
  a real stale-data flash that contradicts the "detail outranks the caches"
  comment's intent. Cheapest fix: in `onTicketUpdated`, seed `detail` with
  `{ kind: 'own', ticket: updated }` even when `prev === null` (a successful
  PATCH is itself a server ownership proof), or drop a late `loadDetail` result
  whose `version` is lower than the row already held.

- **F-2 — The two detail failure surfaces the fix introduces have no direct
  tests.** `Tickets.test.tsx` never asserts (a) a direct navigation to a
  nonexistent id renders "We couldn't find that ticket." (the 404 path with no
  cached row — the only 404 coverage rides incidentally on the `beforeEach`
  default mock under tests asserting *other* things), nor (b) a non-404
  `fetchTicket` failure renders the `ErrorCard` and its Retry re-invokes
  `loadDetail` and recovers. Both branches exist in code
  (`Tickets.tsx:1275-1286`) and are central to the "no stuck states" contract of
  this fix; either could regress silently today (e.g. someone setting
  `detailError` on 404 would reintroduce a retry-forever surface with no test
  failing). Two small tests close this.

### NIT

- **N-1 — Stale module-header threat model in the service.**
  `services/tickets.ts:20-23` still says a 409 means "Callers must refetch
  `listMyTickets` and let the user retry" — this branch's own change made that
  false (recovery now goes through `fetchTicket`; `types/domain.ts:2628-2631` was
  updated to say exactly that, and `fetchTicket`'s own doc block is correct).
  One sentence to update.

- **N-2 — The anonymity test's premise is now counterfactual and its comment
  misleading.** `Tickets.test.tsx:438-453` ("opening the caller's own ticket from
  the Community tab still renders it view-only unless it's also in My tickets"):
  against the real server, `GET /tickets/:id` returns the OWNER shape for the
  caller's own ticket, so this scenario now renders *editable* in production —
  the test only sees view-only because the default `fetchTicket` mock rejects
  with 404 (`:107-109`), a state the real server cannot produce for a ticket the
  community list just returned. The inline comment ("canEdit is false because
  this row never appeared in GET /tickets/mine") attributes the outcome to the
  wrong cause. The test still has value (it proves the 404-fallback cache path
  never grants edit from `isMine`), but its title/comment should be rewritten to
  say that, so a future reader doesn't "fix" production to match it.

- **N-3 — The `beforeEach` default of rejecting `fetchTicket` with 404 makes
  every pre-existing detail test exercise the "authoritative fetch failed, cache
  fast path carried the render" state** (`Tickets.test.tsx:104-109`) rather than
  the normal production state where both agree. Deliberate and documented, and it
  conveniently proves the fast path works — but a default that resolves with the
  matching row (overridden to reject where the fallback is the point) would make
  the suite's default world match production's. Judgment call; fine as is.

### PRAISE

- **P-1** — `TicketDetailResult` (`types/domain.ts:2615-2624`) surfacing the
  server's ownership decision as a checked discriminated union, with the wire
  discriminator (`'version' in wire`, `services/tickets.ts:222-224`) verified to
  mirror the server's two SELECT lists exactly, is the right boundary design:
  ownership is decided once, server-side, and flows through the type system
  instead of being re-guessed per call site.
- **P-2** — The regression test (`Tickets.test.tsx:473-505`) is a textbook
  bug-shaped test: it reconstructs the exact production state (detail URL, both
  cached lists empty), asserts the fixed outcome AND the absence of the buggy
  outcome, and demonstrably fails on revert.
- **P-3** — The 409-recovery rewire kept the whole recovery contract intact
  (fresh row, buffer replacement, notice, "genuinely gone" surface) while also
  quietly fixing a second latent bug the old code had: a `/mine` pagination
  window could hide the row a stale-write recovery needed
  (`Tickets.tsx:1013-1024` documents this honestly).
- **P-4** — Abort discipline is uniform and correct across all four fetch paths
  (mine, community, detail, recovery): per-call controllers, supersede-on-refire,
  unmount cleanup, aborted-signal guards before every setState, and a
  synchronous `setDetail(null)` on id change so ticket A's data can never render
  under ticket B's id.

---

## Detailed findings (file:line index)

| Ref | File:line | Category | One-liner |
| --- | --- | --- | --- |
| F-1 | `client/src/pages/Tickets.tsx:1191-1201`, `:1134-1157`, `:1252` | SHOULD-FIX | Late detail-fetch response can overwrite a just-saved row when `detail` was still `null` at save time (self-heals via 409, but flashes stale data) |
| F-2 | `client/src/pages/Tickets.test.tsx` (absent), code at `Tickets.tsx:1275-1286` | SHOULD-FIX | No direct test for the detail 404 → not-found card, nor for the detail error → ErrorCard → Retry recovery |
| N-1 | `client/src/services/tickets.ts:20-23` | NIT | Module-header threat model still tells 409 handlers to refetch `listMyTickets` |
| N-2 | `client/src/pages/Tickets.test.tsx:438-453` | NIT | Test title/comment describe a scenario the real server can no longer produce; outcome is caused by the mocked 404, not `/mine` absence |
| N-3 | `client/src/pages/Tickets.test.tsx:104-109` | NIT | Default `fetchTicket` 404 rejection puts legacy detail tests in a non-production default state (documented, deliberate) |
| P-1 | `client/src/types/domain.ts:2615-2624`; `client/src/services/tickets.ts:198-225`; `server/src/routes/tickets.ts:239-310` | PRAISE | Server-decided ownership surfaced as a checked discriminated union; wire discriminator verified against both server SELECTs |
| P-2 | `client/src/pages/Tickets.test.tsx:473-505` | PRAISE | Regression test reconstructs the exact bug state and fails on revert |
| P-3 | `client/src/pages/Tickets.tsx:1013-1046` | PRAISE | 409 recovery rewire preserves the full contract and fixes the old pagination-window blind spot |
| P-4 | `client/src/pages/Tickets.tsx:1132-1172`, `:1238-1247` | PRAISE | Uniform abort discipline + synchronous clear-on-id-change kills the A/B race |

---

## Gate run (full client suite, this worktree)

```
cd client && npm ci                                        # clean, 0 vulnerabilities
npm run lint                                               # exit 0, no findings
npx tsc -p tsconfig.app.json --noEmit --incremental false  # exit 0, no errors
npx vitest run                                             # 128 files passed, 2238 tests passed, 0 failed (39.4s)
```
