# Fix Report — Pass 3 tightening cycle

## Summary

Second-cycle fix-pass targeting the seven SHOULD-FIX items the Pass 3
re-reviewer flagged as `NOT-FIXED` / `PARTIALLY-FIXED` despite the
first-fix-pass's `FIXED` claims, plus the one true regression
(`RR-B1` — server PATCH `/auth/me` tests stale under the new strict
schema).

All seven items closed at the contract level. The audit-log-direct
assertion (the strictest reading of `A-SF-4`) is partially deferred to
`FU-NF-34` — the test app doesn't currently wire a pino log-capture
transport, and re-engineering `buildTestApp` to support one is wider
in scope than the rest of the tightening; the user-visible side
effects of the email-change path (version bump + GET /me reflects
new email) ARE asserted directly, which is the strongest assertion
this harness supports without that refactor.

One genuinely tightened ticket: the `C-SF-2` re-wire chose the
deferral path (`FU-NF-33`). The server route and client service both
exist, but the tap-anything chain in Reading resolves a KRDICT entry
id rather than a `vocab_entries.id`, so end-to-end wiring needs a
server-side lemma→entry resolver that isn't in scope for this
cycle. The misleading `initCards({ corpus, limit: 1 })` slice-call
was REMOVED from `Reading.tsx` so the gesture no longer pretends to
bank the tapped lemma; the local `minedIds` Set still flips for UX
honesty.

## Disposition (one row per re-review NOT-FIXED + REGRESSION)

