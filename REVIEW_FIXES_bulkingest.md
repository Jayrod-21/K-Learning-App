# Re-Review — feat/bulk-book-ingest fix-pass verification

Independent re-reviewer: did not author, review, or fix this code. Every claim below was verified
against the actual code on `feat/bulk-book-ingest` (HEAD `bc08cf1`), not against the FIX_REPORT's
description of it. Mutation testing was performed and the working tree was restored byte-exact
afterwards (`git diff` empty, final suite re-run green).

## VERDICT: **PASS WITH CONDITIONS**

All three SHOULD-FIX implementations are correct in the production code path, the four NIT fixes
are real, N-3 is correctly deferred, and nothing regressed. The conditions are two **test-strength
gaps** found by mutation testing (details below) — neither is a defect in the script itself, and
neither blocks the prod run. Ship recommendation at the bottom: **safe to run against prod.**

## Gates (all re-run by me, not trusted from the report)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| `ESLINT_USE_FLAT_CONFIG=false npx eslint src/scripts/bulk-ingest-books.ts tests/scripts/bulk-ingest-books.test.ts` | PASS (exit 0; only the expected eslintrc-deprecation banner) |
| `npx vitest run tests/scripts/bulk-ingest-books.test.ts` | PASS — **18/18** (matches the claimed count) |
| `npm run build` | PASS — `dist/scripts/bulk-ingest-books.js` emitted (21,615 bytes) |

---

## Finding-by-finding verification

### SF-1 (poisoned client after failed ROLLBACK) — **VERIFIED FIXED (code); see NEW-1 for the test**

Verified against the actual `withTransaction` in `server/src/db/pool.ts:128-171`, which on a failed
ROLLBACK calls `releaseOnce(err ...)` with the **original** transaction error (`pool.ts:165`), not
the rollback error, and destroys the client via `client.release(err)`.

The script now matches that contract exactly:
- `ingestOne` (`bulk-ingest-books.ts:253-268`): ROLLBACK failure → logs → invokes
  `hooks.onRollbackFailure?.(err ...)` with the **ORIGINAL** ingest error (`:266`), then rethrows
  the original unmasked. Rollback success → no hook, plain-release eligibility documented.
- `runBulkIngest` (`:408-422`): single `finally`, exactly one release —
  `client.release(poisonedBy)` (destroy) when the hook fired, `client.release()` otherwise.
- Path audit, no double-release / no leak: **success** → plain release; **persist-fail,
  rollback-ok** → `poisonedBy` unset → plain release; **persist-fail, rollback-fails** → hook sets
  `poisonedBy` → `release(err)` destroy; **normalize-fails before BEGIN** → plain release;
  **connect() itself rejects** → no client exists, nothing to release, failure recorded.
  `ingestOne` never releases (caller-owned client), so no double-release is possible.
- The docstrings' "mirrors withTransaction" claim is now accurate.

### SF-2 (pre-flight `--user` check) — **VERIFIED FIXED (code); no test guards it (NEW-2)**

`bulk-ingest-books.ts:361-368`: `SELECT 1 FROM users WHERE id = $1` via the typed `query` helper,
placed after manifest/dir/`--only` validation and **before the entry loop** — i.e., before any
file read or normalization. Zero rows → immediate throw with the clear message
`--user N matches no users row — aborting before any book is processed`.

Dry-run isolation confirmed: the check sits inside `if (!opts.dryRun)`, and I audited the dry-run
branch (`:390-396`) — it calls only `loadAndNormalize`; neither `query` nor `getPool().connect()`
is reachable, so a dry run opens **zero** DB connections (the lazily-built pool is never
constructed on that path).

### SF-3 (mid-transaction rollback tests) — **VERIFIED: 3 of 5 are sharp; 2 batch-runner assertions are weaker than claimed**

The 5 new tests (`tests/scripts/bulk-ingest-books.test.ts:357-507`) do hit REAL testcontainer
Postgres. `wrapFailingClient` (`:119-143`) is a Proxy over a real client that rejects only the
matched `INSERT INTO book_pages` (and optionally ROLLBACK); BEGIN, the FOR UPDATE probe, the
upsert, blob writes, and ROLLBACK all execute against the real DB. Not tautological:

1. **New-book mid-tx failure** (`:358-389`): asserts zero `book_uploads` AND zero `book_pages`
   via the shared pool, plus a same-physical-connection probe (`:382`) that would fail with
   "current transaction is aborted" if ROLLBACK had not actually run. Genuinely discriminating.
2. **Replace variant** (`:391-418`): prior row id, prior page-row ids, and prior blobs on disk
   all asserted intact after the failed re-ingest. Genuinely discriminating.
3. **Failed-rollback hook** (`:420-447`): asserts `onRollbackFailure` fired with the ORIGINAL
   error's exact message and that the rethrow was unmasked. **Mutation-verified** (see below).
4. **Batch runner, rollback-ok** (`:451-478`): failure recorded in `summary.failures`, nothing
   half-written, `idleCount === totalCount` (no leak). Sound for what it claims.
5. **Batch runner, failed-rollback → destroy** (`:480-506`): failure recorded and nothing
   half-written are sound, but the destroy assertion is **not discriminating** — see NEW-1.

### Mutation spot-check (both directions, three mutations)

