# Independent Review — Chat Rework Slice 2 (client: sidebar + multi-conversation)

- **Commit:** `7ecd1f7` on `feat/chat-rework`
- **Scope:** `client/src/pages/Chat.tsx` (+ `Chat.test.tsx`), `client/src/components/Icon.tsx`, sidebar CSS in `client/src/styles/index.css`, SF-1 assertion in `server/tests/routes/conversation.test.ts`
- **Spec:** `db/docs/CHAT_REWORK_DESIGN.md` §Slice 2
- **Toolchain (Docker, node:20-slim):** `tsc -b --force` = 0, `eslint .` = 0, `vitest run src/pages/Chat.test.tsx` = 41/41 pass

## Verdict: NOT APPROVED — 1 BLOCKER, 4 SHOULD-FIX

The risky part — cross-conversation version threading — **holds**. I traced every
writer of `versionRef` and could not construct a send that carries another
conversation's `expected_version` (details under Praise). The blocker is in the
adjacent state model: `loaded` is never invalidated on switch, and a fast
switch-and-bounce leaves a conversation rendered permanently blank. Confirmed
empirically with a probe test against the shipped code (probe reverted after).

---

## BLOCKER

### B1 — Fast switch A→B→back-to-A blanks conversation A's thread, unrecoverably
`client/src/pages/Chat.tsx:667-681` (`selectConversation`), `:560-593` (history effect early-return)

