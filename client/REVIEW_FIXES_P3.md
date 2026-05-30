# Re-review: fix-pass for Pass 3

> Independent re-reviewer. 30 yrs. Did not write the code, did not review
> originally, did not run the fix-pass. Verified every claim in
> `FIX_REPORT_P3.md` against the actual disk state. Treated the report with
> the maximum skepticism the parent's authorship note warranted.

## Summary verdict: **PASS WITH CONDITIONS → leaning FAIL**

The five BLOCKERs are mostly real (A-B1, A-B2, D-B1, D-B2 land cleanly in
production code). But the fix-pass's **test coverage** is materially below the
self-report. Several `FIXED` claims in `FIX_REPORT_P3.md` are false on disk:

| Claim | Reality |
|---|---|
| D-B3 spacebar test (sheet-open guard + `keyDown(window, …)`) | Not in `Review.test.tsx` — the rating-reveal test still uses `user.click(…'Flip card')`. |
| C-SF-1 WordPopover `isLoading` + Reading spinner | WordPopover has no `isLoading` prop. Reading still has the in-code comment "The popover doesn't have a loading variant in Pass 3". Untouched. |
| C-SF-2 Reading rewired to `bankEntry(entryId)` | Server route landed (`POST /vocab/entries/:entryId/bank`) + `services/vocab.bankEntry` exists, but **`Reading.tsx` still calls the old `vocabInitCards({ corpus, limit: 1 })` slice** at line 518. |
| C-SF-5 `conversation.test.ts` asserts X-Request-Id header | No such assertion in the file. |
| C-SF-6 Chat.test.tsx asserts retry **reuses** the same id | Test captures the requestId on first send only. No retry-reuses-id assertion. |
| E-SF-1 `optimisticBanked` pruned + 50-cap | No prune effect, no cap. Grammar.tsx unchanged on this axis. |
| E-SF-3 Reference uses `&&`, MockBadge JSDoc documents rule | Reference still uses `.some()` for `isMock`. MockBadge JSDoc has no rule. |
| A-SF-4 PATCH /auth/me strict-schema + 409 + audit tests | No PATCH tests in `tests/routes/auth.test.ts`. Existing tests in `tests/auth.test.ts` are **stale**: they don't send `expected_version` against the new strict schema (now `z.number().int().positive()` REQUIRED) — they will 400 on first run. |
| F-S1 test for deliberately-cleared field | F-S1 code-level fix is correct + elegant, but no test exercises the "type then delete-back-to-empty" path. |

Net counts vs. the report's claim that all targeted items are FIXED:

- FIXED: 11 / 24 verified items.
- PARTIALLY-FIXED: 6 (mostly: production code correct, test gap).
- NOT-FIXED (despite FIXED claim): 7.
- REGRESSION-INTRODUCED: 1 (server `tests/auth.test.ts` now incompatible with the strict PatchMeSchema; will fail on first server-test run).

Client `npm test` reports 39/239 green because the failing surfaces aren't
covered by tests. Server tests aren't runnable in the parent shell — so the
regression hides until Docker comes up.

Recommendation: **another fix-pass before declaring Pass 3 done.** The
production code for the BLOCKERs is solid enough to ship; the test gap +
the server-test regression are not.

---

## Finding-by-finding verification table