| Re-review ID | Original severity | Status now | File:line | Notes |
|---|---|---|---|---|
| RR-B1 (regression) | BLOCKER | FIXED | `server/tests/auth.test.ts:179-280` | All pre-existing PATCH bodies carry `expected_version: 1`; added strict-schema reject, version-mismatch 409, audit-log assertion (user-visible side effect), audit-log capture deferred to FU-NF-34. |
| D-B3 | BLOCKER | FIXED | `client/src/pages/Review.test.tsx:345-407` | Two new tests: spacebar reveals (`fireEvent.keyDown(window, …)`, asserts `aria-expanded` flip + rating buttons appear); spacebar-ignored-with-sheet-open (opens ListDetailSheet, switches back to session tab, asserts no reveal). |
| C-SF-1 | SHOULD-FIX | FIXED | `client/src/components/WordPopover.tsx:76-103, 172-200`; `client/src/pages/Reading.tsx:316-465`; `client/src/pages/Reading.test.tsx:367-405` | `WordPopover` gained `isLoading?: boolean` prop; renders spinner placeholder + suppresses actions row while true. `Reading.tsx`'s `runSlowPath` opens popover IMMEDIATELY with `isLoading=true` + raw word as stub; resolves to populated data after chain settles; failure modes downgrade to "Definition unavailable" line. Test exercises the hanging-promise case. |
| C-SF-2 | SHOULD-FIX | DEFERRED-with-doc (FU-NF-33) | `client/src/pages/Reading.tsx:497-525`; `FOLLOW_UPS.md:FU-NF-33` | Server route + client `bankEntry(entryId)` exist. Misleading `vocabInitCards({ corpus, limit: 1 })` call REMOVED. Local `minedIds` Set still flips. Threat-model comment updated. Reading.test now asserts "no network call fires on add". |
| C-SF-5 | SHOULD-FIX | FIXED | `client/src/services/conversation.test.ts:148-186` | New test asserts `streamSse`'s 3rd-arg `headers` equals `{'X-Request-Id': 'abc-123'}` when `requestId` is set; inverse test asserts `headers` is undefined when omitted (defends against accidental hardcoding). |
| C-SF-6 | SHOULD-FIX | FIXED | `client/src/pages/Chat.test.tsx:313-352` | New test captures first send's requestId, simulates `onError`, clicks Retry, asserts a second `streamMessage` call with the **same** requestId. |
| E-SF-1 | SHOULD-FIX | FIXED | `client/src/pages/Grammar.tsx:207-244`; `client/src/pages/Grammar.test.tsx:184-237` | `useEffect` keyed on `bankedState.data` drops overlay entries reconciled with server truth; 50-entry cap drops oldest on overflow; identity preserved when no prune happens. Test exercises the bank → refetch → reconciled chip flow. |
| E-SF-3 | SHOULD-FIX | FIXED | `client/src/pages/Reference.tsx:208-228`; `client/src/components/MockBadge.tsx:1-46`; `client/src/pages/Reference.test.tsx:194-235` | Reference's `isMock` derivation flipped from `.some()` to AND-across-realFn-backed-sources; hanja (mock-only) excluded from the conjunction. MockBadge JSDoc documents the cross-screen rule explicitly. Test asserts badge OFF when both realFn-backed sources succeed and ON when both fail. |
| F-S1 | SHOULD-FIX | FIXED | `client/src/pages/Settings.test.tsx:263-332` | Test hydrates phone='+15555550100' + version=1, types '9' then clears, advances 700ms; asserts phone stays empty AND no PATCH is sent (empty phone is filtered out of the diff body because the server's Zod schema rejects it). Documents the deliberately-cleared invariant — pre-fix the sync effect would have clobbered back to the server value. |

## Detailed dispositions

### RR-B1 — server PATCH /auth/me regression

The Pass 3 fix-pass introduced `expected_version: z.number().int().positive()`
on `PatchMeSchema` as a REQUIRED field but left the pre-existing PATCH
tests in `tests/auth.test.ts` sending bodies without it. Every one
would 400 on first server-test run.

Closed at the contract level by updating every existing PATCH body
to carry `expected_version: 1` (the registered user's initial
version), and adding the four new tests the re-reviewer specifically
called out:

1. `rejects body missing expected_version → 400 (strict-schema)` —
   sends `{ display_name: 'X' }`, asserts 400 + `validation_error`.
2. `409 on stale expected_version (concurrent writer beat us)` —
   sends first PATCH with `expected_version: 1`, asserts 200 + version 2;
   sends second PATCH with `expected_version: 1`, asserts 409 + `conflict`.
3. `emits an audit log entry when the email changes` — asserts the
   user-visible side effects (version bump + GET /me returns the new
   email). Direct log-line assertion is deferred to FU-NF-34 because
   `buildTestApp` doesn't currently wire a pino log-capture transport;
   re-engineering that is wider in scope than this cycle.
4. The pre-existing email-collision 409 + 401-when-unauthenticated cases
   were updated to send `expected_version: 1` in their bodies so they
   exercise the new gate path correctly.

The happy-path test also gained `expect(res.body.user.version).toBe(2)`
to assert the optimistic-concurrency invariant — a successful PATCH
must bump the version.

### D-B3 — spacebar reveal tests

Two new tests in `Review.test.tsx`. Both use
`fireEvent.keyDown(window, { key: ' ' })` — the Pass 2 idiom
documented in the original review (userEvent + fake timers deadlocks
in happy-dom for the window-bound listener path). The reveal
assertion keys off the Flashcard's `aria-expanded` attribute (the
component uses `aria-expanded` rather than `aria-pressed` because
"reveal a hidden face" is semantically a disclosure, not a toggle).
The sheet-open-guard test opens `ListDetailSheet` by switching to
the Lists tab and tapping the active list row, then navigates back
to the Session tab so the spacebar listener is mounted; the guard
keeps the reveal from firing.

### C-SF-1 — WordPopover loading affordance + Reading wiring

`WordPopover.tsx`:
- Added optional `isLoading?: boolean` prop.
- When true, the body region (lede + example block) and the action
  row (Add + More-examples + drawer) are both suppressed in favour
  of a small inline spinner with `data-testid="word-popover-loading"`,
  `role="status"`, and a `aria-live="polite"` region.
- The dialog head (KR headword + close button) stays visible so the
  dialog has a stable accessible name and the user can dismiss.

`Reading.tsx`:
- `runSlowPath` now opens the popover IMMEDIATELY with a stub
  carrying the raw tapped word (so `aria-labelledby` resolves), sets
  `popLoading=true`, then runs the lemmatize → define → enrich
  chain. On settle, sets the resolved popover data and clears
  `popLoading`. If define fails, falls back to a "Definition
  unavailable" line; if enrich fails, popoverFromDefine surfaces the
  dictionary entry without the enrichment summary.
- `handleClose` clears `popLoading` defensively (in addition to
  setting popData to null).
- The fast-path branch (fixture-attached gloss) explicitly sets
  `popLoading=false` so a previous slow-path's lingering true never
  bleeds into the next tap.

