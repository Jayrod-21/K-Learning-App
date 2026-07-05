-- 036 (up): ttmik_transcript_lines — FULL lesson-notes transcript for TTMIK.
--
-- Feature: ttmik_sentences holds only each lesson's HIGHLIGHTS (key phrases /
-- vocab pairs extracted by parse_ttmik.py). The complete lesson notes live in
-- the three "Lesson Scripts" PDFs (Levels 1-3 / 4-6 / 7-9, 232 lessons total).
-- This table stores that full text, one row per rendered transcript line, in
-- reading order. Loaded by tools/ingest/loaders/load_ttmik_transcript.py;
-- served by GET /ttmik/lessons/:level/:number as `transcript` alongside the
-- existing highlights. (Personal-use licensed corpus, private single-user app.)
--
-- LINE MODEL — `kind` says how the client renders the row:
--   'header'       section heading inside a lesson ("Sample Conversation").
--   'pair'         "<korean> = <english>" expression/translation line. The
--                  left side is stored VERBATIM (inline [romanization] and
--                  formation text like "안녕+하세요" included) — lossless.
--   'romanization' standalone bracketed line ("[an-nyeong] [ha-se-yo]")
--                  annotating the preceding line.
--   'prose'        explanation paragraph (page-wrap lines re-joined).
--   'dialog'       "A: <korean> = <english>" sample-conversation line; the
--                  speaker prefix stays in the korean text verbatim.
--
-- COLUMN CONTRACT (enforced by loader, documented for the client):
--   * 'pair' / 'dialog': korean = text left of the first " = " separator,
--     english = text right of it.
--   * single-text kinds ('header' / 'romanization' / 'prose'): the verbatim
--     line goes in `korean` when it contains Hangul, else in `english`; the
--     other column is NULL. Clients can simply render `korean ?? english`
--     for these kinds. ck_ttmik_transcript_lines_has_text guarantees at
--     least one side is present.
--
-- IDEMPOTENCY: the loader replaces a lesson's transcript atomically
-- (DELETE by lesson_id + INSERT in one transaction), so there is no
-- content-hash natural key here — (lesson_id, ordinal) is the identity.
--
-- INDEXING: uq_ttmik_transcript_lines_lesson_ordinal is a composite UNIQUE
-- on (lesson_id, ordinal); its backing index left-prefixes on lesson_id AND
-- matches the only read pattern (WHERE lesson_id = $1 ORDER BY ordinal), so
-- a separate bare index on lesson_id would be pure write overhead — the FK
-- is indexed via the unique constraint (Bar §4.4: no over-indexing).
--
-- TRANSACTION OWNERSHIP (ADR-013): no BEGIN/COMMIT here — migrate.py wraps
-- this file and the schema_migrations bookkeeping in one transaction.

CREATE TABLE IF NOT EXISTS ttmik_transcript_lines (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    lesson_id   BIGINT       NOT NULL,
    ordinal     INTEGER      NOT NULL,

    korean      TEXT,
    english     TEXT,
    kind        TEXT         NOT NULL,

    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version     INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_ttmik_transcript_lines_lesson
        FOREIGN KEY (lesson_id) REFERENCES ttmik_lessons(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    -- Identity of a line within its lesson; backing index also serves every
    -- transcript read (lesson_id prefix + ordinal order).
    CONSTRAINT uq_ttmik_transcript_lines_lesson_ordinal
        UNIQUE (lesson_id, ordinal),

    -- Closed kind vocabulary — CHECK-constrained TEXT over a native enum so a
    -- future kind is one migration, not an un-droppable enum member (Bar §4.1).
    CONSTRAINT ck_ttmik_transcript_lines_kind
        CHECK (kind IN ('header', 'pair', 'romanization', 'prose', 'dialog')),

    CONSTRAINT ck_ttmik_transcript_lines_ordinal_pos
        CHECK (ordinal >= 1),

    -- A line with no text on either side is a loader bug — refuse it.
    CONSTRAINT ck_ttmik_transcript_lines_has_text
        CHECK (korean IS NOT NULL OR english IS NOT NULL)
);

COMMENT ON TABLE ttmik_transcript_lines IS
    'Full TTMIK lesson-notes transcript, one row per rendered line in reading '
    'order. Source: the three Lesson Scripts PDFs, parsed by '
    'tools/ingest/loaders/load_ttmik_transcript.py. ttmik_sentences remains '
    'the curated highlights set.';
COMMENT ON COLUMN ttmik_transcript_lines.ordinal IS
    '1-based position within the lesson; contiguous per load. Identity of the '
    'line together with lesson_id (the loader replaces a lesson wholesale).';
COMMENT ON COLUMN ttmik_transcript_lines.korean IS
    'Left side of a pair/dialog line, or the whole line for single-text kinds '
    'when it contains Hangul. NULL only when english carries the text.';
COMMENT ON COLUMN ttmik_transcript_lines.english IS
    'Right side of a pair/dialog line, or the whole line for single-text '
    'kinds without Hangul (e.g. romanization, English prose).';
COMMENT ON COLUMN ttmik_transcript_lines.kind IS
    'Render hint: header | pair | romanization | prose | dialog. '
    'CHECK-constrained TEXT (not a native enum) so the vocabulary can evolve.';

-- updated_at trigger (ADR-001 D6). Rows are replace-on-load in practice, but
-- any manual UPDATE must still maintain the audit column.
CREATE OR REPLACE TRIGGER trg_ttmik_transcript_lines_updated_at
    BEFORE UPDATE ON ttmik_transcript_lines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
