-- migrate: destructive
-- 075 (down): drop audio_transcript_segments.
--
-- LOSSY but self-contained: every transcript segment is discarded. The text
-- is re-derivable by re-running Whisper over the (untouched) audio blobs —
-- expensive (~150-200 hr of corpus audio) but mechanical, hence gated
-- (explicit destructive marker; migrate.py requires --allow-destructive).
-- Nothing references this table (its one FK points OUT to audio_tracks), so
-- the drop reverses 075 completely (also removes its trigger, unique
-- constraint, and CHECKs).
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DROP TABLE IF EXISTS audio_transcript_segments;

-- End of 075_audio_transcript_segments.down.sql
