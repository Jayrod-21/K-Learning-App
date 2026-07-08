-- =============================================================================
-- Migration 041 — book_pages (U1a rework, ZIP/PDF → ordered page images)
--   UP — adds `book_pages` (one row per normalized page image of a book
--        upload) and drops `book_uploads.blob_ref` (the original zip/PDF is
--        no longer retained — only the derived per-page images are stored).
--        See db/docs/PDF_UPLOAD_DESIGN.md §"REVISION (2026-07-08)".
--   Reverse: 041_book_pages.down.sql
--   Depends on: 040_book_uploads (book_uploads, book_upload_type/status enums).
--
-- WHY: the real scans are the vFlat export — a ZIP of ~500 high-res JPG page
-- images (Jared's sample book: 548 pages, 240 MB), not a single <=15MB PDF as
-- 040 assumed. The upload route now accepts EITHER a zip-of-images or a PDF
-- and normalizes both to an ORDERED SEQUENCE OF PAGE IMAGES at ingest time —
-- the viewer fetches one page at a time (never the whole 240MB book), and OCR
-- (U2) reads page images directly. `page_number` is the DISPLAY order —
-- seeded from the source's filename/page order but MUTABLE (`PATCH
-- /uploads/:id/pages/order`, server/src/routes/uploads.ts), because vFlat
-- retakes can land out of order (Jared's sample has pages ~1-60 misordered).
--
-- DESIGN NOTES
--   * `blob_ref` is a RELATIVE path under BOOK_UPLOAD_STORAGE_DIR, built
--     server-side as `{userId}/{uuid}.{jpg|png}` (never client input) — same
--     contract book_uploads.blob_ref had (uploadStore.ts, unchanged
--     mechanism, now writing N page blobs per upload instead of one PDF
--     blob).
--   * UNIQUE (upload_id, page_number): a book can never have two pages
--     claiming the same display position. Reordering (routes/uploads.ts)
--     renumbers through a temporary negative placeholder to avoid tripping
--     this constraint mid-permutation (NOT DEFERRABLE by design — a
--     two-phase UPDATE in application code handles it; see the route).
--   * The UNIQUE constraint's backing index already satisfies "index on
--     (upload_id, page_number)" — Postgres auto-creates a unique index for a
--     UNIQUE constraint, so no separate CREATE INDEX is added (it would just
--     duplicate that index).
--   * ON DELETE CASCADE from book_uploads: deleting an upload deletes all its
--     page ROWS in the same statement. routes/uploads.ts's DELETE handler
--     reads every page's blob_ref BEFORE issuing the delete so it can unlink
--     the blob FILES after the transaction commits (file deletion is not
--     transactional, so it must never race a possible rollback).
--   * `book_uploads.blob_ref` is DROPPED (not just made nullable): nothing
--     writes it anymore under the new model — the original zip/PDF is never
--     retained (storage savings), so a nullable-but-always-NULL column would
--     be dead weight. `byte_size` is KEPT and RE-PURPOSED: it now records the
--     size of the ORIGINAL upload (zip or PDF) at ingest time —
--     informational only, since that file itself is discarded once its pages
--     are extracted.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. book_pages — one row per normalized page image, in DISPLAY order.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS book_pages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    upload_id       BIGINT              NOT NULL,
    page_number     INTEGER             NOT NULL,

    -- RELATIVE path under BOOK_UPLOAD_STORAGE_DIR (e.g. "7/<uuid>.jpg").
    -- NEVER absolute, NEVER built from client input. See uploadStore.ts.
    blob_ref        TEXT                NOT NULL,
    width           INTEGER,
    height          INTEGER,

    -- Audit columns (migrations README "Conventions")
    created_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
    version         INTEGER             NOT NULL DEFAULT 1,

    CONSTRAINT fk_book_pages_upload
        FOREIGN KEY (upload_id) REFERENCES book_uploads(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- One display position per page per book; also the backing index for
    -- "look up page N of upload U" (GET /uploads/:id/page/:n).
    CONSTRAINT uq_book_pages_upload_number UNIQUE (upload_id, page_number),
    CONSTRAINT ck_book_pages_page_number_positive
        CHECK (page_number > 0),
    CONSTRAINT ck_book_pages_blob_ref_nonempty
        CHECK (length(blob_ref) BETWEEN 1 AND 1024),
    CONSTRAINT ck_book_pages_width_positive
        CHECK (width IS NULL OR width > 0),
    CONSTRAINT ck_book_pages_height_positive
        CHECK (height IS NULL OR height > 0),
    CONSTRAINT ck_book_pages_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE book_pages IS
    'One row per normalized page image of a book_uploads row (U1a rework — '
    'ZIP-of-images or PDF, normalized to ordered page images at ingest). '
    'page_number is the DISPLAY order: seeded from the source''s filename/page '
    'order but mutable via PATCH /uploads/:id/pages/order (vFlat retakes can '
    'land out of order). blob_ref points at the page''s image blob under '
    'BOOK_UPLOAD_STORAGE_DIR; width/height are NULL until something bothers to '
    'read them (not populated by U1a).';
COMMENT ON COLUMN book_pages.page_number IS
    'Display position within the book, 1-based. UNIQUE per upload_id. Source '
    'of truth for order — NOT the blob filename, which is an opaque UUID.';
COMMENT ON COLUMN book_pages.blob_ref IS
    'RELATIVE path under BOOK_UPLOAD_STORAGE_DIR (e.g. "7/<uuid>.jpg"), NEVER '
    'absolute and NEVER built from client input. Same contract as the '
    'pre-rework book_uploads.blob_ref (uploadStore.ts, unchanged mechanism).';
COMMENT ON COLUMN book_pages.width IS
    'Page image width in pixels. NULL — not populated by U1a; a future pass '
    'may read it off the stored image.';
COMMENT ON COLUMN book_pages.height IS
    'Page image height in pixels. NULL — not populated by U1a; a future pass '
    'may read it off the stored image.';

CREATE OR REPLACE TRIGGER trg_book_pages_updated_at
    BEFORE UPDATE ON book_pages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. book_uploads — drop blob_ref (the original zip/PDF is not retained;
--    only its derived pages, in book_pages, are). byte_size stays but now
--    documents the ORIGINAL upload's size, not a retained blob's.
-- -----------------------------------------------------------------------------
ALTER TABLE book_uploads DROP COLUMN IF EXISTS blob_ref;

COMMENT ON COLUMN book_uploads.byte_size IS
    'Size, in bytes, of the ORIGINAL upload (a zip-of-images or a PDF) at '
    'ingest time. Informational only — the original file itself is NOT '
    'retained after its pages are extracted into book_pages (storage '
    'savings); this column is the only surviving record of how large it was.';
COMMENT ON COLUMN book_uploads.page_count IS
    'Number of book_pages rows for this upload. Set to the final page count '
    'once normalization succeeds (U1a is synchronous: a POST /uploads that '
    'returns 200/201 has already fully normalized every page — see '
    'services/bookUploadIngest.ts). NULL only for rows that predate this '
    'migration and were never re-uploaded.';
COMMENT ON TABLE book_uploads IS
    'One row per user-uploaded book (U1, PDF/ZIP book-upload feature). The '
    'ORIGINAL zip/PDF is not retained — services/bookUploadIngest.ts '
    'normalizes it to ordered page images (book_pages) at upload time and '
    'discards the source file. Hard-deleted (no history value once removed); '
    'deleting a row CASCADEs its book_pages (and their blob files — cleaned '
    'up by routes/uploads.ts after the DB commit, since file deletion is not '
    'transactional). U2 extraction tags content rows back to this id via '
    'source_upload_id (ON DELETE SET NULL, so removing the upload never '
    'deletes content already pulled from it).';

-- End of 041_book_pages.up.sql — runner owns the transaction (ADR-013).
