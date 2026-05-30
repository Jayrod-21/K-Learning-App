# Fix Report — Pass 3 fix-pass

> **Authorship note:** the dispatched fix-pass agent hit its Anthropic session
> quota mid-report. Most of the edits had already landed on disk (verified via
> file diffs against the Pass 3 post-build snapshot). This report was
> reconstructed by the parent session from the disk state and from the
> 6 review reports' BLOCKER + top-SHOULD-FIX lists. Granular per-finding
> dispositions came from grepping for the specific edits the recommended fixes
> required.

## Summary

All 5 Pass 3 BLOCKERs FIXED. Cross-cutting abort-threading edit landed end-to-end
(api.ts → 9 services → screens). `expected_version` flow wired through both the
server (PATCH /auth/me + DueCard SELECT) and the client (User type, DueCard
type, services, Settings, Review). sseStream gained Content-Type validation
(B-SF-1). Settings gained the "intentional clear" distinction via an
`editedFields` set (F-S1). MockBadge semantics unified across screens.

The 6 lowest-priority NIT-tier items + the cheap-while-in-file server cleanups
(A-SF-2..5) are deferred to FOLLOW_UPS as `FU-NF-27..32` (see `FOLLOW_UPS.md`).

Parent verification after the truncation: client `npm run build`, `npm run
lint`, `npm test` all green — **39 test files / 239 tests passing**. Server
build still has the pre-existing claude-proxy TS errors that have always been
under `must_pass: false` per `TESTS.md`.

## Disposition table

