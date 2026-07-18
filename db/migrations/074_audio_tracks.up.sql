-- migrate: non-destructive
-- =============================================================================
-- Migration 074 — audio_tracks (Track A, audio → Listen, A-1 schema)
--   UP — adds `audio_tracks`: one row per audio FILE (mp3/m4a) within an
--        audio_sources set (073) — the book_pages analog for the Listen
--        surface. Holds the blob pointer the streaming route serves, the
--        per-track transcript lifecycle, and the optional chapter-level
--        alignment link into the paired reader. See
--        docs/TRACK_A_AUDIO_PLAN.md §2. Also adds a UNIQUE(id, user_id) on
--        reading_chapters (§0 below) to back the composite chapter FK.
--   Reverse: 074_audio_tracks.down.sql
--   Depends on: 073_audio_sources (audio_sources — the parent set — and its
--               uq_audio_sources_id_user, which the composite source FK
--               rides), 044_reading_chapters (reading_chapters — the
--               alignment target), 001_core_schema (users, set_updated_at()).
--
-- DESIGN NOTES
--   * blob_ref is a RELATIVE path under AUDIO_UPLOAD_STORAGE_DIR, built
--     server/loader-side as `{userId}/{uuid}.{mp3|m4a}` — never a client
--     string, never absolute. IDENTICAL contract to book_pages.blob_ref
--     (041) / image_captures.blob_path (017): the store root joins +
--     traversal-checks it, rows stay portable if the root moves.
--   * source_id CASCADEs: a track has no meaning apart from its set —
--     deleting the set deletes its track ROWS (the route/loader unlinks the
--     blob FILES after the transaction commits, same non-transactional
--     file-cleanup posture as 041's book_pages note).
--   * user_id is DENORMALIZED (always equals the parent set's user_id) so
--     the hot-path streaming query is a single WHERE id = $1 AND
--     user_id = $2 probe with no join. Because that probe joins NOTHING,
--     its correctness must be STRUCTURAL, not conventional: the composite
--     (source_id, user_id) -> audio_sources(id, user_id) FK (riding 073's
--     uq_audio_sources_id_user — 044 §0's maneuver) makes a drifted user_id
--     impossible to write, so a bugged or bypassed loader can never mint an
--     IDOR row the streaming route would serve. source_id is NOT NULL +
--     CASCADE, so the plain 044 composite form works directly — no PG15
--     column-list action needed on this FK.
--   * chapter_id is the chapter-level alignment link for paired-reader sets
--     (this track IS the audio of that reading_chapters chapter). SOFT —
--     column-list ON DELETE SET NULL (chapter_id), never CASCADE/RESTRICT:
--     reading_chapters is loader-populated and a corpus/book re-load may
--     prune + replace chapter rows; that reload must neither be RESTRICTed
--     nor CASCADE-erase the (expensive, Whisper-transcribed) track. Same
--     carve-out reasoning as 061's lesson/episode FKs — the alignment
--     degrades to NULL and can be re-established by the alignment pass. The
--     FK is COMPOSITE (chapter_id, user_id) -> reading_chapters(id, user_id)
--     because reading_chapters is USER-OWNED (unlike 061's public corpus
--     tables): a track can only ever align to its OWN user's chapter. The
--     column-list form (PG 15+, 051's exact mechanism) nulls ONLY chapter_id
--     on chapter deletion, leaving the NOT NULL user_id untouched; the
--     backing UNIQUE(id, user_id) on reading_chapters is added in §0 below
--     (044 gave reading_chapters no such pair — 051 §0 added (id,
--     source_upload_id) for its own composite; this is the ownership analog).
--   * fk_audio_tracks_user (direct users FK) is kept alongside the composite
--     source FK — belt-and-braces, 051's stated rationale: a user deletion
--     removes their tracks even if a set row somehow outlived them. No
--     dedicated user_id index backs its referencing scan: the composite
--     source CASCADE (indexed via uq_audio_tracks_source_number's source_id
--     prefix) empties this table first when a user is deleted, and no query
--     filters by user_id alone (the streaming probe rides the PK).
--   * transcript_status is the PER-TRACK Whisper lifecycle the Listen UI
--     reads ('pending' -> 'running' -> 'done' | 'failed'). TEXT + CHECK per
--     the README discriminator convention (061 precedent). The job LEDGER
--     for the A1 in-app worker lives in audio_transcription_jobs (076) —
--     this column is the track's own displayable summary of it (the A2
--     offline loader writes it directly, no job row involved).
--   * UNIQUE (source_id, track_number): one display position per track per
--     set — also the backing index for "list a set's tracks in order" and
--     the loader's per-set upsert key (mirrors 041's
--     uq_book_pages_upload_number; no separate CREATE INDEX, it would
--     duplicate this one).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Back the chapter owner-guard composite FK: UNIQUE (id, user_id) on
--    reading_chapters. `id` is already the PK (this never rejects a real
--    row) — it only makes the pair referenceable, exactly like 044 §0's
--    uq_book_uploads_id_user and 051 §0's uq_reading_chapters_id_upload.
--    Guarded through pg_constraint inside DO $$ (Postgres has no
--    ADD CONSTRAINT IF NOT EXISTS) so a manual re-apply of this file against
--    a DB where it already succeeded must not error; scoped by conrelid so a
--    same-named constraint on another table can't mask a missing one here.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'uq_reading_chapters_id_user'
                     AND conrelid = 'reading_chapters'::regclass) THEN
        ALTER TABLE reading_chapters
            ADD CONSTRAINT uq_reading_chapters_id_user UNIQUE (id, user_id);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. audio_tracks — one row per audio file of a set.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audio_tracks (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id          BIGINT      NOT NULL,
    -- Denormalized owner (= the parent set's user_id — written from the
    -- ownership-checked audio_sources row in the same transaction, 069's
    -- pattern). Exists so the streaming route's WHERE id = $1 AND
    -- user_id = $2 probe needs no join.
    user_id            BIGINT      NOT NULL,

    -- Display/play order within the set, 1-based.
    track_number       INTEGER     NOT NULL,
    -- Display title, if the source file/manifest names the track; NULL for
    -- number-only tracks.
    title              TEXT,

    -- RELATIVE path under AUDIO_UPLOAD_STORAGE_DIR (e.g. "7/<uuid>.mp3").
    -- NEVER absolute, NEVER built from client input — same contract as
    -- book_pages.blob_ref (041).
    blob_ref           TEXT        NOT NULL,
    -- Playback length in milliseconds; NULL until something reads it off the
    -- file (informational — the <audio> element learns the real duration
    -- itself).
    duration_ms        INTEGER,
    byte_size          BIGINT      NOT NULL,

    -- Per-track Whisper lifecycle the Listen UI reads:
    -- 'pending' -> 'running' -> 'done' | 'failed'.
    transcript_status  TEXT        NOT NULL DEFAULT 'pending',

    -- Chapter-level alignment: the reading_chapters chapter this track is
    -- the audio of (paired-reader sets only). SOFT — see header.
    chapter_id         BIGINT,

    -- Audit columns (ADR-001 D6)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INTEGER     NOT NULL DEFAULT 1,

    -- OWNER GUARD (044's plain composite form — source_id is NOT NULL, so no
    -- column-list action is needed): (source_id, user_id) must be a real
    -- audio_sources(id, user_id) pair, riding 073's uq_audio_sources_id_user.
    -- A drifted user_id — the no-join streaming probe's IDOR primitive — is
    -- structurally impossible; deleting the set CASCADEs its tracks.
    CONSTRAINT fk_audio_tracks_source
        FOREIGN KEY (source_id, user_id) REFERENCES audio_sources(id, user_id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Belt-and-braces direct user FK (051's rationale) — see header.
    CONSTRAINT fk_audio_tracks_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Column-list SET NULL (chapter_id), NOT CASCADE/RESTRICT: a chapter
    -- re-load must neither be blocked nor erase the transcribed track (061's
    -- carve-out reasoning). Composite because reading_chapters is USER-OWNED:
    -- the pair pins alignment to the caller's OWN chapter (riding §0's
    -- uq_reading_chapters_id_user); the PG 15+ column-list form (051's exact
    -- mechanism) nulls ONLY chapter_id, never the NOT NULL user_id.
    CONSTRAINT fk_audio_tracks_chapter
        FOREIGN KEY (chapter_id, user_id) REFERENCES reading_chapters(id, user_id)
        ON DELETE SET NULL (chapter_id) ON UPDATE RESTRICT,
    -- One display position per track per set; backing index also serves the
    -- ordered track listing + the loader's upsert (mirrors 041).
    CONSTRAINT uq_audio_tracks_source_number UNIQUE (source_id, track_number),
    CONSTRAINT ck_audio_tracks_track_number_positive
        CHECK (track_number > 0),
    CONSTRAINT ck_audio_tracks_title_length
        CHECK (title IS NULL OR length(title) BETWEEN 1 AND 500),
    CONSTRAINT ck_audio_tracks_blob_ref_nonempty
        CHECK (length(blob_ref) BETWEEN 1 AND 1024),
    CONSTRAINT ck_audio_tracks_duration_nonnegative
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
    -- Strictly positive (matches 040's book_uploads.byte_size stance): a
    -- 0-byte audio file is never a valid upload.
    CONSTRAINT ck_audio_tracks_byte_size_positive
        CHECK (byte_size > 0),
    CONSTRAINT ck_audio_tracks_transcript_status
        CHECK (transcript_status IN ('pending', 'running', 'done', 'failed')),
    CONSTRAINT ck_audio_tracks_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE audio_tracks IS
    'One row per audio file of an audio_sources set (Track A — the '
    'book_pages analog): blob pointer under AUDIO_UPLOAD_STORAGE_DIR, '
    'display order, per-track Whisper transcript lifecycle, and an optional '
    'soft chapter-alignment link into the paired reader. CASCADEs from its '
    'set (blob FILES are unlinked by the route/loader after the delete '
    'commits — file deletion is not transactional, 041''s posture) and with '
    'its user; survives a reading-chapter re-load (chapter_id SET NULL). '
    'Transcript text lives in audio_transcript_segments (075).';
COMMENT ON COLUMN audio_tracks.user_id IS
    'Denormalized owner (always = the parent audio_sources.user_id — pinned '
    'STRUCTURALLY by the composite fk_audio_tracks_source to '
    'audio_sources(id, user_id), 044''s maneuver). Lets the streaming route '
    'probe WHERE id = $1 AND user_id = $2 with no join, with drift made '
    'impossible rather than merely route-enforced.';
COMMENT ON COLUMN audio_tracks.track_number IS
    'Display/play position within the set, 1-based. UNIQUE per source_id; '
    'the loader upserts a set''s tracks by (source_id, track_number).';
COMMENT ON COLUMN audio_tracks.blob_ref IS
    'RELATIVE path under AUDIO_UPLOAD_STORAGE_DIR (e.g. "7/<uuid>.mp3"), '
    'NEVER absolute and NEVER built from client input — identical contract '
    'to book_pages.blob_ref (041): the audio store joins it to the root and '
    'asserts the resolved path stays inside it.';
COMMENT ON COLUMN audio_tracks.duration_ms IS
    'Playback length in milliseconds, or NULL until read off the file. '
    'Informational (the player reads real duration from the stream); >= 0 '
    'when present.';
COMMENT ON COLUMN audio_tracks.transcript_status IS
    'Per-track Whisper lifecycle: ''pending'' -> ''running'' -> ''done'' | '
    '''failed''. The Listen UI''s displayable summary; the A1 worker''s '
    'claim/settle ledger is audio_transcription_jobs (076), while the A2 '
    'offline loader sets this directly.';
COMMENT ON COLUMN audio_tracks.chapter_id IS
    'The reading_chapters chapter this track is the audio of (paired-reader '
    'alignment), or NULL — standalone tracks, unaligned tracks, and tracks '
    'whose chapter was pruned by a book re-load (ON DELETE SET NULL). Soft '
    'by design: see fk_audio_tracks_chapter.';
COMMENT ON CONSTRAINT fk_audio_tracks_chapter ON audio_tracks IS
    'Soft composite FK, column-list ON DELETE SET NULL (chapter_id) — 061''s '
    'corpus-reload carve-out on the action, 044''s owner guard on the pair: '
    'reading_chapters rows are loader-populated and may be pruned/replaced '
    'by a book re-load — that reload must neither be RESTRICTed nor '
    'CASCADE-erase a Whisper-transcribed track (only chapter_id is nulled; '
    'the alignment degrades and can be re-established by the alignment '
    'pass). The (chapter_id, user_id) pair makes cross-user alignment '
    'structurally impossible.';

-- The reverse alignment lookup: "which track is the audio of chapter C?"
-- (the Read surface's play-this-chapter affordance). Partial — most tracks
-- are standalone/unaligned, so NULL rows stay out of the index (mirrors
-- ix_vocab_entries_source_upload's shape, 040).
CREATE INDEX IF NOT EXISTS ix_audio_tracks_chapter
    ON audio_tracks (chapter_id)
    WHERE chapter_id IS NOT NULL;
COMMENT ON INDEX ix_audio_tracks_chapter IS
    'Partial (aligned tracks only). Supports the Read surface''s '
    '"play this chapter''s audio" reverse lookup — chapter_id -> track. '
    'Per-user listing rides uq_audio_tracks_source_number via the set; the '
    'streaming probe rides the PK.';

CREATE OR REPLACE TRIGGER trg_audio_tracks_updated_at
    BEFORE UPDATE ON audio_tracks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 074_audio_tracks.up.sql — runner owns the transaction (ADR-013).
