# Independent Review — feat/bulk-book-ingest (operator bulk book ingest CLI)

Reviewer: independent senior review, did not author this code. Scope = `git diff origin/rebuild` for
`server/src/scripts/bulk-ingest-books.ts`, `server/src/scripts/corpus-books.manifest.ts`,
`server/tests/scripts/bulk-ingest-books.test.ts`, `server/package.json`.

## VERDICT: **APPROVE — no blockers.** 0 BLOCKER / 3 SHOULD-FIX / 5 NIT / 4 PRAISE.

The script is safe to run against the production DB + blob store. Idempotency, tx boundaries,
rollback, post-commit blob-unlink ordering, dry-run isolation, and fail-fast manifest validation all
check out against the actual production code paths (I traced `persistUpload`, `withTransaction`,
`deleteBlob`, and the HTTP route, not just the script's comments). The three SHOULD-FIXes are
operational-robustness hardening, not data-safety holes.

---

## Explicit answers to probes 1–7

### Probe 1 — Idempotency / partial writes: **YES, safe**
- Re-run cannot duplicate: `book_uploads` has `CONSTRAINT uq_book_uploads_user_title UNIQUE (user_id, title)`
  (`db/migrations/040_book_uploads.up.sql:87`) and `persistUpload` UPSERTs on it with a prior
  `SELECT ... FOR UPDATE` (`server/src/services/bookUploadIngest.ts:390-421`), so concurrent runs
  serialize rather than interleave. The idempotency test asserts one row survives a re-run.
- Normalization (file read + zip/pdf decode) is entirely BEFORE `BEGIN`:
  `bulk-ingest-books.ts:204` (`loadAndNormalize`) precedes `bulk-ingest-books.ts:206` (`BEGIN`).
  No external file I/O inside the open tx **except** `saveBlob` calls inside `persistUpload`
  (`bookUploadIngest.ts:434`) — which is the production route's own design (blob write before its
  matching row, so rollback can only orphan a FILE, never leave a DB row pointing at a missing
  file; `bookUploadIngest.ts:429-431`). Identical semantics to `POST /uploads`.
- `ROLLBACK` on any persist error: `bulk-ingest-books.ts:211-221`, with the original error
  rethrown and a rollback-failure logged without masking it.
- Failure on book N leaves book N **fully absent (new book) or fully at its prior state
  (replace)** — never a row without pages or pages without rows. Prior blobs are untouched until
  after COMMIT, so a rolled-back replace still has its old files. The only residue is orphan
  blob files from the aborted run (see NIT-2).

### Probe 2 — TX + pool hygiene: **YES, with one deviation (SHOULD-FIX-1)**
- Each book acquires its OWN client (`bulk-ingest-books.ts:339`) and releases it in `finally`
  (`:343-345`) — no leak on the error path, no shared client across books.
- `closePool` reached on both exit paths of the entrypoint (`bulk-ingest-books.ts:441-448`),
  including `closePool().catch(() => undefined)` on failure.
- Deviation: on ROLLBACK failure the script only logs (`:213-219`) and the client is then
  returned to the pool via plain `release()`. The production `withTransaction` explicitly
  **destroys** such a client with `release(err)` because a failed ROLLBACK means the connection
  is suspect (`server/src/db/pool.ts:133-165`). See SHOULD-FIX-1.

### Probe 3 — Prior-blob cleanup ordering: **YES, correct**
- `deleteBlob` of `priorBlobRefs` runs strictly AFTER `COMMIT`
  (`bulk-ingest-books.ts:210` commit → `:227-238` unlink loop). A rolled-back tx therefore never
  deletes live files. Unlink failure warns + counts (`priorBlobUnlinkFailures`) and does not fail
  the book. Mirrors `routes/uploads.ts:215-235` exactly. `deleteBlob` itself tolerates ENOENT
  (`server/src/services/uploadStore.ts:143-151`), so a crash-then-re-run is safe.

### Probe 4 — Safety rails: **YES**
- `assertValidManifest` runs before any file read or write (`bulk-ingest-books.ts:293`), and
  again per-entry inside `loadAndNormalize` (`:132`) so the exported seam is standalone-safe.
  Bad type / empty file / empty title / duplicate title all throw (`:91-111`); the batch test at
  `tests/scripts/bulk-ingest-books.test.ts:350-357` proves even the valid first entry is not
  processed.
- Type validated against the real `BOOK_UPLOAD_TYPES` DB-enum mirror
  (`bookUploadIngest.ts:112-119`) — a manifest typo fails before any Postgres cast error.
