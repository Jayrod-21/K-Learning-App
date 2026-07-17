# FIX REPORT — ticket-detail bug fix, fix-pass (branch `fix/ticket-detail-endpoint`)

Fix-pass over `docs/REVIEW_ticket_server.md` + `docs/REVIEW_ticket_client.md`
(two independent reviews, 0 BLOCKERS, 3 SHOULD-FIX). Fix-pass agent did not
author or review the original diff. All PRAISE items left intact (regression
tests, server-decided `canEdit`, honest 404/error states, the F-023
anonymized SELECT).

## Dispositions

| Finding | Source | Disposition | What was done |
| --- | --- | --- | --- |
| F-1 — save completing while the initial detail fetch is in flight gets overwritten by the fetch's stale response | client review, SHOULD-FIX | **FIXED** | `Tickets.tsx` `onTicketUpdated`: when the updated row is the ticket currently open (`updated.id === ticketId`), it now **aborts the in-flight `detailCtrlRef` fetch** and **seeds `detail` unconditionally** (`{ kind: 'own', ticket: updated }`) — even when `detail` was still `null`, the exact window the old `prev !== null` guard missed. A successful PATCH is itself a server ownership proof, and its response is at least as fresh as any concurrently in-flight GET, so the save is made authoritative by construction: the late GET response can never land (its controller is aborted; the `.then`/`.catch` bail on `signal.aborted`). The id check prevents a save resolving after navigation to a different ticket from clobbering (or aborting) the new ticket's own load. Test: `Tickets.test.tsx` "F-1 RACE" — detail fetch held pending via a captured resolver, save fully lands (PATCH resolved + toast), then the pre-save response is released; asserts the edit buffer keeps the saved title. **Verified to fail against the reverted (`prev !== null`) guard.** |
| F-2 — no direct tests for the detail 404/not-found and error/retry surfaces | client review, SHOULD-FIX | **FIXED** | Two direct tests added (`Tickets.test.tsx`): **F-2a** — direct navigation to a nonexistent id with the default 404 mock renders the honest not-found card, no spinner, no Retry button. **Verified to fail against a regression that routes 404 into `detailError`** (the retry-forever surface the reviewer warned about). **F-2b** — a non-404 (500) failure renders the ErrorCard (not the not-found card), and Retry re-drives `loadDetail` to recovery (`fetchTicket` called twice, second call renders the editable owner row). |
| S1 — SELECT-list parity by convention, not construction (4 hand-copied column lists) | server review, SHOULD-FIX | **FIXED** — option (a) + a belt-and-braces (b) test | Chose **(a) shared SQL fragments** as the review preferred: `routes/tickets.ts` now defines `OWNER_TICKET_COLS` (const) and `communityTicketCols(callerIdParam)` — the caller-id placeholder differs between `/community` (`$1`) and `GET /:id` (`$2`), so the community fragment takes it as a parameter whose TypeScript type is the literal union `'$1' \| '$2'`: nothing request-derived can ever be interpolated, compile-checked. All four queries now compose from these two fragments, so `/mine` vs `GET /:id`-owner and `/community` vs `GET /:id`-anon cannot drift apart structurally. Because a pure refactor has no revert-detectable behavior, a **shape-parity test** was added too (`tickets.test.ts` "SHAPE PARITY"): asserts `GET /:id` owner key set == a `/mine` row's key set, anon key set == a `/community` row's key set, plus the deliberate deltas (`version` owner-only, `is_mine` community-only) — it fails if any of the four shapes forks again, however the SQL is composed. |

## NITs

