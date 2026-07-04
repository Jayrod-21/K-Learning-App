-- 035 (up): add audio_path to ttmik_lessons + iyagi_episodes (F-012, TTMIK audio).
--
-- Feature: the corpus ships 1,179 TTMIK mp3s (lesson tracks + Iyagi episode
-- recordings). The server streams them via GET /ttmik/lessons/:level/:number/audio
-- and GET /iyagi/episodes/:number/audio; the loader
-- tools/ingest/loaders/load_ttmik_audio.py walks the corpus audio tree and
-- writes this column for every row whose (lesson_level, lesson_number) /
-- episode_number matches a parsed mp3 filename.
--
-- CONTRACT: audio_path is a RELATIVE key under the corpus audio root
-- (CORPUS_AUDIO_DIR, e.g. `/corpus` in the container), such as
-- 'TTMIK/이야기들/이야기/143 TTMIK Iyagi 143.mp3' — NEVER a host-absolute path.
-- Keeping it relative means the same row serves any mount point (blue/green
-- containers, local dev, a future object store) and a leaked row never reveals
-- host filesystem layout. The serving route re-anchors it under the configured
-- root and verifies the resolved real path stays inside that root before
-- opening the file (path-traversal / symlink-escape defense lives in the
-- route, not here — the DB stores data, the boundary enforces it).
--
-- Expand-only and additive: one nullable TEXT column per table, no backfill
-- (NULL = "no audio known yet", the state of every existing row until the
-- loader runs). No index: lookups arrive through the existing unique keys
-- (uq_ttmik_lessons_level_lesson, uq_iyagi_episodes_number) and audio_path is
-- only ever SELECTed, never filtered on.
--
-- TRANSACTION OWNERSHIP (ADR-013): no BEGIN/COMMIT here — migrate.py wraps
-- this file and the schema_migrations bookkeeping in one transaction.

ALTER TABLE ttmik_lessons
    ADD COLUMN IF NOT EXISTS audio_path TEXT;

COMMENT ON COLUMN ttmik_lessons.audio_path IS
    'Relative key of this lesson''s mp3 under the corpus audio root '
    '(CORPUS_AUDIO_DIR), e.g. ''TTMIK/Lessons/Lesson 1/01 TTMIK Level 1 '
    'Lesson 1.mp3''. NULL = no audio matched. Written by '
    'tools/ingest/loaders/load_ttmik_audio.py; served by '
    'GET /ttmik/lessons/:level/:number/audio. Never a host-absolute path.';

ALTER TABLE iyagi_episodes
    ADD COLUMN IF NOT EXISTS audio_path TEXT;

COMMENT ON COLUMN iyagi_episodes.audio_path IS
    'Relative key of this episode''s mp3 under the corpus audio root '
    '(CORPUS_AUDIO_DIR), e.g. ''TTMIK/이야기들/이야기/143 TTMIK Iyagi 143.mp3''. '
    'NULL = no audio matched. Written by '
    'tools/ingest/loaders/load_ttmik_audio.py; served by '
    'GET /iyagi/episodes/:number/audio. Never a host-absolute path.';