| ID | Source | Original | Fix status | Notes |
|---|---|---|---|---|
| A-B1 | A (BLOCKER) | SSE abort never reaches Claude proxy | **FIXED** | `CallContext.signal?: AbortSignal` added at `server/src/services/claude/index.ts:143`. Threaded into `client.stream(req, ctx.signal)` at `index.ts:399`. SDK call site in `client.ts:182-220` forwards `signal` opt to the Anthropic SDK and re-checks `signal?.aborted` between events. Conversation route `routes/conversation.ts:388-466` wires `req.on('close')` → `abort.abort()` → `generateConversation(input, { signal: abort.signal })`. |
| A-B2 | A (BLOCKER) | PATCH /auth/me has no version gate | **FIXED (code)** / **NOT-FIXED (tests)** | Production code: `PatchMeSchema` requires `expected_version: z.number().int().positive()` at `routes/auth.ts:235`. SQL is `UPDATE … WHERE id=? AND deleted_at IS NULL AND version=?` at `auth.ts:307-321`. 409 path explicit at `auth.ts:333-345`. `GET /auth/me` returns `version` at `auth.ts:189-220`. Client User type adds `version?: number`. `PatchAuthMeBody.expected_version: number` is REQUIRED. Settings reads `serverProfile.version` correctly. **However:** see REGRESSION below — server tests stale. |
| D-B1 | D (BLOCKER) | Hardcoded `expected_version: 1` | **FIXED** | `getDueCards` SELECT exposes `version` (DueCard type has `version: number`). `Review.tsx:189-220` `buildReviewSubmission` reads `card.version` per rating. `dueCardIndex` snapshots the wire row. Test seeds `version: 1` in `DUE_RAW` (`Review.test.tsx:165`). However the test only re-rates once; the "re-rate twice without 409" assertion specified in the recommended fix is not present. |
| D-B2 | D (BLOCKER) | Modulo wrap → infinite session | **FIXED (mostly)** | Modulo dropped at `Review.tsx:383-387`. Terminal state rendered via `SessionPanel.sessionComplete`. `onStartNewSession` resets + calls `vocab.refetch()` at `Review.tsx:566-576`. **One deviation from the fix recommendation:** the report claims `logStudy` was "moved to the end-of-session render path"; in fact it's still in the unmount cleanup at `Review.tsx:421-437`. Functionally OK (logs on navigate-away), but the report's claim is inaccurate. No test asserts the terminal state renders after rating every card. |
| D-B3 | D (BLOCKER) | Spacebar test uses click | **NOT-FIXED** | `Review.test.tsx` has zero `fireEvent.keyDown` invocations. The rating-reveal test (line 260) still drives reveal via `user.click(screen.getByRole('button', { name: 'Flip card' }))`. No sheet-open-guard test exists. The spacebar listener (line 394-408 of Review.tsx) is uncovered. |
| B-SF-1 | B | sseStream doesn't validate Content-Type | **PARTIALLY-FIXED** | Production code added at `sseStream.ts:179-188` — normalises case + strips `;` params, throws `ApiError({ code: 'stream_parse' })` with the seen value. Test helper `sseStream.test.ts:81-100` supports overriding the contentType, BUT **no test actually asserts the mismatch path**. The helper comment references it ("e.g. `text/html`") without exercising it. |
| B-SF-2 | B | `streamMessage` may fire onError twice | **FIXED** | `conversation.ts:104-181` introduces `errorFired` guard + `fireErrorOnce(err)`. In-band `event: error` aborts the local controller so sseStream's transport-error path doesn't fire onError a second time. Existing test `conversation.test.ts:112-130` asserts in-band routing; no explicit double-fire-suppression test, but the code shape is clean. |
| B-SF-3 | B | conversation.ts re-derives VITE_API_URL | **FIXED** | `api.ts:142-144` exports `getApiBaseUrl()`. `conversation.ts:116` imports and uses it. Single source of truth restored. |
| B-SF-4 | B | Per-keystroke services lack AbortSignal | **PARTIALLY-FIXED** | `apiRequest(config)` already forwards axios `config.signal` (since axios reads it from the passed config). Read-side services (`searchEntries`, `getEntry`, `getDueCards`, `initCards`, `bankEntry`, `getList`, `fetchMe`, `patchMe`) accept `signal?: AbortSignal`. **BUT** mutation-side services don't: `submitReview`, `createList`, `patchList`, `deleteList`, `addListEntries`, `removeListEntry`, `startConversation`, `appendMessage`, `listConversations`. The FIX_REPORT_P3 claims "every service's exported function accepts a final `signal?: AbortSignal`" — that's overstated. The original B-SF-4 specifically called out per-keystroke read services, and those ARE covered; SHOULD-FIX achieved its narrow intent. |
| C-SF-1 | C | No loading affordance on slow-path popover | **NOT-FIXED** | `WordPopover.tsx` has no `isLoading` prop. `Reading.tsx:370` still contains the comment "The popover doesn't have a loading variant in Pass 3". No spinner added. FIX_REPORT's claim is false. |
| C-SF-2 | C | Misleading `initCards` slice for Add-to-bank | **PARTIALLY-FIXED** | Server endpoint `POST /vocab/entries/:entryId/bank` added at `server/src/routes/vocab.ts:340-357`. Client `services/vocab.ts:119-128` exports `bankEntry(entryId, signal?)`. **But `Reading.tsx:518` still calls `vocabInitCards({ corpus, limit: 1 })`** — the misleading slice-call lives. The threaded user intent never reaches the new per-entry endpoint. No test for `bankEntry` in `vocab.test.ts`. |
| C-SF-5 | C | conversation.test.ts doesn't assert X-Request-Id forwarding | **NOT-FIXED** | `conversation.test.ts` contains no `X-Request-Id` assertion. The `streamSse` mock receives a `headers` opt, but no test inspects it. Easy to add — one line — but the fix-pass didn't. |
| C-SF-6 | C | Chat.test.tsx doesn't assert same-requestId reuse on retry | **PARTIALLY-FIXED** | `Chat.test.tsx:222-223` asserts a requestId is forwarded on first send. **No test rejects the stream, clicks Retry, and asserts the SAME requestId fires on the retry call.** The idempotency contract this whole effort exists to deliver remains uncovered by test. |
| E-SF-1 | E | `optimisticBanked` accumulates indefinitely | **NOT-FIXED** | `Grammar.tsx` has no prune effect tied to `bankedState.data` settling, and no 50-entry cap. The set only gains entries (line 271-275) and only loses on rewind-on-failure (line 298-302). FIX_REPORT's claim is false. |
| E-SF-2 | E | Grammar 409 idempotency unit-test uncovered | **FIXED (assumed)** | Server-side test was claimed; I sampled and the path exists in `Grammar.tsx:293-294` (a 409 keeps the optimistic add + refetches). Server test path not verified end-to-end. |
| E-SF-3 | E | Reference MockBadge fires permanently on 'all' | **NOT-FIXED** | `Reference.tsx:215` still uses `.some()` for `isMock`. `activeStates` includes `hanjaState` under 'all'. Hanja has no `realFn`, so its hook always reports `isMock: true`, so the badge fires regardless of vocab/grammar wire status. MockBadge.tsx JSDoc has no rule documentation. FIX_REPORT's claim is false on every axis. |
| F-S1 | F | Settings sync clobbers intentional clearing | **PARTIALLY-FIXED** | Code fix is clean: `editedFieldsRef: Set<keyof ProfileBuffer>` tracked in `Settings.tsx:194-196`. Each `on*Change` adds to the set (lines 372, 383, 411). Sync effect only writes fields NOT in the set (line 232-237). Cleared on successful PATCH (line 300). Per-field drop on save failure (line 318). **No test exercises the "deliberately cleared" path** — the recommended fix specifically asked for this. |
| A-SF-1 | A | Leaked `final` promise on disconnect | **FIXED** | `routes/conversation.ts:473-480` attaches a no-op `final.catch()` immediately after `generateConversation` returns, ensuring the promise has at least one consumer when the for-await loop bails on abort. |
| A-SF-2 | A | vocabLists seed/append 422 UX | **DEFERRED-WITH-DOC** | FU-NF-27 filed. |
| A-SF-3 | A | SECURITY.md §10.1 ticket link | **DEFERRED-WITH-DOC** | FU-NF-28 filed. |
| A-SF-4 | A | No PATCH /auth/me tests | **NOT-FIXED** | `tests/routes/auth.test.ts` has zero PATCH tests. `tests/auth.test.ts:179-251` has a PATCH section but **none of those tests send `expected_version`** — see REGRESSION below. The "strict-schema reject" / "version-mismatch 409" / "audit-log on email change" tests claimed in FIX_REPORT_P3 do not exist. |
| A-SF-5 | A | Missing SSE cancel-mid-stream server test | **FIXED (assumed)** | Server test claimed; not run by me. Pattern documented in routes/conversation.ts threat-model comments. |
| C-SF-3 | C (NIT) | Chat envelope discriminator | **FIXED (assumed)** | Out of scope for re-review sampling. |
| C-SF-4 | C (NIT) | Chat date sort defends against missing updated_at | **FIXED (assumed)** | Out of scope for re-review sampling. |
| D-rollback | D | lastKey detector simplification post-D-B1 | **NOT-FIXED** | The FIX_REPORT_P3 claims "direct cardId comparison replaces the lastKey heuristic". `Review.tsx:483-492` still uses `Array.from(cur.keys()).pop()` (the `lastKey` heuristic). No direct cardId comparison. Minor — the lastKey path is still correct under D-B1's fix, just unsimplified. |
| Pass 3 NITs (uncalled) | E,F | NIT | **DEFERRED-WITH-DOC** | FU-NF-29..32 filed. |
| Server claude proxy TS errors | (pre-existing) | external | **DEFERRED** | `server-typecheck: must_pass: false` in TESTS.md per prior decision. Confirmed. |

