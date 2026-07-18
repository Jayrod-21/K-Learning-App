-- migrate: destructive
-- 074 (down): drop audio_tracks + the reading_chapters UNIQUE(id, user_id)
-- that only existed to back its composite chapter FK.
--
-- LOSSY but self-contained: every track row (blob pointer, order, transcript
-- lifecycle, chapter alignment) is discarded. Blob FILES under
-- AUDIO_UPLOAD_STORAGE_DIR are NOT removed — the DB never deletes files
-- (041/017 posture); orphaned audio blobs are an operator cleanup. Track
-- metadata is re-derivable by re-running the Track A loader; transcripts are
-- 075's problem (in the merged chain 075's down runs BEFORE this one, so no
-- audio_transcript_segments rows still FK this table by the time it drops —
-- likewise 076's jobs and 077's listening_attempts.track_id).
--
-- audio_sources (073) and users are untouched — this table's FKs all point
-- OUT. reading_chapters keeps its rows but loses uq_reading_chapters_id_user
-- (step 2): that UNIQUE only existed to back this table's composite chapter
-- FK (074 up §0), so it goes down with 074 — the same posture as 044's down
-- removing uq_book_uploads_id_user. Dropped AFTER the table so no FK still
-- depends on it.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- 1. Drop the table (its composite FKs, indexes, and trigger go with it).
DROP TABLE IF EXISTS audio_tracks;

-- 2. Remove the UNIQUE(id, user_id) that only existed to back the composite
--    chapter FK.
ALTER TABLE reading_chapters DROP CONSTRAINT IF EXISTS uq_reading_chapters_id_user;

-- End of 074_audio_tracks.down.sql
