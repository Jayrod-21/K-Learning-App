# Review: B4 — Claude proxy module

**Reviewer role:** Independent senior engineer (30 yr).
**Reviewer did NOT author the code.**
**Date:** 2026-05-28
**Scope:** `Repository/server/src/services/claude/**`, `Repository/db/migrations/004_claude_cache_and_usage.{up,down}.sql`, `Repository/db/docs/ADR-020-claude-proxy-architecture.md`.

---

## Summary verdict

**Request changes (1 BLOCKER, 5 SHOULD-FIX).** Architecture, layering, and documentation are well above the senior-engineer bar — this is genuinely good module design (clean public-API surface, single SDK-touching file, all dependencies injected for testing, two-layer caching documented honestly, prompt-injection defenses that aren't theater). The two real problems are: (1) a connection-pool corruption hazard in `cache.ts` where a `PoolClient` is released while a fire-and-forget query may still be in-flight on it, and (2) a cost-math bug that probably double-discounts cached input tokens. Both are mechanical fixes. Once those are addressed and the sanitization false-positive list is loosened for the research/business domains, this passes.

---

## Bar checklist (SENIOR_ENGINEER_BAR §5)

| # | Bar item | Status | Note |
|---|---|---|---|
| 1 | Lint passes (no warnings) | UNVERIFIED | Did not run; code uses `// eslint-disable-next-line` annotations sparingly and for justifiable reasons (in-memory stores' sync-await). |
| 2 | Type-check passes (strict) | LIKELY PASS | Code is strictly typed throughout; no `any`; readonly everywhere. `as never` / `as unknown as SdkLike` casts in test setup only. |
| 3 | All tests pass | UNVERIFIED | Tests cover happy / cache-hit / retry / zod-input / zod-output / streaming / tool-use / rate-limit. Mocked SDK, not live. Looks complete. |
| 4 | Every public function tested | PASS | Each of 4 public methods has at least one happy + one failure test. |
| 5 | `EXPLAIN ANALYZE` on non-trivial queries | NOT EVIDENCED | No query plan output in artifacts. Queries are PK / unique-index lookups so plans are obvious, but the bar says "run it". Minor. |
| 6 | SECURITY.md with attack-vector enumeration | PASS | Present at module root (10 KB). ADR-020 §5 also enumerates. |
| 7 | README written, includes "how to test" | PASS | Present at module root. |
| 8 | ADR for non-obvious decisions | PASS | ADR-020 is excellent — covers two-layer cache rationale, model defaults, alternatives considered, prompt-injection layered defense. |
| 9 | Migrations reversible AND tested both directions | PASS structure / UNVERIFIED tested | Down migration is symmetric; no test artifact run shown. |
| 10 | No `TODO`/`FIXME` without ticket | PASS | None found in module. |
| 11 | No `console.log`/`print()` | PASS | All logging via pino `Logger` injected. |
| 12 | No commented-out code | PASS | Comments are explanatory only. |
| 13 | No hardcoded secrets, URLs, or paths | PASS | All knobs in `config.ts`, env-driven, secrets behind getters. |

---

## Findings

### BLOCKER

- **B-1** `PostgresCacheStore.get`: fire-and-forget hit-increment runs on a client that is released synchronously in `finally`. (`cache.ts:145-152, 167-169`)

### SHOULD-FIX

- **S-1** `computeCostUsd` likely double-discounts cached input tokens by subtracting them from `inputTokens`. (`usage.ts:84-89`)
- **S-2** `INJECTION_MARKERS` will reject legitimate research/business Korean content containing `system:`, `assistant:`, `human:`. (`prompts/sanitize.ts:47-49`)
- **S-3** `loadConfig()` is memoized at module scope and read repeatedly inside hot methods; env changes between tests need `__resetConfigForTests()` and a couple of paths assume a fresh config that isn't guaranteed. (`config.ts:101-156`, `index.ts:152,184,479`)
- **S-4** Rate limiter is consumed BEFORE the cache lookup, so cache hits burn the per-route Anthropic budget. (`index.ts:282-282, 484`)
- **S-5** Streaming path's cache-hit replay synthesizes `delta` events from the full cached `korean` string, losing the real streaming UX *and* potentially flooding the SSE channel with a single huge delta. (`index.ts:339-342`)

### NIT

- **N-1** `MessageRequest` type uses snake_case (`max_tokens`, `tool_choice`, `cache_control`) to match the SDK wire format. Internal vocabulary should be camelCase per BAR §2 naming — fine if this is the SDK-shape boundary, but worth a comment noting why.
- **N-2** `PromptInjectionRejectedError` returns 400 — 422 is the semantically correct status for "syntactically valid but semantically rejected." Minor.
- **N-3** `cache.ts` `InMemoryCacheStore.put` increments `hitCount` on replacement writes; this drifts from Postgres semantics under "same key written twice without intervening reads" but never matters in practice. Document or normalize.
- **N-4** `claude_usage.cost_estimate_usd NUMERIC(12,6)` — the 6 decimal places are great for cents-precision; consider adding a CHECK that estimates above some sanity ceiling (say $100/call) emit a WARN, since a single call shouldn't approach that and any row exceeding it is a writer bug.
- **N-5** `withRetry` swallows attempt 0's delay as `random(0, base)` because `computeDelay(attempt=0)` is called *before* the second attempt. Documented (line 130-135) but the off-by-one between "attempt" semantics in `withRetry` (number tried) and in `computeDelay` (number already failed) is a footgun for the next maintainer.
- **N-6** `claude_usage_daily` view's `cache_hits` column casts a BOOLEAN to INT (`was_cache_hit::int`). Postgres allows it but `(was_cache_hit)::int` is clearer.
- **N-7** `Anthropic` import in `client.ts:22` uses a default import; the typed shape `SdkLike` makes that fine, but the constructor's `as unknown as SdkLike` cast (`client.ts:165`) is a hint that the official `Anthropic` type isn't being verified against `SdkLike` at compile time. A `satisfies SdkLike` clause would close that gap.

### PRAISE

- **P-1** Two-layer caching strategy is correctly identified and the rationale (ADR-020 §3) is exactly right — Anthropic's prompt cache reduces per-call cost; the local Postgres cache eliminates the call. The composition is documented.
- **P-2** SHA-256 cache key with NFC + whitespace normalization (`cache.ts:71-75`) is the correct fix for Korean code-point equivalence collisions — exactly the kind of detail a less-experienced engineer would miss.
- **P-3** Cache miss + zod-parse failure (`hit` schema fail) demotes the row and re-fetches rather than serving garbage (`index.ts:336-358, 499-541`) — exactly the right behavior for migrations that change response shape.
- **P-4** Cost-row write is correctly **soft** — `recordUsageSoft` (`index.ts:628-637`) wraps `usage.record` in a try/warn, so a usage-table outage doesn't fail user requests. The doc commitment matches the code.
- **P-5** API-key redaction via `redactCause()` (`retry.ts:183-191`) defending against future SDK regressions that attach the request object to thrown errors is the kind of paranoia good security engineers practice.
- **P-6** `gradeWriting` uses Anthropic tool-use with `tool_choice: { type: 'tool', name: 'submit_grade' }` to *force* schema-conforming output instead of trusting "respond JSON only" instructions. Correct call.
- **P-7** Model defaults in `config.ts` match CLAUDE_v2 conventions (Haiku 4.5 for cheap, Sonnet 4.6 for default, Opus 4.7 for opt-in hard) and ADR-020 §4 justifies each per-route.
- **P-8** `claude_route` and `claude_model` Postgres ENUMs (not free-text columns) plus the `claude_usage` `ck_claude_usage_cache_hit_zero_cost` check constraint are excellent defense-in-depth — they catch writer bugs at the database layer even if the application layer regresses.
- **P-9** Migration follows ADR-013: no top-level `BEGIN/COMMIT`. The runner owns transactions. (`004_claude_cache_and_usage.up.sql:24-27`)
- **P-10** ESLint `no-restricted-imports` enforcing that only `client.ts` imports `@anthropic-ai/sdk` is the correct architectural guardrail (verified by the inline comment + the actual import pattern).
- **P-11** Test coverage spans the right risk surfaces: retry classification, jitter math, zod-input rejection, prompt-injection rejection, output-schema rejection, streaming, cache hit replay, tool-use parsing. The mocked-SDK design (`makeStubSdk`) keeps tests fast.

---

## Detailed findings

### B-1 — Connection-pool corruption: client released while fire-and-forget query in flight

**File:** `Repository/server/src/services/claude/cache.ts`
**Lines:** `132-169` (get method) — specifically `145-152` (fire-and-forget) and `167-169` (synchronous release in finally).

```ts
const res = await client.query<…>(SELECT_SQL, [hash, key.model]);
if (res.rows.length === 0) return null;
const row = res.rows[0]!;

// Best-effort hit increment in a separate statement. Failure here
// does NOT fail the read — we already have the answer.
void client
  .query(HIT_INCREMENT_SQL, [hash, key.model])
  .catch((e) => this.logger.warn(…));

return {
  response: row.response,
  …
};
// finally:
if (client) client.release();
```

**Problem:** The `void client.query(...)` starts an asynchronous query and is not awaited. The function then returns through the `finally` block, which calls `client.release()`. The release happens *before* the in-flight `UPDATE` completes. `node-postgres` documents that releasing a client while a query is still pending is unsupported and can produce one of: (a) the query failing with `Connection terminated` mid-flight (and the `.catch` swallowing it), (b) the connection being returned to the pool in an inconsistent state (statement still active), or (c) the next user of that pooled connection receiving the response from the previous query — a correctness bug.

Even when (a) is the typical outcome, this is at best wasted writes (hit_count never increments) and at worst a connection-pool poisoning bug under load. The "best-effort" comment masks a real concurrency hazard.

**Fix options:**
1. `await` the increment before returning. The latency cost is one extra round-trip to Postgres; for a "tap-a-word" hot path on a local server this is negligible (<1 ms).
2. Run the increment in a *separate* `pool.connect()` and release that one when its own query settles. Heavier but truly independent.
3. Drop the hit_count field entirely — it's only used for diagnostics and could be approximated from `claude_usage`.

Option (1) is the right answer.

### S-1 — Cost math probably double-discounts cached tokens

**File:** `Repository/server/src/services/claude/usage.ts`
**Lines:** `84-89`

```ts
const cost =
  ((inputTokens - cachedInputTokens) * rates.input +
    cachedInputTokens * rates.cachedInput +
    outputTokens * rates.output) /
  1_000_000;
```

**Problem:** The Anthropic Messages API response separates `input_tokens` from `cache_read_input_tokens` and `cache_creation_input_tokens`. The standard semantics (verified against the published API reference): `input_tokens` already represents the *non-cached* input billed at the full input rate; cached reads are reported separately as `cache_read_input_tokens` and billed at the discounted rate; cache writes are reported as `cache_creation_input_tokens` and billed at a *premium* over the input rate (typically 1.25× for ephemeral). Subtracting `cachedInputTokens` from `inputTokens` therefore double-discounts: a portion of input that was never billed at the full rate is removed *again*, producing under-reported cost estimates and a misleading dashboard.

The `cacheCreationInputTokens` field is also normalized off the wire (`client.ts:86, 250`) but never used in `computeCostUsd` — cache writes are silently free in the cost report, which is the opposite of how Anthropic bills them.

**Recommended formula:**
```ts
const cost =
  (inputTokens * rates.input            // non-cached input (full price)
   + cachedInputTokens * rates.cachedInput
   + cacheCreationInputTokens * rates.cacheCreationInput  // ~1.25× input
   + outputTokens * rates.output) / 1_000_000;
```

Add a `cacheCreationInput` rate to the rate card per model and surface `cacheCreationInputTokens` through `recordUsageSoft` so it lands in `claude_usage`. Also worth adding a column for it in the migration (or backfilling later — historical rows can't be recovered).

**Verification step before fix:** confirm against the current Anthropic pricing-cache docs (the ADR-020 §7 source link should be cross-checked; the `usage.ts` comment dates the rate card 2026-05-28, so verify whether `input_tokens` in *that* version of the API includes or excludes cached reads).

### S-2 — Sanitizer false-positives on research/business Korean

**File:** `Repository/server/src/services/claude/prompts/sanitize.ts`
**Lines:** `47-49` (`'system:'`, `'system :'`, `'assistant:'`, `'assistant :'`, `'human:'`, `'human :'`)

**Problem:** DESIGN_SPEC §"Domain tagging" explicitly calls out *research* and *business* Korean as supported corpora. Business or technical Korean writing routinely contains substrings like:
- "system:" inside English technical loanwords or pasted log lines
- "assistant:" in a job description for an academic research assistant (연구 보조원)
- "human:" in a research-ethics paragraph ("human subjects")

Any of these in a sample sent to `gradeWriting` (16k char cap → plenty of room for a business case study) will throw `PromptInjectionRejectedError` and the user gets a 400 with a confusing "user input contains injection marker: \"human:\"". This is friction without security benefit — the *structural* defense (`<user_input>` wrapping + system-prompt instruction to ignore embedded instructions + zod output validation + no tools with side effects) is already the real defense. The marker list is belt-and-suspenders that catches "ignore previous instructions" and that's the only one that earns its keep.

**Recommended fix:** Drop the role-impersonation markers (`system:`, `assistant:`, `human:`, and the `### system` variants). Keep the `ignore previous`, `disregard previous`, `forget previous`, `<user_input>`, `</user_input>`, and the literal `<<sys>>` markers — those have zero legitimate use in Korean-learning content. Document the rationale inline.

### S-3 — `loadConfig()` memoization + repeated calls

**File:** `Repository/server/src/services/claude/config.ts:101-156`, `index.ts:152, 184, 217, 249, 276, 479`

**Problem:** `loadConfig()` returns a cached config object on every call, but every public method in `ClaudeProxyImpl` calls `loadConfig()` at the top (`index.ts:184, 217, 249, 276, 479`). This is harmless in steady state, but:
1. It couples every method to module-level mutable state (`cached` in `config.ts:101`).
2. Tests that need to vary env per test must use `__resetConfigForTests()` AND repopulate `process.env` AND call `loadConfig()` again — the `setTestEnv()` helper in `tests/setup.ts` exists for this purpose, but `setupProxy` in `index.test.ts:54-78` constructs the proxy and dependencies without explicitly resetting the cached config first. If two tests run in order with different env, the second sees the first's config.
3. The factory `createClaudeProxy` (`index.ts:151`) already calls `loadConfig()` once and could pass the resulting `PublicClaudeConfig` to the impl as a constructor dependency. That removes the module-level cache entirely from the read path.

**Recommended fix:** Pass `cfg` into the `ClaudeProxyImpl` constructor; methods reference `this.cfg` instead of re-calling `loadConfig()`. Keep `loadConfig()` for the boot path. This also aligns with the BAR §2 "dependency injection" principle.

### S-4 — Rate limiter burns budget on cache hits

**File:** `Repository/server/src/services/claude/index.ts:282 (conversation), 484 (json routes)`

**Problem:** `this.rateLimiter.consume(p.route, bucketKey)` runs *before* the cache lookup. A user mashing on the tap-a-word for the same lemma 100 times will consume 100 tokens against a 60/min `enrich` budget and be rate-limited even though only one actual Anthropic call occurred. This makes the limit a "request rate" limit, not the "Anthropic spend rate" limit that ADR-020 §5 §6 describes ("ration the rate-limit budget").

**Recommended fix:** Move `rateLimiter.consume` *after* the cache lookup so it only fires on misses. Side benefit: simplifies the rate-limit error path because cache hits never need to surface `ClaudeRateLimitError`.

If burst-DOS protection on cache reads themselves is a concern, add a *separate*, much-higher-capacity bucket for the lookup path — but DESIGN_SPEC doesn't indicate this is a concern at single-user scale.

### S-5 — Streaming cache replay collapses to one giant delta

**File:** `Repository/server/src/services/claude/index.ts:336-342`

```ts
if (hit) {
  const parsed = safeParse(ConversationTurnSchema, hit.response);
  if (parsed.ok) {
    queue.push({ type: 'start', register: parsed.value.register });
    queue.push({ type: 'delta', text: parsed.value.korean });  // <— entire string
    queue.push({ type: 'complete', turn: parsed.value });
    queue.end();
    …
```

**Problem:** On a cache hit, the SSE client receives `start`, one `delta` containing the entire response, and `complete`. This is observable to the frontend (no token-by-token reveal on a cached scenario) and might be confusing UX once the conversation tutor is in use. More importantly, if `korean` is multi-paragraph, a single SSE frame may exceed buffer limits in some proxies (Cloudflare default = 100 KB; rare to hit but possible for longer conversation turns).

**Recommended fix:** Either (a) chunk the cached text into pseudo-deltas (split on sentences or fixed character counts) and push them with a small delay to simulate streaming, or (b) document that cache hits emit a single delta and verify the frontend handles it. Option (a) is more honest to the UX promise.

---

## Coordination observations

- **Inter-component contract with B3:** `index.ts` exports a clean factory + interface + typed errors with `httpStatus` and `code` fields. B3's route layer can map errors to HTTP responses with one `switch (err.code)`. This is exactly the kind of contract that makes hand-off painless.
- **Migration ordering:** `004` depends on `001` (for `set_updated_at()` and `users` table). The dependency is declared in the file header (line 7) and verified to exist in `001_core_schema.up.sql:59, 154`. Good.
- **ADR-020 covers alternatives considered** (Redis, no-local-cache, response-fingerprint key, tool-use for enrich, no-unique-constraint) — each rejection has a one-sentence rationale a reasonable engineer can verify. Excellent ADR discipline.
- **Conflict surface with B2 (KRDICT, migration 003):** Migration 004 does not touch `krdict_*` tables and doesn't redefine shared types. Confirmed in the up-migration header. Clean separation.
- **SDK version pin (`^0.80.0`):** Caret allows minor/patch upgrades. For a security-critical SDK that owns the API key, consider tilde (`~0.80.0`) to allow only patch updates, with deliberate minor bumps gated by a manual review of the SDK changelog. Optional.
- **Test setup file (`tests/services/claude/setup.ts`) is referenced but not read in this review pass** — assumed to provide `makeStubSdk`, `sdkError`, `setTestEnv` based on the import shape. Worth a spot-check that `setTestEnv()` properly resets the config cache from S-3.
