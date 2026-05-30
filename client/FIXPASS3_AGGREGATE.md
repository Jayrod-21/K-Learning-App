# /fixpass — Pass 3 aggregate

> Aggregator: parent session. Sources: `REVIEW_P3{A..F}*.md`. Date: 2026-05-29.

## Reviewer roll-up

| Reviewer | Surface | Verdict | BLOCKER | SHOULD-FIX |
|---|---|---|---:|---:|
| A — server additions | migrations 011/012, auth PATCH, vocabLists, SSE streaming, SECURITY.md §10 | REQUEST CHANGES | **2** | 5 |
| B — client services + sseStream | 9 services + sseStream + 10 tests | PASS WITH CONDITIONS | 0 | 5 |
| C — Reading + Chat | tap-anything chain + SSE consumer | PASS WITH CONDITIONS | 0 | 6 |
| D — Review | 1300-line file: sessions+lists+all | PASS WITH CONDITIONS | **3** | 8 |
| E — Grammar + Reference | list/bank + multi-source search | PASS WITH CONDITIONS | 0 | 6 |
| F — Settings + plan | profile wiring + AuthProvider.refresh + plan compliance | PASS WITH CONDITIONS | 0 | 1 |
| **Total** | — | **REQUEST CHANGES** | **5** | **31** |

## BLOCKERs — every one, explicitly

| ID | Source | File:line | Headline | Recommended fix |
|---|---|---|---|---|
| **A-B1** | A | `Repository/server/src/routes/conversation.ts:385-392,460-463` vs `services/claude/index.ts:128-135` | SSE abort never reaches Claude proxy. `CallContext` has no `signal` field, so `req.on('close')` aborts the express response but NOT the upstream Claude call. Threat-model claim in SECURITY.md §10 is false. Cost-amplification: a user disconnect mid-stream still drains the full Claude completion. | Extend `CallContext` with `signal?: AbortSignal`. Thread it into the Anthropic client's `requestOptions.signal`. Update the streaming route to pass `controller.signal`. Add a test that aborts mid-stream and asserts the upstream mock was canceled. |
| **A-B2** | A | `Repository/server/src/routes/auth.ts:288-302` | PATCH /auth/me bumps `users.version = version + 1` with no `expected_version` gate. Two concurrent profile saves silently last-writer-wins on the canonical recovery channel (email). Per bar §1 "Optimistic concurrency via the version column for any row a user might edit". | Accept `expected_version` in the PATCH body (or `If-Match` header — pick one and document). `UPDATE … WHERE id = ? AND version = ?` — verify rowCount; 409 with current row on mismatch. Client (Settings) supplies `serverProfile.version`; server's `GET /me` exposes it. |
| **D-B1** | D | `src/pages/Review.tsx:208` | `expected_version: 1` hardcoded in submitReview payload. Every re-rating of any card 409s. Breaks the FSRS learning loop the moment a user rates anything they've previously rated. | (a) Server `getDueCards` SELECT must include the card's current `version`. (b) DueCard wire type carries it. (c) `dueCardIndex` Map stores the snapshot's version. (d) `submitReview` reads the stored version per rating. Add a test that re-rates the same card twice and asserts both succeed. |
| **D-B2** | D | `src/pages/Review.tsx:370` | `cards[idx % Math.max(1, cards.length)]` loops the session infinitely past end-of-deck. `progressPct` overflows past 100%; "time remaining" goes negative; no terminal state. | Drop the modulo. When `idx >= cards.length`, render a "Session complete" Card with `progress.logStudy` already settled + a "Start new session" CTA that calls `refetch()` on the due-cards hook. Test: simulate rating every card → assert terminal state visible. |
| **D-B3** | D | `src/pages/Review.test.tsx` (rating-reveals path) | Spacebar reveal contract is the Pass-2 PRAISE item; the test exercises Flashcard reveal via clicking the role-button, leaving the spacebar handler (with its sheet-open guard) uncovered. A regression in the keydown listener would ship green. | Replace the click with `fireEvent.keyDown(window, { key: ' ' })` per Pass 2 idiom, assert reveal happens. Add a second case: open ListDetailSheet, press space, assert reveal does NOT fire (sheet-open guard). |

## Top SHOULD-FIX (highest impact)