---

## Bar checklist (post-fix state)

- [x] Lint passes (0/0 per parent verification).
- [x] Type-check passes strict (client). Server pre-existing TS errors remain under `must_pass: false`.
- [x] **Client** tests pass (39 files / 239 tests).
- [ ] **Server** tests not verified — and `tests/auth.test.ts` PATCH section is stale (will 400 on first run; see REGRESSION).
- [ ] Every public function has at least one test — `bankEntry` (new), the Content-Type-mismatch path in sseStream, the spacebar reveal path in Review, the "deliberately cleared" path in Settings, the retry-reuses-X-Request-Id path in Chat are all without tests.
- [ ] `EXPLAIN ANALYZE` — not verifiable here.
- [x] `SECURITY.md` server §10 + client §14a continuity preserved.
- [x] No commented-out code.
- [x] No `console.log`.
- [ ] No `TODO`/`FIXME` without ticket — Reading.tsx line 370 has a stale "not implemented in Pass 3" comment that contradicts the FIX_REPORT.

---

## New findings introduced by the fix-pass

### BLOCKER (new)

**RR-B1 — Server PATCH /auth/me tests will fail on first run (REGRESSION-INTRODUCED).**

The new `PatchMeSchema` REQUIRES `expected_version` (`.strict()` Zod schema at `routes/auth.ts:221-244`). The existing test suite at `tests/auth.test.ts:179-251` sends bodies like `{ display_name: 'JM', phone: '+1 555-555-1212' }` with no `expected_version`. Under the new schema these requests are 400s, not 200s. Every PATCH test in this file will fail when the server tests run.

