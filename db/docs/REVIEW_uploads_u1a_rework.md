# Review — U1a rework (zip/PDF → ordered page images), commit `82ea4c2`

Reviewer: independent senior backend/security review (not the author).
Scope: `db/migrations/041_book_pages.{up,down}.sql`, `server/src/routes/uploads.ts`,
`server/src/services/{uploadStore,bookUploadIngest,zipPageExtract,pdfPageRender,naturalSort}.ts`,
`server/Dockerfile`, and the associated tests. Spec: `db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION".

## Verdict: **CONDITIONAL PASS — 2 BLOCKERS**

The ZIP-handling code, path-traversal defenses, IDOR posture, and the reorder
two-phase-renumber logic are all genuinely well done — this is careful,
defense-in-depth work and the zip-bomb guards in particular are close to a
model implementation. But the PDF path has a real, unbounded resource-exhaustion
gap that the zip path deliberately closed, and this commit silently breaks the
client's PDF viewer by removing a route the client still calls. Both are
fixable in isolation without touching the good parts.

Test run: `npx tsc --noEmit` → exit 0. `npx vitest run tests/routes/uploads.test.ts`
→ **45/45 passed** (real Postgres via testcontainers, real hand-built zip via
`yauzl`; PDF path exercises `renderPdfPagesToJpeg` mocked, per the module's own
documented rationale — no poppler-utils in the `node:20-slim` verify image).

---

## BLOCKERS

### B1 — PDF path has no page-count cap and no subprocess timeout (resource exhaustion)
`server/src/services/pdfPageRender.ts:63` invokes `pdftoppm -jpeg -r 150 <in> <out-prefix>`
with **no `-l`/last-page flag** and **no `timeout` option** on `execFileAsync`.
Contrast this with the ZIP path, which bounds entry count (`MAX_ZIP_ENTRIES = 2000`,
`zipPageExtract.ts:48`), per-entry size, and total size *before* decompressing
a single byte. The PDF path has no analogous bound at all:

- A small, well-formed PDF can declare an enormous page count (a `Pages` tree
  whose `Kids` reference the same content object thousands of times is a
  classic PDF "bomb" pattern — the file itself can be tiny). `pdftoppm` will
  happily render every page to a JPEG in the temp dir.
- `renderPdfPagesToJpeg` then does `readdir` + reads **every rendered file
  into memory** (`pdfPageRender.ts:79-82`, `const buffers: Buffer[] = []`) —
  100k pages × ~100-300 KB each is 10-30 GB, enough to OOM-kill the process on
  a single request.
- `execFileAsync` has no `timeout`, so a pathological/malformed PDF that makes
  poppler spin can hang the request indefinitely, holding the connection open
  (no DB transaction is held during this — `ingestUpload` runs before
  `withTransaction` — but it still ties up an Express request/response and,
  eventually, the whole `expensiveLimiter` budget for that user).
- There is no per-user total-storage angle either that would catch this after
  the fact: the daily cap (`BOOK_UPLOAD_DAILY_CAP`) counts *uploads*, not
  bytes or pages, and only applies to brand-new titles.

Notably, `routes/uploads.ts:127-130`'s own comment on `PageOrderBodySchema`
claims the reorder cap of 3000 is "comfortably above the zip/PDF page-count
guards in services/zipPageExtract.ts / pdfPageRender.ts, which bound how many
pages an upload can ever have" — but `pdfPageRender.ts` has **no such guard**.
The comment is describing code that doesn't exist; grep confirms no
`MAX_PDF_PAGES`/`-l`/page-cap anywhere in that file or `bookUploadIngest.ts`.

**Fix**: add a page-count cap analogous to the zip path — either probe the
page count first (`pdfinfo` from the same poppler-utils package, cheap and
already available in the runtime image per `server/Dockerfile:40`) and reject
> N pages before rendering, or pass `-l <N>` to `pdftoppm` and then check
`readdir` length against the PDF's real `/Count` to detect truncation and
reject rather than silently accepting a partial book. Also add an
`execFile` `timeout` (with `killSignal`) so a hung/malicious render can't hold
a request open forever, and map the timeout the same way ENOENT is mapped
(400, not 500).

Given the app's personal/single-user scope this is not an *attacker* vector
today, but it is a self-inflicted-DoS vector (Jared downloading/scanning a
malformed PDF from anywhere) that the zip path explicitly defended against —
the asymmetry is the tell that this was missed, not a deliberate scope call.

### B2 — Client PDF viewer is broken by this commit (route removed, caller not updated)
The design doc's REVISION explicitly calls for removing
`GET /uploads/:id/file` (`PDF_UPLOAD_DESIGN.md:47`, `uploads.ts` module header
line 24), and this commit does remove it — `routes/uploads.ts` has no `/file`
route anymore. But `client/src/pages/UploadViewer.tsx` (shipped one commit
earlier, `39154d1`) still renders via pdf.js against exactly that route:

```
client/src/pages/UploadViewer.tsx:4:  * PDF page-by-page from `GET /uploads/:id/file` via `pdfjs-dist`, ...
client/src/services/uploads.ts:95:  export function pdfFileUrl(id: string, ...): string { ... }
```

`pdfFileUrl` is still called by `UploadViewer.tsx`'s `getDocument(...)` load
path. Nothing in this commit's diff touches the client. As shipped, every tap
into an upload's viewer will 404 against a route that no longer exists — the
one user-facing feature this whole phase exists to deliver (view an uploaded
book) is broken by the server-side rework. This is outside the stated
server-only review slice, but it's a direct, mechanical consequence of this
diff and should block deploy until the client is updated to the
`GET /uploads/:id/page/:n` + `page_count` model (or the old route is kept as a
deprecated back-compat shim until the client catches up — the design doc's own
call is to replace it, not keep both).

---

## SHOULD-FIX

### S1 — No per-user total-storage cap (flagged per the review brief, not a regression)
`BOOK_UPLOAD_DAILY_CAP` (default 10) bounds new *titles*, not bytes. 10 books
× up to 300 MB each = up to 3 GB with no ceiling, and a replace-loop (re-upload
the same title repeatedly) doesn't count against the cap at all by design —
each replace still writes N fresh page blobs before the old ones are unlinked,
so a rapid burst of replaces has a transient double-storage footprint. For a
single trusted user this is an acceptable trade-off (matches
`project_korean_master_personal_scope`), but worth a one-line note in the
design doc so it's a documented decision, not a silent gap.

### S2 — Orphan blobs on crash have no reaper
Documented and accepted (`bookUploadIngest.ts` header, "ATOMICITY") as
"harmless, GC-able" — but there is no actual GC job anywhere in `server/src`.
For a personal app with ~10 books this is genuinely low-stakes, but if a crash
mid-replace or a failed `deleteBlob` (logged as a warning, swallowed) happens
repeatedly, `BOOK_UPLOAD_STORAGE_DIR` grows unboundedly with no cleanup path.
Not blocking; note it as tech debt.

### S3 — `execFile`'s temp dir is per-call but not size-bounded during render
`pdfPageRender.ts` writes the *input* PDF and then every rendered page into
`mkdtemp(tmpdir(), 'km-pdf-pages-')` before reading them back. Combined with
B1, an unbounded page count also means unbounded scratch-disk use in
`/tmp` (container-local, but still: a big enough malicious PDF can fill the
container's writable layer before the in-memory OOM even hits). Same fix as
B1 addresses this too — cap pages before rendering.

---

## NITS

- `zipPageExtract.ts:174-179` intentionally treats `image/webp` as a
  non-page-image and skips it silently — correct per the design doc, but
  worth a code comment cross-reference to `imageIngest.ts`'s
  `sniffImageMime` so a future reader doesn't "fix" this as a bug.
- `uploads.ts:396` `PLACEHOLDER_BASE = 1_000_000_000` is safely far from any
  realistic page count today, but is only an *implicit* invariant tied to
  `page_number`'s `int4` column type and the (currently absent, see B1) upper
  bound on how many pages an upload can have. Once B1 adds a real PDF page
  cap, consider asserting `pageCount < PLACEHOLDER_BASE` defensively at the
  top of the reorder handler, or at persist time, rather than relying on
  "practically can't happen."
- `server/Dockerfile` installs `poppler-utils` in the runtime stage via `apk
  add` with no pinned version — fine for now (matches the existing
  `Deploy/loader.Dockerfile` precedent per the file's own comment), but a
  supply-chain-conscious follow-up would pin or at least log the installed
  version at build time for reproducibility.
- `uploads.test.ts` and `zipPageExtract.test.ts` are excellent — real
  archives, real guard trips (including the "lie about declared size" trick
  in `tests/helpers/zip.ts`, which is exactly the right way to test a
  zip-bomb guard without allocating real gigabytes). The PDF-path tests are
  honestly labeled as mocked, with a *separate*, self-skipping real-poppler
  smoke test (`tests/services/pdfPageRender.test.ts`) rather than pretending
  coverage that doesn't exist. No vacuous tests found in this slice.

---

## PRAISE

- **Zip-slip is not possible.** Every page's on-disk filename is a
  server-generated UUID (`saveBlob(userId, randomUUID(), ext, buffer)`,
  `bookUploadIngest.ts:426`); a zip entry's `fileName` is used *only* as a sort
  key (`zipPageExtract.ts:74`, `naturalCompare`) and never touches
  `uploadStore.ts`. `resolveUnderRoot`/`assertUnderRoot` (`uploadStore.ts:108,
  166`) additionally re-validate any relative path read back from the DB
  before every read/stream/delete — genuine defense in depth, not just
  "trust the UUID."
- **Zip-bomb guards are correctly ordered and correctly re-checked.**
  `zipPageExtract.ts` checks the central-directory *declared* size before
  opening a read stream, then re-checks the *actual* streamed byte count
  against the same cap (`zipPageExtract.ts:129-166`) — closing the
  "lie about your declared size" hole that a naive declared-size-only check
  would leave open. Entry-count, per-entry, and running-total caps are all
  present and independently tested with a hand-built-zip fixture that doesn't
  need to allocate real gigabyte buffers to prove the trip.
- **Reorder concurrency is correctly solved, and the write-up explains why.**
  The two-phase renumber through `PLACEHOLDER_BASE` (`uploads.ts:382-411`) is
  the right fix for a `NOT DEFERRABLE UNIQUE(upload_id, page_number)`
  constraint, and the code comment correctly reasons through *why* a negative
  placeholder doesn't work (`CHECK (page_number > 0)` fires per-statement, not
  deferred). `page_ids` is validated to be *exactly* the current page-id set
  (no subset, no foreign ids, no dupes) before either phase runs
  (`uploads.ts:368-380`), and both the upload row and every `book_pages` row
  are locked `FOR UPDATE` up front, which also correctly serializes a
  concurrent reorder against a concurrent replace-upload or delete (both of
  which lock the same `book_uploads` row).
- **IDOR is uniformly 404, never 403, across every route** — `GET :id`,
  `GET :id/page/:n` (folds "not yours" and "out of range" into the identical
  404, `uploads.ts:280-282`), `PATCH :id/pages/order`, and `DELETE :id` all
  confirmed 404-only via the real test suite, not just by inspection.
- **Replace-by-title correctly avoids orphan-vs-dangling-reference races**:
  new page blobs are written and their rows inserted *inside* the transaction;
  the *old* pages' blob files are only unlinked *after* commit
  (`uploads.ts:181-199`, `bookUploadIngest.ts:389-399`) — a rollback can never
  strand a live DB row pointing at a deleted file, and the worst case on
  crash is a harmless orphan file, never a broken read. Verified by the
  passing `re-uploading the SAME (user, title) REPLACES` test.
- **pdftoppm invocation is argv-array, never shell-interpolated**
  (`execFileAsync('pdftoppm', ['-jpeg', '-r', String(RENDER_DPI), inputPath,
  outputPrefix])`, `pdfPageRender.ts:63`) — command injection is not possible
  here regardless of filename/content, and the input path is a server-owned
  `mkdtemp` temp file, never user-controlled.

---

## Direct answers (per review brief)

- **(a) Zip-slip possible?** No. Entry filenames are used only for sort
  order; every on-disk path is server-built from a UUID, and `resolveUnderRoot`
  re-validates on every read/write/delete.
- **(b) Zip-bomb bounded?** Yes, for the ZIP path (entry count, per-entry
  declared+actual size, running total, all checked pre-decompression). **No**
  for the PDF path — see BLOCKER B1 (unbounded page count, unbounded
  in-memory buffer accumulation, no subprocess timeout).
- **(c) pdftoppm injection-safe + output-bounded?** Injection-safe: yes
  (argv-array `execFile`, server-owned temp path, never a shell string).
  Output-bounded: **no** — see B1.
- **(d) Page-serving IDOR-safe?** Yes — user-scoped join, uniform 404 for
  foreign/missing/out-of-range, `n` is Zod-validated (400 on garbage, never a
  500), blob path derives from a DB-stored UUID never from `n` or client
  input. Confirmed by 45/45 passing tests including explicit IDOR cases.
- **(e) Reorder transactional + validates page set + user-scoped?** Yes to
  all three — two-phase placeholder renumber avoids the unique-constraint
  collision, `page_ids` must exactly match the current page-id set (no
  partial/foreign/duplicate ids), and the owning row is locked `FOR UPDATE`
  under the requesting user's id.
- **(f) Replace leaves no orphan blobs?** On the happy path, no — old blobs
  are deleted after commit, confirmed by test. On a mid-replace **crash**,
  the DB transaction rolls back cleanly (no dangling DB-row-to-missing-file
  case), but any page blobs already written before the crash become
  unreferenced orphan files with no reaper (S2) — accepted/documented
  trade-off for this app's scale, not a correctness bug.
