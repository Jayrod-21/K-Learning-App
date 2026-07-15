# Re-review: B1 Reliability fix-pass

Branch `feat/beta-phaseB1-reliability` @ `8072ac4` (base `rebuild`). Independent
re-review of `FIX_REPORT_b1.md` against the actual code — I did not write the
original code, the two reviews (`REVIEW_b1-reliability.md`, `REVIEW_b1-errors.md`),
or the fix-pass. Verified against `git diff rebuild -- server/` (full B1 batch:
original builder `8a38fd9` + fix-pass `8072ac4`) and `git diff 8a38fd9 8072ac4 --
server/` (the fix-pass diff in isolation).

## Summary verdict: PASS WITH CONDITIONS

Both BLOCKERs and the SHOULD-FIX are genuinely closed, verified independently
(not just by reading the fix report) — including reproducing the F-125
guard-removal regression myself in a scratch copy and probing the diagnostic.ts
leak path's actual wire response. No regressions in the untouched B-032/B-033
code or tests. Two new, non-blocking findings surfaced during this pass (test
coverage gap on the diagnostic.ts leak path; a third un-migrated,
non-leaking Claude route the doc-comment still omits). Full server suite gate:
see numbers below.

## Per-finding status

### 1. diagnostic.ts leak (BLOCKER) — FIXED

`server/src/routes/diagnostic.ts`, `buildGeneratedItem`'s `.catch` (lines
~522-547). Confirmed both branches:

- **Recognized `ClaudeProxyError`** (`mapClaudeError(err) !== err`): the
  already-mapped, whitelisted `UpstreamError` is rethrown directly — no
  re-wrapping, no re-interpolation. `mapClaudeError` itself already logged the
  raw code/message server-side.
- **Unrecognized/raw error** (no `httpStatus`, e.g. a raw undici/SDK error
  rethrown verbatim by `retry.ts:96-99`): the catch logs `{ name, message }`
  server-side via `getLogger().error(...)` and throws a **fixed** generic
  `UpstreamError('diagnostic ${section} item generation failed')` — zero
  interpolation of `err.message` into the client-facing string.

Grep confirms no `new UpstreamError(\`...\${err` pattern remains anywhere in
`src/`.

**Independently reproduced (not just read):** copied `server/` to
`/tmp/km-b1-verify`, temporarily instrumented the existing B-006 test
(`/answer never calls the Claude proxy — the reveal returns even when
generation is down`, which already throws a raw `Error('claude is down —
generation must not run inline')` at this exact catch site) to print and
assert on the response body. Observed:

```
next3.body = {"error":{"code":"upstream_error","message":"diagnostic vocab item generation failed"},"correlationId":"..."}
```

The raw string `"claude is down"` does NOT appear anywhere in the response —
confirmed via a passing `expect(next3.body.error.message).not.toContain('claude is down')`
assertion. The fix works on the real raw-error path, not just in theory.

4xx-passthrough vs. 502 contract: correct. A `ClaudeProxyError` 4xx (e.g.
`ClaudeRateLimitError`/`PromptInjectionRejectedError`) now reads as 400/429 at
this route too, consistent with the F-094 consolidation; a raw/unrecognized
error still 502s (status defaults to 502 inside `UpstreamError` when no
`{ status }` details are passed) — the "claude down → 502" contract is intact.

**Gap (not a regression, but real):** `server/tests/routes/diagnostic.test.ts`
has **zero diff** across both the original-builder commit (`8a38fd9`) and the
fix-pass commit (`8072ac4`) — confirmed via `git diff 8a38fd9 8072ac4 --stat --
tests/`. R2's BLOCKER 1 write-up explicitly asked for "a route-level regression
test exercising a raw (non-ClaudeProxyError) thrown error to pin that the
client never sees it" — no such test was added. The pre-existing B-006 test
happens to exercise the raw-error branch (status/`genCalls` only) but, before
my scratch-copy edit, asserted nothing about message content. There is also
zero coverage in `diagnostic.test.ts` of the OTHER branch (a `ClaudeProxyError`
with `httpStatus` reaching this catch, to pin the 4xx-passthrough). The fix
itself is correct (I verified it), but it is currently unpinned in the
committed suite — a future refactor of this catch block could reintroduce the
leak with no test catching it.

