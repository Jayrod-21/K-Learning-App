# Fix-pass report — F-007 (resume in-progress TOPIK mock)

Fixes applied by orchestrator (deepest context on the code); independent re-review follows.
Reviews: `REVIEW_F007_backend.md` (R1), `REVIEW_F007_client_service.md` (R2), `REVIEW_F007_examrunner.md` (R3).
All 3 reviewers: **0 BLOCKERs.** Foundation verified sound (determinism = total order via `uq_topik_items_test_number`; picks string↔number key round-trip lossless; IDOR-safe by construction).

## Findings → disposition

| ID | Src | Sev | Disposition |
|----|-----|-----|-------------|
| INT4-overflow | R1 SF-1 | SHOULD-FIX | **FIXED** |
| picks-key no coverage | R1 SF-2 | SHOULD-FIX | **FIXED** |
| in-flight-save resurrect | R3 SF-1 + R2 SF-1 | SHOULD-FIX | **FIXED** |
| no save-side test | R3 SF-2 | SHOULD-FIX | **FIXED** |
| clearAttempt unused / no resurrect-guard test | R3 SF-3 | SHOULD-FIX | **FIXED** |
| silent resume-failure (no user feedback) | R2 NIT | NIT | DEFERRED → follow-up |
| timer pauses while app closed | R2 NIT | NIT | WONTFIX (expected — wall-clock not persisted mid-close; save cadence bounds loss) |
| GET picks trusted client-side | R2 NIT | NIT | WONTFIX (user's own data; server validates on WRITE) |

## What changed

**INT4-overflow** (`server/src/routes/topik.ts`): added `INT4_MAX = 2_147_483_647` const + `.max(INT4_MAX)` on `sourceTest`/`currentIdx`/`remainingMs` in `AttemptBodySchema`. Above-max now 400 at boundary, never reaches INTEGER column to 500. (Matches the grammar-Bank "schema looser than DB" incident.)

**picks-key + INT4 coverage** (`server/tests/routes/topik.test.ts`): validation test extended — non-numeric picks key `{abc:'a'}` → 400; `sourceTest`/`remainingMs` = 2_147_483_648 → 400.

**in-flight-save resurrect** (`client/src/pages/topik/MockMode.tsx`):
- ExamRunner: `saveCtrlRef` (AbortController per save). `saveProgress` aborts the prior save + passes the new signal to `onSave`. `doSubmit` aborts the in-flight save before submitting → a save can't land after `/mock/submit`'s DELETE and re-INSERT. Also kills R2's out-of-order-PUT nit (only one save in flight).
- `onSave` signature gains `signal?: AbortSignal`; `handleSaveProgress` forwards it to `saveAttempt(body, signal)`.
- MockMode `runSubmit`: on REAL-submit success only, `void clearAttempt()` mop-up (belt-and-suspenders vs a straggler that raced the tx DELETE). NOT on the offline fallback — a failed real submit never cleared server-side, so its attempt legitimately remains for retry. This is also the first caller of the previously-unused `clearAttempt`.

**tests** (`client/src/pages/topik/MockMode.test.tsx`): mock now provides `clearAttempt`. Submit test asserts (1) save side — latest `saveAttempt` carries `picks {1001:b,1002:a}` keyed by item id; (2) `clearAttempt` called on submit (mop-up). `Topik.test.tsx` mock stub completed with `clearAttempt`.

## Verification (post-fix)
- Server: full suite 711 pass / 4 skip; topik 52 (incl new cases). tsc clean.
- Client: 599 pass; tsc + lint + build clean.

## Deferred → FOLLOW_UPS
- Silent resume-failure: on `resumeAttempt` fetch failure the banner just disappears (no toast). Personal app, rare; add a small "couldn't resume" notice later.
