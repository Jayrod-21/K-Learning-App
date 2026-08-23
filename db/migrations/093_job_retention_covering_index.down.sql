-- =============================================================================
-- Migration 093 — job-retention covering indexes (DOWN)
--   Drops the three partial indexes. IF EXISTS so a partial/repeated rollback
--   is a no-op. Purely additive up → purely subtractive down; no data touched.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner wraps
-- the down body in a single transaction.
-- =============================================================================

DROP INDEX IF EXISTS ix_audio_transcription_jobs_retention;
DROP INDEX IF EXISTS ix_story_audio_jobs_retention;
DROP INDEX IF EXISTS ix_story_image_jobs_retention;

-- End of 093_job_retention_covering_index.down.sql — runner owns the transaction (ADR-013).
