-- 040 (down): drop book_uploads + the source_upload_id columns it introduced.
--
-- LOSSY by design: rolling back discards every book_uploads row (the metadata
-- pointer AND the "which PDF did this content come from" tag on vocab_entries/
-- kgiu_entries — the underlying blob FILES on disk are untouched by this SQL
-- migration and become orphans; an operator rolling back should also clear
-- BOOK_UPLOAD_STORAGE_DIR by hand if reclaiming that space matters). The
-- content rows themselves (vocab_entries / kgiu_entries) are NOT deleted —
-- only the nullable source_upload_id column is dropped, so no corpus content
-- is lost, just its upload provenance tag.
--
-- Column drops run BEFORE the table drop so the FK dependency direction never
-- blocks a `DROP TABLE`. The trigger + index are book_uploads-owned and go
-- with it; set_updated_at() is shared (001) and must remain.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- 1. Un-tag content rows (drops the FK along with the column).
DROP INDEX IF EXISTS ix_kgiu_entries_source_upload;
ALTER TABLE kgiu_entries DROP COLUMN IF EXISTS source_upload_id;

DROP INDEX IF EXISTS ix_vocab_entries_source_upload;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS source_upload_id;

-- 2. Drop book_uploads itself (trigger + index are table-owned).
DROP TABLE IF EXISTS book_uploads;

-- 3. Drop the enums. Safe only once nothing references them (the table above
--    is already gone).
DROP TYPE IF EXISTS book_upload_status;
DROP TYPE IF EXISTS book_upload_type;