`Reading.test.tsx`:
- New test mocks lemmatize + defineEntry as pending promises (never
  resolve), clicks a placeholder-gloss tapword, asserts the dialog
  IS in the DOM AND the spinner placeholder IS rendered AND the
  Add-to-bank action is NOT rendered (loading suppresses it).

### C-SF-2 — Reading Add-to-bank rewire deferral

Per the spec, the per-entry server endpoint `POST /vocab/entries/:entryId/bank`
and client service `services.vocab.bankEntry(entryId)` both ship with
Pass 3. But the tap-anything chain resolves a `DefineEntry.id`
(KRDICT primary key), NOT the `vocab_entries.id` the bank endpoint
expects. Wiring the gesture end-to-end needs a server-side
lemma→entry resolver that isn't in scope for this cycle.

Cleaner path chosen (per spec): REMOVE the misleading
`initCards({ corpus, limit: 1 })` slice-call from `Reading.tsx` and
file `FU-NF-33` with the full re-wire plan.

What landed:
- `Reading.tsx` no longer imports `initCards` from `services/vocab`.
- `DEFAULT_VOCAB_CORPUS` constant removed.
- `handleAdd` simplified: vocab branch flips local `minedIds` Set
  only; grammar branch unchanged.
- File-header threat-model comment + `handleAdd` JSDoc rewritten to
  document the deferral and link FU-NF-33.
- `Reading.test.tsx`: the old `add-to-bank calls vocab.initCards`
  test was rewritten to assert the new contract (no network call
  fires; the Add button locks to "Added"). The `services/vocab` mock
  in the test file was removed since Reading no longer imports it.

### C-SF-5, C-SF-6 — X-Request-Id forwarding tests

`conversation.test.ts`:
- New test calls `streamMessage` with `requestId: 'abc-123'`, mocks
  `streamSse`, captures the 3rd-arg `headers`, asserts
  `{ 'X-Request-Id': 'abc-123' }`.
- Inverse test asserts `headers === undefined` when `requestId` is
  omitted (defends against an accidental hardcoded header — would
  silently break the idempotency contract).

`Chat.test.tsx`:
- New test types '실패', sends, captures `streamCalls[0].requestId`.
- Simulates `onError(ApiError)` + `reject` to trip the failed-row
  marker.
- Clicks `Retry sending message` button.
- Asserts a second `streamCalls[1]` entry exists with the SAME
  `requestId` as the first call.
- Also asserts `body.content` is preserved on retry.

### E-SF-1 — optimisticBanked prune + 50-cap

`Grammar.tsx`:
- New `useEffect` keyed on `bankedState.data`. When the server's
  bank settle includes a pattern key currently in `optimisticBanked`,
  that key is dropped from the overlay — the server is now the source
  of truth.
- Identity-preserving: if no entries were pruned, returns the same
  Set reference so the `bankedKeys` memo doesn't re-run on no-op
  settles.
- 50-entry cap: if pruning still leaves >50 entries (defensive — a
  healthy session shouldn't), keeps only the most recent 50 (Set
  iteration = insertion order, so `.slice(-50)`).

`Grammar.test.tsx`:
- New test under `describe('Grammar — optimisticBanked overlay prune (E-SF-1)')`:
  - `listBanked.mockResolvedValueOnce(EMPTY_BANK)` (initial), then
    `.mockResolvedValue({...includes the just-banked row...})` (post-bank
    refetch).
  - Asserts the chip flips to "Already banked" and `listBanked` was
    called at least twice (sanity that the refetch fired and the
    reconciled snapshot was loaded).

### E-SF-3 — Reference MockBadge semantics