### 2. enrich.ts + gradeWriting.ts (BLOCKER) — FIXED

Both routes now `import { mapClaudeError } from '../middleware/errors.js'` and
call `next(mapClaudeError(err))`; the private inline `'httpStatus' in err' →
`${code}: ${message}`` blocks are gone. The now-unused `UpstreamError` import
was dropped from both files (`grep UpstreamError src/routes/enrich.ts
src/routes/gradeWriting.ts` → no matches).

Independent repo-wide greps (not just re-running the fix report's own greps):

```
grep -rn "'httpStatus' in err" server/src/          → only middleware/errors.ts:163 (mapClaudeError itself)
grep -rn '${code}: ${message}' server/src/          → only in comments (enrich.ts:50, gradeWriting.ts:165, errors.ts doc)
grep -rn 'new UpstreamError(`' server/src/          → kiwi.ts (unrelated, non-Claude, status-code-only) + diagnostic.ts:546 (fixed generic string, no interpolation)
```

Zero live raw-forwarding paths remain outside the shared mapper.

`errors.ts`'s doc comment now lists `writing.ts / reading.ts / grammarDrill.ts
/ diagnostic.ts / conversation.ts / imageIngest.ts / enrich.ts /
gradeWriting.ts` and is accurate for all eight — each of those files does call
`mapClaudeError` (grep-confirmed).

**New finding (NIT, not a regression):** `server/src/routes/grammar.ts`'s
`POST /grammar/identify` also calls `getClaudeProxy()` (confirmed via
`grep -rl 'getClaudeProxy()' src/`) but its catch is a bare
`catch (err) { next(err); }` — never wired to `mapClaudeError`, and still not
named in the doc-comment's "every Claude-touching route" list. This is
**pre-existing** (untouched by this diff) and does **not** leak: a
`ClaudeProxyError` is not an `AppError` subclass, so it falls through
`errorHandler`'s catch-all branch to the generic opaque 500 — and there is
already a dedicated pre-existing test, `tests/routes/grammar.test.ts:775`
("B4 throws → 500 (no leak)"), pinning exactly that. So this is a completeness
gap in the doc-comment's claim of exhaustiveness (same category as the
original enrich/gradeWriting miss, just a third file, and non-security since
no raw text reaches the client) — worth a follow-up ticket, not a blocker.

### 3. F-125 test bites (SHOULD-FIX) — FIXED, independently reproduced

`server/tests/routes/conversation.test.ts`, "two concurrent first-name calls
(F-125)". The stub's `nameConversation` now folds a per-call counter into the
title (`#1`/`#2`), so the two racing calls produce divergent candidates;
assertions added: `nameCalls === 2` (proves the race window was hit),
`r1.body.title === r2.body.title` (now load-bearing — only true if the guard
enforced exactly-once), `r1.body.title` matches `/#[12]$/`, and the persisted
DB row matches the converged title.

**Reproduced the guard-removal scenario myself**, independent of trusting the
fix report's claim:

1. Copied `server/` to `/tmp/km-b1-verify` (scratch dir, no changes to the
   shared checkout).
2. Removed only `AND title IS NULL` from the UPDATE at
   `server/src/routes/conversation.ts:1099` in the scratch copy.
3. Ran `npx vitest run tests/routes/conversation.test.ts -t "F-125"` there.

**Result: 1 failed | 74 skipped.**

```
AssertionError: expected 'Chat about ... #1' to be 'Chat about ... #2'
 ❯ expect(r1.body.title).toBe(r2.body.title);
```

This is the exact regression the test now catches — with the guard removed,
both UPDATEs match unconditionally and each returns its own numbered
candidate via `RETURNING title`, so the two responses diverge and the
assertion fails. Ran the same test against the real, unmodified checkout for
contrast: **1 passed | 74 skipped**. The test is now load-bearing, closing
the exact gap R1 found (the original test passed green in both cases).

### 4. Consequent test changes — FIXED, no weakening

- `gradeWriting.test.ts` "B4 5xx error" — status assertion updated 504→502
  (correct: `mapClaudeError` flattens every 5xx-class proxy error to a blanket
  502 by design, praised by R2), plus NEW leak-closure assertions that
  `error.message` excludes `b4_timeout`/`upstream timeout`. This test used to
  prove the leak existed; it now proves it's closed. Not a weakening — it adds
  assertions the old version lacked.
- `enrich.test.ts` "B4 throws with httpStatus" (429) — status/code assertions
  unchanged (429 passthrough is correct, caller-triggered condition), plus NEW
  leak-closure assertions that `error.message` excludes
  `b4_rate_limited`/`too many tokens`. Makes the enrich migration load-bearing
  for F-124 rather than a assertion-free pass-through.

Both are strictly additive strengthenings, not regressions. PRAISE items from
the original reviews are intact and unaffected: `server/src/services/claude/
retry.ts` + `tests/services/claude/retry.test.ts` (B-032 duck-typing test) and
`server/src/routes/tickets.ts` + `tests/routes/tickets.test.ts` (B-033 race
test) have **zero diff** in the fix-pass commit (confirmed via
`git diff 8a38fd9 8072ac4 --stat`) — the fix-pass touched only
`middleware/errors.ts`, `routes/diagnostic.ts`, `routes/enrich.ts`,
`routes/gradeWriting.ts`, and three test files
(`conversation.test.ts`/`enrich.test.ts`/`gradeWriting.test.ts`). The shared
whitelist mapper's structure (whitelist-not-blacklist, `DEFAULT_UPSTREAM_
MESSAGE` fallback, server-side-only logging) is unchanged by the fix-pass
beyond the doc comment and the enrich/gradeWriting/diagnostic wiring.

## Full-suite gate (this pass, not targeted)

From `server/`:

- `npm run typecheck` (`tsc --noEmit`): **0 errors.**
- `npm run lint`: **0 errors, 73 warnings** (all pre-existing
  `@typescript-eslint/no-non-null-assertion`; matches the fix report's own
  tally exactly).
- `npx vitest run` (full suite, real Postgres testcontainers, no `-t` filter):
  **57 test files passed | 1 skipped (58 total); 1336 tests passed | 4 skipped
  (1340 total); 0 failed. Exit code 0. Duration 1137s (~19 min).** (The
  `claude output failed Zod parse` lines in the log are the intentional
  negative-path test fixtures for the output-schema-error branches — expected,
  not failures.)

## New findings (not in either original review or the fix report)

1. **Diagnostic.ts leak-path fix has no dedicated regression test** (SHOULD-FIX
   for follow-up). Add an assertion to the existing B-006 "claude is down"
   test in `diagnostic.test.ts` pinning `error.message` does NOT contain the
   raw thrown string, and add a second case exercising a `ClaudeProxyError`
   (with `httpStatus`) reaching this same catch to pin the 4xx-passthrough
   branch. Verified today's fix is correct by hand; it is not yet
   self-verifying in CI.
2. **`grammar.ts`'s `/identify` route is a third Claude-touching route outside
   the shared mapper** (NIT, pre-existing, non-leaking, already has its own
   "no leak" test). The doc-comment in `middleware/errors.ts` should either
   list it as a known exception or the route should be migrated for
   consistency — cosmetic/completeness only, not a security gap.

## Recommendation

**Ship** — both BLOCKERs and the SHOULD-FIX are genuinely closed and I
independently verified all three (including live reproduction of the two
"prove it" claims: the F-125 guard-removal failure and the diagnostic.ts
raw-error wire response). The two new findings are low-severity test-coverage/
documentation gaps, not regressions or open leaks; recommend filing them as a
fast-follow rather than blocking this merge on another fix-pass round.