`selectConversation` clears `msgs` (`setMsgs([])`, line 677) but does **not**
invalidate `loaded`. If the user switches A→B and clicks back to A **before B's
history fetch resolves** (any double-click misfire or sub-RTT bounce; B's fetch
is aborted by the effect cleanup so its `setLoaded` never runs), the effect
re-runs for A and hits the early return at line 562 (`loaded?.key === activeId`
is still true from A's original load). Result, **confirmed by a probe test run
against the commit**:

- no refetch of A fires (`getCalls` for id 42 stays at 1);
- A's history is not re-rendered (`msgs` was wiped by the two `setMsgs([])`);
- no loading indicator (`historyLoading` derives false — `loaded.key === activeId`);
- no error state. The thread pane is simply **empty** for a conversation that
  has history. If A had loaded empty and the user had sent messages this
  session, those bubbles vanish too and only the opener shows.

Recovery is not possible by re-clicking the row: `selectConversation` no-ops on
`id === activeKey` (line 669). The user must bounce through another
conversation, wait for **its** load, and come back.

Mitigating: `versionRef` still holds A's correct version and `threadReady` is
true, so a send from the blank thread uses the **right** `expected_version` and
the server threads correctly — no data corruption. But this is a correctness
break in the exact invariant the component documents ("`loaded` — which
conversation's history the thread currently holds", line 23-24): after the
bounce, `loaded` says A-with-history while the thread holds nothing. The slice's
whole point is trustworthy switching.

**Fix:** invalidate on switch — e.g. `setLoaded(null)` inside
`selectConversation` (the derived `historyLoading` then shows the loading state
and the effect refetches; the late-result abort guard already handles the
in-flight fetch), or key the thread cache per conversation. Add the bounce as a
regression test (see S3).

---

## SHOULD-FIX

### S1 — Lazy-start double-send race can create two conversations
`client/src/pages/Chat.tsx:900-944` (`send`), `:727-736` (`ensureActiveConversationId`)

On the pending-'new' state, `send()` appends the optimistic bubble and awaits
`ensureActiveConversationId()`, but `streaming` only becomes true inside
`runStream` — **after** `startConversation` resolves. During that RTT,
`streaming` is false and `threadReady` is true (`activeId === null`), so a
second Send (type + Enter twice quickly) passes the guard and fires a **second**
`startConversation`: two conversations are created, the two messages land in
different threads, and the second adoption wins the selection. Latch the window
(set an in-flight flag or reuse `creating` before the await; clear in a
`finally`).

### S2 — Unmount during a pending lazy-start starts a never-aborted SSE stream
`client/src/pages/Chat.tsx:913-917` (send continuation), `:627-631` (unmount cleanup)

The unmount cleanup aborts `sendCtrlRef.current` — which is null while
`startConversation` is still in flight. If the user navigates away during that
window, the continuation still runs: `runStream` creates a **new**
`AbortController` after the cleanup has already fired and opens a full SSE
stream (a real Claude turn) against the dead tree. All `setMsgs`/`setStreaming`
calls are React-18 no-ops (no crash, no warning), but the connection is held to
server EOF and the spend happens invisibly — the exact leak
`services/conversation.ts`'s own threat model warns about ("Dropping the
controller without abort holds the TCP connection open"). Guard with
`mountedRef.current` before calling `runStream` (and before
`adoptStartedConversation`, for tidiness). `retryFailedRow` shares the shape but
its `ensureActiveConversationId` resolves in a microtask when `activeId` is set,
so only the lazy-start path has a real window.

### S3 — Test gaps on the two claimed switch behaviors
`client/src/pages/Chat.test.tsx`

- "**switch aborts in-flight stream**" is asserted in the commit message and
  Chat.tsx's threat model, but only *unmount*-aborts-stream is tested
  (`unmounting mid-stream aborts…`). Add: start a stream in 42, click row 11,
  assert the captured stream call's `signal.aborted === true`.
- The **fast-bounce** path (B1) has no test — the existing
  `switching aborts the in-flight history fetch and a late result never paints`
  test always lets the second fetch settle before any further interaction. Add
  the A→B→A-before-B-resolves repro as the regression test for the B1 fix.

### S4 — The "version came from the history fetch, not the list" assertion is vacuous
`client/src/pages/Chat.test.tsx:341-345, 355-371`

`detailVersions = { 42: 3, 11: 1 }` **equals** the LIST fixture's `version`
fields (42→3, 11→1). An implementation that read `row.version` off the list
envelope and never rebound from `getConversation` would pass every version
assertion identically — the comment ("Versions mirror the LIST fixture rows so
send tests assert the version came from the HISTORY fetch") claims the opposite
of what mirroring achieves. Make them differ (e.g. `detailVersions[42] = 5`,
assert 5 goes out) to pin provenance. Note the **cross-conversation rebind**
itself IS non-vacuously covered: the switch test sends `expected_version: 1`
into conversation 11 after having loaded 42 at 3 — a stale `versionRef` would
fail it. Only the history-vs-list provenance is unpinned.

---

## NIT

### N1 — `onDone` trusts a client-side `+= 1` over the server's authoritative version
`client/src/pages/Chat.tsx:810-812`; `client/src/services/conversation.ts` (`onDone?: () => void`)

The server's terminal `done` frame carries `version`, but `streamMessage` drops
the envelope and Chat does `versionRef.current += 1`. Correct under today's
contract (one bump per committed stream), but if the server ever bumps
differently the client 409s on the next send. Plumb the done envelope's
`version` through `onDone` and assign instead of incrementing.

### N2 — `snippetTitle` can split a surrogate pair
`client/src/pages/Chat.tsx:278-283`

`flat.slice(0, TITLE_SNIPPET_MAX - 1)` slices UTF-16 code units; a first message
starting with 41 chars then an emoji (or any astral char at the boundary)
renders a lone surrogate (�) in the sidebar title. Korean is BMP so it's rare —
`Array.from(flat).slice(0, N)` fixes it cheaply.

### N3 — Relative times are frozen at mount
`client/src/pages/Chat.tsx:299, 448`

`nowMs` is captured once, so "2m ago" is stale in a long-lived tab (already
acknowledged in the comment). Fine for the personal-app scope.

### N4 — Client-clock timestamps merged lexicographically with server ISO strings
`client/src/pages/Chat.tsx:644-664, 813-816, 450-465`

Adopted local rows and `touchedAt` bumps use `new Date().toISOString()` and are
compared against server `updated_at` strings; client clock skew can mis-order
the sidebar. Also, a local row permanently shadows the server's row for the same
id in the merge (stale `message_count: 0` — currently unused, so harmless).

---

## PRAISE

- **The version-threading crux is genuinely sound.** Every `versionRef` writer
  pairs atomically (same handler) with a `loaded`/adopt update for the *same*
  conversation: history-load success sets `versionRef = detail.version` and
  `setLoaded({ key: detail.id })` together behind the aborted-guard; both start
  paths set `versionRef = 1` then adopt; and the `onDone` bump cannot land after
  a switch because `selectConversation`/`startNewChat` abort the stream and
  `sseStream` checks `signal.aborted` immediately before invoking `onDone`
  (`sseStream.ts:230-245`), while `streamMessage` additionally suppresses
  `onDone` after an in-band terminal error. `threadReady`
  (`loaded?.key === activeId`) gates both `send` and `retryFailedRow` *and* the
  button's disabled state, so no send can fire between a switch and its
  history/version rebind.
- **Abort discipline is exemplary and non-vacuously tested.** One controller per
  history load, cleanup aborts on switch/unmount, both continuations guarded;
  the `late result never paints` test manually resolves an aborted fetch and
  asserts a total no-op, and the unmount test asserts the signal actually
  aborted. No `set-state-in-effect` risk: the history effect sets state only in
  async continuations, `historyLoading` is derived, and the F-020 seed-clear
  effect performs navigation (a side effect), not a state set.
- **The failed-history test is sharp**: it types into the composer *then*
  asserts Send is disabled and zero stream calls — non-vacuous proof of the
  `threadReady` gate on the failure path, plus fixed-copy (never server prose)
  and a working Retry re-arm.
- **SF-1 is a real gate-order tripwire.** The counter wraps `makeStubProxy`'s
  `ocrImage` (behavior unchanged), resets per test, and asserts exactly 0 on all
  four gate-fail paths (no-file 400, cap 429, stale 409, IDOR 404) and exactly 1
  on happy. Since a Vision call leaves no DB trace, the previous
  `image_captures = 0` assertions could not catch a gate reorder; this can — a
  reorder flips a 0 to 1 and fails loudly.
- **The derived-selection model is loop-free and unambiguous.**
  `selectedKey ?? rows[0]?.id ?? 'new'` is a pure derivation; the history
  effect's `loaded`/`historyError` deps always early-return once settled (no
  render loop — 41 tests would hang otherwise); `useEndpointOrMock` never
  refetches spontaneously (manual `refetch()` only), so `rows[0]` can't shift
  under an unpinned selection; and `send()` pins the derived default before
  dispatch, making the target immune to recency reordering. The rendered-only
  opener shows exactly for `activeId === null` or a loaded-empty thread and
  never over real history (tested).
- Sidebar a11y is thorough: real `<button>` rows (keyboard-operable),
  `aria-current` on the active row, collapse with `aria-expanded` +
  `aria-controls`, accessible names preserved in the collapsed rail, switch/load
  announcements via a dedicated polite live region that deliberately avoids
  colliding with the dictionary's `role="status"` contract, and the retention
  note ("kept 30 days, then cleared") accurately reflects Slice 1's
  `updated_at < now() - 30 days` soft-delete sweep.

---

## Answers to the review's directed questions

**(a) Can a send ever carry the wrong conversation's version?** No. Traced and
probed; the `threadReady` gate plus atomic version/loaded pairing plus
abort-before-`onDone` closes every path, including fast-switch races (in the B1
bounce, the version is *still correct* — only the rendering is wrong).

**(b) Can a late/aborted history load render into the wrong conversation, or
set state after unmount?** No — both continuations are `signal.aborted`-guarded
and the cleanup aborts on switch/unmount (tested non-vacuously). The distinct
failure is B1: the *absence* of a load where one is needed. S2 is the one
post-unmount leak (a lazy-start send opens an unabortable stream — resource and
spend, not state).

**(c) Any regression to send/stream/dictionary/seed?** None found. All 41 tests
(incl. the unchanged F-016/F-020/stream/retry/request-id contracts) pass;
`runStream`'s wiring is byte-compatible with Pass 3. One intentional behavior
change: Send is disabled until the active history loads (the seed test dropped
its "Send enabled" assertion accordingly) — correct given the version gate.

**(d) Is the derived-selection model loop-free and unambiguous?** Yes — loop-
free and unambiguous as a selection model; its integrity hole is the missing
`loaded` invalidation on switch (B1), which is a one-line fix.