- `--dry-run` does zero DB/blob writes AND never dials the DB: `getPool()` only appears in the
  non-dry branch (`bulk-ingest-books.ts:339`); the dry branch (`:328-334`) only calls
  `loadAndNormalize`. Test asserts empty DB + no blob dir (`test.ts:277-295`).
- Path traversal: `entry.file` is joined to `--dir` (`:134`, `:315`); a `..` would escape, but
  the manifest is static, versioned, trusted code (same trust level as the script itself), not
  user input. Acceptable; cheap belt-and-suspenders suggested as NIT-1.

### Probe 5 — Manifest correctness: **YES — 17/17 exact**
- 17 entries; I diffed each `file` against `ls "/home/jared-williams/data/My Scanned Books"`:
  all 17 basenames match byte-for-byte, including the tricky ones —
  `내 삶에 힘이 되는 니체의 말_20260716 (1).zip` (space + `(1)`),
  `너의 이름은._20260716.zip` (trailing `.` before `_`), and
  `Real-Life Korean Conversations_ Intermediate_20260716.zip` (underscore-space).
- Types sane: TOPIK mindmap `both`, 2000 Words + Slang `vocab`, the two 그림으로 comics + 이순신
  이야기 `comic`, 삼국사기/삼국유사 + readers `literature`, Real-Life Conversations `dialogue` —
  all members of `BOOK_UPLOAD_TYPES`. Titles unique.

### Probe 6 — Tests real: **YES**
- Real Postgres via testcontainers (`tests/helpers/pg.ts:8` — `GenericContainer` from
  `testcontainers`, real migrations from `db/migrations` applied at `:13,43`).
- Real zips: hand-built, byte-valid STORED archives (`tests/helpers/zip.ts`) parsed by the REAL
  yauzl path — not mocks. Real blob files asserted byte-for-byte (`test.ts:209-213`).
- **Would the idempotency test catch a revert? YES** — `test.ts:217-249` re-runs the same title
  with a different archive and asserts: ONE `book_uploads` row (`:236`), same uploadId (`:230`),
  old page rows gone (`:242-243`), old blobs unlinked from disk (`:245`), new blobs present
  (`:246-248`). Any duplication, page-merge, or unlink regression fails it.
- **Would the invalid-type test catch a revert? YES** — `test.ts:263-275` asserts the throw AND
  zero rows AND no blob directory for the user, so a "validate after write" regression fails it.
  The batch-level variant (`:350-357`) additionally proves fail-fast-before-any-entry.
- No tautologies found; assertions are against the DB and the filesystem, not against the code's
  own return values alone. One coverage gap: SHOULD-FIX-3.

### Probe 7 — Exit codes / batch semantics: **YES, sane**
- Per-book try/catch (`bulk-ingest-books.ts:327-371`): one bad archive records a failure and the
  loop continues (proven at `test.ts:317-333`).
- Missing file = warn + skip, NOT a failure (`:316-325`, proven at `test.ts:298-315`).
- Non-zero exit iff `failures.length > 0` (`:428-433` throw → `:445-448` exit 1); skips alone
  exit 0 — as specified. Edge case worth knowing: NIT-4.

---

## Findings

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — Suspect client returned to the pool after a failed ROLLBACK.**
`bulk-ingest-books.ts:211-221` + `:343-345`. `ingestOne`'s docstring (`:189-191`) claims it
"mirrors withTransaction's contract", but `withTransaction` destroys the connection with
`client.release(err)` when ROLLBACK fails (`src/db/pool.ts:133-165` — "ROLLBACK failing means the
connection itself is suspect"); the script logs and then `runBulkIngest`'s `finally` returns the
client to the pool with a plain `release()`. Worst case a client stuck in an aborted-tx state is
handed to the NEXT book, whose first query fails ("current transaction is aborted"), producing one
spurious extra book failure before that book's own ROLLBACK clears it. Not data corruption
(self-heals, and the run exits non-zero anyway), but it deviates from the production contract the
comment cites. Fix: have `ingestOne` signal rollback-failure (or take an `onBroken` callback /
return the error) so the caller can `client.release(rollbackErr)`; also fixes the comment.

**SF-2 — No pre-flight check that `--user` exists.**
`bulk-ingest-books.ts:288-306` validates the manifest and `--dir` up front but never checks the
target user row. A typo'd `--user 2` means every book is FULLY normalized (a ~240 MB zip → ~500
decoded pages, minutes of CPU each) before its `book_uploads` INSERT dies on the `user_id` FK —
17 expensive failures instead of one instant one. (No data risk: the FK fires before any
`saveBlob` call in `persistUpload`, so not even orphan blobs are created — verified against
`bookUploadIngest.ts:410-439` ordering.) One `SELECT 1 FROM users WHERE id = $1` before the loop
(non-dry-run only) turns a ~30-minute wasted batch into an instant error.

