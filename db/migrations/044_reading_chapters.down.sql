-- 044 (down): drop reading_passages + reading_chapters + the book_uploads
-- UNIQUE(id, user_id) added to back the composite FK.
--
-- LOSSY by design: every reading_chapters / reading_passages row is discarded
-- (the digitized literature text). It is re-derivable by re-uploading the book
-- and re-running tools/ingest/load_literature.py — this migration only removes
-- the schema, not the source scans (book_uploads / book_pages are untouched).
--
-- Order matters: drop reading_passages first (it FKs reading_chapters), then
-- reading_chapters (it FKs book_uploads via the composite key), then the
-- book_uploads UNIQUE that composite FK referenced.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- 1. Passages depend on chapters — drop them first (CASCADE from the table drop
--    also removes the trigger + unique index).
DROP TABLE IF EXISTS reading_passages;

-- 2. Chapters — dropping the table drops the composite FK to book_uploads, so
--    the UNIQUE below is then unreferenced and safe to remove.
DROP TABLE IF EXISTS reading_chapters;

-- 3. Remove the UNIQUE(id, user_id) that only existed to back the composite FK.
--    (book_uploads.id remains the PK — this drop restores book_uploads exactly
--    to its pre-044 shape.)
ALTER TABLE book_uploads DROP CONSTRAINT IF EXISTS uq_book_uploads_id_user;

-- End of 044_reading_chapters.down.sql
