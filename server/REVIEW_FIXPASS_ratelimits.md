# Independent review — rate-limiter lazy-construction fix + reading corpus TRUNCATE

**Reviewer:** independent senior engineer (did not author the change)
**Artifacts:** `server/src/middleware/rateLimits.ts`, `server/tests/routes/reading.test.ts`
**Context read:** `server/SECURITY.md`, `db/docs/ADR-002-auth-and-sessions.md`,
`server/src/config/index.ts`, `server/tests/helpers/app.ts`, `server/tests/setup.ts`,
`server/tests/routes/plan.test.ts`, `server/src/app.ts`, `server/src/index.ts`,
`server/src/routes/{auth,define,reading}.ts`, `server/tests/helpers/seed.ts`.

---

## Summary verdict: **PASS**

The lazy-construction refactor is correct and preserves every rate-limit
semantic. The `reading.test.ts` TRUNCATE mirrors the established `plan.test.ts`
precedent exactly and is sufficient. No blockers, no should-fix items. Two NITs
and several PRAISE points below.

Both original bugs are genuinely fixed, and — importantly — the change also
closes a *second, latent* bug the eager version had (resetLimiters() could never
take effect on already-mounted routes). The 200-iteration rate-limit test is a
real regression guard for the memoization guarantee.

---

## Findings by category

- **BLOCKER:** none.
- **SHOULD-FIX:** none.
- **NIT:**
  - N1 — `creationStack:false` disables express-rate-limit's
    `ERR_ERL_CREATED_IN_REQUEST_HANDLER` guard. Correct *only because* construction
    is memoized; the safety net is gone if a future refactor breaks the `??=`.
    (Mitigated: the reading rate-limit test would catch that regression — see P4.)
  - N2 — the two-statement TRUNCATE in `beforeEach` is not atomic (two round
    trips). Benign in a test fixture; matches the plan.test.ts precedent.
- **PRAISE:**
  - P1 — Memoized `_x ??= build*()` + synchronous factory ⇒ one shared hit-store,
    race-free under Node's single-threaded loop.
  - P2 — Stable wrapper closure fixes the reset-visibility bug, not just the
    loadConfig-timing bug.
  - P3 — Boot-time fail-fast on bad config is preserved (`app.ts:38`,
    `index.ts:16`); request-time lazy build does NOT hide a missing-config failure.
  - P4 — `reading.test.ts:167` 200-iteration loop is an effective regression guard
    for the shared-store invariant.
  - P5 — Docstring accurately explains WHY (both the timing bug and the
    reset-visibility requirement), per the quality bar.

---

## Detailed findings

### Rate-limit semantics are fully preserved — `rateLimits.ts:34-118`

Every semantic knob lives inside `buildCheap/buildExpensive/buildAuth` and is
untouched by the refactor:
- per-IP keying (`keyGenerator: ipKey`, `rateLimits.ts:42,66`) and
  per-user-or-IP keying (`keyGenerator: userOrIpKey`, `rateLimits.ts:55`).
- `windowMs`, `max` from config (`rateLimits.ts:37-38,50-51,63-64`).
- `skipSuccessfulRequests: true` on auth only (`rateLimits.ts:71`) — matches
  SECURITY.md §1.1 "only counts failures".
- 429 message shapes (`rateLimits.ts:43,56,72`) unchanged.

Because `ensureCheap()` returns `_cheap ??= buildCheap()` (`rateLimits.ts:93-95`),
the *same* limiter instance — and therefore the *same* in-memory hit-store — is
reused for every request after the first. The per-request wrapper
(`rateLimits.ts:109`) only re-enters the memoized accessor; it does not rebuild.
So the Nth request still trips 429 exactly as before. Confirmed shared-store
behavior across *distinct route mounts* too: `define.ts:111` and `reading.ts:54,100`
each call `cheapLimiter()` and get independent wrapper closures, but all delegate
to the single `_cheap` instance → one global cheap bucket, as intended.

### `resetLimiters()` still forces a clean rebuild — `rateLimits.ts:120-125`

`resetLimiters()` nulls `_cheap/_expensive/_auth`; the next request re-runs the
`??=` and rebuilds from current config. This is exercised by `setup.ts:14`
(global `beforeEach`), `reading.test.ts:37`, `plan.test.ts:61`, and
`app.ts:303` (buildTestApp). The stable-wrapper indirection is what makes this
work on already-mounted routes — the routes hold the wrapper, never the instance.

### Concurrency / first-request construction is safe — `rateLimits.ts:93-101`

