# RE-REVIEW — follow-up batch (`fix/followups`, uncommitted)

Independent re-review, 2026-07-06. Scope: the three security-adjacent /
broad-surface fixes verified in depth; the four cosmetic UI fixes spot-checked.
Reviewer did not author any of these changes.

**Gates re-run by this review** (Docker, per protocol):
- Client: `TC=0`, `LINT=0`, vitest **745 passed / 745 (70 files)**.
- Server: `tests/routes/auth.test.ts` + `tests/routes/define.test.ts` +
  `tests/services/claude` — **146 passed / 4 skipped (150)**.

---

## 1. Rate-limit ordering (F-UP-018) — **HOLDS**

**(a) Authed users not newly over-throttled.** Verified in
`server/src/routes/{enrich,gradeWriting,lemmatize}.ts`: the chain is now
`cheapLimiter(), requireAuth, expensiveLimiter()` — `expensiveLimiter` stayed
AFTER auth, so it still keys per-user (`userOrIpKey`,
`middleware/rateLimits.ts:24-26`); it was not demoted to per-IP. On
`define.ts` the swap is behavior-identical for authed callers because
`cheapLimiter` keys per-IP (`ipKey`) regardless of auth state. The only new
cost to an authed user is that expensive-route calls also debit the shared
per-IP cheap bucket: ceiling 120/min vs the expensive cap of 20/min — 6x
headroom, plus define/health traffic. Not a realistic 429 for a single user;
the trade-off is documented in the route comments.

**(b) Unauth floods now actually gated.** All five mounts verified: the new
limiter is the FIRST middleware, before `requireAuth`
(`define.ts:174-182`, `enrich.ts:27-36`, `gradeWriting.ts:55-64`,
`lemmatize.ts:15-24`, `auth.ts:984-990` `/logout`, `auth.ts:1007` `/me`).
Pre-fix, `/me` and `/logout` had NO limiter and define's limiter sat behind
auth — bogus-cookie floods (one session-table lookup each) were never
counted. Now they are.

**(c) Test semantics are right, not made-green.**
- `define.test.ts` new test: shrinks the cheap bucket to 3 via
  `_setConfigForTesting` + `resetLimiters()` (restored in `finally`), then
  asserts `statuses[0] === 401` (auth semantics preserved under the cap),
  `contains 429`, and `at(-1) === 429`. This FAILS on the pre-fix ordering
  (endless free 401s) — non-vacuous.
- `auth.test.ts` new describe: unauth `/me` (bogus cookie) and `/logout`
  floods trip 429 within AUTH_MAX=5 (pinned in `tests/helpers/app.ts:277`);
  if the limiter were missing, the loop would see 25 straight 401s and the
  test fails. The third test registers a real session and asserts 10
  consecutive authed `/me` calls all return 200 — pinning
  `skipSuccessfulRequests` so legitimate polling is never throttled.
  `resetLimiters()` runs in the suite's beforeEach (line 34), so buckets
  don't bleed across tests. The pre-existing `/logout → 401` and login-429
  tests are untouched and still pass.
- `authLimiter` counts failures only (`skipSuccessfulRequests: true`,
  `rateLimits.ts:113`), so authed `/me` polling and normal logouts cost
  nothing.

**(d) DEFERRED 15-router blanket change — sound call.** Verified against
`ttmik.ts`: audio/Range routes use `mediaLimiter()` (lines 234, 323, per-user
600/min) precisely so streaming cannot exhaust the shared cheap bucket
(F-012 R1). A blanket pre-auth `router.use(cheapLimiter())` on that router
would put every partial-content audio request back through the 120/min
per-IP cheap bucket — re-creating exactly the coupling F-012 removed. The
residual exposure (one indexed session lookup per bogus-cookie request, on a
private app behind Cloudflare + the nginx allow-list) is acceptable;
revisit-on-multi-user is the right trigger.

**Legit-user 429 exposure:** none found at realistic usage. One theoretical
edge, noted not blocking: `/me` 401s (expired session) now share the per-IP
auth bucket with `/login`, so 10 failures inside 60 s (prod default) would
briefly 429 the login form. The client probes `/me` exactly once per load
(`AuthProvider` — "the GET /auth/me probe runs exactly once"), so hitting
this requires ~10 rapid reloads with a dead cookie; window is 60 s. Accepted.

## 2. SSE redaction (F-UP-018, services layer) — **HOLDS**

`server/src/services/claude/index.ts:689-706`: the worker catch now pushes
`{ type: 'error', code, message: 'conversation stream failed' }` and logs the
raw detail at error level with `{ route, requestId, code, errMsg }`. Verified
the placement is not just correct but NECESSARY: the route
(`routes/conversation.ts:502-509`) forwards the error frame verbatim
(`code: ev.code, message: ev.message`), so the services layer is the only
gate. The client still gets enough to act — the structured `code` rides the
wire and the fixed message is what the fixed-copy client renders anyway. The
detail is NOT lost: it is logged with request correlation, and the `final`
promise still rejects with the ORIGINAL error (redaction is wire-only).

