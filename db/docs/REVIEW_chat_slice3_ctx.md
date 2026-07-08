# REVIEW — chat rework Slice 3: CONTEXT + POPUP + FAB slice (commit 1e13623)

Reviewer: independent senior (React). Scope: `client/src/lib/chatContext.ts`, `client/src/hooks/useChatContext.ts`, `client/src/components/ChatFab.tsx`, popup + FAB-entry logic in `client/src/pages/Chat.tsx`, 5 publishing pages (Today/Progress/Ttmik/Topik/Grammar). Image-upload path NOT in scope (other reviewer).

Ran (Docker, node:20-slim): `tsc -b --force` = 0, `eslint .` = 0, vitest targeted (chatContext.test.ts, hooks, ChatFab.test.tsx, Chat.test.tsx) = 156/156 pass.

## VERDICT: NOT APPROVED — 1 BLOCKER (popup's modal a11y machinery dead in prod + scroll-lock leak), otherwise the slice is solid. Fix is small + localized.

---

## BLOCKER

### B-1. Popup focus-trap + initial-focus never arm in production; body scroll-lock leaks onto skeleton/error screens
- `client/src/pages/Chat.tsx:647-651` — `useModalA11y({ open: contextPopupOpen, ... })` armed unconditionally at mount.
- `client/src/pages/Chat.tsx:1515-1522` — the popup DOM (`popupRef` div, Chat.tsx:1622) renders only inside the third branch of `loading ? <SkeletonCard/> : hasNothingToShow ? <ErrorCard/> : <layout>`.
- `client/src/hooks/useEndpointOrMock.ts:159-161` — hook returns `{ data: null, loading: true }` on FIRST render, always, in prod (list fetch is async). So on EVERY prod FAB entry the first commit renders the skeleton, popup NOT mounted.
- `client/src/hooks/useModalA11y.ts:130-149` (initial focus) + `:154-186` (Tab trap) both read `containerRef.current` at effect time, early-return on null, and are keyed `[open]` ONLY. `open` never flips (stays true from mount) → when the list resolves and the popup finally mounts, NEITHER effect re-runs.
- Prod result, every FAB-with-context entry: dialog claims `aria-modal="true"` but has NO Tab trap + NO initial focus. Esc still works (that effect needs no container).
- Worse: `useModalA11y.ts:103-104` sets `document.body.style.overflow = 'hidden'` container-free → body scroll locked during the loading skeleton with no dialog visible; and if the list fetch FAILS in prod (`hasNothingToShow` → ErrorCard), popup never mounts, `contextPopupOpen` stays true → scroll locked indefinitely on the error screen (only Esc or unmount releases).
- Why tests miss it: Chat.test.tsx:156-176 mocks `useEndpointOrMock` synchronously (`kind: 'data'` at first render) → popup mounts in the same commit the hook effects arm → trap works in test, dead in prod. (Same lesson as the corpus-data memory: mock shape hides prod behavior.)
- Fix options (any one): gate the hook on actual render — `useModalA11y({ open: contextPopupOpen && popupContext !== null && !loading && !hasNothingToShow, ... })`; or add the container/mount signal to the two `[open]` dep arrays in useModalA11y (callback-ref pattern); or hoist the popup out of the loading branch. First option is 1 line + a test with `kind: 'loading'` → flip to data → assert trap/initial focus.

## SHOULD-FIX

### SF-1. `aria-modal="true"` on a backdrop-less inline card — background stays fully interactive
- `client/src/pages/Chat.tsx:1622-1628` + `client/src/styles/index.css:3523-3531` — `.km-chat__askpop` is a static in-flow card: no backdrop, no `position: fixed`, no inert/pointer blocking. Sidebar rows, New chat, composer, Send all remain mouse-clickable while the "modal" is up.
- AT is told everything else is inert (`aria-modal="true"`); pointer users are not. Consequences observed by code-trace (all non-crashing, all guarded, but incoherent): user can switch conversations with the popup up, then click "Yes, use it" and seed the composer of an EXISTING thread (softens the seed-vs-popup boundary); user can Send with the popup up and the popup stays open.
- Fix: either make it a real modal (backdrop + pointer blocking — then also close on backdrop click) or make it honest non-modal chrome (drop `aria-modal` + drop the trap, keep Esc-=No as a plain shortcut, dismiss on send/switch). Given the mockup treats it as a lightweight offer, non-modal is arguably the better product call; either resolves the incoherence. Coordinate with B-1 fix.

## NIT

### N-1. Forged state carrying BOTH discriminators activates both consumers
- `client/src/pages/Chat.tsx:495-505` — a hand-forged `history.state` of `{ seedText: 'x', kmChatOpen: true, context: {...} }` sets `chatSeed` AND `openRequest`: composer pre-fills with the F-020 seed, popup arms, selection is 'new'. No crash, no clobber (Yes-branch `prev.trim() === ''` guard at Chat.tsx:635 keeps the seed), but strictly one producer should win. Cheap hardening: skip `readChatSeedState` when `readChatOpenState` matched. Real producers can never emit both — theoretical only.