**SF-3 — Test gap: no mid-transaction failure test.**
Every failure exercised by the tests (`garbage.zip`, missing file, bad type) fires BEFORE `BEGIN` —
in validation or normalization. The rollback path at `bulk-ingest-books.ts:211-221` (persist fails
mid-tx → ROLLBACK → book fully absent / prior state intact, no half-written book) is the single
most safety-critical branch in the file and has zero direct coverage. Suggest: a test that forces
`persistUpload` to fail mid-persist (e.g., a client wrapper that errors on the Nth `book_pages`
INSERT, or a pre-inserted conflicting `(upload_id, page_number)` row) and asserts the DB shows
either nothing (new book) or the untouched prior pages (replace).

### NIT

**N-1** — `assertValidManifest` (`bulk-ingest-books.ts:91-111`) could also assert
`path.basename(entry.file) === entry.file`, making the manifest docstring's "never a path; the CLI
joins it onto --dir" (`corpus-books.manifest.ts:11-12`) machine-enforced instead of
comment-enforced. One line, closes the theoretical `..` traversal completely.

**N-2** — Orphan blob accumulation has no reaper. Two paths create orphans by design: rollback
after some `saveBlob` calls (`bookUploadIngest.ts:434`), and a crash between COMMIT and the prior-
blob unlink loop (`bulk-ingest-books.ts:227-238`). Both are called "GC-able" (`:38`,
`routes/uploads.ts:219-220`) but no GC exists anywhere in the repo. For 500-page books an aborted
run can strand hundreds of files, and re-runs mint fresh UUIDs so they never get overwritten.
Fine for now; worth a future `--sweep-orphans` mode (compare `book_pages.blob_ref` vs disk).

**N-3** — The pool client is checked out BEFORE normalization (`bulk-ingest-books.ts:339` connect
→ `:342` `ingestOne` → `loadAndNormalize`), so a connection sits idle (not in-tx) for the minutes
a 240 MB zip takes to decode. Harmless at pool default sizes with sequential processing, but
normalizing before `connect()` would be strictly better and costs nothing.

**N-4** — All-files-missing exits 0: `--dir` pointing at the WRONG-but-existing directory yields
17 skips, 0 ingested, exit 0. A driving script checking only the exit code would read a total
no-op as success. Consider exiting non-zero (or a `--strict-missing` flag) when
`ingested === 0 && skippedMissing.length > 0`.

**N-5** — Under `--dry-run`, successes are counted into `created` (`bulk-ingest-books.ts:331`) so
the summary reports "N new" for books that would actually be REPLACES. Commented as intentional
("would ingest") and the console line says "not written", but a `wouldIngest` counter would avoid
the operator misreading "17 new" on a re-run dry-run.

### PRAISE

**P-1** — Transaction/cleanup ordering is exactly right and provably mirrors the production route:
normalize → BEGIN → persist → COMMIT → best-effort unlink of prior blobs, with ROLLBACK never able
to delete live files. This is the part that corrupts data when someone gets it wrong; it's correct
here, and the comments cite the real reasons, not cargo-cult.

**P-2** — Reuse discipline: zero bespoke ingest logic — the script goes through the identical
`extractZipPages`/`renderPdfPagesToJpeg`/`persistUpload` pipeline as `POST /uploads`, skipping only
the daily-cap check, and the header honestly documents that the cap is the ONLY thing skipped.

**P-3** — Tests are genuinely integration-grade: real testcontainer Postgres with real migrations,
real hand-built yauzl-parseable zips, byte-for-byte blob assertions, natural-sort page-order proof,
and negative tests that assert on the DB and filesystem rather than on return values.

**P-4** — Fail-fast design: whole-manifest validation (type against the DB enum mirror, dup-title
detection with a message that names the idempotency key) before any file is read, `require.main`
entrypoint guard so importing the module can never do I/O, and `--only`/`--dry-run` operator
escape hatches.

---

*Would the idempotency + invalid-type tests catch a revert? **YES** and **YES** (details under Probe 6).*