**Mutation-probe claim verified by inspection:** the test
(`tests/services/claude/index.test.ts`, "redacts the raw upstream message")
asserts `errEvent.message` is EXACTLY `'conversation stream failed'`, does
not contain the planted `x-api-key` prose, `code` is a non-empty string, and
`final` rejects with the full original message. Reverting the queue push to
`message: detail` necessarily fails the exact-match assertion. Non-vacuous.

## 3. ApiError echo → fixed copy (F-UP-018, app-wide) — **HOLDS, one CONCERN**

`client/src/lib/errorCopy.ts` keys ONLY on structured fields — `code`
(network/timeout), `status` (401/429), and the numeric `retryAfter` — and
otherwise returns the call site's own author-controlled fallback. No path
returns `err.message`. Error classes keep distinct, actionable meaning: 429
still says try-again (with a seconds countdown when `retry_after` is
present), 401 says sign in again, network/timeout are distinct; generic
failures get per-call-site copy that stays specific ("Rename failed.",
"Could not load the transcript.", etc. — not one collapsed string).
`Images.tsx` correctly kept its richer per-status upload copy (413/400/502)
and only dropped the three `err.message ||` prefixes. All 9 pages verified
routed through the helper; `lib/errorCopy.test.ts` (5 tests) covers
prose-never-escapes across status/code shapes, retry_after interpolation,
fallback passthrough, and non-ApiError input. The 7 updated page tests all
assert BOTH the fixed copy AND absence of the planted server prose —
non-vacuous (Chat, Images, Progress, Review, Reference x2, Ttmik x2).

**CONCERN — one echo site missed:** `client/src/pages/topik/MockMode.tsx:125`

```ts
function toMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}
```

Four call sites (lines 294, 314, 356, 371) feed `errorMsg`, rendered in the
mock-exam ErrorCard (line ~419). The sweep fixed `Topik.tsx` (StudyMode) but
missed the `pages/topik/` subdirectory — the "28 sites across 9 pages" count
did not include it. Same one-line fix as Diagnostic took (delegate to
`errorMessageFor`). Pre-existing behavior, so not a regression introduced by
this batch — but the batch's own doc claims the echo is fixed "app-wide",
and this branch is uncommitted, so close the gap before merge.

**Utility-loss check:** no case found where a user loses actionable
information they realistically had. Unmapped 4xx (e.g. the vocab-list 409 on
duplicate add, zod 400 prose) now render the generic call-site fallback
instead of server prose; the client pre-validates the common 400s, and a 409
mapping can be added to `errorCopy.ts` later if it ever bites. Acceptable
under the no-prose contract.

## 4. Cosmetic spot-checks — all render correctly, tests non-vacuous

- **Today carousel (F-UP-016a):** per-panel "Couldn't load this trend." vs
  reserved "No data yet"; total-outage collapses to one ErrorCard wired to
  `series.refetch`. Tests assert the failure copy, ABSENCE of "No data yet",
  absence of the carousel on total outage, and that Retry fires the observed
  per-key refetch. Good.
- **Writing pool-1 (F-UP-017):** `canRotatePrompt = prompts !== null &&
  prompts.length > 1`; both buttons disabled with explanatory title. Tests
  assert disabled state, draft survives a click, and the graded footer stays
  disabled while "Revise & regrade" remains enabled. Good — this was a
  draft-destroying no-op before.
- **Diagnostic fatal branch:** now an ErrorCard with fixed copy +
  `snap.refetch`; test asserts fixed copy, absence of the planted
  `diagnostic_snapshots` prose, Retry fires refetch, and "Begin" still
  renders (no dead end). Good.
- **Hanja featured failure:** ErrorCard on `todayResult.error`, empty state
  reserved for a successful null; test asserts the retry hits ONLY the
  `today` source (list/progress spies untouched). Good.
- **reference.ts mock deletion:** TC=0 + 745/745 is the regression proof;
  no importers remain.

---

## Verdict: **FIX-FIRST** (one small item), then ship

| Fix | Status |
|---|---|
| Rate-limit ordering (5 mounts + deferral) | **HOLDS** |
| SSE redaction (services layer) | **HOLDS** |
| ApiError echo → fixed copy | **HOLDS w/ CONCERN** (MockMode.tsx missed) |
| 4 cosmetic UI fixes | **HOLD** (spot-checked) |

Before merge: route `MockMode.tsx`'s `toMessage` through
`lib/errorCopy.errorMessageFor` (one-line change + a prose-absence assertion
in the MockMode tests, mirroring the Diagnostic fix). Nothing else must
change. No legit-user 429 path, no lost error detail, no broken auth test.
