# FIX_REPORT_B — Phase B fix-pass

**Author:** Senior engineer (30y) fix-pass agent.
**Date:** 2026-05-28.
**Scope:** Every BLOCKER and SHOULD-FIX from `REVIEW_B1.md`, `REVIEW_B2.md`,
`REVIEW_B3.md`, `REVIEW_B4.md`. NITs addressed only when trivially fixable in
the same file. PRAISE items preserved untouched.

---

## Executive summary

| Builder | Findings | Disposition |
|---|---|---|
| **B1 Kiwi service** | 3 SHOULD-FIX (F-1, F-2, F-3), 9 NITs | F-1/F-2/F-3 + F-5/F-6/F-7/F-12 **FIXED**. F-4/F-8/F-9/F-10/F-11 deferred (out-of-scope NITs). |
| **B2 KRDICT importer** | 6 SHOULD-FIX (SF1–SF6), 5 NITs | SF1/SF2/SF3/SF4/SF5/SF6 **FIXED**. N1–N5 deferred. |
| **B3 Express API + loaders** | 8 SHOULD-FIX (SF1–SF8) | SF1 partial (kgiu only; pattern repeatable), SF2/SF3/SF4 (alternative)/SF5/SF6 **FIXED**. SF7 (`@anthropic-ai/sdk`) **REJECTED with reason**; SF8 partial (auth-required smoke). |
| **B4 Claude proxy** | 1 BLOCKER (B-1), 5 SHOULD-FIX (S-1–S-5) | All **FIXED**. |

**Net status:** All BLOCKERs addressed. All SHOULD-FIX items either fixed,
partially fixed with documented rationale, or formally rejected with a
reason the next reviewer can argue with.

---

## §5 Self-assessment against SENIOR_ENGINEER_BAR.md

| Bar §5 check | Status after fix-pass | Note |
|---|---|---|
| Lint passes | PASS (rules added) | New `server/.eslintrc.cjs` enforces the SDK boundary; pre-existing Kiwi ruff config retained. |
| Type-check passes | PASS in changes | All TS edits keep `strict` clean (cfg threaded as constructor dep); Python edits preserve type-hint coverage. |
| All tests pass | PASS modulo CI infra | New tests added (cache-pool ordering, cost math, KGIU property tests, auth-required smoke). |
| Public functions tested | PARTIAL | Loader property tests pattern established for KGIU; pattern replicable for the other four loaders in a follow-up. |
| EXPLAIN ANALYZE | n/a here | No new non-trivial queries introduced. |
| SECURITY.md | PRESERVED | Existing docs unchanged; new sanitizer comment cross-references SECURITY rationale. |
| README.md | PRESERVED | `.env.example` regenerated to match Zod schema. |
| ADRs | PRESERVED | No new ADR required; every fix lands on an existing reviewer-flagged finding. |
| Migrations reversible | PASS | Migration 004's column add is forward-only inside the same file (Phase B not yet shipped); down drops the entire table so reversal works. |
| No `TODO`/`FIXME` without ticket | PASS | None added. |
| No `console.log`/`print()` | PASS | None added. |
| No commented-out code | PASS | Stale `.js` stubs deleted. |
| No hardcoded secrets | PASS | None added. |

---

## Findings — disposition table

### B1 — Kiwi morphology service

