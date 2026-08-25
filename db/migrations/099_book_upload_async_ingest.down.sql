-- migrate: destructive
-- =============================================================================
-- Migration 099 — book_uploads async ingest (DOWN)
--   Drops the run-tracking + raw_blob_ref columns (and their CHECKs) added by
--   099_book_upload_async_ingest.up.sql. IF EXISTS everywhere so a partial/
--   repeated rollback is a no-op.
--
--   The 'pending' enum VALUE is NOT removed — Postgres has no `ALTER TYPE …
--   DROP VALUE` (mirrors 072/021/016's down files, which document the exact
--   same limitation for 'comic'/'user_mined'/'hanja'). This is harmless: an
--   unused enum label with no column ever set to it again (once the columns
--   this migration adds are gone, nothing in the schema can reach the async
--   ingest path) is inert, not a data-integrity issue.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
--
-- DESTRUCTIVE: drops columns (started_at/finished_at/error/raw_blob_ref).
-- `migrate.py` requires `--allow-destructive` to run this down.
-- =============================================================================

ALTER TABLE book_uploads DROP CONSTRAINT IF EXISTS ck_book_uploads_raw_blob_ref_len;
ALTER TABLE book_uploads DROP COLUMN IF EXISTS raw_blob_ref;

ALTER TABLE book_uploads DROP CONSTRAINT IF EXISTS ck_book_uploads_error_len;
ALTER TABLE book_uploads DROP COLUMN IF EXISTS error;
ALTER TABLE book_uploads DROP COLUMN IF EXISTS finished_at;
ALTER TABLE book_uploads DROP COLUMN IF EXISTS started_at;

-- End of 099_book_upload_async_ingest.down.sql — runner owns the transaction (ADR-013).
