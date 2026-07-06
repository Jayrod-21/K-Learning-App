# Independent Re-Review — F-007 fix-pass verification (resume in-progress TOPIK mock)

**Re-reviewer:** Independent senior engineer (did NOT author the code, the original reviews, or the fixes).
**Base:** `983fa09` (F-007 as built). **Fixes:** uncommitted working tree on top (`git diff`).
**Inputs checked:** `REVIEW_F007_backend.md` (R1), `REVIEW_F007_client_service.md` (R2), `REVIEW_F007_examrunner.md` (R3), `FIX_REPORT_F007.md`, and the actual current code.

---

## Summary verdict: **PASS** (ship for the personal single-user scope)

All five SHOULD-FIXes were genuinely addressed in code, not just in the report. I independently re-traced every claim and re-ran both suites: **server 52/52 pass, client MockMode 12/12 pass.** No regressions introduced. The one item that deserves a precise judgment — the in-flight-save resurrect race — is materially mitigated but **not structurally closed**; the fix-pass shipped the *client mitigation* and deferred the *server-side guard* R3 named as "the robust one." For a private single-user app that residual is acceptable; I would not block on it, but it is a real (narrow) remaining window and should not be recorded as "closed."

Counts: **4 FIXED, 1 PARTIALLY-FIXED, 0 NOT-FIXED, 0 REGRESSIONS.**

---

## Finding-by-finding

| ID | Src | Orig sev | Fix status | Verified |
|----|-----|----------|-----------|----------|
| INT4-overflow | R1 SF-1 | SHOULD-FIX | **FIXED** | `.max(INT4_MAX=2_147_483_647)` present on **all three** int fields (`sourceTest`, `currentIdx`, `remainingMs`) in `AttemptBodySchema` (`server/src/routes/topik.ts:546-554`). Tests assert `2_147_483_648` → **400** for `sourceTest` and `remainingMs`. Boundary is real: without `.max`, that value passes zod, hits the INTEGER column, throws PG `22003`, generic handler maps to **500** → the test (expecting 400) would fail. Proven. |
| picks-key coverage | R1 SF-2 | SHOULD-FIX | **FIXED** | New assertion `{ abc: 'a' }` → 400 added (`server/tests/routes/topik.test.ts:439`). Correctly exercises the `^\d+$` key regex — a widening to `z.string()` would drop this to 200 and fail the test. |
| in-flight-save resurrect | R3 SF-1 + R2 SF-1 | SHOULD-FIX | **PARTIALLY-FIXED** (client mitigation; server-side residual deferred) | See detailed trace below. Ordering, `.then`-placement, and signal threading all correct. Residual server-reorder window remains open by construction; acceptable for scope but not eliminated. |
| no save-side test | R3 SF-2 | SHOULD-FIX | **FIXED** | Submit test now asserts the latest `saveAttempt` body: `sourceTest === 7` and `picks` `toMatchObject({ '1001':'b', '1002':'a' })` (`MockMode.test.tsx:246-254`). Non-vacuous — `TEST.sourceTest=7`, and the two radio clicks (`나`→b on 1001, `하나`→a on 1002) are the values asserted, so it proves the stateRef-ordering end-to-end (latest pick is persisted, string-keyed by item id). |
| clearAttempt unused / resurrect-guard test | R3 SF-3 | SHOULD-FIX | **FIXED (with a caveat)** | Dead-export resolved: `clearAttempt` now has a real caller (`runSubmit` mop-up). Test asserts `clearAttempt` was called on submit (`MockMode.test.tsx:270-273`). **Caveat:** the *specific* SF-3 assertion R3 asked for — "no `saveAttempt` fires after submit resolves / on unmount" (the `submittedRef` no-op guard) — was **not** added; that guard is verified only by inspection, not locked by a test. Minor; see NEW-2. |
| silent resume-failure | R2 N-1 | NIT | DEFERRED-WITH-DOC | Logged to FOLLOW_UPS. Correct call for scope. |
| timer pauses while closed | R2 N-5 | NIT | WONTFIX-WITH-DOC | Documented; lenient-by-design for a study app. Fine. |
| GET picks trusted client-side | R2 N-6 | NIT | WONTFIX-WITH-DOC | User's own data; write-side constrained. Fine. |

---

## The resurrect race — detailed trace (the item worth a definitive judgment)

**Claim (a): `doSubmit` aborts the in-flight save BEFORE `onSubmit` fires.** VERIFIED.
`MockMode.tsx:683-691` — `submittedRef.current = true` → `saveCtrlRef.current?.abort()` → `onSubmit(buildBody())`, in that synchronous order. The abort provably precedes the submit dispatch.

**Claim (b): `clearAttempt` mop-up is ONLY on the real-submit success path, NOT the offline fallback.** VERIFIED.
`runSubmit` (`MockMode.tsx:300-314`): the `void clearAttempt().catch()` sits inside the `submitMockTest(...).then((real) => …)` block, after `setPhase('results')`. The offline fallback lives in the `.catch → submitTopikMockTestMock(...)` branch (`:315-331`) and contains no `clearAttempt`. So a *failed* real submit (never cleared server-side) correctly leaves its attempt for retry. Correct placement.

**Claim (c): the abort signal is threaded all the way to axios.** VERIFIED end-to-end.
`saveProgress` (`:756-762`) creates a fresh `AbortController`, stores it in `saveCtrlRef`, calls `onSave(stateRef.current, ctrl.signal)` → `handleSaveProgress(state, signal)` (`:187-207`) forwards `signal` as the 2nd arg to `saveAttempt(body, signal)` → service `saveAttempt` (`services/topik.ts:188-197`) passes `signal !== undefined ? { signal } : undefined` into `api.put`. The signal reaches the HTTP layer; it is not an accepted-but-dropped no-op.

