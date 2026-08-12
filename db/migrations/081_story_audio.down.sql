-- migrate: destructive
-- =============================================================================
-- Migration 081 — story audio (DOWN)
--   Reverses 081_story_audio.up.sql: drops story_audio_jobs, removes the
--   audio_sources story link (deleting every 'generated_story' set first —
--   see below), restores the 3-value kind CHECK, and drops
--   generated_stories.turns + the composite-FK-backing UNIQUE.
--
-- LOSSY BY DESIGN (hence the destructive marker; migrate.py requires
-- --allow-destructive):
--   * story_audio_jobs — the TTS job history INCLUDING the per-user daily
--     cap's char_count ledger — is discarded.
--   * Every kind = 'generated_story' audio_sources row is DELETEd (and with
--     it, via CASCADE, its audio_tracks + audio_transcript_segments — the
--     voiced narration). Required: the restored 3-value kind CHECK would
--     otherwise fail validation against surviving 'generated_story' rows.
--     Re-derivable data — re-upping and re-voicing rebuilds it (a paid TTS
--     call per story). Blob FILES under AUDIO_UPLOAD_STORAGE_DIR are NOT
--     removed — the DB never deletes files (041/074's posture); orphaned
--     narration blobs are an operator cleanup.
--   * generated_stories.turns is dropped — the latent multi-voice structure
--     is lost for stories that carried it (regenerable only by re-generating
--     the story). body_ko — the reader's source of truth — is untouched, so
--     no story becomes unreadable.
--
-- Post-081 route code (the /reading/generated/:id/audio pair + the runner)
-- must not run against a pre-081 schema (035/078's contract).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

-- 1. The jobs table first (it FKs both audio_sources and generated_stories).
DROP TABLE IF EXISTS story_audio_jobs;

-- 2. Delete the voiced sets so the narrowed kind CHECK below can validate;
--    CASCADE inside the audio stack removes their tracks + segments.
DELETE FROM audio_sources WHERE kind = 'generated_story';

-- 3. Remove the story link + its rails, restore the pre-081 kind CHECK
--    (073's exact value set).
DROP INDEX IF EXISTS uq_audio_sources_generated_story;
ALTER TABLE audio_sources DROP CONSTRAINT IF EXISTS ck_audio_sources_story_kind_link;
ALTER TABLE audio_sources DROP CONSTRAINT IF EXISTS fk_audio_sources_generated_story;
ALTER TABLE audio_sources DROP COLUMN IF EXISTS generated_story_id;

ALTER TABLE audio_sources DROP CONSTRAINT IF EXISTS ck_audio_sources_kind;
ALTER TABLE audio_sources ADD CONSTRAINT ck_audio_sources_kind
    CHECK (kind IN ('paired_reader', 'standalone_listening', 'topik'));

-- 4. generated_stories: drop the turns column + its CHECK and the
--    composite-FK-backing UNIQUE (nothing references it once §1/§3 are gone —
--    074's down posture for uq_reading_chapters_id_user).
ALTER TABLE generated_stories DROP CONSTRAINT IF EXISTS ck_generated_stories_turns_array;
ALTER TABLE generated_stories DROP COLUMN IF EXISTS turns;
ALTER TABLE generated_stories DROP CONSTRAINT IF EXISTS uq_generated_stories_id_user;

-- End of 081_story_audio.down.sql — runner owns the transaction (ADR-013).
