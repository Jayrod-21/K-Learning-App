-- migrate: non-destructive
-- =============================================================================
-- Migration 099 — book_uploads async ingest (Phase 2.5 — OOM fix)
--   UP — turns `book_uploads` INTO the queue for its own ingest job: adds the
--        'pending' status value (the row now exists BEFORE its zip/PDF is
--        decoded, not after) plus run-tracking columns (`started_at`,
--        `finished_at`, `error`) and `raw_blob_ref` (the server-generated
--        relative path of the raw uploaded file on the km_book_uploads
--        volume, read by the runner after the request has already returned).
--   Reverse: 099_book_upload_async_ingest.down.sql
--   Depends on: 040_book_uploads (book_uploads, book_upload_status enum),
--     041_book_pages (drops the old whole-book blob_ref this replaces with a
--     per-page model — raw_blob_ref here is unrelated: it is the SOURCE
--     zip/PDF, held only until the runner has decoded it into book_pages).
--
-- WHY THIS MIGRATION EXISTS (see RECON.md / BUILD_BRIEF.md "Phase 2.5")
--   `POST /uploads` used to decode an entire book (up to 2 GiB of zip
--   entries, or up to 2000 rendered PDF pages) SYNCHRONOUSLY in the request,
--   all resident in memory together — km-server's 1 GiB cgroup limit OOM-
--   killed the whole process on a large book. The fix moves decoding into an
--   in-process runner (server/src/services/bookIngestRunner.ts, mirroring
--   services/storyAudio.ts's claim/settle/reap shape) that streams ONE page
--   at a time; the route now just writes the raw file to disk and enqueues.
--   `book_uploads` is chosen as the queue itself (not a new `book_upload_jobs`
--   table): an ingest is 1:1 with an upload — the row already carries
--   `status`/`page_count`, so it IS the natural unit of work, and giving it a
--   'pending' state before 'processing' is the smallest change that supports
--   claim/reap semantics without a second table to keep in sync.
--
-- DESIGN NOTES
--   * PICK UP THE PG ENUM GOTCHA (mirrors 072/021/016 — see their headers):
--     a newly ADDed enum value cannot be USED (compared/cast/inserted) in the
--     SAME transaction that added it. This migration ONLY ADDS 'pending' —
--     nothing in this file compares any column to the literal 'pending'. The
--     partial claim index that DOES reference 'pending' is deliberately a
--     SEPARATE migration (100_book_upload_pending_claim_index) so it runs in
--     its own, later-committing transaction. The runner/route that USES
--     'pending' at runtime (server/src/services/bookIngestRunner.ts,
--     server/src/routes/uploads.ts) ships in the SAME deploy as this
--     migration but always runs in its own fresh connection/transaction,
--     long after 099 has committed — never a problem.
--   * `started_at` / `finished_at` mirror `story_audio_jobs`' run-tracking
--     columns (081) exactly: `started_at` is stamped at claim (NULL for a
--     'pending' row, never NULL once 'processing'/'ready'/'failed'),
--     `finished_at` is stamped at settle (NULL until 'ready'/'failed'). Both
--     back the stale-run reap query
--     (`WHERE status = 'processing' AND started_at < now() - make_interval(...)`).
--   * `error` mirrors `story_audio_jobs.error` — a bounded, server-authored
--     failure message (never raw provider/library text — see
--     bookIngestRunner.ts's `failureMessage`). Length-capped defensively,
--     matching the DB-side ceiling every other job-error column in this
--     schema uses (076/081).
--   * `raw_blob_ref` is nullable and NULL once ingest settles either way: the
--     runner deletes the raw file and clears this column on BOTH 'ready' (the
--     source has been fully decoded — no reason to keep it) and 'failed'
--     (an unusable/adversarial file is not retried automatically; a retry is
--     a fresh POST with a fresh raw_blob_ref). It is populated ONLY while a
--     row is 'pending' or 'processing'. Same shape/contract as
--     `book_pages.blob_ref` (041) — a RELATIVE path under
--     BOOK_UPLOAD_STORAGE_DIR, built server-side from a UUID, NEVER absolute
--     and NEVER built from client input (services/bookUploadIngest.ts's
--     multer diskStorage `filename` callback) — see uploadStore.ts's
--     `resolveUnderRoot` for the traversal guard the runner reuses to read
--     and later delete it.
--   * No new UNIQUE/CHECK changes to `uq_book_uploads_user_title`: the
--     idempotent same-title "replace" semantics stay in place, now applied by
--     the ROUTE at enqueue time (a terminal 'ready'/'failed' row for that
--     title is reset to 'pending' with a fresh raw_blob_ref) and by the
--     RUNNER at decode time (`DELETE FROM book_pages WHERE upload_id = $1`
--     immediately after claim, BEFORE the per-page insert loop — see
--     bookIngestRunner.ts's header for why this single mechanism also gives
--     the stale-reap-then-rerun path its idempotency for free: a reaped
--     'processing' row that gets reclaimed later re-runs the exact same
--     delete-then-decode sequence, so a partial page set from the crashed run
--     can never survive into the retry). A 'pending'/'processing' row for the
--     SAME title is NOT replaceable by a second POST — the route 409s
--     (ConflictError) rather than racing two decodes over one row; see
--     routes/uploads.ts.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. book_upload_status — add 'pending'. ONLY adds; nothing below (or in this
--    file at all) compares/casts/inserts the literal 'pending' — see the PG
--    ENUM GOTCHA note above.
-- -----------------------------------------------------------------------------
ALTER TYPE book_upload_status ADD VALUE IF NOT EXISTS 'pending';

-- -----------------------------------------------------------------------------
-- 2. Run-tracking columns — mirror story_audio_jobs' claim/settle contract.
-- -----------------------------------------------------------------------------
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS error TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'book_uploads'::regclass
           AND conname  = 'ck_book_uploads_error_len'
    ) THEN
        ALTER TABLE book_uploads
            ADD CONSTRAINT ck_book_uploads_error_len
            CHECK (error IS NULL OR length(error) <= 2000);
    END IF;
END$$;

COMMENT ON COLUMN book_uploads.started_at IS
    'Stamped by the ingest runner''s claim UPDATE (pending -> processing). '
    'NULL for a pending row; never NULL once processing/ready/failed. Backs '
    'the stale-run reap query (WHERE status = ''processing'' AND started_at '
    '< now() - make_interval(mins => BOOK_INGEST_STALE_RUN_MINUTES)).';
COMMENT ON COLUMN book_uploads.finished_at IS
    'Stamped by the runner''s settle UPDATE (processing -> ready|failed). '
    'NULL until the row reaches a terminal state.';
COMMENT ON COLUMN book_uploads.error IS
    'Bounded, server-authored failure message set on settle-to-failed (never '
    'raw provider/library text) — server/src/services/bookIngestRunner.ts''s '
    '`failureMessage`. NULL for every non-failed row.';

-- -----------------------------------------------------------------------------
-- 3. raw_blob_ref — the raw uploaded file's relative path, populated by the
--    route at enqueue time, read (and then deleted) by the runner.
-- -----------------------------------------------------------------------------
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS raw_blob_ref TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'book_uploads'::regclass
           AND conname  = 'ck_book_uploads_raw_blob_ref_len'
    ) THEN
        ALTER TABLE book_uploads
            ADD CONSTRAINT ck_book_uploads_raw_blob_ref_len
            CHECK (raw_blob_ref IS NULL OR length(raw_blob_ref) BETWEEN 1 AND 1024);
    END IF;
END$$;

COMMENT ON COLUMN book_uploads.raw_blob_ref IS
    'RELATIVE path under BOOK_UPLOAD_STORAGE_DIR to the RAW uploaded zip/PDF '
    '(e.g. "raw/7/<uuid>.bin"), NEVER absolute and NEVER built from client '
    'input — server/src/services/bookUploadIngest.ts''s multer diskStorage. '
    'Populated while status is pending/processing; NULL once the row settles '
    '(ready or failed) — the runner deletes the raw file and clears this '
    'column either way (see module header). Same traversal-guard contract as '
    'book_pages.blob_ref (041) — resolved via uploadStore.ts''s '
    '`resolveUnderRoot`.';

COMMENT ON COLUMN book_uploads.status IS
    'pending (route enqueued, raw file on disk, awaiting the runner) -> '
    'processing (runner claimed it, decoding) -> ready|failed (runner '
    'settled it). A same-title re-upload of a TERMINAL (ready/failed) row '
    'resets it to pending; a re-upload while pending/processing 409s (see '
    'routes/uploads.ts) rather than racing two decodes over one row.';

-- End of 099_book_upload_async_ingest.up.sql — runner owns the transaction (ADR-013).