### N-2. Dev/mock fallback never shows ASK_OPENER on a FAB entry
- `client/src/pages/Chat.tsx:762-777` — `openRequest !== null → [ASK_OPENER]` only reached when `serverList !== null`; the mock-fixture branch (`serverList === null`, `mockSeed.length > 0`) returns `personalise(mockSeed)` regardless of `openRequest`. Dev-only inconsistency (🅂 badge visible), prod unaffected.

### N-3. `readChatOpenState` clamps `seedText` untrimmed
- `client/src/lib/chatContext.ts:169-172` — `pageLabel`/`summary` get `.trim()` before truncate; `seedText` is clamped raw (leading/trailing whitespace survives into the composer). askSeed.ts has the same behavior for its seedText, so consistent-with-sibling, but inconsistent within the function. Cosmetic.

### N-4. Progress can publish a dangling summary when `dimensions` is empty
- `client/src/pages/Progress.tsx:445-460` — a snapshot with `dimensions: []` yields `summary: 'Latest diagnostic: '` (non-blank via prefix → passes the publish + read guards) → popup shows "Progress · 성장 — Latest diagnostic: ". Only matters if the API can return a dimensionless snapshot; guard with `latestSnapshot.dimensions.length > 0` if it can.

### N-5. FAB visit replaces the greeting on empty EXISTING conversations too
- `client/src/pages/Chat.tsx:759-765` — `openRequest !== null` gates ASK_OPENER for EVERY empty thread of the visit, incl. an empty server conversation the user switches to via the sidebar. Comment declares this intentional ("the FAB's contract is a fresh, topic-open conversation"); noting it as reviewed-and-accepted.

## PRAISE

- **Discrimination is genuinely sound.** `kmChatOpen: true` (exact-true check, chatContext.ts:150) vs non-blank string `seedText` (askSeed.ts:126) are disjoint requirements; the negative test at chatContext.test.ts:75-78 pins the F-020-shape-rejection explicitly, and the 7 F-020 tests (Chat.test.tsx:1176+) pass unmodified. A malformed `context` degrades to no-popup instead of blocking the open (chatContext.ts:141-173, tested Chat.test.tsx:1930-1950) — the right failure direction.
- **Token guard is correct and honest.** Identity-token no-op retract (chatContext.ts:96-100) covers the out-of-order cleanup case; React's cleanup-before-mount-effects commit order makes the common path safe anyway; StrictMode publish→retract→publish sequence holds; null-descriptor flip retracts (useChatContext.ts:35-46); no leak path found (retract on unmount covers all 5 publishers). The overlap test (useChatContext.test.tsx:69-78) is exactly the right non-vacuous shape.
- **`useSyncExternalStore` used correctly** — module-stable subscribe/getSnapshot, snapshot reference stable between store writes, honest `() => null` server snapshot.
- **Effect keyed on descriptor FIELDS** (useChatContext.ts:31-46) kills inline-object churn; verified by the fresh-object-same-values test (useChatContext.test.tsx:57-67). No set-state-in-effect anywhere in the publish path.
- **Lazy-'new' verified non-vacuously**: Chat.test.tsx:1843-1844 asserts `startCalls.length === 0` AND `getCalls.length === 0` before first send, then the stream lands on the NEW id (9001) not the newest existing row (42), with the sidebar still listing priors. Abandoned FAB opens provably create nothing.
- **Yes-branch clobber guard** (`prev.trim() === '' ? seed : prev`, Chat.tsx:635) + never-auto-send asserted (`streamCalls.length === 0` post-Yes, Chat.test.tsx:1856).
- **ChatFab tests exercise the REAL store** (publish → carry → narrow round-trip, ChatFab.test.tsx Slice-3 block) rather than mocking the registry — integration where it matters.
- **Publishers are lightweight + gated on content**: all 5 publish `null` while loading/browsing (Today gated on `today.data`, Grammar on the open Sheet row, Ttmik on selection, Topik study-mode-only, Progress on latest snapshot); descriptors are label + one-line summary, read-side clamped (120/400/4000). No PII beyond the single user's own study state.

## Test-adequacy notes
- Covered non-vacuously: popup yes/no/Esc/no-context/malformed, state-clear-after-consume, plain-nav-resumes-latest, FAB-new lazy start, token-guard ordering, field-keyed republish, store notify/unsubscribe, seed clamps.
- Gaps: (1) no test drives the `loading: true → data` transition with an armed open request — this is exactly the B-1 hole; (2) no test that typed-then-Yes preserves typed text (the guard at Chat.tsx:635 is untested — cheap to add); (3) no test of the both-discriminators forged state (N-1).
