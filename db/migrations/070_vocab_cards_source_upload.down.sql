-- migrate: destructive
-- 070 (down): drop vocab_cards.source_upload_id + its partial index.
--
-- LOSSY: any per-user "saved from THIS upload" provenance tags recorded
-- since 070 are discarded by the DROP COLUMN — the cards themselves are NOT
-- deleted, only their upload-provenance dimension (same shape as 068's down,
-- which un-tags rather than deletes content). The 070 backfill is NOT
-- reversed onto vocab_entries (nothing was removed from there to restore).
-- DROP COLUMN carries no DROP TABLE/SCHEMA/DATABASE or TRUNCATE keyword, so
-- the legacy sniff would miss it — declared destructive explicitly (F-088)
-- so --allow-destructive is required.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DROP INDEX IF EXISTS ix_vocab_cards_source_upload;

-- Dropping the column drops fk_vocab_cards_source_upload with it.
ALTER TABLE vocab_cards
    DROP COLUMN IF EXISTS source_upload_id;

-- End of 070_vocab_cards_source_upload.down.sql