- **Mutation A** — weakened the SF-1 wiring in `runBulkIngest` to an unconditional plain
  `client.release()` (the destroy branch deleted). Result: **18/18 PASSED — the mutation
  SURVIVED.** Test 5's assertions (`totalCount === idleCount`, `totalCount <= 1`) hold for both
  a destroy (0===0) and a wrongful re-pool (1===1), because the pre-flight's client is reused for
  the per-book checkout so there is only ever one physical client. This contradicts the
  FIX_REPORT's claim that test 5 "directly exercises the SF-1 release(err) wiring end-to-end."
- **Mutation B** — removed the `hooks.onRollbackFailure?.(...)` invocation in `ingestOne`.
  Result: **1/18 FAILED** (the `onRollbackFailure receives the ORIGINAL error` test, at the
  `poisonedBy!.message` assertion) — this guard is real and sharp.
- **Mutation C** — disabled the SF-2 pre-flight throw (`if (false && ...)`). Result: **18/18
  PASSED — the mutation SURVIVED.** No test exercises a nonexistent `--user`.
- **Restore verified after each mutation**: `git checkout -- server/src/scripts/bulk-ingest-books.ts`,
  `git diff --exit-code` empty, final full suite re-run **18/18 PASS**, `npm run build` clean.
  The working tree is byte-identical to HEAD.

### NITs

- **N-1 — VERIFIED FIXED**: `assertValidManifest` enforces `basename(entry.file) === entry.file`
  (`bulk-ingest-books.ts:112-117`); the `..`/path-separator hole is machine-closed.
- **N-2 — VERIFIED FIXED (doc)**: module header `:48-56` documents both orphan-blob paths, the
  absence of a reaper, and the future `--sweep-orphans` design.
- **N-3 — CORRECTLY DEFERRED**: connect (`:402`) still precedes normalization (inside
  `ingestOne` → `loadAndNormalize`). The deferral rationale (restructuring the exported seam) is
  legitimate and the original review itself called the current behavior harmless.
- **N-4 — VERIFIED FIXED**: `main()` (`:517-525`) throws (→ exit 1) when
  `ingested === 0 && skippedMissing.length > 0`; partial batches with ≥1 ingest still exit 0 on
  skips alone, per spec. (No test covers `main()` — it is a thin wrapper; acceptable.)
- **N-5 — VERIFIED FIXED**: dry-run summary (`:455-457`) prints
  `N normalized OK (would ingest; new-vs-replaced unknown without a DB)` — no more misleading
  "N new". `BulkIngestSummary` shape unchanged.

### No-regression sweep

- **PRAISE intact**: P-1 tx/cleanup ordering unchanged (BEGIN → persist → COMMIT → post-commit
  best-effort unlink, `:248-286`); P-2 reuse discipline unchanged (still `persistUpload` +
  shared normalizers, zero bespoke ingest logic — `services/bookUploadIngest.ts` is not in the
  branch diff at all); P-3 test posture unchanged (real testcontainers + real migrations + real
  zips + byte-for-byte blob assertions); P-4 fail-fast + `require.main` guard intact (`:531`).
- **Idempotency unchanged**: the UPSERT lives in untouched production code; the idempotency test
  (one row, replaced pages, unlinked old blobs) still present and passing.
- **Prior-blob unlink still strictly post-COMMIT**: `:252` COMMIT → `:275-286` unlink loop.
- **Manifest byte-unchanged by the fix-pass**: the fix commit `bc08cf1` touches only
  `bulk-ingest-books.ts`, the test file, and `FIX_REPORT_bulkingest.md` —
  `corpus-books.manifest.ts` and all production exports untouched.
- The only `package.json` change on the branch is the additive `ingest:books` script.

---

## NEW issues (both test-strength, neither a code defect)

**NEW-1 (should-fix, non-blocking) — Test 5's "poisoned client DESTROYED" assertion cannot
detect the regression it exists to prevent.** Proven by Mutation A surviving. The pool-count
assertions pass whether the client is destroyed or wrongfully re-pooled. Fix: assert
`injected.totalCount === 0` after the run, or (more robust against pool-reuse timing) listen for
the pool's `'remove'` event and assert it fired exactly once. One-line-ish test change in
`tests/scripts/bulk-ingest-books.test.ts:480-506`.

**NEW-2 (nit) — SF-2 has no test.** Proven by Mutation C surviving. A one-test addition
(`runBulkIngest` with a nonexistent userId → rejects with `matches no users row`, zero rows
written) would lock the pre-flight in. The original review did not demand a test for SF-2, so
this is a gap in defense-in-depth, not an unmet requirement.

Neither issue changes runtime behavior; both are guards for FUTURE edits to already-correct code.

---

## Ship recommendation

**Safe to run against the production DB + blob store.** The properties that protect prod data —
idempotent UPSERT keyed on (user_id, title), per-book transactions with verified-real rollback
(new book fully absent / replaced book fully intact, proven against real Postgres including a
same-connection probe), strictly post-COMMIT prior-blob unlink, dry-run touching neither DB nor
disk, fail-fast manifest + `--user` + `--dir` validation, and destroy-not-repool of a suspect
connection — are all correct in the code as written and (except the two test gaps above) guarded
by discriminating tests. Recommended prod sequence unchanged from the original review: dry-run
first, then one book via `--only`, then the full batch. NEW-1/NEW-2 should be picked up in a
follow-up commit but do not gate the operator run.
