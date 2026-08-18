-- migrate: destructive
-- =============================================================================
-- Migration 085 — TOPIK question images (DOWN)
--   Reverses 085_topik_item_images.up.sql: drops topik_items.image_ref.
--
--   Marked destructive explicitly: the DROP COLUMN is a data drop the legacy
--   keyword-sniff would MISS (F-088's marker posture — 063/077/078's downs
--   took the same stance).
--
-- LOSSY BY DESIGN (078's exact reasoning for its audio_path down)
--   Rolling back discards the item→image mapping. That is recoverable, not
--   stranded: the cropped image files and the extraction manifest JSONs are
--   the system of record — re-running tools/ingest/loaders/load_topik_image.py
--   after a re-up repopulates the column in full. Post-085 route/DTO code
--   must not run against a pre-085 schema (035/078's contract).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this down body in its
--   own transaction together with the bookkeeping DELETE.
-- =============================================================================

ALTER TABLE topik_items
    DROP COLUMN IF EXISTS image_ref;

-- End of 085_topik_item_images.down.sql — runner owns the transaction (ADR-013).
