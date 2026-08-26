-- migrate: destructive
-- =============================================================================
-- Migration 103 — generated_items audio columns (DOWN)
--   Reverses 103_generated_items_audio.up.sql: deletes every
--   kind = 'generated_listening' audio_sources row first (so the narrowed
--   kind CHECK below can validate — 081's down's exact maneuver), restores
--   the pre-103 4-value kind CHECK, drops the audio_source_id FK, and drops
--   the three generated_items columns this migration added.
--
-- LOSSY BY DESIGN (hence the destructive marker; migrate.py requires
-- --allow-destructive):
--   * Every kind = 'generated_listening' audio_sources row is DELETEd (and
--     with it, via CASCADE, its audio_tracks — the synthesized dialogue
--     audio). Required: the restored 4-value kind CHECK would otherwise fail
--     validation against surviving 'generated_listening' rows. Blob FILES
--     under AUDIO_UPLOAD_STORAGE_DIR are NOT removed (041/074/081's
--     posture — the DB never deletes files); orphaned blobs are an operator
--     cleanup. Re-derivable: re-upping and re-running the synth CLI rebuilds
--     it (a paid ElevenLabs call per item).
--   * generated_items.turns / audio_cost_estimate_usd / audio_synthesized_at
--     are dropped — any authored-but-not-yet-synthesized dialogue script is
--     lost (regenerable only by re-running the $0 script generator).
--     generated_items.audio_source_id (101's column) is UNTOUCHED — it
--     reverts to unconstrained/NULL-for-everyone, exactly its pre-103 state.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

-- 1. Null out every generated_items row's audio_source_id before deleting the
--    'generated_listening' sets it points at, so the FK drop below never has
--    to race a dangling reference (belt-and-braces — ON DELETE SET NULL
--    would already handle this, but the FK itself is dropped in this same
--    transaction so the ordering is made explicit rather than relied upon).
UPDATE generated_items gi
   SET audio_source_id = NULL
  FROM audio_sources s
 WHERE gi.audio_source_id = s.id
   AND s.kind = 'generated_listening';

-- 2. Delete the synthesized listening audio sets so the narrowed kind CHECK
--    below can validate; CASCADE removes their tracks (074).
DELETE FROM audio_sources WHERE kind = 'generated_listening';

-- 3. Restore the pre-103 kind CHECK (081's 4-value set).
ALTER TABLE audio_sources DROP CONSTRAINT IF EXISTS ck_audio_sources_kind;
ALTER TABLE audio_sources ADD CONSTRAINT ck_audio_sources_kind
    CHECK (kind IN ('paired_reader', 'standalone_listening', 'topik', 'generated_story'));

-- 4. Drop the audio_source_id FK (101's column itself stays — pre-103 state
--    was "column exists, unconstrained").
ALTER TABLE generated_items DROP CONSTRAINT IF EXISTS fk_generated_items_audio_source;

-- 5. Drop the three columns this migration added (their CHECKs go with them).
ALTER TABLE generated_items DROP COLUMN IF EXISTS audio_synthesized_at;
ALTER TABLE generated_items DROP COLUMN IF EXISTS audio_cost_estimate_usd;
ALTER TABLE generated_items DROP COLUMN IF EXISTS turns;

-- End of 103_generated_items_audio.down.sql — runner owns the transaction (ADR-013).
