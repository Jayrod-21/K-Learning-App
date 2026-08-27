-- migrate: destructive
-- =============================================================================
-- Migration 105 — generated_items stimulus-group columns (DOWN)
--   Reverses 105_generated_items_stimulus_group.up.sql: drops the partial
--   index and the two stimulus-group columns (their CHECKs go with them).
--
-- LOSSY BY DESIGN (hence the destructive marker; migrate.py requires
-- --allow-destructive):
--   Every paired-reading/paired-listening row's group membership
--   (stimulus_group_id/stimulus_group_ordinal) is discarded — the rows
--   themselves survive (this migration touches no other column), but they
--   revert to looking like unrelated standalone rows sharing a coincidental
--   `passage`/`audio_source_id` value. Re-derivable only by re-running the
--   ingest CLI against the original (or an equivalent) work-order file, which
--   assigns fresh group ids.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

DROP INDEX IF EXISTS ix_generated_items_stimulus_group;

ALTER TABLE generated_items DROP CONSTRAINT IF EXISTS ck_generated_items_stimulus_group_paired;
ALTER TABLE generated_items DROP CONSTRAINT IF EXISTS ck_generated_items_stimulus_group_ordinal_positive;
ALTER TABLE generated_items DROP CONSTRAINT IF EXISTS ck_generated_items_stimulus_group_id_len;

ALTER TABLE generated_items DROP COLUMN IF EXISTS stimulus_group_ordinal;
ALTER TABLE generated_items DROP COLUMN IF EXISTS stimulus_group_id;

-- End of 105_generated_items_stimulus_group.down.sql — runner owns the
-- transaction (ADR-013).