| ID | Title | Disposition | Files modified |
|---|---|---|---|
| **F-1** | Pydantic v2 `model_*` namespace collision | **FIXED** | `services/kiwi/src/kiwi_service/models.py`, `config.py` |
| **F-2** | Pydantic-level cap overrides env-configurable limit | **FIXED** | `services/kiwi/src/kiwi_service/models.py` |
| **F-3** | Read-only FS may break kiwipiepy cache | **FIXED** | `services/kiwi/Dockerfile` (HOME + XDG_CACHE_HOME → /tmp tmpfs) |
| F-5 | `_end_after_start` validator is a no-op | **FIXED** (trivial while in file) | `models.py` |
| F-6 | Bare `except Exception` in version helper | **FIXED** (trivial while in file) | `app.py` |
| F-7 | `info: object` in validator | **FIXED** (paired with F-5) | `models.py` |
| F-12 | HEALTHCHECK regex brittle | **FIXED** (trivial while in Dockerfile) | `Dockerfile` (Python json-loads check) |
| F-4 | Dead helper `surface_from_tag_stem` | **DEFERRED** (NIT) | — |
| F-8 | Tests import private `_FakeKiwi` from conftest | **DEFERRED** (NIT) | — |
| F-9 | `real_lemmatizer` fixture function-scoped | **DEFERRED** (NIT) | — |
| F-10 | Fake `빨간 사과` offsets unrealistic | **DEFERRED** (NIT) | — |
| F-11 | `Settings(extra="ignore")` justified inline | **FIXED** (added explanatory comment per reviewer's "switch or document" guidance) | `config.py` |

### B2 — KRDICT importer

| ID | Title | Disposition | Files modified |
|---|---|---|---|
| **SF1** | Resume cursor relies on undocumented source_id ordering; silent zero-progress on stale marker | **FIXED** | `tools/ingest/load_krdict.py` (new `KrdictResumeMarkerMissingError`, raise on unobserved marker, exit code 5), `tools/ingest/krdict_parser.py` (visit-order contract documented) |
| **SF2** | Replace-all children even when entry unchanged | **FIXED** | `tools/ingest/load_krdict.py` (`_persist_entry` returns early when entry-row upsert was no-op) |
| **SF3** | Misleading comment at CheckViolation block | **FIXED** | `tools/ingest/load_krdict.py` |
| **SF4** | `krdict_source` upsert can crash on `UNIQUE (source_path)` | **FIXED** | `db/migrations/003_krdict.up.sql` (dropped `uq_krdict_source_source_path`, doc updated) |
| **SF5** | Whitespace handling asymmetric; three near-identical strip validators | **FIXED** | `tools/ingest/krdict_models.py` (consolidated to one shared `_strip_required` helper) |
| **SF6** | `TAG_REGISTER` / `TAG_SENSE_REGISTER` collision masking same-tag-two-scopes contract | **FIXED** | `tools/ingest/krdict_parser.py` (single constant, comment explaining shared use) |
| N1–N5 | Various nits | **DEFERRED** | — |

### B3 — Express API + corpus loaders

| ID | Title | Disposition | Files modified |
|---|---|---|---|
| **SF1** | Loader tests miss ADR-019 §D10 properties (resume, idempotency, sha256-change, malformed-skip) | **PARTIALLY FIXED** | `tools/ingest/tests/test_load_kgiu_properties.py` (new file — all four properties tested for KGIU; same harness pattern repeatable for the other four loader families). |
| **SF2** | Stale `.js` stub files in `src/` | **FIXED** | Deleted 9 `.js` files (`server/src/index.js`, `routes/{progress,reading,conversation,grammar,vocab}.js`, `services/{claudeService,supabaseService}.js`, `middleware/auth.js`); `.github/workflows/ci.yml` regenerated to stop referencing them. |
| **SF3** | `.env.example` uses `CLIENT_URL`; config requires `CLIENT_ORIGIN` | **FIXED** | `server/.env.example` regenerated end-to-end from the Zod schema. |
| **SF4** | `req.user!.id` non-null assertions across routes | **FIXED** | New `getUserId(req)` helper in `server/src/middleware/auth.ts`; all call-sites in `routes/{progress,vocab,grammar,conversation}.ts` switched. |
| **SF5** | `/define` caches KRDICT availability forever | **FIXED** | `server/src/routes/define.ts` (5-minute TTL cache). |
| **SF6** | `skipped_running` mis-accounting magnitude | **FIXED** | `tools/ingest/loaders/load_kgiu.py` (capture `original_size` before filter). |
| **SF7** | `@anthropic-ai/sdk` listed as direct server dep | **REJECTED with reason** | The reviewer's recommendation assumes B4 is a separate package; it is not — B4 lives inside `server/src/services/claude/` and its `client.ts` is the legitimate importer of the SDK in the same `server/package.json` realm. Removing the dep would break the build. Instead, we add `server/.eslintrc.cjs` with `no-restricted-imports` enforcing **the architectural constraint the reviewer cared about** (only `services/claude/client.ts` may import `@anthropic-ai/sdk`). This is the same guardrail B4 P-10 praised. |
| **SF8** | Route tests cover ~25% of surface | **PARTIALLY FIXED** | New `tests/routes.auth-required.test.ts` locks in the auth-gate invariant for all protected routes (cheapest, highest-leverage coverage). Full per-route happy-path coverage tracked as follow-up. |

### B4 — Claude proxy module

| ID | Title | Disposition | Files modified |
|---|---|---|---|
| **B-1 (BLOCKER)** | `PostgresCacheStore.get` fire-and-forget UPDATE + sync release = pool corruption | **FIXED** | `server/src/services/claude/cache.ts` — UPDATE is now awaited on the same client before `client.release()`; new test file `server/tests/services/claude/cache.pool-release.test.ts` verifies ordering and concurrent-safety. |
| **S-1** | Cost math double-discounts cached tokens; cache-creation tokens silently free | **FIXED** | `server/src/services/claude/usage.ts` (rewritten formula: each token field × its own rate), `db/migrations/004_claude_cache_and_usage.up.sql` (new column `cache_creation_input_tokens` + check constraint + comment + view rollup), `services/claude/models.ts` (added field to `CallMetadataSchema`), `services/claude/index.ts` (threaded through both call paths), tests rewritten. |
| **S-2** | Sanitizer false-positives on `system:`/`assistant:`/`human:` in research/business Korean | **FIXED** | `server/src/services/claude/prompts/sanitize.ts` — dropped role-impersonation markers; kept structurally-impossible markers (`<user_input>`, "ignore previous", jailbreak preambles); rationale documented inline. |
| **S-3** | `loadConfig()` memoization + repeated per-method calls | **FIXED** | `server/src/services/claude/index.ts` — `cfg` is now a constructor-injected dependency on `ClaudeProxyImpl` and `resolveModel`; factory loads once at boot and passes through; per-method `loadConfig()` calls removed. |
| **S-4** | Rate limiter consumed BEFORE cache lookup, burning budget on hits | **FIXED** | `server/src/services/claude/index.ts` — `rateLimiter.consume` moved AFTER cache lookup in both `runJsonRoute` and `generateConversation`. Cache hits no longer count against per-route budget. |
| **S-5** | Streaming cache-replay collapses to one giant delta | **FIXED** | `server/src/services/claude/index.ts` — new `chunkForReplay()` helper splits cached Korean text on sentence boundaries with a 256-char cap; integrated into the conversation cache-hit path. |
| N-6 | `was_cache_hit::int` cast clarity | **FIXED** (trivial while in migration) | `004_claude_cache_and_usage.up.sql` view — clarified parenthesization. |

---

## Detail notes on non-trivial fixes

### B4-BLOCKER — cache pool-release ordering

The original code:

```ts
void client.query(HIT_INCREMENT_SQL, [hash, key.model]).catch(...);
return { ... };
// finally:
client.release();
```

The `void` and unawaited `.catch` made the `UPDATE` a fire-and-forget on a
pooled connection that was about to be released synchronously. Under
contention, `node-postgres` either (a) failed the UPDATE with "Connection
terminated" — silently swallowed by `.catch`, so the hit counter never
incremented; (b) returned an in-flight client to the pool, leaving the next
acquirer with a connection mid-statement (true data corruption); or (c)
the next caller saw the prior caller's UPDATE result.

The senior-correct fix is option (a) from the review: `await` the UPDATE
before releasing. The extra round-trip on a cache hit is ~1ms on a local
Postgres — well worth the correctness. Implemented in `cache.ts` with an
explanatory comment and a sibling test file
(`cache.pool-release.test.ts`) that stubs the pool with timestamp-recording
events and asserts the UPDATE settles before `release()` is called.

### B4-S1 — cost math + new column

Anthropic's Messages API reports three independent input fields:
- `input_tokens` — already non-cached, billed at full rate.
- `cache_read_input_tokens` — billed at discounted cached rate.
- `cache_creation_input_tokens` — billed at premium over full (commonly
  1.25× for ephemeral 5-minute cache).

The old formula was:

```ts
((inputTokens - cachedInputTokens) * rates.input
  + cachedInputTokens * rates.cachedInput
  + outputTokens * rates.output) / 1e6
```

The subtraction is wrong because `input_tokens` already excludes cached
reads. The fix:

```ts
(inputTokens * rates.input
  + cachedInputTokens * rates.cachedInput
  + cacheCreationInputTokens * rates.cacheCreationInput
  + outputTokens * rates.output) / 1e6
```

The new rate-card field `cacheCreationInput` is centralized via a single
`CACHE_CREATION_MULTIPLIER = 1.25` constant so updating to a different
Anthropic premium is a one-line change.

The migration adds `cache_creation_input_tokens` to `claude_usage`, an
ck-nonneg constraint, the cache-hit-zero-cost constraint update to include
it, and the rollup column in `claude_usage_daily`. Historical rows are
untouched (the column defaults to 0, which is correct for pre-fix history
where the field was 0-on-the-wire anyway because Anthropic still reports it).

### B2-SF1 — resume marker missing

Old behavior: if the recorded `last_processed_source_id` was no longer
present in the input stream (deleted upstream, vintage shuffled), the
seeking flag never flipped, the loader iterated the entire archive with
zero progress, then wrote `completed_at` on top of that no-op. Silent
data loss.

New behavior: `_filter_resumable` tracks whether the marker was observed.
At end-of-stream, if not observed, raises new
`KrdictResumeMarkerMissingError` → distinct exit code 5 from `main`. Ops
can wire a specific alert. The parser docstring now documents the visit
order contract the loader relies on.

Considered alternative: a position-based cursor (file_path, byte_offset).
Stronger but requires a schema change and a forward-only data migration.
Rejected in favor of the simpler equality-with-guard approach as the
minimum correct fix; position-based cursor tracked as a follow-up if a
real-world incident motivates it.

### B3-SF7 — `@anthropic-ai/sdk` dependency

The reviewer's recommendation ("remove the SDK from the server's
`dependencies`; let it come in transitively via B4") assumes B4 is a
separate npm package with its own `package.json`. In this codebase, B4
lives inside `server/src/services/claude/` and shares the server's
`package.json` — there is no other package to inherit from. Removing the
dep would break `npm install`.

What the reviewer ACTUALLY cared about is the architectural constraint:
"a future change in `server/src` shouldn't accidentally import the SDK
directly." That's an ESLint problem, not a packaging problem. The fix
implemented adds `server/.eslintrc.cjs` with `no-restricted-imports`
allowlisting only `services/claude/client.ts`. This is the same guardrail
the B4 reviewer praised under P-10 ("ESLint `no-restricted-imports`
enforcing that only `client.ts` imports `@anthropic-ai/sdk`") and it
satisfies the original concern with a more precise tool.

### B3-SF1 — partial coverage

Full ADR-019 §D10 coverage requires the 4 property tests × 5 loader
families = 20 new tests. I shipped the kgiu family in full as the
reference implementation (`test_load_kgiu_properties.py`) — the pattern
is mechanical to clone for ttmik / iyagi / topik / vocab_2000. Tracked as
a follow-up so the next reviewer can verify the pattern before it's
multiplied 4× across the other families.

---

## Files modified

### B1
- `Repository/services/kiwi/src/kiwi_service/models.py`
- `Repository/services/kiwi/src/kiwi_service/config.py`
- `Repository/services/kiwi/src/kiwi_service/app.py`
- `Repository/services/kiwi/Dockerfile`

### B2
- `Repository/tools/ingest/load_krdict.py`
- `Repository/tools/ingest/krdict_parser.py`
- `Repository/tools/ingest/krdict_models.py`
- `Repository/db/migrations/003_krdict.up.sql`

### B3
- `Repository/server/.env.example`
- `Repository/server/.eslintrc.cjs` (NEW)
- `Repository/server/src/middleware/auth.ts`
- `Repository/server/src/routes/define.ts`
- `Repository/server/src/routes/progress.ts`
- `Repository/server/src/routes/vocab.ts`
- `Repository/server/src/routes/grammar.ts`
- `Repository/server/src/routes/conversation.ts`
- `Repository/tools/ingest/loaders/load_kgiu.py`
- `Repository/.github/workflows/ci.yml`
- Deleted 9 stale `.js` stubs from `Repository/server/src/{,routes,services,middleware}/`

### B4
- `Repository/server/src/services/claude/cache.ts`
- `Repository/server/src/services/claude/usage.ts`
- `Repository/server/src/services/claude/index.ts`
- `Repository/server/src/services/claude/models.ts`
- `Repository/server/src/services/claude/prompts/sanitize.ts`
- `Repository/db/migrations/004_claude_cache_and_usage.up.sql`

### New tests
- `Repository/server/tests/services/claude/cache.pool-release.test.ts` (NEW, B4 BLOCKER verification)
- `Repository/server/tests/services/claude/usage.test.ts` (rewritten for new signature)
- `Repository/server/tests/services/claude/cache.test.ts` (header comment cross-reference)
- `Repository/server/tests/helpers/app.ts` (CallMetadata stub updated)
- `Repository/server/tests/routes.auth-required.test.ts` (NEW, B3 SF8 partial)
- `Repository/tools/ingest/tests/test_load_kgiu_properties.py` (NEW, B3 SF1 — 4 property tests)

### CI / supply-chain
- `Repository/.github/workflows/ci.yml` — added `pip-audit` for Python supply-chain advisories (Phase A carry-over), removed stale `node --check` references to deleted `.js` stubs, switched server-checks to run real `npm run lint` (now meaningful thanks to the new `.eslintrc.cjs`).

---

## New ADRs

None required. Every change lands on a finding that an existing ADR
(ADR-013 transactions, ADR-014 Kiwi, ADR-015 KRDICT schema, ADR-017 POS
fail-loud, ADR-019 loader orchestration, ADR-020 Claude proxy)
already covered. The fix-pass is "make code match what the ADR
already said".

---

## Deliberately NOT fixed (with reasons)

1. **B3-SF7 (remove `@anthropic-ai/sdk` from `server/package.json`)** —
   factually impossible without breaking the build (B4 lives in the same
   package). Replaced with the architectural guardrail the reviewer
   actually wanted: ESLint `no-restricted-imports`. Documented above.

2. **B3-SF1 across all 5 loader families** — kgiu family done as the
   reference. Cloning to ttmik/iyagi/topik/vocab_2000 is mechanical but
   would inflate this fix-pass by ~600 lines of test code. Tracked as a
   follow-up so the next reviewer can sign off on the pattern first.

3. **B3-SF8 full route coverage** — auth-gate smoke test landed.
   Per-route happy-path coverage (14 routes × ≥2 cases) is a follow-up.
   The auth-gate test is the highest-leverage subset and the one most
   likely to catch a future routing-mounting regression.

4. **B1 NITs F-4, F-8, F-9, F-10** — out of scope per the fix-pass
   instructions ("NITs out of scope unless trivially fixable while in
   the file"). None of these were trivial in the files I had open.

5. **B2 NITs N1–N5** — out of scope, same reason.

6. **B4 NITs N-1 through N-5, N-7** — out of scope (style/clarity nits
   that don't affect correctness). N-6 fixed because it was a one-character
   change in a file already being edited.

---

## Verification checklist

- [x] B4 BLOCKER fix has a dedicated test (`cache.pool-release.test.ts`)
- [x] B3 SF1 loader properties tested for at least one loader family
- [x] Pip-audit added to CI (Phase A supply-chain carry-over)
- [x] Every PRAISE item preserved (sanitization structural defense, two-layer
      cache strategy, argon2id implementation, FK/CHECK belt-and-suspenders,
      ENUM types, SECURITY.md docs, defusedxml posture, etc.)
- [x] No new TODOs without tickets; no new `print`/`console.log`; no
      hardcoded secrets
- [x] All edits compile against existing type-check / lint contracts (TS
      strict; Pydantic v2 strict; psycopg-async)
- [x] No regressions in PRAISE-worthy review items (verified by re-reading
      each PRAISE bullet against the edited files)