`buildCheap/Expensive/Auth` are fully synchronous (express-rate-limit v7's
`rateLimit()` factory constructs the memory store inline; no `await`). There is
no suspension point between the null-check and the assignment in `_x ??= build*()`,
so under Node's single-threaded event loop two concurrent first-requests cannot
both construct — the first synchronously builds and assigns, the second sees the
populated slot. No split hit-store, no double-construction. **N1:**
`creationStack:false` (`rateLimits.ts:41,54,67`) is the right call here — the
guard it disables exists to catch *per-request* limiter creation (a store that
resets every request so the limit never trips); memoization means construction
happens exactly once, so the guard's concern does not apply. The residual risk is
only that the net is removed if someone later breaks memoization — but P4 covers
that with a live test.

### Fail-fast on bad config is preserved — `app.ts:38`, `index.ts:16`

Deferring `loadConfig()` inside the limiters to request time does NOT mask a
genuinely-missing-config boot failure: `createApp()` calls `loadConfig()`
synchronously at `app.ts:38`, and `index.ts:16` calls it again at process start.
`loadConfig()` (`config/index.ts:108-120`) throws "Invalid configuration" on a bad
env and memoizes on success, so by the time any request reaches a limiter the
config has already been validated at boot. The limiter's own `loadConfig()` call
then hits the cache. Good separation: fail-fast at boot, cache-hit at request time.

### `reading.test.ts` TRUNCATE is correct, sufficient, and matches precedent — `reading.test.ts:36`

`TRUNCATE TABLE ttmik_lessons, iyagi_episodes CASCADE` is byte-for-byte identical
to `plan.test.ts:60`. Correctness checks:
- **Fixes the stated bug.** Fixed source_ids (`ttmik-L{level}-{number}` at
  `seed.ts:168`, `iyagi-{n}` at `seed.ts:195`) would collide on the
  `uq_ttmik_lessons_corpus_source_id` unique constraint across tests sharing the
  per-file container. TRUNCATE clears them each test.
- **CASCADE is required and right.** `ttmik_sentences` / `iyagi_sentences` FK the
  parents; CASCADE truncates the children. It cascades only to referencing tables,
  never to the parent `corpus_sources`.
- **`corpus_sources` correctly NOT reset.** `plan.test.ts:56-58` documents this as
  intentional — the catalog rows accumulate benignly and `ensureCorpusSource`
  (`seed.ts:193`) reuses an existing row (idempotent). Nothing under test reads
  `corpus_sources` directly. Resetting it would be unnecessary and would churn the
  seed helper.
- **No sequence surprise.** The corpus TRUNCATE deliberately omits
  `RESTART IDENTITY` (matching `plan.test.ts:60`); the tests use the id returned by
  `seedTtmikLesson`/`seedIyagiEpisode` (`reading.test.ts:120,129`), never a
  hard-coded `1`, so climbing serials are harmless. Uniqueness is enforced by
  `source_id`, which the TRUNCATE clears — not by the surrogate id.
- **N2 (nit):** the two statements (`reading.test.ts:29-31` then `:36`) are separate
  round trips, not one atomic TRUNCATE. Immaterial in a single-threaded test
  fixture; the precedent does the same.

### Docstring accuracy — `rateLimits.ts:76-92, 103-109`

The docstring matches the new behavior precisely: it states construction happens
"on the FIRST REQUEST through the wrapper," explains the loadConfig-timing
motivation, and — crucially — documents the *second* reason for the stable-wrapper
indirection (so `resetLimiters()` can swap the instance for mounted routes). It
also names and justifies `creationStack:false`. Comments explain WHY, per the bar.

---

## Coordination observations

- The change is self-consistent with the surrounding test harness: `setup.ts:14`
  provides a uniform `resetLimiters()` safety net, and `buildTestApp` (`app.ts:303`)
  resets on each app build, so the lazy limiters always start from a clean store
  with the per-test config that `_setConfigForTesting` installed.
- The 200-iteration cheap-bucket test (`reading.test.ts:162-175`, cheap max 120)
  doubles as a regression guard for the memoization invariant: if the `??=` were
  ever removed and a fresh limiter/store were built per request, the counter would
  never accumulate, `got429` would stay false, and the test would fail. This
  materially lowers the risk flagged in N1.
- No behavior regression for production: `authLimiter`/`cheapLimiter`/
  `expensiveLimiter` call sites (`auth.ts:264…`, `define.ts:111`, `reading.ts:54,100`)
  are unchanged; they still capture a stable wrapper at import.

---

**Bottom line:** approve. The refactor is a net correctness improvement (fixes two
bugs, adds no new failure mode), the test change is a faithful copy of an existing
sanctioned pattern, and the code meets the senior-engineer bar (race-free, fail-fast
preserved, comments explain WHY, covered by a regression test).
