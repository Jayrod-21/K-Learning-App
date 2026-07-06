# REVIEW — F-014 slice: B-016 rate-limit middleware (commit a8ff23b)

Reviewer: independent senior pass. Slice = `server/src/middleware/rateLimits.ts`, `server/src/app.ts` (limiter/mount wiring), 429/retry_after tests, `server/src/routes/plan.ts` interaction w/ legacy-row retirement.

## VERDICT: **APPROVE** — 0 BLOCKER, 1 SHOULD-FIX (test strength), 2 NIT, 3 PRAISE

Both headline questions answered definitively:

**retry_after accuracy — CORRECT.** `rateLimitedHandler` (`server/src/middleware/rateLimits.ts:41-56`) reads `req.rateLimit.resetTime`, computes `Math.max(1, Math.ceil((resetTime - Date.now()) / 1000))`. Verified against installed express-rate-limit **7.5.1** source (`server/node_modules/express-rate-limit/dist/index.cjs`):
- `req.rateLimit` is populated from the **same** `store.increment()` result that made the 429 decision (index.cjs ~L712-744: `info = { …, resetTime }` → `augmentedRequest[requestPropertyName] = info` → THEN `if (totalHits > limit) config.handler(...)`). No drift — one source of truth.
- MemoryStore v7 is a **per-client fixed window**: `resetTime = first-hit-in-window + windowMs`, recycled when `resetTime <= now` (index.cjs `increment`/`resetClient`). So the delta IS the actual seconds until THIS client's counter resets — not a constant, not the full window, not ms (÷1000 + ceil → positive integer, floored at 1).
- Header consistency: the library sets its own `Retry-After` before invoking the handler (`setRetryAfterHeader`, index.cjs ~L800), which can legitimately be `0` at the window edge; the custom handler **overwrites** it with the same value as the body (`rateLimits.ts:51`), so header == body always. The comment at `rateLimits.ts:34-37` describes exactly this and is accurate.
- Fallback when `resetTime` missing: full `windowMs` — conservative (over-waits, never under-waits); each call site passes the same `cfg.RATE_LIMIT_WINDOW_MS` its limiter was built with. Consistent.

