-- migrate: non-destructive
-- =============================================================================
-- Migration 077 — listening_attempts 'audio_track' target (Track A, A-1)
--   UP — widens 061's listening_attempts to count Track A audio listens:
--        adds a third soft target column `track_id` -> audio_tracks (074)
--        and relaxes the two 061 CHECKs (`ck_listening_attempts_source_kind`
--        gains 'audio_track'; `ck_listening_attempts_target_not_both`
--        becomes at-most-one-of-THREE). The existing attempt-logging +
--        "listened today" plumbing then counts corpus-audio listens with
--        zero new surface. See docs/TRACK_A_AUDIO_PLAN.md §2.
--   Reverse: 077_listening_source_kind_audio_track.down.sql
--   Depends on: 061_listening_attempts (the table + both CHECKs being
--               relaxed), 074_audio_tracks (the new FK target).
--
-- DESIGN NOTES
--   * track_id is SOFT — ON DELETE SET NULL ON UPDATE RESTRICT, the exact
--     carve-out 061 applies to its lesson/episode FKs: audio_tracks rows are
--     loader-populated and a corpus re-ingest may prune/replace them
--     (deleting a set CASCADEs its tracks); that reload must neither be
--     RESTRICTed nor CASCADE-erase the learner's listening history.
--     title_snapshot (server-derived at completion time, 061's contract)
--     carries the display label forward once track_id degrades to NULL.
--   * Both CHECKs are relaxed by DROP + re-ADD under the SAME names,
--     strictly MORE PERMISSIVE — every row satisfying the 061 definition
--     satisfies the new one (track_id is NULL on all pre-077 rows), so no
--     existing row can be invalidated and error messages / the down
--     migration stay stable. Byte-for-byte the maneuver 069 performed on
--     the kgiu_entries CHECKs.
--   * target_not_both stays "AT MOST one", NEVER strict XOR — 061's exact
--     reasoning, now over three columns: Postgres re-checks every table
--     CHECK on any UPDATE to a row, and the three FKs' ON DELETE SET NULL
--     actions ARE an UPDATE to this row. An "exactly one" CHECK would ABORT
--     a corpus reload's lesson/episode/track delete the instant it tried to
--     null the referencing column. `num_nonnulls(...) <= 1` expresses
--     at-most-one-of-three directly (the 2-column `NOT (a AND b)` form
--     doesn't scale to pairwise triples legibly). The route remains the
--     sole enforcer of "exactly one, matching source_kind" at INSERT time.
--   * The FK ADD is guarded through pg_constraint inside DO $$ … $$ —
--     Postgres has no ADD CONSTRAINT IF NOT EXISTS (044 §0's pattern), so a
--     manual re-apply of this file against a DB where it already succeeded
--     must not error. ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS
--     make the rest of the body re-runnable too.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The third soft target column + its guarded, named FK.
-- -----------------------------------------------------------------------------
ALTER TABLE listening_attempts
    ADD COLUMN IF NOT EXISTS track_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'fk_listening_attempts_track'
                     AND conrelid = 'listening_attempts'::regclass) THEN
        ALTER TABLE listening_attempts
            ADD CONSTRAINT fk_listening_attempts_track
                FOREIGN KEY (track_id) REFERENCES audio_tracks(id)
                ON DELETE SET NULL ON UPDATE RESTRICT;
    END IF;
END $$;

COMMENT ON COLUMN listening_attempts.track_id IS
    'Soft target #3 (077): the audio_tracks row completed. NULL when '
    'source_kind is ''ttmik_lesson''/''iyagi_episode'', or after the track '
    'is pruned by an audio re-ingest (ON DELETE SET NULL) — the row survives '
    'on title_snapshot, same degraded-row contract as lesson_id/episode_id.';
COMMENT ON CONSTRAINT fk_listening_attempts_track ON listening_attempts IS
    'Soft FK, ON DELETE SET NULL (the same corpus-reload carve-out as the '
    'lesson/episode FKs, 061): an audio re-ingest may prune/replace '
    'audio_tracks rows without RESTRICTing the reload or CASCADE-erasing '
    'listening history.';

-- -----------------------------------------------------------------------------
-- 2. Relax the two 061 CHECKs (same names, strictly more permissive — no
--    existing row can be invalidated; mirrors 069's kgiu relaxations).
-- -----------------------------------------------------------------------------
ALTER TABLE listening_attempts
    DROP CONSTRAINT IF EXISTS ck_listening_attempts_source_kind;

ALTER TABLE listening_attempts
    ADD CONSTRAINT ck_listening_attempts_source_kind
        CHECK (source_kind IN ('ttmik_lesson', 'iyagi_episode', 'audio_track'));

ALTER TABLE listening_attempts
    DROP CONSTRAINT IF EXISTS ck_listening_attempts_target_not_both;

-- AT MOST one of the three targets — never strict XOR (see header: the SET
-- NULL actions are UPDATEs and an XOR would abort a corpus reload). A fully
-- degraded row (all three NULL) stays a legal, display-only history entry.
ALTER TABLE listening_attempts
    ADD CONSTRAINT ck_listening_attempts_target_not_both
        CHECK (num_nonnulls(lesson_id, episode_id, track_id) <= 1);

-- -----------------------------------------------------------------------------
-- 3. Refresh the comments 077 changes the meaning of.
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN listening_attempts.source_kind IS
    'Which soft-FK column is populated for this row: ''ttmik_lesson'' '
    '(ttmik_lessons.id), ''iyagi_episode'' (iyagi_episodes.id), or '
    '''audio_track'' (audio_tracks.id — 077). Exactly one of '
    'lesson_id/episode_id/track_id is non-null at INSERT time '
    '(route-enforced — see ck_listening_attempts_target_not_both''s comment '
    'for why the DB only rejects MORE than one being set, not fewer); any '
    'may independently go NULL later if its source row is pruned by a '
    'corpus reload — the row survives on title_snapshot (degraded, but '
    'still a valid history entry).';
COMMENT ON TABLE listening_attempts IS
    'Append-only log of completed listening actions (F-172 + Track A): one '
    'row per "finished this TTMIK lesson" / "finished this Iyagi episode" / '
    '"finished this audio track" event, keyed by source_kind '
    '(ttmik_lesson|iyagi_episode|audio_track) with a soft, SET-NULL FK to '
    'whichever target was completed. title_snapshot (server-derived at '
    'completion time) keeps history readable after a corpus reload prunes '
    'the source row. Feeds the Today/streak "did the user listen today" '
    'surface. CASCADEs away with the user; never UPDATEd post-insert.';

-- End of 077_listening_source_kind_audio_track.up.sql — runner owns the transaction (ADR-013).
