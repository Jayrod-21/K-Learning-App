-- =============================================================================
-- Migration 040 — book_uploads (U1a, PDF book-upload feature, front door)
--   UP — adds `book_uploads` (user-owned scanned-PDF metadata + blob pointer)
--        and a nullable `source_upload_id` FK on the two corpus content tables
--        U2 extraction will populate (`vocab_entries`, `kgiu_entries`), so the
--        "sort by source" filter has somewhere to attach once curated content
--        lands. See db/docs/PDF_UPLOAD_DESIGN.md §"U1 -> U1a server".
--   Reverse: 040_book_uploads.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()), 002_darakwon_corpora
--     (vocab_entries, kgiu_entries).
--
-- DESIGN NOTES
--   * Blob storage mirrors `image_captures.blob_path` (migration 017) exactly:
--     `blob_ref` is a RELATIVE path under a configured store root
--     (BOOK_UPLOAD_STORAGE_DIR), built server-side as `{userId}/{uuid}.pdf` —
--     never a client string, never absolute. See server/src/services/
--     uploadStore.ts. Column named `blob_ref` (not `blob_path`) per the design
--     doc's own naming; same contract as `image_captures.blob_path` otherwise.
--   * `book_uploads` is HARD-deleted (no `deleted_at`). Unlike image_captures
--     (which is mining history worth preserving), a deleted book upload is a
--     user-initiated "remove this PDF" action with nothing that must survive
--     it — extracted content rows (added by U2) reference it via
--     `source_upload_id ON DELETE SET NULL`, so deleting the upload orphans
--     (does not delete) any content already pulled from it.
--   * UNIQUE (user_id, title): re-uploading the same title REPLACES the row
--     in place (idempotent "test-then-keep" iteration per the design doc) —
--     the route UPSERTs on this key rather than erroring on a duplicate title.
--   * `status` starts 'processing' and moves to 'ready'/'failed' by U2's
--     extraction pass; U1 never sets anything but 'processing' (no extractor
--     exists yet). `page_count` is NULL until U2 can read the PDF's page tree.
--   * `source_upload_id` lands on `vocab_entries` + `kgiu_entries` only in this
--     migration. No reading/dialogue table exists yet in this schema (grepped
--     — none), so that column is DEFERRED to whichever migration introduces
--     it (U2 scope). Both existing columns are nullable and stay NULL until
--     U2's loaders start populating them; U1's routes never write them.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum types (closed value sets — ADR-001 D8). DO blocks guard creation so
--    the migration is re-runnable; PG 16 has no CREATE TYPE IF NOT EXISTS for
--    enums (mirrors 001_core_schema's pattern).
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'book_upload_type') THEN
        CREATE TYPE book_upload_type AS ENUM ('vocab', 'grammar', 'both', 'dialogue', 'literature');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'book_upload_status') THEN
        CREATE TYPE book_upload_status AS ENUM ('processing', 'ready', 'failed');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. book_uploads — one row per uploaded PDF + its blob pointer
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS book_uploads (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT              NOT NULL,

    title           TEXT                NOT NULL,
    type            book_upload_type    NOT NULL,
    status          book_upload_status  NOT NULL DEFAULT 'processing',

    -- RELATIVE path under BOOK_UPLOAD_STORAGE_DIR (e.g. "7/<uuid>.pdf"). NEVER
    -- absolute, NEVER built from client input — see module note above.
    blob_ref        TEXT                NOT NULL,
    byte_size       INTEGER             NOT NULL,
    -- NULL until U2's extraction pass reads the PDF's page tree.
    page_count      INTEGER,

    -- Audit columns (ADR-001 D6)
    created_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
    version         INTEGER             NOT NULL DEFAULT 1,

    CONSTRAINT fk_book_uploads_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Idempotent re-upload: same (user, title) REPLACES via UPSERT rather than
    -- erroring — see module note.
    CONSTRAINT uq_book_uploads_user_title UNIQUE (user_id, title),
    CONSTRAINT ck_book_uploads_title_length
        CHECK (length(title) BETWEEN 1 AND 200),
    CONSTRAINT ck_book_uploads_blob_ref_nonempty
        CHECK (length(blob_ref) BETWEEN 1 AND 1024),
    CONSTRAINT ck_book_uploads_byte_size_positive
        CHECK (byte_size > 0),
    CONSTRAINT ck_book_uploads_page_count_positive
        CHECK (page_count IS NULL OR page_count > 0),
    CONSTRAINT ck_book_uploads_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE book_uploads IS
    'One row per user-uploaded scanned-book PDF (U1, PDF book-upload feature). '
    'Blob bytes live on the filesystem under BOOK_UPLOAD_STORAGE_DIR; this row '
    'holds the pointer + status. Hard-deleted (no history value once removed); '
    'U2 extraction tags content rows back to this id via source_upload_id '
    '(ON DELETE SET NULL, so removing the upload never deletes content already '
    'pulled from it).';
COMMENT ON COLUMN book_uploads.title IS
    'User-supplied display title. UNIQUE per user — re-uploading the same '
    'title REPLACES the row (idempotent test-then-keep iteration).';
COMMENT ON COLUMN book_uploads.type IS
    'What the book is expected to yield: vocab/grammar/both/dialogue/literature. '
    'Drives which U2 extraction playbook + downstream filter it appears under.';
COMMENT ON COLUMN book_uploads.status IS
    'processing (default, set by U1 upload) -> ready|failed (set by the U2 '
    'extraction pass, not implemented yet).';
COMMENT ON COLUMN book_uploads.blob_ref IS
    'RELATIVE path under BOOK_UPLOAD_STORAGE_DIR (e.g. "7/<uuid>.pdf"), NEVER '
    'absolute and NEVER built from client input. Mirrors '
    'image_captures.blob_path (migration 017) — see uploadStore.ts.';
COMMENT ON COLUMN book_uploads.byte_size IS
    'Stored PDF size in bytes; > 0. The route caps uploads at ~15 MB.';
COMMENT ON COLUMN book_uploads.page_count IS
    'PDF page count. NULL until U2 extraction reads it (not populated by U1).';

-- Query 1: "list a user's uploads, newest first" (GET /uploads).
CREATE INDEX IF NOT EXISTS ix_book_uploads_user_created
    ON book_uploads (user_id, created_at DESC);
COMMENT ON INDEX ix_book_uploads_user_created IS
    'Supports GET /uploads — a user''s uploads newest first.';

CREATE OR REPLACE TRIGGER trg_book_uploads_updated_at
    BEFORE UPDATE ON book_uploads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. source_upload_id — the source dimension U2 will populate.
--    Nullable, ON DELETE SET NULL: removing an upload never deletes content
--    already extracted from it, it just un-tags the source. NULL until U2
--    ships its loaders; U1 never writes this column.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_entries
    ADD COLUMN IF NOT EXISTS source_upload_id BIGINT
        REFERENCES book_uploads(id) ON DELETE SET NULL ON UPDATE RESTRICT;
COMMENT ON COLUMN vocab_entries.source_upload_id IS
    'FK -> book_uploads. NULL for all pre-existing corpus rows and for every '
    'row until U2 extraction tags it. ON DELETE SET NULL: deleting the source '
    'upload un-tags the entry rather than deleting it.';

CREATE INDEX IF NOT EXISTS ix_vocab_entries_source_upload
    ON vocab_entries (source_upload_id)
    WHERE source_upload_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_entries_source_upload IS
    'Partial index (most rows are NULL pre-U2). Supports the "sort/filter by '
    'source book" facet once U2 populates source_upload_id.';

ALTER TABLE kgiu_entries
    ADD COLUMN IF NOT EXISTS source_upload_id BIGINT
        REFERENCES book_uploads(id) ON DELETE SET NULL ON UPDATE RESTRICT;
COMMENT ON COLUMN kgiu_entries.source_upload_id IS
    'FK -> book_uploads. NULL for all pre-existing corpus rows and for every '
    'row until U2 extraction tags it. ON DELETE SET NULL: deleting the source '
    'upload un-tags the entry rather than deleting it.';

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_source_upload
    ON kgiu_entries (source_upload_id)
    WHERE source_upload_id IS NOT NULL;
COMMENT ON INDEX ix_kgiu_entries_source_upload IS
    'Partial index (most rows are NULL pre-U2). Supports the "sort/filter by '
    'source book" facet once U2 populates source_upload_id.';

-- No reading/dialogue table exists in this schema yet (checked every
-- migration's CREATE TABLE list) — deferred to whichever migration
-- introduces one (U2 scope), per the design doc.

-- End of 040_book_uploads.up.sql — runner owns the transaction (ADR-013).