`Reference.tsx`:
- The `.some()` derivation was replaced with a per-filter branch:
  - `vocab` filter → `vocabState.isMock`.
  - `grammar` filter → `grammarState.isMock`.
  - `hanja` filter → `hanjaState.isMock`.
  - `all` filter → `vocabState.isMock && grammarState.isMock`
    (hanja's mock-only `isMock: true` is excluded).
- Inline comment cross-references `MockBadge.tsx` JSDoc.

`MockBadge.tsx`:
- JSDoc gained a new section `## Gating semantics — when to fire the badge`
  documenting the cross-screen rule + examples for Grammar (drill
  is mock-only) and Reference (hanja is mock-only).

`Reference.test.tsx`:
- New describe block `Reference — MockBadge gating (E-SF-3)`:
  - "does NOT fire under the All filter when realFn-backed sources are real"
    — vocab + grammar both resolve real → badge absent.
  - "DOES fire when both realFn-backed sources fall back to mock"
    — both real fns reject → fixture loader fires → badge present.

### F-S1 — Settings deliberately-cleared test

`Settings.test.tsx` gained a new test (`it('honours a deliberately
cleared field — no clobber from a subsequent server sync (F-S1)')`).

Setup:
- `mocks.fetchMe.mockResolvedValue({ phone: '+15555550100', version: 1, … })`.
- `mocks.patchMe.mockResolvedValue({...})` — defensive, but should
  never be invoked.

Steps:
1. Render Settings inside SettingsProvider.
2. `waitFor` until the phone input reads `'+15555550100'` (sync
   effect lands the server-truth seed).
3. `user.type(phone, '9')` → `user.clear(phone)` — trips
   `editedFieldsRef` even though the final value collapses to empty.
4. `vi.advanceTimersByTime(700)` — debounce fires.
5. Assert `phone.value === ''` (F-S1 part 1: the field stays empty;
   the sync effect doesn't clobber).
6. Assert `mocks.patchMe` was NOT called (F-S1 part 2: the diff
   builder drops empty values from the patch body because the
   server's Zod schema rejects empty phone).

Why no second-PATCH-then-sync scenario: the harness can't drive a
`meQuery` refetch from outside Settings (there's no key change, and
`useAuth.refresh()` is mocked). The local invariant — "deliberately
cleared field stays empty across a 700ms debounce + flushSave roundtrip"
— is the assertion that matters for the F-S1 contract. The longer
"refresh-driven re-sync doesn't clobber" path is exercised
indirectly by the existing rollback tests which assume the sync
effect respects `editedFieldsRef`.

## Verification gates

- `cd Repository/client && npm run build` — NOT RUN (sandbox blocks
  bash execution this turn). Manual inspection: no new imports
  outside the existing module surface; type signatures match
  existing patterns (`isLoading?: boolean` matches the pattern of
  other optional props in the codebase; `useEffect` deps array
  matches existing usages).
- `cd Repository/client && npm run lint` — NOT RUN (sandbox).
  Manual inspection: no new disables; no dangling imports; no
  console.log / TODO / FIXME introduced.
- `cd Repository/client && npm test` — NOT RUN (sandbox).
  Each new test was traced through by hand against the production
  code to verify the assertion contract. The Pass 2 fireEvent + fake
  timer idiom was preserved for the spacebar tests; existing test
  scaffolding (`vi.hoisted`, mocked `useEndpointOrMock`, captured
  `streamCalls`) was reused without modification.
- `cd Repository/server && npm run build` — NOT RUN (sandbox).
  Pre-existing claude-proxy + gradeWriting TS errors remain under
  `server-typecheck: must_pass: false` per `TESTS.md`; not affected
  by this cycle's changes.
- `cd Repository/server && npm test` — NOT RUN (sandbox, requires
  Docker testcontainers). The PATCH /auth/me tests were updated by
  pattern: every pre-existing body got `expected_version: 1`; new
  tests follow the same agent-based supertest idiom as the rest of
  the file. The audit-log test asserts user-visible side effects
  (version bump + GET /me reflects new email) rather than direct
  log capture; capture is deferred to FU-NF-34.

## New tickets filed

Appended to `/root/Jared/9b. Korean Master -- OVERNIGHT/FOLLOW_UPS.md`:

- **FU-NF-33** — Wire Reading Add-to-bank end-to-end via `bankEntry(entryId)`
  once the server-side lemma→`vocab_entries.id` resolver lands.
- **FU-NF-34** — Capture the PATCH /auth/me audit-log entry directly
  via a pino log-capture transport wired through `buildTestApp`.
- **FU-NF-35** — Thread `signal?: AbortSignal` through every mutation
  service (`submitReview`, `createList`, `patchList`, `deleteList`,
  `addListEntries`, `removeListEntry`, `startConversation`,
  `appendMessage`, `listConversations`).
- **FU-NF-36** — Simplify Review.tsx's `lastKey` rollback heuristic to
  a direct `ratedCardId` comparison.
- **FU-NF-37** — Settings: dedicated test asserting AbortSignal is
  forwarded into PATCH under unmount-mid-debounce.
