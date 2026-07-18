-- migrate: destructive
-- 076 (down): drop audio_transcription_jobs + its enum.
--
-- LOSSY by design: every job row — INCLUDING the per-user daily
-- transcription-cap cost ledger, which deliberately survives track deletion
-- via the up's ON DELETE SET NULL — is discarded (hence the destructive
-- marker; migrate.py requires --allow-destructive). Nothing references this
-- table (its FKs point OUT to audio_tracks/users), so the drop reverses 076
-- completely (also removes the partial-unique claim index, the worker's
-- pending index, the trigger, and the CHECKs).
--
-- The enum drops cleanly once the only table using it is gone (069's down
-- posture for upload_extraction_status).
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- 1. Drop the jobs table (and with it its indexes + trigger).
DROP TABLE IF EXISTS audio_transcription_jobs;

-- 2. Drop the enum — nothing else references it once the table is gone.
DROP TYPE IF EXISTS audio_transcription_status;

-- End of 076_audio_transcription_jobs.down.sql
