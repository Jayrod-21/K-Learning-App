# FIX — sweep batch: services/cache/pool (2026-07-06)

Scope: `server/src/services/claude/{cache,config}.ts`, `server/src/db/pool.ts`, non-claude-index services + tests. Did NOT touch `services/claude/index.ts`, `client.ts`, routes, client (other agents' scope).

Verify: `npx tsc --noEmit` → STC=0; `npx vitest run tests/services` → **17 files passed | 1 skipped, 188 tests passed | 4 skipped**. All 6 new regression tests confirmed FAILING against reverted (pre-fix) code before final run.

## Finding #2 (HIGH) — TTL-0 inverted semantics → FIXED

Files: `server/src/services/claude/cache.ts`, comment fix in `config.ts:71`.

Approach — fix entirely inside `CacheStore` (both impls), since `index.ts` (`runJsonRoute` unconditionally get/put) is out of scope:

- `put(ttlSeconds = 0)` (or any non-positive/NaN) → **no-op**: skip connect + write entirely. Shared `expiryFor()` helper so Postgres + InMemory impls can't drift.
- Cache-forever now requires explicit exported sentinel `CACHE_TTL_FOREVER` (= `Number.POSITIVE_INFINITY`) → maps to far-future `expires_at` (`9999-12-31`), **never NULL**. Confirmed NONE of the 4 ttl-0 routes (`diagnostic_item`, `image_ocr`, `generate_grammar_drill`, `score_grammar_drill`) want forever — config docs all say "0 = no caching"; no caller uses the sentinel today. Env schema (`nonnegative int`) cannot express it → no accidental opt-in.
- `SELECT_SQL` now requires `expires_at IS NOT NULL AND expires_at > now()` → legacy NULL-expiry poison rows (incl. colliding image_ocr rows) are **misses immediately**, no purge needed for correctness.
- `EVICT_SQL` now also deletes `expires_at IS NULL` rows → poisoned rows self-heal out via the existing eviction sweep (`evictExpiredCache`). Optional manual prod cleanup (not required): `DELETE FROM claude_cache WHERE expires_at IS NULL;`
- Resolves both sub-issues: never-expire caching of the 4 routes AND image_ocr weak-key cross-image collision (route no longer cached at all).
- Deliberately did NOT edit migration 004 comment ("NULL = no expiry") — file already applied, `migrate.py` checksum-drift detection forbids touching it. Code comments in cache.ts document the new NULL-is-poison semantics.

Tests (`tests/services/claude/cache.test.ts` + `grammar_drill.test.ts`):
- InMemory: ttl 0 → nothing stored, get misses; positive ttl → stored + expires; `CACHE_TTL_FOREVER` → stored, survives evict.
- Postgres (stub pool): ttl 0 put → zero connects/queries; ttl 60 → real future `expires_at` param; FOREVER → year-9999 `expires_at`; SELECT predicate excludes NULL expiry; EVICT sweeps NULL rows.
- End-to-end via proxy (`grammar_drill.test.ts`): two identical `generateGrammarDrill` calls (real default ttl 0) → 2 SDK calls, `cache.size() === 0`, both `cacheHit false`. Pre-fix: 1 SDK call + populated cache (verified failing).

## Finding #5 (LOW-MED) — withTransaction dead-client re-pool → FIXED

File: `server/src/db/pool.ts`.

- Criterion: ROLLBACK **succeeded** → connection demonstrably healthy → plain `release()` (re-pool). ROLLBACK **failed** (socket death, backend restart) → `client.release(err)` with the original error → pg **destroys** the client instead of handing it to the next caller.
- `releaseOnce()` guard ensures exactly one release (pg throws on double-release); destroy path wraps non-Error throws into `Error`.

Tests (`tests/services/db.pool.test.ts`, new — stub pool via `setPoolForTesting`, restored after each test):
- success → BEGIN/COMMIT + one plain release;
- fn throws + ROLLBACK ok → one plain release;
- fn throws + ROLLBACK fails → exactly one `release(originalError)` (verified failing pre-fix);
- non-Error throw → destroy arg is an `Error` instance.

## Finding #7 (LOW) — cache hit-count accounting → FIXED

File: `server/src/services/claude/cache.ts`.

- UPSERT `ON CONFLICT` no longer bumps `hit_count`/`last_hit_at` (a refresh write is not a hit).
- `HIT_INCREMENT_SQL` gains `RETURNING hit_count`; `get()` reports the POST-increment count, falling back to the pre-read value if the UPDATE hits 0 rows/fails (row evicted concurrently — cosmetic only).
- `InMemoryCacheStore` mirrored (re-put preserves hitCount).

Tests: re-put does not count as hit (pre-fix reported 3, now 2); Postgres get returns RETURNING value (5, not stale 4); fallback path; UPSERT SQL contains no `hit_count`/`last_hit_at`.

## Kiwi nit (sweep "verified-clean" note) — FIXED

File: `server/src/services/kiwi.ts`.

- 5xx-exhaustion now rethrows the recorded `UpstreamError('kiwi <status>')` instead of mislabeling a live-but-erroring upstream as `'kiwi unreachable'`. Genuine network failure still → `'kiwi unreachable'`.

Tests (`tests/services/kiwi.test.ts`, new — real local HTTP server, no module mocks): reachable 500×2 → `'kiwi 500'` after 2 attempts (verified failing pre-fix); 503→200 retry succeeds; 400 → `ValidationError`, no retry.

## Skipped / not mine

- #1 (CRITICAL sdkFinal) — `claude/index.ts`, other agent (regression test already present in `index.test.ts`).
- #3 (drill score round) — `routes/grammarDrill.ts`, routes agent. NOTE: my #2 fix removes the "bad score cached forever" amplifier, but the fractional-score 500 itself still needs the route fix.
- #4 (topik_level), #8 (gradeWriting maxTotal floor), #9 (vision-cap race) — route/migration scope.
- #6 (migration idempotence) — mitigated by migrate.py runner; touching applied migrations breaks checksums; no action.
- `claudeProxy.ts` (thin adapter), `imageStore.ts`, `fsrs.ts`, `grammarScheduler.ts` — reviewed, nothing actionable (matches sweep verified-clean list).