| Nit | Disposition | Notes |
| --- | --- | --- |
| N-1 (client) — stale 409 threat-model prose in `services/tickets.ts` (module header + `patchTicket` doc still said "refetch `listMyTickets`") | **FIXED** | Both spots now say recovery goes through `fetchTicket` (the id-addressed read), matching the code and `types/domain.ts`. Comment-only. |
| N-2 (client) — anonymity test's title/comment attribute the view-only outcome to the wrong cause (a scenario the real server can no longer produce) | **FIXED** | Test retitled ("the community-cached fallback path never grants edit rights from `isMine`") and its comment rewritten to state the real cause (the default 404 mock forces the cache-fallback path) and the real value (that path derives no edit rights from `isMine`). Assertions unchanged. |
| N-3 (client) — default `fetchTicket` 404 mock puts legacy detail tests in a non-production default state | **SKIPPED** | Reviewer's own call: "deliberate and documented … fine as is." Flipping the default would ripple through every legacy detail test for zero behavioral coverage gain. |
| N1 (server) — `assertAnonymized` is substring-based | **SKIPPED (partially mitigated)** | Pre-existing helper, outside this diff's scope, and reviewer marked it "fine to defer." The new shape-parity test adds exactly the kind of key-set assertion the reviewer suggested as the stronger form, on the routes this diff touched. |
| N2 (server) — no explicit non-numeric-id test | **FIXED** | One-liner added: `GET /tickets/abc` → 400 `validation_error`. |
| N3 (server) — two sequential queries in `GET /:id` | **SKIPPED** | Reviewer: "No change requested" — the two-query form is the safer posture (keeps `user_id` out of the app layer on the community path). |

## Gates (all green, run in this worktree)

Client (`client/`):

```
npm ci                                                     # clean, 0 vulnerabilities
npm run lint                                               # exit 0, 0 findings
npx tsc -p tsconfig.app.json --noEmit --incremental false  # exit 0, 0 errors
npx vitest run                                             # 128 files, 2241 tests, 0 failed  (was 2238; +3 new)
npx vite build --outDir /tmp/km-tf2-dist                   # exit 0
```

Server (`server/`, touched for S1):

```
npm ci                                                     # clean
npm run typecheck                                          # exit 0, 0 errors
npx vitest run tests/routes/tickets.test.ts                # 1 file, 43 tests, 0 failed  (was 41; +2 new — testcontainer, single run)
```

Revert-verification (each fix's test demonstrated to fail without its fix):

- F-1 race test vs the old `prev !== null` guard → **1 failed** (then fix restored).
- F-2a not-found test vs 404-routed-into-`detailError` → **1 failed** (then fix restored).
- S1: behavior-preserving refactor; the shape-parity test is the drift guard (fails on any future fork of the shapes).

## Self-assessment

- The F-1 fix deliberately goes further than the review's "cheapest fix"
  (seeding `detail` when `prev === null`): seeding alone does NOT close the
  race — the still-in-flight fetch's `.then` would immediately overwrite the
  seed with the pre-save row. Aborting the in-flight controller is what makes
  the save authoritative; the seed then makes the state coherent. The added
  `updated.id === ticketId` guard also closes a secondary race the old code
  had no exposure to only by luck (a save resolving after navigating to a
  different ticket would have been list-only before; with unconditional
  seeding it would have clobbered the new ticket's detail).
- `onTicketUpdated`'s `useCallback` deps grew `[ticketId]` — its identity now
  changes on ticket navigation. Checked the consumer chain (`TicketDetail`
  prop → `save`'s deps): re-created callbacks there are re-render-safe; no
  effect keys off `onTicketUpdated` identity.
- S1's interpolation of `callerIdParam` into SQL text is confined to a
  literal-union-typed parameter (`'$1' | '$2'`) with a comment stating the
  invariant — no request data can reach it, and the security posture the
  server review PASSed (parameterized values only) is unchanged.
- No PRAISE item was touched: the regression tests, the server-decided
  `canEdit` derivation, the 404-vs-error split, and the anonymized SELECT
  semantics are all byte-for-byte or behavior-for-behavior intact (the
  SELECTs now composed from fragments were kept textually identical modulo
  whitespace; the 43-test server suite, including the reviewer-praised
  anonymity and regression tests, passes unmodified).