**Bonus (real): R2's out-of-order-PUT nit (R2 SF-1) is also closed.** Because `saveProgress` aborts the prior save before starting a new one, only one PUT is ever in flight, so last-write-wins can no longer reorder two concurrent saves. The report's claim here is accurate.

**Residual — is there STILL a window?** YES, a narrow one, by construction.
The abort only cancels the request *client-side*. A PUT already received by the server before the abort still commits. The `clearAttempt` mop-up covers the *common* reorder (PUT commits → submit DELETE → clearAttempt DELETE = all consistent, row gone). But a fully adversarial interleave remains:

1. `saveProgress` dispatches PUT at T0 (before submit).
2. User submits → PUT aborted client-side, but it is already on the wire → `onSubmit` → `/mock/submit` DELETE commits.
3. Client receives the submit response → fires `clearAttempt()` DELETE, which reaches + commits on the server.
4. The straggler PUT from step 1 — delayed on the server longer than a full submit round-trip **plus** the clearAttempt round-trip — finally commits, re-INSERTing the row via the unconditional `ON CONFLICT … DO UPDATE`.

Result: a resume banner for an already-graded section. Recoverable (dismiss / re-submit). The window requires the PUT to be delayed on the server past *two* subsequent round-trips — far narrower than the pre-fix window (which was every 15s-interval/auto-submit save), but it is not zero. The truly robust fix is server-side: use the already-present-but-unused `version` column or a submitted tombstone so a PUT refuses to *create* a row for a `(user, source_test)` just submitted. That was **not** implemented; the client mop-up was chosen instead.

**Judgment:** Acceptable for a personal single-user app (single device, human-paced submit-confirm dialog, recoverable outcome). I would ship it. It should be recorded as a *known, deferred, server-side residual*, not as "the resurrect race is closed." Recommend a follow-up ticket to add the server-side `version`/tombstone guard if this ever goes multi-device or public.

---

## Regression sweep (fixes may have broken working behavior)

| Risk probed | Result |
|---|---|
| `signal` added to `onSave` breaks the **unmount** final flush | **No regression.** Unmount cleanup (`:771-777`) calls `saveProgress()`, which creates a *fresh* controller nothing subsequently aborts → the flush completes. When submit already happened, `submittedRef` short-circuits it (intended no-resurrect), and `doSubmit` already aborted the prior save. |
| Interval + pick saves **cancel each other** so no save ever settles under rapid picking | **No regression.** Each save is full-state (latest-wins is correct). After picking stops, the last save's controller is never aborted → it settles; the 15s interval also re-converges. At least the settling save completes. |
| stateRef effect-ordering (R3 P-1) undone | **Intact.** `stateRef` update effect (`:750-752`, deps `[idx,picks,remaining]`) still precedes the save effects; `saveProgress` still reads `stateRef.current`. The save-side test now locks this behavior. |
| `submittedRef` guard (R3 P-2) undone | **Intact and strengthened** — still guards `saveProgress` (`:757`) and now `doSubmit` additionally aborts the in-flight save. |
| Determinism reliance (R1) touched | **Untouched.** Server changes are limited to three `.max()` additions; the `/mock` assembly query and ordering are unchanged. |
| Offline-fallback path altered | **Correctly untouched** — `clearAttempt` is not on the fallback branch (see Claim b). |

---

## NEW findings

### NIT
- **NEW-1 — `currentIdx` overflow is guarded but untested.** The INT4 overflow test covers `sourceTest` and `remainingMs` but not `currentIdx`, even though all three received `.max(INT4_MAX)`. A regression dropping `.max` from `currentIdx` alone would pass the suite. Cheap to add `currentIdx: 2_147_483_648 → 400`. (Practically low-risk: `currentIdx` is also bounded by the exam length at hydrate.)
- **NEW-2 — R3 SF-3's resurrect-guard assertion was not fully realized.** The test proves `clearAttempt` *is* called (mop-up), but not the complementary guard R3 asked for: that **no** `saveAttempt` fires after `submitMockTest` resolves / on unmount (the `submittedRef` no-op). That guard is correct by inspection and by the `doSubmit` abort, but it is not pinned by a test, so a future regression removing the `submittedRef` check in `saveProgress` would not be caught here. Consider adding `expect(svc.saveAttempt).not.toHaveBeenCalledTimes(...)` after submit, or asserting no save call carries post-submit state.

### Observation (not a defect)
- The FIX_REPORT marks in-flight-resurrect as **FIXED**. More precisely it is **client-mitigated with a deferred server-side residual** (see trace above). Substance of the fix is real and sufficient for scope; only the label is slightly generous.

---

## Recommendation

**SHIP** for the personal single-user scope. The fix-pass is honest, the code matches the report, tests are green and non-vacuous, and no regressions were introduced.

Open two lightweight follow-up tickets (neither blocks ship):
1. **Server-side resurrect guard** — use the unused `version` column or a submitted tombstone so `PUT /topik/attempt` cannot re-create a just-submitted `(user, source_test)` row. Closes the residual window; required before any multi-device/public use.
2. **Test hardening** — add `currentIdx` INT4-overflow case (NEW-1) and the post-submit "no save fires" guard assertion (NEW-2).

Already-deferred: the silent resume-failure notice (R2 N-1), correctly in FOLLOW_UPS.
