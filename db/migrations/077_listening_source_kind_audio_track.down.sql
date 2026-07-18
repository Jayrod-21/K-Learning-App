-- migrate: destructive
-- =============================================================================
-- Migration 077 — listening_attempts 'audio_track' target (DOWN)
--   Reverses 077_listening_source_kind_audio_track.up.sql:
--     1. restores both 061 CHECK definitions VERBATIM (2-value source_kind,
--        2-column target_not_both — same names);
--     2. restores the 061 comment texts the up rewrote;
--     3. drops the `track_id` column (its fk_listening_attempts_track goes
--        with it).
--
--   Marked destructive explicitly: the `DROP COLUMN` is a data drop the
--   legacy keyword-sniff would MISS (the exact shape F-088's marker exists
--   for — 063's down took the same posture), and any audio-listen history
--   distinguishable only by track_id loses that linkage.
--
-- CANNOT TEAR DOWN A POPULATED AUDIO-LISTEN HISTORY
--   If any listening_attempts rows exist with source_kind = 'audio_track'
--   (a learner has logged audio listens), the unconditional CHECK
--   restoration below FAILS LOUDLY — ADD CONSTRAINT validates existing
--   rows against the restored 2-value set. A clean down then requires the
--   operator to first remove those rows (a deliberate, destructive act) —
--   the correct posture for a learner's listening history, and exactly
--   069's stance for a populated user_mined kgiu corpus. A down on
--   populated data is an operator decision, never a silent stranding.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this down body in its
--   own transaction together with the bookkeeping DELETE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Restore both 061 CHECK definitions verbatim. Fails loudly if
--    'audio_track' rows still exist — see header.
-- -----------------------------------------------------------------------------
ALTER TABLE listening_attempts
    DROP CONSTRAINT IF EXISTS ck_listening_attempts_source_kind;

ALTER TABLE listening_attempts
    ADD CONSTRAINT ck_listening_attempts_source_kind
        CHECK (source_kind IN ('ttmik_lesson', 'iyagi_episode'));

ALTER TABLE listening_attempts
    DROP CONSTRAINT IF EXISTS ck_listening_attempts_target_not_both;

ALTER TABLE listening_attempts
    ADD CONSTRAINT ck_listening_attempts_target_not_both
        CHECK (NOT (lesson_id IS NOT NULL AND episode_id IS NOT NULL));

-- -----------------------------------------------------------------------------
-- 2. Restore the 061 comment texts (the up rewrote them to mention the
--    third target).
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN listening_attempts.source_kind IS
    'Which soft-FK column is populated for this row: ''ttmik_lesson'' '
    '(ttmik_lessons.id) or ''iyagi_episode'' (iyagi_episodes.id). Exactly one '
    'of lesson_id/episode_id is non-null at INSERT time (route-enforced — see '
    'ck_listening_attempts_target_not_both''s comment for why the DB only '
    'rejects BOTH being set, not fewer than one); either may independently go '
    'NULL later if its source row is pruned by a corpus reload — the row '
    'survives on title_snapshot (degraded, but still a valid history entry).';
COMMENT ON TABLE listening_attempts IS
    'Append-only log of completed listening actions (F-172): one row per '
    '"finished this TTMIK lesson" / "finished this Iyagi episode" event, keyed '
    'by source_kind (ttmik_lesson|iyagi_episode) with a soft, SET-NULL FK to '
    'whichever target was completed. title_snapshot (server-derived at '
    'completion time) keeps history readable after a corpus reload prunes the '
    'source row. Feeds a future Today/streak "did the user listen today" '
    'surface. CASCADEs away with the user; never UPDATEd post-insert.';

-- -----------------------------------------------------------------------------
-- 3. Drop the third target column (drops fk_listening_attempts_track with
--    it). Runs LAST so the loud CHECK validation above fires first — inside
--    the runner's single transaction either everything reverts or nothing
--    does.
-- -----------------------------------------------------------------------------
ALTER TABLE listening_attempts DROP COLUMN IF EXISTS track_id;

-- End of 077_listening_source_kind_audio_track.down.sql — runner owns the transaction (ADR-013).