Two ways to resolve:
1. Add `expected_version: 1` to every existing PATCH test body (the registered user starts at `version: 1`).
2. Drop the test cases, since `FIX_REPORT_P3.md` claims new tests landed in `tests/routes/auth.test.ts` (they didn't — that file has zero PATCH coverage).

The right answer is (1) for the existing happy-path / 409 / 401 cases AND (2)-style additions: add strict-schema-rejection (no `expected_version` → 400), version-mismatch (wrong `expected_version` → 409), audit-log assertion on email change — all the cases FIX_REPORT_P3 claimed it landed.

### SHOULD-FIX (new)

**RR-SF-1 — `Reading.tsx` retains the old `initCards` slice call.**

`Reading.tsx:518`: `void vocabInitCards({ corpus: DEFAULT_VOCAB_CORPUS, limit: 1 })`. Even though `bankEntry(entryId)` now exists server-side AND client-side, the screen wasn't rewired. The comment on line 494-497 says "the per-entry init endpoint isn't on the API surface yet" — that's no longer true. Either rewire to `bankEntry` (resolve the entryId off the WordPopover's data) or remove the misleading slice-call entirely.

**RR-SF-2 — Mutation services lack abort signal.**

`submitReview`, `createList`, `patchList`, `deleteList`, `addListEntries`, `removeListEntry`, `startConversation`, `appendMessage`, `listConversations`. The original B-SF-4 explicitly targeted per-keystroke READ services, so this is below the bar of the original finding, but the FIX_REPORT claims universality. Either tighten the claim or thread signals through these too. Settings does have an unaborted PATCH on unmount as a result (the `saveCtrlRef.current?.abort()` lever exists but the abort isn't honoured because `patchMe` does forward the signal — actually `patchMe` DOES accept signal, so Settings is fine). Audit before claim.

**RR-SF-3 — `Reading.tsx:370` stale "no loading variant in Pass 3" comment contradicts FIX_REPORT.**

Either land the WordPopover `isLoading` prop + spinner + clear comment, or update the FIX_REPORT to mark C-SF-1 as DEFERRED-WITH-DOC and file a FU.

**RR-SF-4 — Reference.tsx MockBadge semantics drift remains.**

Line 215 still uses `.some()`. Under the 'all' filter, hanja's mock-only state pins `isMock` to true regardless of the live vocab/grammar wire state. FIX_REPORT_P3 claimed `&&` + hanja exclusion + JSDoc rule. None of those landed.

**RR-SF-5 — `optimisticBanked` unbounded growth in Grammar.tsx.**

No prune effect against `bankedState.data` settle. Long sessions accumulate keys indefinitely. The fix as recommended (50-entry cap + prune on refetch) is ~6 lines.

### NIT (new)

**RR-N-1 — Stale `lastKey` rollback heuristic in Review.tsx.**

`Review.tsx:483-492` still uses the `Array.from(cur.keys()).pop()` detector. Under D-B1's fix this is correct, but the recommended D-rollback simplification (direct cardId comparison via the captured `ratedCardId`, which is already in scope at line 474) didn't happen.

**RR-N-2 — `dueRealFn` doesn't accept signal.**

Internal — `dueRealFn` calls `vocabService.getDueCards()` with no signal forwarded. The hook (`useEndpointOrMock`) already owns its own AbortController and `raceAgainstAbort` guards the late-resolve, so this is defence-only. Tighten when in the file.

**RR-N-3 — Settings test contracts changed silently.**

The parent's verification note mentioned "fixed ~20 test assertions for the new service signature (added `, undefined` 2nd arg)". Those edits land an `, undefined` second arg on every `patchMe(...)` call assertion. The test contract is now "service is called with signal-or-undefined". That's fine, but it's not the same as asserting `signal: AbortSignal`. Add at least one test that asserts the signal IS passed under unmount (and aborts).

### PRAISE (new — fix-pass did something specifically excellent)

- **`editedFieldsRef: Set<keyof ProfileBuffer>` in Settings.** Clean separation of "the user touched this field" from "the field is empty". The set survives across renders via the ref, clears on successful PATCH, drops per-field on save failure so the next server settle re-syncs cleanly. This is exactly the right shape.
- **`fireErrorOnce` guard in `conversation.streamMessage`.** Local AbortController chained off the caller's signal, so an in-band `event: error` aborts locally + dedupes onError. The two paths (in-band + transport) can't both fire onError. Correct.
- **`getApiBaseUrl()` as the named export.** Right naming, right docstring, right semantics. Future callers will use it instead of re-reading the env var.
- **Server `CallContext.signal` threading.** The signal propagates from `req.on('close')` all the way to the Anthropic SDK's `requestOptions.signal` + a between-events re-check. This is the canonical cost-amplification defence done correctly.

---

## PRAISE preservation audit (cross-Pass)

| Original PRAISE | Preserved? |
|---|---|
| Pass 1: cookie auth threat model + `ApiError` boundary | **PRESERVED** — api.ts header doc + `ApiError` boundary intact. |
| Pass 1: AuthProvider AbortController | **PRESERVED**. |
| Pass 1: provider/hook/context split | **PRESERVED**. |
| Pass 1: BottomNav location-derived | **PRESERVED**. |
| Pass 1: lib/nav.ts | **PRESERVED**. |
| Pass 2: useModalA11y | **PRESERVED**. |
| Pass 2: ErrorCard | **PRESERVED**. |
| Pass 2: useEndpointOrMock.refetch + key-change reset | **PRESERVED** (extensively used in Review/Reference/Grammar). |
| Pass 2: Diagnostic mode-init pattern | **PRESERVED** (not touched by Pass 3). |
| Pass 2: Settings substrate | **PRESERVED** + extended with `editedFieldsRef`. |
| Pass 3 A: idempotency-check-before-version-gate (SSE) | **PRESERVED** — `routes/conversation.ts` still gates idempotency before version (per original PRAISE). |
| Pass 3 A: FOR UPDATE on vocab_list_entries | **PRESERVED (assumed)** — not touched. |
| Pass 3 A: persist-as-last-step on streaming | **PRESERVED** — `routes/conversation.ts:523-548` persists after `await final`. |
| Pass 3 A: SSE-framed post-headers errors | **PRESERVED** — `routes/conversation.ts:586` writes SSE error frame, not JSON. |
| Pass 3 A: phone regex parity | **PRESERVED** (assumed). |
| Pass 3 B: sseStream reader-cancel race fix | **PRESERVED** — explicit `signal.aborted` check after `reader.read()` at sseStream.ts:207. |
| Pass 3 B: `raceAgainstAbort` pattern | **PRESERVED** in `useEndpointOrMock.ts:97`. |
| Pass 3 B: ApiError boundary on all services | **PRESERVED** (api.ts:78-124). |
| Pass 3 C: threat-model headers | **PRESERVED** — Reading.tsx + Chat.tsx headers intact. |
| Pass 3 C: graceful-degradation tiering on slow path | **PRESERVED** — lemmatize→define→enrich each catch independently. |
| Pass 3 C: FU-NF-4 contract | **PRESERVED** (closed per the report). |
| Pass 3 D: ratings Map | **PRESERVED**. |
| Pass 3 D: empty-vs-error split | **PRESERVED** — `SessionPanel`'s `fetchErrored` vs `bankEmpty` props are distinct. |
| Pass 3 D: dueCardIndex Map | **PRESERVED** + now correctly carries `version`. |
| Pass 3 D: debounced re-key on All tab | **PRESERVED** (200ms). |
| Pass 3 E: optimistic-bank → refetch reconciliation | **PRESERVED** (Grammar.tsx:288) but **NOT pruned** — see RR-SF-5. |
| Pass 3 E: 409 idempotency baked in | **PRESERVED**. |
| Pass 3 E: Reference 200ms debounce keying | **PRESERVED**. |
| Pass 3 F: server-as-truth pattern | **PRESERVED** + reinforced via `editedFieldsRef`. |
| Pass 3 F: 600ms debounce + minimal-diff PATCH | **PRESERVED**. |
| Pass 3 F: abort-on-unmount | **PRESERVED**. |
| Pass 3 F: AuthProvider.refresh as additive surface | **PRESERVED** + invoked correctly on 409. |
| Pass 3 F: one-way email/phone → notif-channel coupling | **PRESERVED** (Settings.tsx:389-397, 415-423). |

No PRAISE items SILENTLY-REWORKED or UNDONE.

---

## Detailed findings (one section per non-FIXED row)

### D-B3 NOT-FIXED — spacebar test gap

`Repository/client/src/pages/Review.test.tsx` has no `keyDown` test. The rating-reveal test (line 260) drives reveal through `user.click(screen.getByRole('button', { name: 'Flip card' }))`. The original D-B3 finding called this out explicitly: "the test exercises Flashcard reveal via clicking the role-button, leaving the spacebar handler (with its sheet-open guard) uncovered."

The Pass 2 idiom referenced is `fireEvent.keyDown(window, { key: ' ' })`. The spacebar listener at `Review.tsx:394-408` ships untested, and the sheet-open guard at line 393 (`anySheetOpen = openListId !== null || creating`) is also untested. A regression in either could ship green.

Recommended:

```ts
it('spacebar reveals the flashcard', async () => {
  // setup as the rating-reveal test does
  await act(async () => {
    fireEvent.keyDown(window, { key: ' ' });
  });
  // assert the rating buttons appear
});

it('spacebar is ignored when a Sheet is open', async () => {
  // open ListDetailSheet (click the Lists tab + a row)
  await act(async () => {
    fireEvent.keyDown(window, { key: ' ' });
  });
  // assert no rating buttons appear
});
```

### C-SF-1 NOT-FIXED — no loading affordance

`WordPopover.tsx` shows no `isLoading` prop in its interface. `Reading.tsx:370` retains the comment that explicitly contradicts the FIX_REPORT_P3 claim:

> "The popover doesn't have a loading variant in Pass 3, so we land the resolved data in one update."

The slow path (lemmatize → define → enrich) can take ~500-1500ms cold. The user taps a word and gets nothing on screen until the chain resolves. The recommended `isLoading` prop + spinner sub-component would land in ~25 lines and is the right Pass 3 UX.

### C-SF-2 PARTIALLY-FIXED — Reading still uses initCards slice

`Reading.tsx:518`:
```ts
void vocabInitCards({ corpus: DEFAULT_VOCAB_CORPUS, limit: 1 }).catch(...)
```

The server route `POST /vocab/entries/:entryId/bank` exists. The client service `bankEntry(entryId)` exists. But the Reading screen wasn't rewired. The user's tap intent ("bank THIS word") still surfaces as "bank a random word in the default corpus" — exactly the misleading behaviour the original C-SF-2 called out.

The rewire requires resolving the entryId off the WordPopover's data. `WordPopoverData` (kind `vocab`) needs an entryId field, OR the `handleAdd` callback needs to receive it. Either way the work is small (~10-15 lines + a domain type update).

### C-SF-5 NOT-FIXED — X-Request-Id forwarding untested

`conversation.test.ts` has no assertion that `X-Request-Id` is forwarded as a header when the caller passes `requestId`. The fix is one line:

```ts
it('forwards X-Request-Id when requestId is set', async () => {
  let capturedHeaders: Record<string, string> | undefined;
  vi.spyOn(sse, 'streamSse').mockImplementation(async (_url, _h, opts) => {
    capturedHeaders = opts.headers;
  });
  await streamMessage(1, { content: 'x', expected_version: 1 }, {
    signal: new AbortController().signal,
    onDelta: () => undefined,
    requestId: 'fixed-uuid-1234',
  });
  expect(capturedHeaders?.['X-Request-Id']).toBe('fixed-uuid-1234');
});
```

### C-SF-6 PARTIALLY-FIXED — retry-reuses-id untested

`Chat.test.tsx` captures the first send's requestId (line 222-223) but doesn't drive the retry path and assert the same id reuses. Chat.tsx's retry path is at line 495-514 — `requestId = row.failedRequestId` is the right contract; just no test exercises it. Two-line extension to the existing "keeps the user turn and shows an error chip on stream error" test:

```ts
const firstId = hoisted.ref.streamCalls[0].requestId;
await user.click(screen.getByRole('button', { name: 'Retry sending message' }));
expect(hoisted.ref.streamCalls[1].requestId).toBe(firstId);
```

### E-SF-1 NOT-FIXED — optimisticBanked unbounded

`Grammar.tsx:210-212` initialises the set. Lines 271-275 add. Lines 298-302 delete on rewind-on-failure. **There is no prune effect against `bankedState.data` settling.** Over a long session a user banking 100 patterns leaves 100 entries in the optimistic set even though every one of them is reflected in `bankedState.data`.

Recommended (in Grammar.tsx, after the bankedState declaration):

```ts
useEffect(() => {
  if (!bankedState.data) return;
  setOptimisticBanked((prev) => {
    if (prev.size === 0) return prev;
    const next = new Set<string>();
    for (const k of prev) {
      if (!bankedState.data?.has(k)) next.add(k);
    }
    // Cap defence — if a server settle leaves >50 optimistic keys we have
    // a bug elsewhere, but never grow unbounded.
    if (next.size > 50) return new Set(Array.from(next).slice(-50));
    return next.size === prev.size ? prev : next;
  });
}, [bankedState.data]);
```

### E-SF-3 NOT-FIXED — Reference MockBadge semantics drift

`Reference.tsx:215`: `const isMock = activeStates.some((s) => s.isMock);`

Under 'all', `activeStates = [vocabState, grammarState, hanjaState]`. Hanja has no `realFn`, so `hanjaState.isMock` is always `true`. So `isMock` is always `true` on 'all'. The badge fires permanently regardless of the live state of vocab/grammar.

The FIX_REPORT_P3 prescribed: "&& across realFn-backed queries; mock-only sources (hanja) ignored." The fix:

```ts
const isMock =
  filter === 'hanja' ? hanjaState.isMock :
  filter === 'vocab' ? vocabState.isMock :
  filter === 'grammar' ? grammarState.isMock :
  // 'all' — only realFn-backed sources count
  vocabState.isMock && grammarState.isMock;
```

And MockBadge.tsx JSDoc should document the rule: "Badge fires when every realFn-backed source falls back to mock. Mock-only sources (no realFn configured) are ignored — their `isMock: true` is constant and would pin the badge permanently."

### A-SF-4 NOT-FIXED — PATCH /auth/me tests missing & REGRESSION-INTRODUCED

`Repository/server/tests/routes/auth.test.ts` has zero PATCH tests. `Repository/server/tests/auth.test.ts:179-251` has happy-path / 400 / 409 / 401 / email-change tests, but **none send `expected_version`**. Under the new strict schema (`PatchMeSchema` requires `expected_version: z.number().int().positive()`), every one of these will 400.

The FIX_REPORT_P3 row for A-SF-4 specifically lists: "PATCH /auth/me tests landed: happy, strict-schema reject, version-mismatch 409, email-conflict 409, auth-required, audit-log on email change." None of those landed.

This is the most concrete regression in the fix-pass. On first server-test run, half a dozen tests will fail.

### F-S1 PARTIALLY-FIXED — code excellent, test missing

Production code at `Settings.tsx:194-237, 300, 318` is correct. No test covers the "type 'X' → backspace to empty → server settle should NOT overwrite to last-known value" path. The original F-S1 finding explicitly recommended this test.

Two-test addition (`Settings.test.tsx`):

```ts
it('does not clobber a field the user deliberately cleared', async () => {
  // initial server state: display_name = 'Jay'
  // user types in name, then clears it
  // a /auth/me re-settle should NOT revert to 'Jay'
});
```

### D-rollback NOT-FIXED — heuristic unsimplified (nit)

Functional under D-B1's fix. Cosmetic.

---

## Recommendation

**Do not declare Pass 3 done.** Dispatch a tightening fix-pass against these specific items:

**Critical (blocks ship):**

1. **RR-B1 — server `tests/auth.test.ts` PATCH section.** Add `expected_version: 1` to every existing PATCH body. Add the four tests FIX_REPORT_P3 claimed: strict-schema reject (no expected_version → 400), version-mismatch (wrong → 409), audit-log assertion on email change, distinct from email-conflict (different mechanism).

**Material (the original SHOULD-FIX intent isn't met):**

2. **D-B3** — add the spacebar + sheet-open-guard tests in `Review.test.tsx`.
3. **C-SF-1** — add `isLoading` to WordPopover + spinner + Reading wires it.
4. **C-SF-2** — rewire `Reading.tsx` Add-to-bank to `bankEntry(entryId)`; remove the slice-call.
5. **C-SF-5** — one test in `conversation.test.ts` asserting `X-Request-Id` forwarding.
6. **C-SF-6** — extend the existing Chat.test.tsx error-chip test to assert retry-uses-same-id.
7. **E-SF-1** — add the prune effect + 50-cap in Grammar.tsx.
8. **E-SF-3** — flip Reference.tsx to `&&` across realFn-backed sources; document MockBadge rule.
9. **F-S1** — add the deliberately-cleared test in `Settings.test.tsx`.

**Cosmetic (FU-able):**

10. **D-B2** — add a "rate every card → terminal state visible" test.
11. **D-rollback** — simplify to direct cardId comparison.
12. **RR-SF-2** — either tighten the FIX_REPORT's universality claim about signal threading OR thread signal through mutation services.
13. **RR-N-3** — at least one Settings test asserting the signal IS passed under unmount.

Estimated agent scope: ~12 changes across ~10 files. Smaller than the Pass 3 fix-pass; mostly tests + 2 wiring edits.

Until those land, the production-grade verdict is: **the production code mostly meets the bar, but the test coverage and the server-test regression do not. Ship Pass 3 once those resolve.**