| ID | Source | Headline |
|---|---|---|
| **B-SF-1** | B | `sseStream` doesn't validate `Content-Type: text/event-stream`. A misrouted 200 HTML page silently produces zero events and calls `onDone`. |
| **B-SF-2** | B | `conversation.streamMessage` fires `onError` on in-band `event: error` SSE events AND forwards sseStream's transport `onError` — consumers can receive a callback twice; typed payload widens from `ApiError` to `Error`. |
| **B-SF-3** | B | `conversation.ts` re-derives `VITE_API_URL` directly, bypassing `api.ts`'s cross-origin tripwire (`warnInsecureCrossOriginCookiePosture`). |
| **B-SF-4** | B | Per-keystroke services (`lemmatize`, `searchEntries`, `listPatterns`, `identifyPattern`) lack an `AbortSignal` parameter. P3C/D/F all work around with local AbortControllers + ignore-late-resolve; that's not a substitute for actual cancellation. |
| **C-SF-1** | C | No loading affordance during cold-start tap-path (lemmatize→define→enrich). User taps a word; nothing renders for ~500ms; WordPopover appears suddenly. |
| **C-SF-2** | C | `vocabInitCards` slice-vs-per-entry mismatch should be REMOVED, not honestly hidden in a comment. Either wire a real per-entry endpoint (add to server) or queue the bank action client-side until Pass 4 ships the route. |
| **C-SF-5** | C | `conversation.test.ts` doesn't assert `X-Request-Id` header forwarding. |
| **C-SF-6** | C | `Chat.test.tsx` doesn't assert same-requestId reuse on retry of a failed turn (the idempotency contract is the whole FU-NF-4 closeout value). |
| **D-rollback** | D | `lastKey` detector for rate-rollback breaks under the session-loop re-rating that B2's fix removes; once B2 lands, re-verify. |
| **E-SF-1** | E | `optimisticBanked` accumulates across the session with no pruning despite a JSDoc that promises cleanup. Memory leak in long sessions. |
| **E-SF-2** | E | 409 idempotency code path in Grammar bank is unit-test-uncovered despite being load-bearing in the threat model. |
| **E-SF-3** | E | Reference MockBadge fires permanently on default 'all' filter because hanja has no realFn AND the gating uses `.some()` instead of Grammar's `&&` (semantics mismatch between the two screens). |
| **F-S1** | F | Settings sync effect's `=== ''` clause clobbers a user's intentional clearing of a field. Conflates "never typed" with "deliberately cleared". |
| **A-SF-1** | A | Leaked `final` promise on disconnect in the SSE route — once the client closes, the server's await chain still resolves and tries to write to a dead response. |
| **A-SF-2** | A | Inconsistent seed-vs-append not-found UX in vocabLists (`POST /lists/:id/entries` with bad entry id behaves differently from `POST /lists` with bad seed_entry_ids). |
| **A-SF-3** | A | SECURITY.md §10.1 email-verification deferral has no ticket id link. |
| **A-SF-4** | A | No PATCH /auth/me tests at all in `auth.test.ts`. |
| **A-SF-5** | A | Missing SSE cancel-mid-stream test on server. |

## Cross-cutting observations

1. **Abort plumbing is the dominant theme.** Server doesn't forward abort to Claude (A-B1); client services don't accept signals (B-SF-4); Reading + Chat work around with local controllers (C). All resolved by one coordinated edit: add `signal?: AbortSignal` to every service signature + thread it through `api.ts` `apiRequest` → axios config + add it to `CallContext`/Anthropic client.
2. **Test coverage of the idempotency story is thin.** X-Request-Id forwarding (C-SF-5), reuse on retry (C-SF-6), 409 bank idempotency (E-SF-2), expected_version retry (A-B2 once fixed) — the whole "safe to retry" contract goes untested.
3. **MockBadge semantics drifted between Grammar and Reference** (E-SF-3). Pick one rule and apply uniformly: badge fires when "no realFn at all" OR "all configured realFns mock-fell-back". Document in MockBadge.tsx.
4. **PATCH /auth/me's missing version gate (A-B2) silently disagrees with Pass 1 SECURITY.md §2's "we treat the cookie as the only canonical state".** Email-change without optimistic concurrency means a hijacked session winning a race against a legitimate one is undetectable.
5. **D-B1 (hardcoded expected_version: 1)** is a Pass 3 wiring bug, not a server bug. Server emits version correctly for vocab_cards — client just drops it on the floor.

## PRAISE — fix-pass must not undo (cross-Pass)

- **From Pass 1**: cookie auth threat model, ApiError boundary, provider/hook/context split, BottomNav location-derived, lib/nav.ts, AuthProvider AbortController.
- **From Pass 2**: useModalA11y, ErrorCard, useEndpointOrMock.refetch + key-change reset, Diagnostic mode-init pattern, Settings substrate.
- **From Pass 3 (per reviewers)**:
  - A: idempotency-check-BEFORE-version-gate on SSE (so a retry never 409s), dup-detect under FOR UPDATE on vocab_list_entries, persistence-as-last-step on streaming, SSE-framed post-headers errors (no JSON middleware corruption), phone Zod regex matches DB CHECK byte-for-byte.
  - B: sseStream reader-cancel race fix (parent caught + agent retained), `raceAgainstAbort` pattern intact, ApiError boundary held across all 10 services.
  - C: threat-model headers at the senior-engineer bar, graceful-degradation tiering on the Reading slow-path, FU-NF-4 contract delivered.
  - D: ratings Map, empty-vs-error split, dueCardIndex Map, debounced re-key on All tab.
  - E: optimistic-bank → refetch reconciliation, 409 idempotency baked in (test gap aside), Reference 200ms debounce keying the hook is "the cleanest expression of D-SF-1 in the codebase".
  - F: server-as-truth pattern, 600ms debounce + minimal-diff PATCH, abort-on-unmount, AuthProvider.refresh as additive context surface, one-way email/phone → notif-channel coupling preserved.

## Recommendation

Dispatch a single fix-pass agent against:

- **Every BLOCKER (5)**: A-B1, A-B2, D-B1, D-B2, D-B3.
- **High-leverage SHOULD-FIX (10)**: B-SF-1, B-SF-2, B-SF-3, B-SF-4 (the abort threading is one coordinated edit + closes the C, D, E workarounds), C-SF-1, C-SF-5, C-SF-6, E-SF-1, E-SF-3, F-S1.
- **Cheap-while-in-file**: C-SF-2 (queue or remove), A-SF-1..5 (small server cleanups), E-SF-2 (one test).

Out of scope (file in FOLLOW_UPS.md): NITs not listed above. Server pre-existing claude proxy TS errors (already FU). Plan-doc edit for `/grammar/recognize` → `/identify` (code is correct, plan is stale — already noted).

Estimated agent scope: ~50 changes across ~25 files. Larger than Pass 2 fix-pass; expect 1.5–2× the work. The abort-threading cross-cut alone touches `api.ts`, all 9 services, all 6 wired screens, server CallContext, and Anthropic client.
