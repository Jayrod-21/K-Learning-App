# Review

**Scope:** `server/src/middleware/rateLimits.ts` + `server/tests/auth.test.ts`, `git diff HEAD~1` on branch `fix/fup004-005-retry-after` (commit `93099ce`, closing F-UP-004/F-UP-005).

**Reviewer:** independent read-only pass. Verified against the *installed* `express-rate-limit@7.5.1` (package.json pins `^7.4.0`) — source in `server/node_modules/express-rate-limit/dist/index.cjs` and types in `dist/index.d.ts` — not just the change's own comments.

## Verdict

**APPROVE.** No blockers. The `retry_after` is genuinely precise, not a silent fallback: `resetTime` is populated (`req[requestPropertyName] = info` runs before `config.handler` is invoked, `info.resetTime` comes straight from `MemoryStore`'s `Client.resetTime`, which is a real `Date`), and the installed type (`RateLimitInfo.resetTime: Date | undefined`) matches the code's `instanceof Date` guard exactly — there is no epoch-number variant in this version, so the fallback path is dead code for the normal case (as intended: only a defensive guard against a future/exotic store). All four limiters route through the shared helper; the auth 429 test now asserts a numeric, positive `retry_after` and would fail against the pre-fix static-object `message`. Ran the four named suites plus `tsc --noEmit` — all green, 51/51 tests, no regressions to any other 429 assertion in the suite.

## Findings

**BLOCKER:** none.

**SHOULD-FIX:**
- None strictly required to merge, but see the `Math.max(1, ...)` vs. the library's own `Retry-After`/`RateLimit-Reset` floor-of-0 inconsistency below (Detailed §3) — worth a one-line comment so a future reader doesn't "fix" it into a mismatch.
- No test exercises `mediaLimiter`'s `retry_after` at all (not just this diff's gap — pre-existing; grep of `tests/` turns up zero `mediaLimiter`/`RATE_LIMIT_MEDIA` references). Since media shares the exact same `rateLimitedMessage` construction as cheap/expensive (already covered), the residual risk is low, but it's the one limiter with zero direct coverage post-change.

**NIT:**
- `rateLimitedMessage`'s inline cast `(req as Request & { rateLimit?: { resetTime?: Date } })` re-declares a shape that already exists as `express-rate-limit`'s own `RateLimitInfo` type (imported nowhere in this file). Importing `type { RateLimitInfo } from 'express-rate-limit'` and typing `req.rateLimit` via a shared augmentation (or at least via that type) would remove the duplicate/hand-rolled shape and pick up upstream changes automatically.
- The auth test bounds only `> 0`, not `<= windowMs`ish upper bound — see Detailed §5 for why this is a NIT, not a SHOULD-FIX.

**PRAISE:**
- The `message` function correctly captures `windowMs` per-limiter via closure (not a shared module constant), so cheap/expensive/media (same window in this config, but not guaranteed) and auth each fall back to their own configured window, not each other's.
- Genuinely useful comment block (lines 28–35) that names the F-UP ticket, explains *why* it's a function (needs the populated per-request `req.rateLimit`) and *why* every limiter uses it (client's `ApiError.retryAfter` consumer) — this is the "comment explains why" bar, not restating the code.
- The regression test change is a real regression test: it names the old behavior it disproves (`F-UP-005`), and separately keeps the pre-existing behavioral assertions (`code`, `message` text) rather than only adding the new assertion — so it can't accidentally pass by loosening prior checks.

## Detailed

### 1. `express-rate-limit` contract — `message` as `(req) => object`

Confirmed legal and behaves identically to a static object. From `dist/index.d.ts`:
```
message: any | ValueDeterminingMiddleware<any>;
```
and the handler in `dist/index.cjs` (~line 663):
```js
async handler(request, response, _next, _optionsUsed) {
  response.status(config.statusCode);
  const message = typeof config.message === "function"
    ? await config.message(request, response)
    : config.message;
  if (!response.writableEnded) { response.send(message); }
}
```
`response.status(429)` happens first regardless of `message`'s type, then `res.send(obj)` — Express's `res.send` delegates to `res.json` for a plain object, setting `Content-Type: application/json; charset=utf-8` exactly as it did for the old static object literal. **No behavior change** to status code, header set, or JSON body shape/serialization — only the *values* inside `error` change (now includes a real `retry_after`).

`standardHeaders: 'draft-7'` (`RateLimit-Reset`) is set earlier in the same middleware, *before* `config.handler` (and thus before the custom `message` function) runs — see §2. The two are independent writes (one a header, one the body) and coexist fine; no ordering hazard.

### 2. `resetTime` population and type — the core risk this review was asked to rule out