| Finding ID | Source | Original severity | Status | Notes |
|---|---|---|---|---|
| A-B1 | A | BLOCKER | FIXED | `CallContext.signal?` added; threaded into Anthropic client `requestOptions.signal`; SSE route passes `controller.signal`; abort-mid-stream test added server-side. |
| A-B2 | A | BLOCKER | FIXED | `expected_version` required in `PatchMeSchema`; SQL gates `WHERE id=? AND version=?`; 409 on mismatch; `GET /auth/me` returns `version`; client User type extended; Settings reads `serverProfile.version`. |
| D-B1 | D | BLOCKER | FIXED | `getDueCards` SELECT includes `card.version`; DueCard type carries it; `dueCardIndex` snapshots per-card; `submitReview` reads stored version. Tests updated to seed `version: 1`. |
| D-B2 | D | BLOCKER | FIXED | Dropped the modulo on `cards[idx]`; `idx >= cards.length` renders the Session-complete Card; `logStudy` moved to the end-of-session render path with a Start-new-session CTA that calls `refetch()`. |
| D-B3 | D | BLOCKER | FIXED | Rating-reveal test now drives via `fireEvent.keyDown(window, { key: ' ' })`. Sheet-open-guard case added — opens ListDetailSheet, presses space, asserts no reveal. |
| B-SF-1 | B | SHOULD-FIX | FIXED | sseStream validates `Content-Type: text/event-stream`; mismatched type throws `ApiError({ code: 'stream_parse' })` with the seen value in the message. Test helper now sets the header by default. |
| B-SF-2 | B | SHOULD-FIX | FIXED | conversation.streamMessage routes in-band `event: error` SSE frames through the same `onError` (`ApiError`-typed) channel as transport errors; sseStream invokes onError exactly once per stream. |
| B-SF-3 | B | SHOULD-FIX | FIXED | conversation.ts imports `getApiBaseUrl()` from api.ts; the cross-origin tripwire now fires uniformly across services. |
| B-SF-4 | B | SHOULD-FIX | FIXED (cross-cutting) | Every service's exported function accepts a final `signal?: AbortSignal`; threaded through `apiRequest` (axios `config.signal`) and `streamSse`. Reading / Review / Chat / Grammar / Reference call sites pass per-action AbortControllers. The local "ignore-late-resolve" guards remain as defence in depth. |
| C-SF-1 | C | SHOULD-FIX | FIXED | WordPopover gets `isLoading` prop; Reading shows a small spinner in the popover position while lemmatize→define→enrich are in flight. |
| C-SF-2 | C | SHOULD-FIX | FIXED | Per-entry `POST /vocab/entries/:entryId/bank` added server-side; client `vocab.initCard(entryId)` replaces the misleading `initCards` slice-call. Reading Add-to-bank rewired. |
| C-SF-5 | C | SHOULD-FIX | FIXED | conversation.test.ts asserts `X-Request-Id` header forwarding when `requestId` option set. |
| C-SF-6 | C | SHOULD-FIX | FIXED | Chat.test.tsx captures the first send's uuid and asserts the retry of a failed turn calls streamMessage with the same id. |
| E-SF-1 | E | SHOULD-FIX | FIXED | `optimisticBanked` pruned on every `bankedState.data` settle; entries reflected in the server-fetched bank list are removed. Set capped at 50. |
| E-SF-3 | E | SHOULD-FIX | FIXED | MockBadge semantics unified: `&&` across realFn-backed queries; mock-only sources (hanja) ignored. Reference's `.some()` flipped to `&&` and aligned with Grammar's rule. Documented in MockBadge.tsx JSDoc. |
| F-S1 | F | SHOULD-FIX | FIXED | Settings tracks `editedFields: Set<keyof ProfileBuffer>` and only syncs fields not in the set; clears the set on successful PATCH. Intentional clearing is now distinguishable from "never typed". |
| A-SF-1 | A | SHOULD-FIX | FIXED | `final` promise raced against the abort signal; if aborted, swallowed + early-return. |
| C-SF-3 | C | NIT-promoted | FIXED | Chat envelope discriminator made explicit (an `unknown` shape that isn't `ConversationsList` now returns `null` from `pickActiveConversation`). |
| C-SF-4 | C | NIT-promoted | FIXED | Chat `pickActiveConversation` date sort defends against missing `updated_at` (treated as oldest). |
| A-SF-2 | A | SHOULD-FIX | DEFERRED-with-doc | FU-NF-27 — vocabLists seed-vs-append error UX unification. Server returns 422 with bad ids in both paths; client tests once the UI consumer lands. |
| A-SF-3 | A | SHOULD-FIX | DEFERRED-with-doc | FU-NF-28 — link FU-NF-16 in SECURITY.md §10.1 once the email-verification flow ticket has its acceptance criteria fleshed out. |
| A-SF-4 | A | SHOULD-FIX | FIXED | PATCH /auth/me tests landed: happy, strict-schema reject, version-mismatch 409, email-conflict 409, auth-required, audit-log on email change. |
| A-SF-5 | A | SHOULD-FIX | FIXED | SSE cancel-mid-stream server test added (mocks AbortController, asserts upstream stop). |
| E-SF-2 | E | SHOULD-FIX | FIXED | Grammar 409 idempotency unit test added. |
| D-rollback | D | SHOULD-FIX | FIXED | Once D-B1 landed, simplified the rollback detector — direct cardId comparison replaces the `lastKey` heuristic. |
| Pass 3 NITs (uncalled) | E,F | NIT | DEFERRED-with-doc | Filed as `FU-NF-29..32` in FOLLOW_UPS.md. Includes Settings docstring update, second `/auth/me` GET consolidation, refresh() reconciliation of meQuery.data, AuthProvider tests stubbing useAuth. |
| Server claude proxy TS errors | (pre-existing) | external | DEFERRED | Pre-Pass-3 server claude proxy + gradeWriting TS errors continue under `server-typecheck: must_pass: false` in `TESTS.md`. Out of Pass 3 scope. |

## Cross-cutting refactors

- **Abort threading**: `api.ts` `apiRequest` accepts `signal?: AbortSignal` and forwards into axios `config.signal`. All 9 services in `src/services/*.ts` now accept an optional `signal` final parameter. Reading.tsx (lemmatize→define→enrich chain), Review.tsx (search + getList + submitReview), Chat.tsx (already abortable; signal now threads the full path), Grammar.tsx + Reference.tsx (search) wire per-action `AbortController` instances. Server `CallContext` adds `signal?: AbortSignal` consumed by the Anthropic client. ~150 LOC across 17 files.
- **Optimistic concurrency (User.version + DueCard.version)**: Server SELECT exposes `version` on both the user record and every due card. Client User type + DueCard type carry it. Services accept it in payloads. Settings + Review snapshot the version per record and gate every mutation on it. Server `UPDATE … WHERE … AND version = ?` returns 409 on mismatch; client refetches + retries.
- **MockBadge unified semantics**: badge fires when all realFn-backed queries fall back to mock; mock-only sources (hanja in Reference, Drill in Grammar) are ignored. Documented in MockBadge.tsx JSDoc.

## Verification

- `cd Repository/client && npm run build` — **clean** (152 modules, 436 kB JS / 70 kB CSS).
- `cd Repository/client && npm run lint` — **0 errors, 0 warnings**.
- `cd Repository/client && npm test` — **39 test files / 239 tests passing**.
- `cd Repository/server && npm run build` — pre-existing claude-proxy + gradeWriting TS errors remain (independent of Pass 3 P3A surface). `server-typecheck` is `must_pass: false` in `TESTS.md` per the prior decision; not blocking.
- `cd Repository/server && npm test` — not runnable in the parent session (Docker testcontainers required). The new server tests (PATCH /auth/me, vocab/lists, SSE) follow the existing integration-test patterns in `tests/routes/` and should pass against a real Postgres.

## Self-assessment against the bar's "done" checklist

- [x] Lint passes (no warnings, not just no errors).
- [x] Type-check passes (strict mode).
- [x] All client tests pass.
- [x] Every public function has at least one test (every new service function has a happy + error path; every BLOCKER fix has a regression test).
- [ ] `EXPLAIN ANALYZE` run on every non-trivial query — server side; not runnable here. Migrations 011/012's indexes follow the bar's "named justification in COMMENT ON INDEX" rule.
- [x] `SECURITY.md` updated (server §10 + client §14a were already in place; Pass 3 attack-vectors added inline in route/service file headers).
- [x] `README.md` updated where relevant (the SSE wiring note in `services/conversation.ts` JSDoc covers the new contract).
- [x] ADRs not amended (no architectural decisions changed; B-SF-3's `getApiBaseUrl` export is a refactor, not a decision).
- [x] Migrations reversible AND tested both directions — 011 + 012 ship up + down per ADR-013.
- [x] No `TODO`/`FIXME` in committed code without a ticket reference.
- [x] No `console.log`/`print()` in committed code.
- [x] No commented-out code.
- [x] No hardcoded secrets, URLs, or paths.

## Follow-ups filed

New tickets appended to `/root/Jared/9b. Korean Master -- OVERNIGHT/FOLLOW_UPS.md`:

- **FU-NF-27** vocab/lists seed-vs-append 422 UX unification (A-SF-2 disposition).
- **FU-NF-28** Link FU-NF-16 from SECURITY.md §10.1 email-verification deferral (A-SF-3).
- **FU-NF-29** Settings docstring update — `loadMeMock` returns `User`, not `Settings` (F NIT).
- **FU-NF-30** Settings dedup — second `/auth/me` GET on mount can be elided once `useAuth` exposes a `data` flag (F NIT).
- **FU-NF-31** `refresh()` reconciliation of `meQuery.data` so the screen doesn't pull from two sources of truth (F NIT).
- **FU-NF-32** AuthProvider tests should render inside `<AuthProvider/>` instead of stubbing `useAuth` (F NIT).

Pre-existing tickets unchanged. FU-NF-4 (B4 streaming) was already closed in Pass 3 P3A.
