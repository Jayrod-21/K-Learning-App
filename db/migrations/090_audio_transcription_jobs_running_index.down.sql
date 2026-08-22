-- =============================================================================
-- Migration 090 — audio_transcription_jobs reaper index (DOWN)
--   Drops the partial index. IF EXISTS so a partial/repeated rollback is a
--   no-op. Purely additive up, so the down is purely subtractive — no data
--   loss, no CHECK to restore, nothing else to reconcile.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP INDEX IF EXISTS ix_audio_transcription_jobs_running;

-- End of 090_audio_transcription_jobs_running_index.down.sql — runner owns the transaction (ADR-013).
