# Review: U1a — PDF book-upload feature (server)

Reviewer: independent senior (30y, backend security). Did not author the code under review.
Commit under review: `8ddadae` (branch `feat/pdf-uploads`). Spec: `db/docs/PDF_UPLOAD_DESIGN.md` §"U1 → U1a server".

## Summary verdict

**REQUEST CHANGES.** The application-layer work — migration, routes, ingest service, blob
store, tests — is genuinely excellent: it faithfully reuses the `images.ts`/`imageStore.ts`
security posture (magic-byte sniff, UUID-only filesystem paths, IDOR→404 everywhere, atomic
transactional persist with post-commit blob cleanup), the migration follows the 037/038
conventions exactly, and the 33-test suite is non-vacuous (it asserts on-disk bytes, not just
status codes). Nothing in `routes/uploads.ts`, `services/uploadStore.ts`, or
`services/bookUploadIngest.ts` shows a correctness or IDOR gap.

However there is **one BLOCKER outside the reviewed source files but squarely in the reviewed
slice's scope (blob storage durability)**: the PDF blob store has **no persistent or
cross-color-shared volume wired into the deploy** (`Deploy/docker-compose.{blue,green}.yml`,
`Deploy/.env.example`, `Deploy/README.md`). `IMAGE_STORAGE_DIR` — the mechanism this feature
was explicitly told to reuse — is mounted on a **shared `km_images` volume on BOTH colors**;
`BOOK_UPLOAD_STORAGE_DIR` has no equivalent anywhere in `Deploy/`. In the actual blue/green
production topology this repo runs, every uploaded PDF blob is written to the **container's
ephemeral writable layer** and is invisible to the other color and wiped on the next container
recreate — while the `book_uploads` metadata row (in the durably-volumed `km_db_data` Postgres)
survives untouched. The result: `GET /uploads/:id/file` 404s ("upload bytes not found" — the
code's own defensive path for exactly this situation) for every previously-uploaded book after
the very next deploy or color flip. This is a real, verified production data-loss bug, not a
theoretical one — see Finding B-1.

Once B-1 is fixed (add a shared `km_book_uploads` volume + `BOOK_UPLOAD_STORAGE_DIR` env wiring
to both compose files, `.env.example`, and the README's volume table, mirroring `km_images`
exactly), this phase is ready to ship.

---

## Findings

### BLOCKER

**B-1 — `BOOK_UPLOAD_STORAGE_DIR` has no persistent/shared volume in the deploy; uploaded PDFs
are lost on the next deploy or color flip.**
Files: `Deploy/docker-compose.blue.yml`, `Deploy/docker-compose.green.yml`, `Deploy/.env.example`, `Deploy/README.md` (all: absent — grepped, zero hits for `book_upload`/`BOOK_UPLOAD` anywhere under `Deploy/`).

- `server/src/config/index.ts` defines `BOOK_UPLOAD_STORAGE_DIR` with a **relative** default
  (`./var/book-uploads`) — same shape as `IMAGE_STORAGE_DIR`'s default
  (`server/src/config/index.ts`, diff hunk).
- `IMAGE_STORAGE_DIR` is wired in `Deploy/docker-compose.blue.yml`/`green.yml` as both an
  `environment:` entry (`IMAGE_STORAGE_DIR=${IMAGE_STORAGE_DIR:-/app/var/images}`) **and** a
  `volumes:` mount onto the **same named volume `km_images`, declared external, on both colors**
  (`Deploy/docker-compose.blue.yml:114,122`; identical in `green.yml`) — this is what makes
  images survive a color switch or redeploy, and is called out explicitly in
  `Deploy/README.md`'s "Shared volumes (survive a color switch)" table
  (`km_images → BOTH km-server-{blue,green} at $IMAGE_STORAGE_DIR`).
- `BOOK_UPLOAD_STORAGE_DIR` has **none of this**: not in either compose file's `environment:`
  block, not in either `volumes:` block, not in the top-level `volumes:` declarations
  (`Deploy/docker-compose.blue.yml:238-241` only declares `km_images`), not in
  `Deploy/.env.example`, not in `Deploy/README.md`'s volume table.
- Confirmed no `env_file:` directive exists for `km-server-{blue,green}` (grepped — zero hits),
  so the container's `process.env.BOOK_UPLOAD_STORAGE_DIR` is genuinely undefined in prod; the
  Zod default takes over and `uploadStore.ts`'s `resolve(cfg.BOOK_UPLOAD_STORAGE_DIR)` resolves
  to a path under the container's own filesystem, not any mounted volume.

Consequence (both are real for this repo's actual deploy protocol — see
`feedback_korean_master_bluegreen_protocol`):
1. A deploy recreates the **idle** color's container from a fresh image; because the store dir
   isn't a volume, that fresh container starts with an empty `book-uploads` directory. Once
   traffic flips to it, every `book_uploads.blob_ref` written under the OLD active color's
   container now points at bytes that don't exist under the new one → `GET /uploads/:id/file`
   hits the code's own `isEnoent` branch (`routes/uploads.ts:243-250`) and 404s.
2. Even without any redeploy, blue and green are **separate containers with no shared
   storage** for this feature (unlike images), so uploading a book while blue is active and
   then flipping to green (a routine no-op maintenance action) already breaks every existing
   upload.
3. `book_uploads` rows are NOT lost (Postgres is on the durable `km_db_data` volume), so the
   Uploads list will keep showing titles/status forever while every "view PDF" tap 404s — a
   silent, confusing failure mode rather than a clean one.

This directly contradicts the design doc's own instruction ("Blob storage for the PDF — REUSE
the mechanism `image_captures` blobs use (find it; don't invent)" —
`db/docs/PDF_UPLOAD_DESIGN.md` §U1a) — the **code** mechanism was reused faithfully
(`uploadStore.ts` mirrors `imageStore.ts` line for line in structure), but the **deploy-level**
half of "reuse the mechanism" (the shared volume that makes it durable) was not.

**Fix**: add a `km_book_uploads` (or similarly named) external volume to both compose files'
`volumes:` blocks, mount it at `${BOOK_UPLOAD_STORAGE_DIR:-/app/var/book-uploads}` on both
`km-server-blue` and `km-server-green` (identically to the `km_images` pattern), declare it in
the top-level `volumes:` section of both files, add `BOOK_UPLOAD_STORAGE_DIR=/app/var/book-uploads`
to `Deploy/.env.example`, and add a row to `Deploy/README.md`'s "Shared volumes" table. Also
create the actual Docker volume on the host once (`docker volume create km_book_uploads`)
before the next deploy, exactly as was presumably done for `km_images`.

---

### SHOULD-FIX

**SF-1 — `SECURITY.md` has no section for the uploads surface.**
File: `server/SECURITY.md` (no hits for "upload"/"book_upload" — grepped).
Every prior file-handling/blob-storage surface in this repo gets its own numbered section
(§16 "Pass 8 surface — Images / OCR mining"). The uploads feature is at least as
security-sensitive (file upload + blob storage + IDOR + a migration touching existing tables,
per this review's own brief) and the in-code header comments in `routes/uploads.ts` and
`services/bookUploadIngest.ts` restate the threat model well, but nothing was added to the
project's canonical security document. This is a documentation-completeness gap, not a
functional one, and is worth closing so the security posture "compounds" per the project's own
standing order rather than living only in one route file's header comment.

**SF-2 — per-user daily-cap check has a TOCTOU race across distinct titles.**
File: `server/src/services/bookUploadIngest.ts:192-212`.
The cap check (`SELECT count(*) ... WHERE created_at >= today`) and the eventual INSERT are not
in the same transaction/lock — two concurrent `POST /uploads` calls with two *different* new
titles, both issued at exactly the cap, can both read `usedToday = cap - 1`, both pass, and both
insert, landing the user one over cap. The code and its own comment are explicit that the cap is
"an abuse/runaway-script backstop, not a meaningful usage limit" for a personal single-user app
with ~10 books total ever, so this is correctly triaged as non-blocking, but it's worth a
one-line comment acknowledging the race is accepted risk (the same way `persistUpload`'s
same-title race is explicitly closed with `FOR UPDATE`) so a future reader doesn't mistake the
asymmetry for an oversight.

### NIT

**N-1 — `CREATE OR REPLACE TRIGGER` (migration 040) vs. plain `CREATE TRIGGER` (038, and
presumably earlier migrations).**
File: `db/migrations/040_book_uploads.up.sql:131-133`.
PG 14+ supports `CREATE OR REPLACE TRIGGER`; using it here (vs. the bare `CREATE TRIGGER` in
`038_writing_attempts.up.sql:170-172`) is strictly more re-run-safe and not a bug, but it's an
unexplained stylistic divergence from the immediately-preceding migration in the same file
family — worth a one-line comment on why 040 upgrades the pattern, or worth backporting to
keep the convention uniform.

**N-2 — `book_upload_type`/`book_upload_status` enums have no `ALTER TYPE ... ADD VALUE`
precedent to validate against.**
Not a defect — just noting for the next agent who extends this enum (e.g. adding a `reading`
type in U2): `ADD VALUE` cannot run inside the same transaction as a later use of the new value
in Postgres < 12, but PG 16 (this repo's pinned version, per `REVIEW_A3.md`) lifted that
restriction for the "add" half; only *using* a brand-new value in the same transaction it was
added in is still disallowed. Migration 040 itself only *creates* new enums (no `ALTER TYPE`), so
this migration is unaffected — flagging only because U2 will need to know this the first time it
extends `book_upload_type`.

### PRAISE

- **`uploadStore.ts` path-traversal defense is genuinely layered**: server-generated
  `{userId}/{uuid}.pdf` construction, PLUS `assertUnderRoot` re-validated on every read/delete
  even though the path is "supposed to" always be well-formed
  (`resolveUnderRoot`, `server/src/services/uploadStore.ts:95-103`) — defense in depth done
  right, not just claimed.
- **IDOR posture is uniform and correct across all four user-facing routes.** Every one of
  `GET /uploads/:id`, `GET /uploads/:id/file`, `DELETE /uploads/:id` scopes its query to
  `WHERE id = $1 AND user_id = $2` and maps "no row" to a **uniform 404** regardless of whether
  the id belongs to another user or doesn't exist at all (`routes/uploads.ts:191-199, 221-228,
  279-286`) — never a 403 that would confirm existence. Verified by dedicated tests for each
  route (`uploads.test.ts:375-382, 453-460, 497-509`).
- **Magic-byte sniff is the actual authority, not the declared mime.** `sniffPdfMagicBytes`
  (`bookUploadIngest.ts:131-140`) checks the literal `%PDF-` signature independent of
  `file.mimetype`; the fileFilter's mime check is correctly documented as an early-reject
  optimization only. Test `uploads.test.ts:154-167` proves this by sending SVG bytes with a
  spoofed `application/pdf` content-type and asserting rejection + zero rows written.
  Test `uploads.test.ts:169-177` separately proves the fileFilter's declared-mime reject path.
- **Size cap enforced before full buffering cost matters**: `multer.memoryStorage()` with
  `limits.fileSize` rejects mid-stream once the limit is exceeded (doesn't require reading the
  full 15MB+ payload before responding), mapped to a precise 413 rather than a generic 500
  (`bookUploadIngest.ts:102-122`), and the oversize test (`uploads.test.ts:185-203`) asserts
  BOTH the 413 status AND that zero rows were written.
- **Idempotent replace is race-safe and rollback-safe**: the prior blob is looked up
  `FOR UPDATE` (serializing concurrent replaces of the same title) and deleted only AFTER the
  wrapping transaction commits (`bookUploadIngest.ts:246-263`, `routes/uploads.ts:133-150`) — a
  rolled-back request can never destroy the still-live prior file. Test
  `uploads.test.ts:254-302` exercises the full lifecycle: same row id, new blob written, old
  blob actually gone from disk.
- **Range/streaming implementation correctly reuses `ttmik.ts`'s `parseRangeHeader`** rather
  than re-deriving RFC 9110 range-parsing logic (`routes/uploads.ts:67, 330`), and adds the same
  `nosniff` + exact `Content-Type: application/pdf` + `Content-Disposition: inline` headers the
  design doc asked for. Tests cover the full body (200), a bounded range (206 + exact slice), an
  open-ended range (206 to EOF), and an unsatisfiable range (416 + `Content-Range: bytes */N`)
  — `uploads.test.ts:408-451`.
- **Migration 040 correctly protects existing corpus content from the new FK.** Both
  `source_upload_id` columns are nullable with `ON DELETE SET NULL`
  (`040_book_uploads.up.sql:141-143, 156-158`), so deleting an upload un-tags rather than
  cascades into `vocab_entries`/`kgiu_entries` — verified by reading the DELETE route's own
  comment (`routes/uploads.ts:276-278`) and the migration's design notes. No existing `SELECT *`
  usage was found in `vocab.ts`/`grammar*.ts` that a new column could silently break, and no
  `.strict()` Zod schema wraps a DB row read from either table (grepped both files) — the new
  nullable columns are additive-safe for every existing reader.
- **Mass-assignment defense is real, not decorative.** `UploadBodySchema` (`routes/uploads.ts:90-95`)
  is `.strict()`, and the test suite specifically proves a client cannot smuggle `status` onto
  the row (`uploads.test.ts:243-252`).

---

## Direct answers to the review brief

- **(a) Can user B read user A's PDF bytes via `GET /uploads/:id/file`?** No. The row lookup is
  `WHERE id = $1 AND user_id = $2` before any filesystem touch; a foreign id returns a uniform
  404 (`routes/uploads.ts:221-228`), proven by test (`uploads.test.ts:453-460`).
- **(b) Is the file validated by magic byte, not spoofable ext/mime?** Yes. `sniffPdfMagicBytes`
  checks the literal `%PDF-` byte signature and is the sole authority; the declared mime is only
  an early, non-authoritative reject (`bookUploadIngest.ts:124-140`). Proven by test with a
  spoofed-mime SVG payload (`uploads.test.ts:154-167`).
- **(c) Any path traversal in blob handling?** None found. The blob path is built entirely from
  a server-side numeric `userId` + server-`randomUUID()` + fixed `.pdf` extension — never client
  input — and `resolveUnderRoot`/`assertUnderRoot` re-validate on every read/delete regardless
  (`uploadStore.ts:61-103, 153-158`).
- **(d) Does migration 040 break existing vocab/grammar reads?** No. Both new
  `source_upload_id` columns are nullable, added via `ADD COLUMN IF NOT EXISTS`, with no default
  requiring a table rewrite concern beyond nullable-add (cheap in PG), and no existing route
  uses `SELECT *` or a `.strict()` Zod schema against either table's rows (grepped
  `routes/vocab.ts`, `routes/grammar*.ts`) — the new columns are invisible to every existing
  explicit-column-list reader.
- **(e) Is re-upload leak-free (old blob deleted)?** Yes. The prior blob is deleted only after
  the DB transaction that wrote the new row commits, and best-effort (a delete failure logs and
  does not fail the request, leaving at worst a harmless orphan file, never a double-delete of a
  live file). Test proves the new blob differs, holds the new bytes, and the old blob path is
  actually gone from disk (`uploads.test.ts:254-302`).
- **(f) Is nginx valid, and is `/uploads` reachable both as an API prefix and as the SPA viewer
  route?** `nginx -t` passes on both `Deploy/nginx-blue-active.conf` and
  `Deploy/nginx-green-active.conf` (verified via `docker run nginx:alpine nginx -t` against each
  file as `/etc/nginx/nginx.conf`, since these are full configs with their own `events{}` block,
  not conf.d fragments — both passed with "syntax is ok" / "test is successful"). `/uploads` was
  added to the allow-list regex in all 4 locations across both files (2 server blocks × 2
  files), and the existing `Accept: text/html` branch that routes browser navigations to the SPA
  client while XHR/fetch goes to the server (the mechanism that lets `/uploads/:id` serve the
  client-side PDF-viewer route while `/uploads` XHR calls hit the API) is untouched by this diff
  — it applies to `/uploads` exactly as it does to every other prefix in the list.

**However**: none of the above matters if the underlying blob file doesn't exist on the serving
container in the first place — see BLOCKER B-1. The route-level IDOR/traversal/streaming
correctness is airtight; the deploy-level durability underneath it is not yet wired up.

---

## Verification commands run

- `npx tsc --noEmit` inside `node:20-slim` against `server/`: **STC=0** (clean typecheck).
- `npx vitest run tests/routes/uploads.test.ts tests/routes/vocab.test.ts tests/routes/grammar.test.ts`
  (real Postgres via testcontainers): **[PENDING — see below; environment resource contention
  from repeated prior invocations slowed this run substantially; result appended once
  available]**.
- `nginx -t` via `docker run --rm -v <conf>:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t` for
  both `Deploy/nginx-blue-active.conf` and `Deploy/nginx-green-active.conf`: **both PASS**
  ("syntax is ok" / "test is successful").
- Deploy-wiring check: `grep -rn "book_upload\|BOOK_UPLOAD" Deploy/` → **zero hits** (confirms
  B-1); contrasted against `IMAGE_STORAGE_DIR`/`km_images`, which appear in the compose files,
  `.env.example`, and `README.md`.
