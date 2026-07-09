-- =============================================================================
-- Migration 044 — reading_chapters + reading_passages (U3b, digitized reader)
--   UP — adds the two-level literature content store the digitized chapter
--        reader consumes: `reading_chapters` (one row per chapter of an
--        uploaded literature book) and `reading_passages` (one row per
--        paragraph/passage within a chapter, the tap-to-define unit). Also adds
--        a UNIQUE(id, user_id) on book_uploads to back the composite FK below.
--   Reverse: 044_reading_chapters.down.sql
--   Depends on: 040_book_uploads (book_uploads + its user_id FK), 001 (users,
--               set_updated_at()).
--
-- WHY: U1 stores an uploaded book as ordered page IMAGES (book_pages); U2 tags
-- vocab/grammar extracted from a book. U3b adds the LITERATURE consumption
-- surface — the OCR'd + curated running text of a literature book, structured
-- for a chapter reader with tap-to-define. See db/docs/U3_READER_DESIGN.md §U3b
-- and db/docs/PDF_UPLOAD_DESIGN.md §U3.
--
-- SHAPE (Jared's call, 2026-07-08): per-PARAGRAPH rows, not one body-blob per
-- chapter. A chapter has an ordered list of passages; each passage carries its
-- own text. This enables per-passage read/progress state and graded-passage
-- reuse later. Tap-to-define still tokenizes each passage body CLIENT-side on
-- the fly (client/src/lib/tapChain.ts), so nothing here is pre-tokenized.
--
-- DESIGN NOTES
--   * reading_chapters.source_upload_id is NOT NULL — a literature chapter only
--     ever exists as the digitized text of a specific uploaded book (unlike
--     vocab_entries.source_upload_id, which is nullable because most vocab is
--     curated-corpus, not book-sourced). Deleting the book deletes its chapters
--     (ON DELETE CASCADE) — the chapter text is re-derivable by re-uploading +
--     re-running the loader, and is meaningless once its source book is gone.
--   * user_id is denormalized onto reading_chapters (query-scoping convenience,
--     matching image_captures / vocab_cards / every other user-owned content
--     table) BUT its correctness is guaranteed at the DB level, not by
--     convention: the composite FK (source_upload_id, user_id) ->
--     book_uploads(id, user_id) makes it structurally impossible to tag a
--     chapter with a user_id that isn't the owner of its source upload. That
--     composite FK needs a UNIQUE(id, user_id) on book_uploads to reference —
--     added below; since `id` is already the PK, that UNIQUE never rejects a
--     real row, it only enables the reference. The CASCADE also rides this
--     composite FK, so a deleted upload cascades its chapters (and, through
--     reading_chapters, their passages).
--   * UNIQUE (source_upload_id, chapter_number): one chapter per display
--     position per book. The loader upserts by this key (idempotent re-load
--     replaces a book's chapters — test-then-keep). Its backing index also
--     serves "list chapters of upload U ORDER BY chapter_number".
--   * reading_passages.body is the curated passage text (newline-preserving);
--     length-bounded (1 .. 20000 chars) so a malformed load can't store an
--     unbounded blob. UNIQUE (chapter_id, passage_number) mirrors the chapter
--     key; the loader upserts a chapter's passages by it.
--   * page_number (nullable) links a passage back to the scan page it sits on,
--     so the reader's "view original scan" affordance can jump the image-page
--     viewer to the right page. Nullable because a curator may not always
--     record it. It is NOT FK'd to book_pages(page_number): book_pages is keyed
--     (upload_id, page_number) and page_number is MUTABLE (reorder tool), so a
--     hard FK would fight the reorder path — it is an advisory pointer, matching
--     how kgiu_entries.source_pages records page hints as plain data.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Back the composite FK: UNIQUE (id, user_id) on book_uploads.
--    `id` is already the PK (so this is never violated), but a composite FK
--    must reference a UNIQUE/PK column set exactly — this makes (id, user_id)
--    referenceable so reading_chapters can pin its denormalized user_id to the
--    upload's true owner.
--
--    Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so this is guarded the
--    same way 002_darakwon_corpora.up.sql guards its own cross-table
--    `ADD CONSTRAINT fk_vocab_cards_vocab_entry` (a `pg_constraint` existence
--    check inside `DO $$ ... $$`) — a manual re-apply of this file against a
--    DB where it already succeeded must not error.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'uq_book_uploads_id_user') THEN
        ALTER TABLE book_uploads
            ADD CONSTRAINT uq_book_uploads_id_user UNIQUE (id, user_id);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. reading_chapters — one row per chapter of an uploaded literature book.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reading_chapters (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_upload_id   BIGINT      NOT NULL,
    -- Denormalized owner — kept provably consistent with the upload's owner by
    -- the composite FK below (never set independently).
    user_id            BIGINT      NOT NULL,
    -- Display order within the book, 1-based.
    chapter_number     INTEGER     NOT NULL,
    -- Chapter title, if the book titles its chapters (many literature books do);
    -- NULL for books with unnamed/numbered-only chapters.
    title              TEXT,
    -- Optional page span into the source scan (book_pages.page_number), so the
    -- reader can open the image-page viewer at this chapter's first page.
    start_page         INTEGER,
    end_page           INTEGER,

    -- Audit columns (migrations README "Conventions")
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INTEGER     NOT NULL DEFAULT 1,

    -- Composite FK: pins (source_upload_id, user_id) to a real book_uploads
    -- (id, user_id) pair, so user_id ALWAYS equals the upload's owner and a
    -- deleted upload cascades its chapters.
    CONSTRAINT fk_reading_chapters_upload_owner
        FOREIGN KEY (source_upload_id, user_id)
        REFERENCES book_uploads(id, user_id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_reading_chapters_upload_number
        UNIQUE (source_upload_id, chapter_number),
    CONSTRAINT ck_reading_chapters_number_positive
        CHECK (chapter_number > 0),
    CONSTRAINT ck_reading_chapters_title_len
        CHECK (title IS NULL OR length(title) BETWEEN 1 AND 500),
    CONSTRAINT ck_reading_chapters_start_page_positive
        CHECK (start_page IS NULL OR start_page > 0),
    CONSTRAINT ck_reading_chapters_end_page_positive
        CHECK (end_page IS NULL OR end_page > 0),
    -- If both page bounds are set, the span must be well-formed.
    CONSTRAINT ck_reading_chapters_page_span
        CHECK (start_page IS NULL OR end_page IS NULL OR end_page >= start_page),
    CONSTRAINT ck_reading_chapters_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE reading_chapters IS
    'One row per chapter of an uploaded LITERATURE book (U3b, digitized chapter '
    'reader). Chapters are the OCR''d + curated running text of a book_uploads '
    'row of type ''literature'', loaded via tools/ingest (load_literature.py). '
    'source_upload_id is NOT NULL and CASCADEs — a chapter has no meaning apart '
    'from its source book and is re-derivable by re-uploading. user_id is '
    'denormalized but pinned to the upload''s owner by the composite FK to '
    'book_uploads(id, user_id). A chapter''s text lives in its reading_passages '
    'rows (per-paragraph), tokenized for tap-to-define client-side at read time.';
COMMENT ON COLUMN reading_chapters.chapter_number IS
    'Display position within the book, 1-based. UNIQUE per source_upload_id; the '
    'loader upserts chapters by (source_upload_id, chapter_number).';
COMMENT ON COLUMN reading_chapters.user_id IS
    'Denormalized owner (= book_uploads.user_id for source_upload_id). Kept '
    'consistent by the composite FK, NOT set independently — the reader routes '
    'scope by it directly instead of joining book_uploads on every read.';
COMMENT ON COLUMN reading_chapters.start_page IS
    'First page (book_pages.page_number) of this chapter in the source scan, or '
    'NULL. Advisory pointer for the reader''s "view original scan" jump — NOT '
    'FK''d, because book_pages.page_number is mutable (reorder tool).';
COMMENT ON COLUMN reading_chapters.end_page IS
    'Last page (book_pages.page_number) of this chapter in the source scan, or '
    'NULL. Same advisory-pointer posture as start_page — NOT FK''d, because '
    'book_pages.page_number is mutable (reorder tool).';
COMMENT ON COLUMN reading_chapters.source_upload_id IS
    'The literature book_uploads row this chapter was OCR''d + curated from. '
    'NOT NULL and CASCADEs (unlike vocab_entries.source_upload_id, which is '
    'nullable because most vocab is curated-corpus, not book-sourced) — a '
    'chapter has no meaning apart from its source book. Also the left half of '
    'the composite FK to book_uploads(id, user_id) that pins user_id to the '
    'upload''s true owner.';
COMMENT ON CONSTRAINT fk_reading_chapters_upload_owner ON reading_chapters IS
    'Pins (source_upload_id, user_id) to a real book_uploads(id, user_id) row, '
    'so user_id can never drift from the upload''s true owner. Does NOT '
    'constrain book_uploads.type — nothing here stops a chapter from '
    'referencing a non-''literature'' upload; that invariant is enforced by '
    'construction in the loader (tools/ingest/load_literature.py only ever '
    'loads chapters for uploads it processed as literature) and the '
    '/reading routes, not by this FK.';

CREATE OR REPLACE TRIGGER trg_reading_chapters_updated_at
    BEFORE UPDATE ON reading_chapters
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. reading_passages — one row per paragraph/passage within a chapter, in
--    reading order. The tap-to-define unit.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reading_passages (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chapter_id       BIGINT      NOT NULL,
    -- Display order within the chapter, 1-based.
    passage_number   INTEGER     NOT NULL,
    -- The curated passage text (newline-preserving). Tokenized client-side for
    -- tap-to-define at read time — stored as plain text, not pre-tokenized.
    body             TEXT        NOT NULL,
    -- Optional source-scan page this passage sits on (advisory; see the chapter
    -- start_page note — not FK'd for the same reason).
    page_number      INTEGER,

    -- Audit columns
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    version          INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_reading_passages_chapter
        FOREIGN KEY (chapter_id) REFERENCES reading_chapters(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_reading_passages_chapter_number
        UNIQUE (chapter_id, passage_number),
    CONSTRAINT ck_reading_passages_number_positive
        CHECK (passage_number > 0),
    CONSTRAINT ck_reading_passages_body_len
        CHECK (length(body) BETWEEN 1 AND 20000),
    CONSTRAINT ck_reading_passages_page_number_positive
        CHECK (page_number IS NULL OR page_number > 0),
    CONSTRAINT ck_reading_passages_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE reading_passages IS
    'One row per paragraph/passage within a reading_chapters chapter (U3b), in '
    'reading order. The tap-to-define unit: body is curated running text, '
    'tokenized client-side (tapChain.ts) at read time. CASCADEs from its '
    'chapter (and thus from the source book upload). The loader upserts a '
    'chapter''s passages by (chapter_id, passage_number).';
COMMENT ON COLUMN reading_passages.body IS
    'Curated passage text, newline-preserving, 1..20000 chars. Stored as plain '
    'text — tokenization into tappable words happens client-side at read time, '
    'so nothing here is pre-tokenized or language-analyzed.';
COMMENT ON COLUMN reading_passages.page_number IS
    'Source-scan page (book_pages.page_number) this passage sits on, or NULL '
    '(a curator may not always record it). Advisory pointer, NOT FK''d — same '
    'reason as reading_chapters.start_page/end_page: book_pages.page_number is '
    'mutable (reorder tool), so a hard FK would fight that path.';

CREATE OR REPLACE TRIGGER trg_reading_passages_updated_at
    BEFORE UPDATE ON reading_passages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 044_reading_chapters.up.sql — runner owns the transaction (ADR-013).