Traced the middleware body in `dist/index.cjs` (~line 705 onward):
```js
const incrementResult = await config.store.increment(key);
resetTime = incrementResult.resetTime;
...
const info = { limit, used: totalHits, remaining, resetTime };
augmentedRequest[config.requestPropertyName] = info;   // req.rateLimit = info, for EVERY limiter
...
if (totalHits > limit) {
  if (config.legacyHeaders || config.standardHeaders) setRetryAfterHeader(response, info, config.windowMs);
  config.handler(request, response, next, options);      // ← our message fn runs from inside here
  return;
}
```
`req[requestPropertyName]` (`req.rateLimit` — this project uses the default property name, not overridden) is assigned unconditionally on **every** request that reaches the increment step, well before the `totalHits > limit` branch that invokes `config.handler`. So by the time `rateLimitedMessage`'s returned function executes, `req.rateLimit.resetTime` is always populated for all four limiters (cheap/expensive/auth/media all use the default `MemoryStore`, confirmed — no custom `store:` option anywhere in this file).

Type: `MemoryStore.Client.resetTime` is declared `Date` (not optional) in `dist/index.d.ts`, and the public `RateLimitInfo.resetTime` is `Date | undefined` — **never a number/epoch** in the installed 7.5.1 (nor is there such a variant in the 7.x line generally; the draft-6/7/8 header helpers all call `.getTime()` on it directly, which would throw if it were ever a number). So the hypothesized "resetTime is epoch-number → guard silently falls back" bug **does not exist in this version**. The `instanceof Date` check is correct and matches the actual runtime type; the `windowMs` fallback path is unreachable under normal operation (it would only fire if a future custom `Store` implementation returned something other than a `Date`, which the type system would already flag at the `Store` interface boundary) — a reasonable defensive guard, not a bug.

### 3. Math correctness

`Math.max(1, Math.ceil(ms / 1000))`:
- `ms > 0` → whole seconds rounded up (client should wait at least this long) — correct, matches the library's own `Retry-After`/`RateLimit-Reset` semantics of "ceil to whole seconds."
- `ms <= 0` (reset already passed, e.g. clock skew or a slow rejection racing the window boundary) → floors to `1`, never `0` or negative — correct: a client is never told to retry in the past or with `retry_after: 0`, which the frontend contract (`client/src/services/api.ts:108`: `typeof retryAfterRaw === 'number' && Number.isFinite(retryAfterRaw) && retryAfterRaw > 0`) explicitly requires (`0` would be silently dropped there, becoming `undefined` — i.e. worse UX than the tiny `1` floor).
- Units: seconds, matching `ApiError.retryAfter`'s documented contract (`client/src/services/api.ts:61`, `:106-111`).

One inconsistency worth a one-line comment (SHOULD-FIX, cosmetic — not a contract break): the library's own `getResetSeconds` (`dist/index.cjs:37-45`, used for `Retry-After` and `RateLimit-Reset` headers) floors at `0`, not `1` (`Math.max(0, deltaSeconds)`). So in the rare `ms <= 0` case, this code's JSON body could say `retry_after: 1` while the `Retry-After`/`RateLimit-Reset` headers on the *same response* say `0`. Both are defensible (1s is arguably friendlier), but a reader diffing headers vs. body could read it as a bug. A short comment noting "we intentionally floor at 1s unlike the library's header helper, which floors at 0" would close that out.

### 4. Coverage & consistency

All four limiters (`buildCheap`, `buildExpensive`, `buildAuth`, `buildMedia`) now construct `message` via `rateLimitedMessage(...)`; `code` stays `'rate_limited'` everywhere, auth keeps its distinct `'too many auth attempts'` text vs. `'too many requests'` elsewhere — confirmed by direct read of the diff, no drift.

Grepped every other test file for 429/`rate_limited` assertions to check for a body-shape break:
- `tests/routes/auth.test.ts:85-100`, `conversation.test.ts:172-182`, `define.test.ts:223-235`, `progress.test.ts:169-179`, `grammar.test.ts:572-584` — all assert only `status === 429` (and in one case, `error.code`), never a fixed full-body shape lacking `retry_after`. None of these break.
- `tests/routes/auth.mfa.test.ts:350-360` asserts `retry_after` on a **423 `account_locked`** response — a different code path (account-lockout, not `express-rate-limit`) untouched by this diff; unaffected either way.
- Ran the four suites named in the task plus a full `tsc --noEmit`: **4 files / 51 tests passed**, zero type errors.

### 5. Test quality (auth 429 test, F-UP-005)

Confirmed this is a real regression test, not a tautology: pre-fix, `buildAuth`'s `message` was the static object `{ error: { code: 'rate_limited', message: 'too many auth attempts' } }` — no `retry_after` key at all, so `typeof err?.retry_after === 'number'` would have evaluated `typeof undefined === 'number'` → `false`, failing the test on the old code. The test also keeps asserting `err?.code` and `err?.message` unchanged, so it can't pass by accident via a loosened body shape.

`expect(retry_after).toBeGreaterThan(0)` without an upper bound is adequate here (NIT, not SHOULD-FIX): the test doesn't control a fake clock, so bounding tightly against `windowMs` risks flakiness under CI scheduling jitter for no real safety gain — `> 0` is exactly what the client-side contract in `api.ts:108` checks, so the test is asserting the actual consumed contract. A tighter bound (`<= Math.ceil(windowMs / 1000)`) would be a nice belt-and-suspenders addition given the fallback path exists, but its absence is not a gap that would let a real bug through undetected — the fallback correctness was already verified directly against the library source in §2.
