# REVIEW_P3F — Pass 3 Settings profile wiring + AuthProvider.refresh + legacy archive + plan compliance

**Reviewer:** Independent senior (30 yrs). Did not write this code.
**Scope under review:**
- `client/src/pages/Settings.tsx` + `Settings.test.tsx`
- `client/src/hooks/auth-context.ts` (refresh added)
- `client/src/hooks/AuthProvider.tsx` (refresh wired)
- `client/src/hooks/AuthProvider.test.tsx` (new)
- `client/src/hooks/useAuth.ts` (type re-exports)
- `client/archive/legacy-client/README.md` (new historical note)

**Verdict: PASS WITH CONDITIONS.** Profile wiring is solid: server-as-truth, 600 ms debounce, minimal-diff patch, optimistic rollback, author-controlled error strings, one-way coupling preserved, unmount aborts both pending timer and in-flight PATCH. AuthProvider.refresh is a clean additive surface that reuses the existing probe + abort coalescing. The archive README is a defensible historical note. Tests cover the happy paths and the key failure modes. One SHOULD-FIX (sync effect can clobber a user's intentional clearing of a field), a handful of NITs around stale docstrings, redundant network round-trips, and missing edge-case tests. Nothing in the diff regresses Pass 1 / Pass 2 fixpass deliverables (provider/hook/context split, ErrorCard, useEndpointOrMock, useModalA11y, Settings substrate at `SECURITY.md` §14a) — all confirmed intact.

---

## BLOCKER (0)

None. The wiring is internally consistent and the threat-model section at the head of `Settings.tsx` enumerates the real risks honestly. Email-change-account-takeover is acknowledged as a defence-in-depth gap deferred to FU-NF-16 (verification-on-change), not silently ignored.

---

## SHOULD-FIX (1)

### S1 — Sync effect clobbers a field the user has intentionally cleared
**File:** `client/src/pages/Settings.tsx:205-220`

**The heuristic.** The sync effect treats a buffer field as "untouched" when its current value `=== ''` OR `=== prevServer[field]`, and overwrites it with the freshly-fetched server value. The `=== ''` branch is the problem.

**Repro.** User opens Settings while `meQuery` is still in-flight. `useState(() => bufferFromUser(user))` seeds `buffer.display_name = 'Jay'` from the AuthProvider user. The user clears the Name input (buffer = ''). Within the next ~80 ms (mock) or ~few-hundred ms (network), `meQuery` settles with `{display_name: 'Jay'}`. The sync effect runs:

```
prev.display_name === ''                          // true  → first branch hits
∴ rolled.display_name = next.display_name = 'Jay' // user's intentional clear is undone
```

The user's deliberate "blank this out" gesture is silently reverted to the server value. They have no way to know this happened other than watching the input flicker back.

**Why this matters.** The plan's threat model explicitly calls out "preserve user input rather than clobber it with the server's view." That commitment is honoured for `'Jared'` mid-typing but violated for the empty-string case. The class is identical: the user has expressed an intent that diverges from server truth; the heuristic should respect it.

**Suggested fix.** Track which fields the user has touched explicitly (a `touchedRef: Set<keyof ProfileBuffer>` populated by `onNameChange` / `onEmailChange` / `onPhoneChange`), and gate the overwrite on `!touchedRef.current.has(field)`. The `=== prevServer` branch is fine on its own — it's the equality-on-empty special-case that conflates "never typed" with "deliberately cleared."

A lighter alternative: only overwrite when `prev[field] === prevServer[field]` (drop the `=== ''` clause). That regresses one case — the first-paint hydration where the seed from `useAuth().user` was already empty (because the user record genuinely has no phone, say) and `meQuery` then resolves with a populated phone. But the seed is *also* `bufferFromUser(user)`, so if `user.phone` was empty the *real* server probably has no phone either; the meQuery resolve is unlikely to introduce a value the AuthProvider hadn't. In practice the `=== ''` clause buys very little and costs the regression above.

---

## NIT (5)

### N1 — Stale comment claims the mock loader returns "the Settings fixture (NOT a User)"
**File:** `client/src/pages/Settings.tsx:186-187` (and the docstring at lines 82-87 contradicts itself in the same module).

The comment reads:
> The mock loader returns the Settings fixture (NOT a User), so we gate on `isMock` to avoid treating fixture data as profile truth.

But `loadMeMock` (defined at lines 89-100 of the same file) actually returns a `User` shape (`{ id, email, display_name, phone }`). The `isMock` gate is still defensible (we don't want the corner badge gating wrong), but the rationale is wrong — fixture data IS user-shaped here. Update the comment to "we gate on `isMock` so the 🅂 badge and the server-truth state stay in sync; treating a dev fixture as last-known-good would falsely satisfy rollback comparisons after a real PATCH succeeds."

The lead docstring at lines 82-87 has the same drift — it references a phantom `loadSettingsMock` returning `Settings`, which is a Pass-2 mock unrelated to this screen's `/auth/me` query.

### N2 — Two `/auth/me` GETs per Settings mount
**File:** `client/src/pages/Settings.tsx:154-156` + `client/src/hooks/AuthProvider.tsx:67-120`

`AuthProvider` already probes `/auth/me` once at app mount. `Settings.tsx` then issues a second `/auth/me` GET through `useEndpointOrMock('settings:me', loadMeMock, { realFn: fetchMe })`. The seeded initial value from `useAuth().user` means the screen *renders* immediately, so the second fetch isn't load-bearing for paint — it's there as a "fresh truth before edits" safety net. That's defensible, but worth either (a) a one-liner comment justifying the round-trip, or (b) skipping the explicit fetch and relying on `useAuth().refresh()` for both pull and reconciliation. The current shape spends a request per Settings visit that the AuthProvider already paid for at app mount. Server-side rate-limit and audit-log impact is trivial, but the asymmetry is worth flagging.

### N3 — `refresh()` mutates AuthProvider's user but does NOT trigger `meQuery` refetch
**File:** `client/src/pages/Settings.tsx:271` + `client/src/hooks/useEndpointOrMock.ts`

After a successful PATCH, `setServerProfile(updatedBuf)` reconciles the local rollback target, and `await refresh()` updates `useAuth().user` for the rest of the app. But `meQuery.data` retains the stale pre-PATCH user — `useEndpointOrMock` has no way to know `/auth/me` changed. This is harmless in the current screen logic (the sync effect's `prevServer` ref is held in a separate React state that flushSave updated explicitly), but a reader new to this file will assume `refresh()` reconciles `meQuery` and reach for `meQuery.refetch()` next. Either add an explicit `meQuery.refetch()` after `refresh()` for symmetry, or document in the docstring that "Settings owns its own server-truth state and `meQuery` is only consulted on mount; the hook's cache is intentionally allowed to drift post-edit." Current code does the latter implicitly; making it explicit costs one comment.

### N4 — Missing tests
**File:** `client/src/pages/Settings.test.tsx`

Three coverage gaps that would have caught regressions in the threat-model promises:
- **Abort on unmount.** No test verifies that unmounting mid-debounce cancels the pending timer and that an in-flight PATCH's settle is ignored. The promise is in the head docstring; the test suite doesn't enforce it.
- **Two fields edited in the same debounce window.** A test where the user edits both display_name and email, then a 409 fires — both fields should roll back and both should show per-field errors. The current "rolls back the input and surfaces an inline error" test covers single-field rollback only.
- **Type-then-clear (the S1 case).** No test pins down the current behaviour for "user typed and deleted back to empty" — adding one now would (a) document the present semantics and (b) catch the S1 fix when it lands.

`AuthProvider.test.tsx:120-129` is a particularly nice touch — asserting that `api.get` was called with an `AbortSignal` validates the abort plumbing without inspecting internals. That same rigour applied to Settings would close the gaps above.

### N5 — Settings test mocks `useAuth` rather than rendering inside `<AuthProvider/>`
**File:** `client/src/pages/Settings.test.tsx:60-70`

The test file directly stubs `../hooks/useAuth` to provide a synthetic context value. The stated rationale ("the integration between useAuth and AuthProvider has its own test in AuthProvider.test.tsx") is sound, but it means *no* test exercises the actual context wiring. If `useAuth()` someday adds a new field that Settings reads, or if `auth-context.ts` rearranges the AuthContextValue shape, the Settings tests pass while the production code breaks. A single integration test that wraps `<AuthProvider><Settings/></AuthProvider>` with a real `api.get` mock (the AuthProvider tests already do this) would close the gap cheaply.

---

## PRAISE (kept short — preservation, not novelty)

- **Provider/hook/context three-file split intact.** `AuthProvider.tsx` (component-only, default export), `auth-context.ts` (createContext + types), `useAuth.ts` (hook + type re-exports). The `react-refresh/only-export-components` invariant Pass-1 and Pass-2 fixpasses paid for survives Pass 3 cleanly. Same for Settings — substrate at `SECURITY.md` §14a is untouched.
- **Author-controlled error messages.** `messageFor()` at `Settings.tsx:115-125` is a fixed lookup keyed on `err.status` / `err.code`; the server's text never reaches `<ErrorCard message=…/>`. The `Login.tsx` precedent set in Pass 1 is honoured here, closing the XSS-via-error-echo vector explicitly enumerated in the head docstring.
- **Abort hygiene.** `AuthProvider.probe` aborts the prior controller before issuing a new request (login/register call sites do the same), preventing the post-login probe-clobber race the docstring describes. `Settings.tsx` mirrors the pattern with its own `saveCtrlRef` for in-flight PATCHes plus a `saveTimerRef` for the pending debounce timer; both are cleared from the unmount effect at lines 230-233.
- **`refresh: probe` is just probe re-exposed.** No second code path — `AuthProvider.tsx:215` ships the existing function under a new name, and `auth-context.ts:51` documents the contract crisply ("never throws — failures are folded into status === 'guest'"). Additive, no break, dep array updated to match (line 217).
- **One-way coupling preserved.** Clearing email also clears `notif.channel.email` (`Settings.tsx:330-340`), same for phone. The Pass-2 fixpass F-B3 commitment is honoured. The `useSettings()` calls are functional updates (`updateSettings((prev) => …)` for the email-clear branch), avoiding stale-closure clobber.
- **Minimal-diff patch + collapse-to-noop.** `flushSave` only sends fields that actually changed AND have non-empty trimmed values; same-value edits are dropped before the network hop. Spares the server an audit-log row for "save" events that didn't save anything.
- **`AuthProvider.test.tsx` asserts the AbortSignal contract.** `expect.objectContaining({ signal: expect.any(AbortSignal) })` at lines 122-129 pins down a property the threat-model header takes credit for; without this test, a refactor that drops the signal would still pass the spec-level tests.

---

## Plan compliance (Pass 3 exit criteria)

| # | Pass 3 exit criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Six screens flip mock → real (Reading, Review, Chat, Grammar list+bank, Reference, Settings profile) | **PASS** | `realFn` passed to `useEndpointOrMock` in Reading.tsx:316, Review.tsx:332/337/1090, Chat.tsx:177, Grammar.tsx:195/204, Reference.tsx:169/182, Settings.tsx:154-156 |
| 2 | 🅂 MockBadge gone from those 6; stays on Today, TOPIK, Diagnostic, Hanja, Images, Settings appearance/notif | **PARTIAL** | The 6 wired screens render `<MockBadge />` only when `isMock` is true (i.e. when realFn fails and the hook falls back) — that's "gone in normal operation." The mock-only screens still ship the badge (Today.tsx:116, Topik.tsx:60, Diagnostic.tsx:92, Hanja.tsx:124, Images.tsx:103). Settings.tsx:413 also gates badge on `meQuery.isMock`, so the badge will appear if `/auth/me` is unreachable — that's behaviourally correct ("dev fixture is showing") but technically means a wired screen still has a badge in degraded mode. Acceptable interpretation; the plan's "🅂 badge gone from those" reads "when the realFn succeeds" which is what's implemented. Calling PARTIAL only because the criterion is ambiguous and the implementation chose the strict reading. |
| 3 | Tap-anything → understand → bank gesture works end-to-end on Reading | **PASS (presumed)** | Out of file scope for this review, but Reading.tsx:316 wires the loader; full end-to-end behaviour is covered by REVIEW_P3B / earlier reviews. No regression here. |
| 4 | FU-NF-4 closed (B4 streaming wire-up) | **PASS** | `FOLLOW_UPS.md:89-102` marks FU-NF-4 closed on Pass 3 (2026-05-29) with `/conversation/:id/messages` calling `generateConversation`, the new `/stream` SSE endpoint, and idempotency via `X-Request-Id`. |
| 5 | `archive/legacy-client/` created | **PASS (as historical note)** | `archive/legacy-client/README.md` exists and is honest about the situation — the files were already deleted in the Pass 1 fixpass because they imported the removed `services/supabase.ts`. The README replaces the would-be file move with an explicit list of removed paths + replacements + pointer to `PROJECT_HISTORY.md`. Plain prose, no link rot, internal hanji-screen replacements named in a table. |

**Overall: 4 PASS + 1 PARTIAL on a defensible reading.** None of the partials are regressions; they reflect interpretation choices the plan didn't constrain.

---

## Plan deviations (enumerated)

The work-as-done diverges from the plan in five places. Each deviation is defensible; documenting them so the next pass doesn't re-litigate the same choices.

1. **Services don't accept `AbortSignal`.** Plan implied unified abort plumbing through the service layer; actual: `services/auth.ts` exposes `fetchMe()` / `patchMe(patch)` with no signal parameter, and `services/grammar.ts` is the same. The screens work around it with local `AbortController`s used as flags (Settings.tsx:264-273) and via `useEndpointOrMock`'s internal controller. Functional, but means abort is observable from inside the consumer only — the network request itself continues until the server responds. For PATCH this means a "discarded" rollback PATCH still hits the server (server has no idempotency on `/auth/me`, so the late settle still mutates). Pass 4+ should plumb `AbortSignal` through `api.{get,post,patch}` and accept it at the service-fn level.

2. **`vocab.initCards` is corpus-slice not per-entry.** Out of file scope for this review; flagged here per spec because the parent prompt expects an enumeration.

3. **`StreamMessageOptions` extended with `requestId`.** `services/conversation.ts:60-130` carries an optional `requestId` field in the public interface for retry-idempotency via `X-Request-Id`. Plan defined Chat-only scope without naming this knob; the addition is well-motivated (it's the client end of the FU-NF-4 idempotency promise) but technically exceeds the Chat-only contract the spec called out. Defensible because the streaming flow needs to be idempotent end-to-end to honour the FOLLOW_UPS.md closure language.

4. **Plan called the grammar endpoint `/grammar/recognize`; actual is `/grammar/identify`.** Server route is `/grammar/identify` (server/src/routes/grammar.ts:177; client/src/services/grammar.ts:62-71). The plan's note "(verify endpoint name at `routes/grammar.ts:181`)" was a placeholder; the actual route name didn't move in Pass 3, the client just learned the truth. Reasonable.

5. **Six screens stay on mock (Today, TOPIK, Diagnostic, Hanja, Images, Settings notif + appearance halves).** Plan explicitly defers these to Pass 4-9; the Settings notif/appearance halves are correctly noted as Pass 9 in the screen↔endpoint map. Not a deviation, listed only because the parent prompt requested enumeration.

---

## Preservation check — Pass 1 + Pass 2 PRAISE invariants

| Invariant | Status |
|---|---|
| AuthProvider/hook/context three-file split | INTACT (`AuthProvider.tsx` + `auth-context.ts` + `useAuth.ts`, no exports moved) |
| SettingsProvider/hook/context three-file split | INTACT (mirror layout under `hooks/`) |
| `ErrorCard` author-controlled message contract | INTACT — Settings.tsx uses `messageFor()` fixed lookup, never echoes `err.message` |
| `useModalA11y` | INTACT (untouched) |
| `useEndpointOrMock` `refetch` contract + `isMock` gating + abort | INTACT (Settings.tsx consumes the contract correctly) |
| `SECURITY.md` §14a Settings substrate (Pass 2 fixpass C-B1) | INTACT (lines 319-397 still present, unchanged) |
| `MockBadge` gated by `import.meta.env.PROD` | INTACT (not in diff) |

---

## Sign-off

PASS WITH CONDITIONS. Land S1 before declaring Pass 3 done. N1-N5 are NITs — fold into the next checkpoint or carry as known soft debt. The work is at senior bar: threat model is honest about what it defers (email-change verification → FU-NF-16), the abort plumbing is correct end-to-end inside the React tree even though the network layer doesn't help, and the additive `refresh` API is the right shape for the next several passes (Settings, future PATCH /auth/me variants, password-change flow).
