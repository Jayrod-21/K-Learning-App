-- 041 (down): drop book_pages + restore book_uploads.blob_ref.
--
-- LOSSY by design: every book_pages row is discarded, and the page-image blob
-- FILES on disk are untouched by this SQL migration and become orphans (an
-- operator rolling back should also clear BOOK_UPLOAD_STORAGE_DIR by hand if
-- reclaiming that space matters — mirrors 040's own down-migration caveat).
--
-- book_uploads.blob_ref is restored NULLABLE (not NOT NULL, as it was
-- pre-041) because there is no data to backfill it with — under the 041
-- model the original zip/PDF was never retained, so there is nothing for a
-- restored blob_ref to point at. This migration only restores the SCHEMA
-- shape; the pre-041 upload/serve code path (a single retained PDF blob) is
-- not reinstated by a schema change alone.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- 1. Restore book_uploads.blob_ref (nullable — no historical data survives).
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS blob_ref TEXT;
ALTER TABLE book_uploads
    ADD CONSTRAINT ck_book_uploads_blob_ref_nonempty
        CHECK (blob_ref IS NULL OR length(blob_ref) BETWEEN 1 AND 1024);

COMMENT ON COLUMN book_uploads.blob_ref IS
    'RELATIVE path under BOOK_UPLOAD_STORAGE_DIR (e.g. "7/<uuid>.pdf"), NEVER '
    'absolute and NEVER built from client input. Restored NULLABLE by this '
    'down migration — 041 dropped it and no historical data survives the '
    'round trip (the original file was never retained under the 041 model).';
COMMENT ON COLUMN book_uploads.byte_size IS
    'Stored PDF size in bytes; > 0. The route caps uploads at ~15 MB.';
COMMENT ON COLUMN book_uploads.page_count IS
    'PDF page count. NULL until U2 extraction reads it (not populated by U1).';
COMMENT ON TABLE book_uploads IS
    'One row per user-uploaded scanned-book PDF (U1, PDF book-upload feature). '
    'Blob bytes live on the filesystem under BOOK_UPLOAD_STORAGE_DIR; this row '
    'holds the pointer + status. Hard-deleted (no history value once removed); '
    'U2 extraction tags content rows back to this id via source_upload_id '
    '(ON DELETE SET NULL, so removing the upload never deletes content already '
    'pulled from it).';

-- 2. Drop book_pages itself (trigger + index are table-owned; the FK to
--    book_uploads goes with it).
DROP TABLE IF EXISTS book_pages;

-- End of 041_book_pages.down.sql
