-- migrate: destructive
-- =============================================================================
-- Migration 078 — TOPIK listening audio (DOWN)
--   Reverses 078_topik_listening_audio.up.sql:
--     1. drops ck_topik_items_audio_span, then the two span columns on
--        topik_items;
--     2. drops topik_tests.audio_path.
--
--   Marked destructive explicitly: the DROP COLUMNs are a data drop the
--   legacy keyword-sniff would MISS (the exact shape F-088's marker exists
--   for — 063/077's downs took the same posture).
--
-- LOSSY BY DESIGN (035's exact reasoning for its audio_path down)
--   Rolling back discards the audio-file mapping and every per-question
--   span. That is recoverable, not stranded: the 24 corpus MP3s and the
--   segmentation JSON artifacts (plan §5) are the system of record —
--   re-running tools/ingest/loaders/load_topik_audio.py after a re-up
--   repopulates all three columns in full. Post-078 route/DTO code must not
--   run against a pre-078 schema (035's contract).
--
--   NOT touched: topik_items.extra's 'audio_seg' provenance keys. extra is
--   a data column this migration never wrote through — scrubbing it here
--   would be a mass UPDATE of loader-owned data inside a schema rollback.
--   The keys are inert without the span columns and the loader's next run
--   rewrites them.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this down body in its
--   own transaction together with the bookkeeping DELETE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. topik_items: the span CHECK, then its columns. (DROP COLUMN would take
--    the CHECK with it — the explicit drop keeps the reversal readable and
--    exactly mirrors the up's order.)
-- -----------------------------------------------------------------------------
ALTER TABLE topik_items
    DROP CONSTRAINT IF EXISTS ck_topik_items_audio_span;

ALTER TABLE topik_items
    DROP COLUMN IF EXISTS audio_start_ms,
    DROP COLUMN IF EXISTS audio_end_ms;

-- -----------------------------------------------------------------------------
-- 2. topik_tests: the whole-section MP3 mapping.
-- -----------------------------------------------------------------------------
ALTER TABLE topik_tests
    DROP COLUMN IF EXISTS audio_path;

-- End of 078_topik_listening_audio.down.sql — runner owns the transaction (ADR-013).
