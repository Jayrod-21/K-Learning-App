# Fix Report — feat/bulk-book-ingest (post-review fix-pass)

Input: `REVIEW_bulkingest.md` (APPROVE, 0 BLOCKER / 3 SHOULD-FIX / 5 NIT / 4 PRAISE).
Files touched: `server/src/scripts/bulk-ingest-books.ts`, `server/tests/scripts/bulk-ingest-books.test.ts`.
Manifest + production ingest exports (`persistUpload` etc.) untouched. PRAISE items P-1..P-4 preserved (tx ordering, reuse, testcontainer posture, fail-fast design all intact).

## SHOULD-FIX

**SF-1 — FIXED** (poisoned client after failed ROLLBACK).
- `ingestOne` now takes optional `hooks: IngestOneHooks` with `onRollbackFailure(originalErr)` — invoked ONLY when ROLLBACK itself throws; receives the ORIGINAL ingest error, matching `withTransaction` (`src/db/pool.ts:165` passes the original `err` to `releaseOnce(err)`, not the rollback error). Verified against pool.ts before implementing.
- `runBulkIngest` finally-path: `client.release(poisonedBy)` (DESTROY) when the hook fired, plain `client.release()` otherwise. Exactly one release runs (single finally, single flag).
- Docstrings updated — the "mirrors withTransaction's contract" claim is now true, not aspirational.

**SF-2 — FIXED** (no pre-flight `--user` check).
- `runBulkIngest`: before the entry loop, non-dry-run only: `SELECT 1 FROM users WHERE id = $1` via the typed `query` helper from `src/db/pool.ts` (keeps the "never touch the raw pool" convention). 0 rows → immediate throw `--user N matches no users row — aborting before any book is processed`.
- `--dry-run` still opens ZERO DB connections — the check sits inside `if (!opts.dryRun)`; dry-run test (asserts nothing written) still passes and the lazily-built pool stays untouched on the dry path.

**SF-3 — FIXED** (no mid-transaction rollback coverage). 5 new tests, all against the REAL testcontainer Postgres; the only non-real element is a fault-injector wrapper (`wrapFailingClient`) around a real client — BEGIN, FOR UPDATE, the upsert, blob writes, and ROLLBACK all hit the real DB; only the matched `INSERT INTO book_pages` (and, where configured, ROLLBACK) reject:
1. `ingestOne` mid-tx failure (new book): rejects with the injected error; NO `book_uploads` row, NO `book_pages`; the same physical connection then answers a real query (proves ROLLBACK actually ran — an aborted-open tx would error, and a same-connection count would otherwise see its own uncommitted upsert).
2. Replace variant: prior book fully intact after the failed re-ingest — same row id, same page-row ids (the replace's DELETE rolled back), prior blobs still on disk.
3. Failed-rollback seam: `onRollbackFailure` fires with the ORIGINAL error (message asserted), rethrown error unmasked.
4. Batch runner (module-global pool injected via `setPoolForTesting`, restored after): mid-tx failure recorded in `summary.failures` (non-zero-exit semantics — `main()` throws on any failure), nothing half-written, and the client RETURNED to the pool (`idleCount === totalCount`, no leak) since ROLLBACK succeeded.
5. Batch runner + failed ROLLBACK: failure recorded AND the poisoned client DESTROYED, not re-pooled (`totalCount === idleCount ≤ 1` — the per-book client is gone from the pool). This directly exercises the SF-1 `release(err)` wiring end-to-end.
- Pool injection keeps `pool.query`'s callback-connect path unwrapped so the SF-2 pre-flight runs against the real user row; only the per-book promise-style `connect()` yields fault-injected clients.

## NITs

**N-1 — FIXED**: `assertValidManifest` now enforces `basename(entry.file) === entry.file` — the manifest docstring's "never a path" promise is machine-checked; closes the theoretical `..` traversal.
**N-2 — FIXED (doc)**: module header now documents the two orphan-blob paths (mid-tx failure after `saveBlob`s; crash between COMMIT and the prior-blob unlink loop), that no reaper exists, and the future `--sweep-orphans` design (diff `book_pages.blob_ref` vs. storage dir).
**N-3 — DEFERRED**: connect-before-normalize (idle client held during minutes-long decode). Fixing it means restructuring the exported `ingestOne` seam (normalize outside / persist-only inside, or a pre-normalized pass-through param) — not a trivial same-file tweak, and harmless at current pool sizes with sequential processing per the review itself. Left for a follow-up.
**N-4 — FIXED**: `main()` now throws (exit 1) when `ingested === 0 && skippedMissing.length > 0` — a wrong-but-existing `--dir` (total no-op) can no longer read as success to a driving script. Partial batches with ≥1 ingest still exit 0 on skips alone, as specified.
**N-5 — FIXED**: dry-run summary line no longer claims "N new" — prints `N normalized OK (would ingest; new-vs-replaced unknown without a DB)`. `BulkIngestSummary` interface unchanged (no consumer churn); only the operator-facing wording fixed.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| `ESLINT_USE_FLAT_CONFIG=false npx eslint src/scripts/bulk-ingest-books.ts tests/scripts/bulk-ingest-books.test.ts` | PASS (exit 0, no warnings) |
| `npx vitest run tests/scripts/bulk-ingest-books.test.ts` | PASS — **18/18** (was 13; +5) |
| `npm run build` | PASS — `dist/scripts/bulk-ingest-books.js` emitted |

No real prod DB / real corpus touched; all DB work in throwaway testcontainers + temp dirs.