**Blast radius — SAFE, and intentionally broad.** All four limiters (cheap/expensive/auth/media) switched `message:` → `handler:`. This is NOT scope creep: predecessor commit fde008e (F-UP-004/005) had already put the retry_after **body** on every limiter via a `message` function; a8ff23b only swaps the delivery mechanism. Externally observable changes per route:
- Status: unchanged (handler hardcodes 429 == library default; no limiter overrides `statusCode`).
- Body: byte-identical shape `{ error: { code, message, retry_after } }` (old `message` object was sent via the default handler's `res.send`, also JSON).
- Headers: `RateLimit` draft-7 standard headers still set (library sets them before the handler runs — verified in index.cjs). Only `Retry-After` changes: library-computed (could be 0) → body-consistent (≥1). No client or test reads the old value. `authLimiter`'s `skipSuccessfulRequests` decrement path untouched.
- Existing 429 tests: `tests/auth.test.ts:129` (auth limiter, F-UP-005) and `tests/routes/auth.mfa.test.ts:355` (account-lockout — a *different* code path, `account_locked`, not the limiter) both assert body `retry_after` only → unaffected, and pass.
- `cheapLimiter` semantics (window/max/key) untouched; only its 429 responder unified. Fine.

**Does it fix B-016 — YES, end-to-end traced.** Limiter 429 body `error.retry_after` (snake_case, body) → client `client/src/services/api.ts:106-111` parses `body.error.retry_after` (finite number > 0) → `ApiError.retryAfter` → `client/src/pages/Writing.tsx:120-121` renders "Try again in about N seconds". Field name/casing/location match exactly (server writes snake_case body; client reads snake_case body; the header is belt-and-braces for standards compliance, not what the client consumes). Client tests exercise the now-live branch: `client/src/services/writing.test.ts:111` (429 → retryAfter intact) and `client/src/pages/Writing.test.tsx:267` (renders structured retryAfter, preserves text).

**plan.ts / legacy-row retirement — SAFE + covered.** `GET /plan/today` writing pick is `WHERE is_active` ordered by band-match then deterministic md5 (`server/src/routes/plan.ts:294-306`) — retired rows (mig 038 `UPDATE writing_prompts SET is_active = FALSE WHERE rubric IS NULL`) can never surface. Mig 038 seeds 6 active rubric-tagged rows with in-enum levels (L3/L4/L5+) and non-null `est_minutes` (15/30), so `mins`/`level` narrowing at plan.ts:309-322 gets real values. New test `server/tests/routes/plan.test.ts:284` pins the invariant directly: 0 active untagged rows, >0 active tagged rows, `/plan/today` writing non-null AND drawn from the tagged pool. TRUNCATE → CASCADE updates in the band-preference/empty-bank tests (plan.test.ts:322,347) are required by the new `writing_attempts.prompt_id` FK and correctly scoped; `tests/helpers/seed.ts` doc updated to match.

**Tests executed** (dockerized, real Postgres): `tests/routes/plan.test.ts` + `tests/routes/gradeWriting.test.ts` + `tests/auth.test.ts` → **51/51 pass**, including `gradeWriting.test.ts:215` "expensive-bucket exceeded → 429 with retry_after in the body AND a matching Retry-After header (B-016)". (Note: the review harness path `tests/middleware` doesn't exist — the limiter test lives in `tests/routes/gradeWriting.test.ts`.)

---

## Findings

### SHOULD-FIX

**SF-1 — 429 test can't catch a units (ms-vs-s) regression.** `server/tests/routes/gradeWriting.test.ts:238-244` asserts `retry_after` is a positive integer and header == body — but both are derived from the *same* variable in the handler, so if a future edit drops the `/ 1000` (retry_after ≈ 59873), integer>0 AND header-equality still pass. Test window is 60s (`tests/helpers/app.ts:274` `RATE_LIMIT_WINDOW_MS='60000'`). Add one line: `expect(retryAfter).toBeLessThanOrEqual(60);` — bounds the value to the window and makes the test regression-proof for the exact bug class B-016 exists to prevent. (Same cheap hardening available at `tests/auth.test.ts:156`.)

### NIT

**N-1 — handler hardcodes `.status(429)` instead of `options.statusCode`.** `rateLimits.ts:53`. express-rate-limit passes `(req, res, next, options)` to custom handlers; using `options.statusCode` would track a future per-limiter override. All four limiters use the default today, so no behavioral difference — just future-proofing.

**N-2 — `windowMs` fallback passed per call site.** `rateLimitedHandler(code, msg, windowMs)` requires each `build*()` to pass the same window its limiter uses (all currently `cfg.RATE_LIMIT_WINDOW_MS`, correct). A future limiter with a different window that forgets to update the third arg would get a wrong *fallback* (only matters if `resetTime` is ever absent — it never is with MemoryStore). Acceptable; a comment on the param would do.

### PRAISE

**P-1 — retry_after and the limit decision share one source of truth.** Reading `req.rateLimit.resetTime` (populated from the very `increment()` that tripped the limit) instead of recomputing from the window is the correct design — no drift under any store, and per-client-accurate with MemoryStore v7's per-client fixed window.

**P-2 — header/body consistency by construction.** Setting `Retry-After` from the same computed value (rather than trusting the library's independently-computed header, which can be 0 at the window edge while the body floors at 1) eliminates a real, subtle disagreement. The comment block (rateLimits.ts:28-39) documents the exact library behavior it defends against — verified accurate against the installed 7.5.1 source.

**P-3 — test coverage is layered.** Server: 429 body + header assertions (gradeWriting.test.ts:215). Client service: retryAfter survives the transport (writing.test.ts:111). Client UI: the previously-dead countdown branch renders (Writing.test.tsx:267). Plan: the retirement invariant is asserted against the live DB, not mocked (plan.test.ts:284). A regression to the old missing-retry_after behavior fails at three layers.

---

## app.ts note (in slice, no finding)
`server/src/app.ts:70` mounts `/writing` (cheapLimiter per-route inside the router — correct per DESIGN_F014 contract; `/grade-writing` keeps `expensiveLimiter` at `gradeWriting.ts:58`). The mount comment correctly flags the nginx allow-list requirement (km_nginx_api_route_allowlist), and both `Deploy/nginx-{blue,green}-active.conf` were updated in the same commit.
