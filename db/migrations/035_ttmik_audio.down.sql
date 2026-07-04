-- 035 (down): remove ttmik_lessons.audio_path + iyagi_episodes.audio_path.
--
-- Lossy by design: rolling back discards the audio-file mapping — the audio
-- endpoints then 404 (column gone means the route code from before 035 didn't
-- exist either; post-035 code must not run against a pre-035 schema). The
-- corpus mp3 tree on disk is the system of record and re-running
-- tools/ingest/loaders/load_ttmik_audio.py after a re-up repopulates both
-- columns in full. No dependent objects (no index, no constraint) were
-- created in the up, so a plain DROP COLUMN is complete.

ALTER TABLE ttmik_lessons
    DROP COLUMN IF EXISTS audio_path;

ALTER TABLE iyagi_episodes
    DROP COLUMN IF EXISTS audio_path;
