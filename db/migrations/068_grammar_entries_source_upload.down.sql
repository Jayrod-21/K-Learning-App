-- migrate: destructive
-- 068 (down): drop grammar_entries.source_upload_id + its partial index.
--
-- LOSSY: any user-saved "banked from THIS upload" provenance tags recorded
-- since 068 are discarded by the DROP COLUMN — the banked patterns themselves
-- are NOT deleted, only their upload-provenance dimension (same shape as
-- 040's down, which un-tags rather than deletes content). DROP COLUMN carries
-- no DROP TABLE/SCHEMA/DATABASE or TRUNCATE keyword, so the legacy sniff
-- would miss it — declared destructive explicitly (F-088) so
-- --allow-destructive is required.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DROP INDEX IF EXISTS ix_grammar_entries_source_upload;

-- Dropping the column drops fk_grammar_entries_source_upload with it.
ALTER TABLE grammar_entries
    DROP COLUMN IF EXISTS source_upload_id;

-- End of 068_grammar_entries_source_upload.down.sql
