-- migrate: non-destructive
-- =============================================================================
-- Migration 075 — audio_transcript_segments (Track A, audio → Listen, A-1)
--   UP — adds `audio_transcript_segments`: the Whisper transcription of an
--        audio_tracks row (074), one row per TIMED SEGMENT (Whisper's native
--        output unit — a few seconds of speech with start/end timestamps).
--        See docs/TRACK_A_AUDIO_PLAN.md §2.
--   Reverse: 075_audio_transcript_segments.down.sql
--   Depends on: 074_audio_tracks (audio_tracks — the parent),
--               001_core_schema (set_updated_at()).
--
-- WHY TIMED SEGMENTS, NOT ONE TRANSCRIPT BLOB PER TRACK
--   The Listen UI highlights the CURRENT line as audio plays — that needs
--   per-segment [start_ms, end_ms] windows the client can binary-search
--   against the <audio> currentTime. Segments are also the alignment unit
--   for paired readers (passages ↔ segments line up by time), and per-row
--   bounds (body 1..5000) mean a malformed Whisper run can't store an
--   unbounded blob. This mirrors 044's per-passage (not per-chapter-blob)
--   call for the reading text, and 036's per-line ttmik_transcript_lines.
--
-- DESIGN NOTES
--   * track_id CASCADEs: a transcript has no meaning apart from its track,
--     and is re-derivable by re-running Whisper — same posture as
--     reading_chapters' CASCADE from its book (044). No user_id here: a
--     segment is always reached THROUGH its track, whose denormalized
--     user_id already scopes the query (mirrors book_pages/reading_passages,
--     which also carry no owner column).
--   * start_ms/end_ms are INTEGER milliseconds into the track. end_ms >=
--     start_ms (Whisper can emit zero-length segments for noise — an equal
--     pair is legal; a NEGATIVE-length one is not). Overlap/ordering across
--     segments is NOT constrained — Whisper's windows legitimately overlap
--     at boundaries; segment_number is the display order.
--   * UNIQUE (track_id, segment_number): one row per position — the loader's
--     per-track upsert key, and its backing index IS the ordered segment
--     fetch ("the transcript of track T, in order"), so no separate CREATE
--     INDEX (it would duplicate that index — 041's note).
--   * Audit columns present per ADR-001 §D6 even though the loader
--     replace-loads rather than editing rows in place (schema consistency —
--     same stance as the append-only attempt logs, 060/061).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audio_transcript_segments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    track_id        BIGINT      NOT NULL,

    -- Display/temporal order within the track, 1-based.
    segment_number  INTEGER     NOT NULL,

    -- Segment window, milliseconds into the track. Equal start/end is legal
    -- (Whisper emits zero-length segments); negative length is not.
    start_ms        INTEGER     NOT NULL,
    end_ms          INTEGER     NOT NULL,

    -- The transcribed text of this segment (Whisper output, post any loader
    -- normalization). Bounded so a malformed run can't store a blob.
    body            TEXT        NOT NULL,

    -- Audit columns (ADR-001 D6)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_audio_transcript_segments_track
        FOREIGN KEY (track_id) REFERENCES audio_tracks(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- One row per position; backing index also serves the ordered transcript
    -- fetch + the loader's upsert (no separate index needed — 041's note).
    CONSTRAINT uq_audio_transcript_segments_track_number
        UNIQUE (track_id, segment_number),
    CONSTRAINT ck_audio_transcript_segments_number_positive
        CHECK (segment_number > 0),
    CONSTRAINT ck_audio_transcript_segments_start_nonnegative
        CHECK (start_ms >= 0),
    CONSTRAINT ck_audio_transcript_segments_range_ordered
        CHECK (end_ms >= start_ms),
    CONSTRAINT ck_audio_transcript_segments_body_length
        CHECK (length(body) BETWEEN 1 AND 5000),
    CONSTRAINT ck_audio_transcript_segments_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE audio_transcript_segments IS
    'Whisper transcript of an audio_tracks row, one row per timed segment '
    '(Track A). [start_ms, end_ms] windows drive the Listen UI''s '
    'play-position line highlight and the paired-reader passage<->segment '
    'time alignment. CASCADEs from its track (re-derivable by re-running '
    'Whisper); the loader replace-loads a track''s segments keyed on '
    '(track_id, segment_number). No user_id — always reached through the '
    'track, whose denormalized owner scopes the query.';
COMMENT ON COLUMN audio_transcript_segments.segment_number IS
    'Display/temporal position within the track, 1-based. UNIQUE per '
    'track_id; the loader upserts by (track_id, segment_number).';
COMMENT ON COLUMN audio_transcript_segments.start_ms IS
    'Segment window start, milliseconds into the track (>= 0). The client '
    'binary-searches these against the <audio> currentTime for the line '
    'highlight.';
COMMENT ON COLUMN audio_transcript_segments.end_ms IS
    'Segment window end, milliseconds into the track. >= start_ms (equal = '
    'zero-length segment, legal Whisper output). Cross-segment '
    'overlap/ordering is deliberately unconstrained — Whisper windows '
    'overlap at boundaries; segment_number carries the order.';
COMMENT ON COLUMN audio_transcript_segments.body IS
    'Transcribed segment text (Whisper output, 1..5000 chars). Plain text — '
    'tap-to-define tokenizes client-side at read time, nothing is '
    'pre-tokenized (044''s stance for reading_passages.body).';

CREATE OR REPLACE TRIGGER trg_audio_transcript_segments_updated_at
    BEFORE UPDATE ON audio_transcript_segments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 075_audio_transcript_segments.up.sql — runner owns the transaction (ADR-013).
