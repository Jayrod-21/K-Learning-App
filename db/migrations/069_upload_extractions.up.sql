-- migrate: non-destructive
-- =============================================================================
-- Migration 069 — upload_extractions (F-108, U2 extraction/OCR pipeline)
--   UP — adds `upload_extractions` (one row per extraction RUN over a page
--        range of a book upload: status lifecycle, page range, result counts,
--        error) and relaxes the two kgiu_entries CHECKs so the extraction
--        pipeline can insert grammar-candidate rows under the existing
--        'user_mined' corpus (mirrors what migration 022 did for
--        vocab_entries).
--   Reverse: 069_upload_extractions.down.sql
--   Depends on: 040_book_uploads (book_uploads + source_upload_id columns),
--     041_book_pages (book_pages — the pages a run reads), 021/022 (the
--     'user_mined' corpus enum value + its corpus_sources row, which the
--     kgiu inserts reuse), 002_darakwon_corpora (kgiu_entries + its CHECKs),
--     001_core_schema (users, set_updated_at()).
--
-- WHY A RUN TABLE (design note, F-108)
--   Extraction is a metered external call (Claude Vision, one call per page)
--   over a book that can be ~500 pages. It must be:
--     * OBSERVABLE — the client's status view reads real rows, not logs;
--     * RESUMABLE — the next run defaults to starting after the highest
--       page_to any 'done' run reached, so a book is worked through in
--       bounded slices across days;
--     * IDEMPOTENT — re-running a range must not double-insert content
--       (the corpus rows carry deterministic source_ids arbitrated by
--       UNIQUE (corpus, source_id) — see server/src/services/uploadExtract.ts)
--       and must not double-charge concurrently (the partial UNIQUE below
--       admits at most ONE live run per upload — the INSERT is the claim);
--     * COST-ACCOUNTABLE — the per-user daily Vision-page cap sums
--       pages_requested over today's runs BEFORE any upstream call, and a
--       failed run still counts (a cap is a COST control; failures spent
--       money too — same stance as image_captures counting soft-deleted).
--
-- WHY THE LEDGER SURVIVES UPLOAD DELETION (fk upload_id ON DELETE SET NULL)
--   book_uploads is HARD-deleted (040 — no soft-delete column). If this FK
--   CASCADEd, `DELETE /uploads/:id` would erase today's charged run rows and
--   RESET the daily Vision-page cap on demand (extract → delete → re-upload →
--   extract again ≈ BOOK_UPLOAD_DAILY_CAP × the intended Vision budget). The
--   cap query sums by the denormalized user_id alone, so a SET-NULL'd
--   (orphaned) run row keeps charging the user who spent the money — the
--   image_captures stance ("deleting the artifact must not refund the
--   budget") actually holds here. upload_id is therefore NULLABLE: NULL means
--   "the upload this run charged for was deleted after the fact". The partial
--   UNIQUE claim index below is unaffected: it only covers live
--   (pending/running) rows, and Postgres never treats two NULLs as equal, so
--   an orphaned row can neither block nor be blocked by a new claim.
--
-- WHY user_id IS DENORMALIZED
--   The daily cap query ("pages this user requested today") runs on every
--   trigger. Storing the owner directly avoids a join through book_uploads
--   on the hot path and keeps the cap intact even mid-transaction while the
--   parent row is locked. The route writes it from the ownership-checked
--   book_uploads row inside the same transaction, so it can never disagree
--   with book_uploads.user_id. It is also what keeps the ledger chargeable
--   after upload deletion nulls upload_id (the user FK still CASCADEs — a
--   deleted USER takes their cost history with them, which is correct).
--
-- WHY THE kgiu CHECK RELAXATIONS ARE SAFE
--   Both CHECKs are made strictly MORE PERMISSIVE — every row that satisfied
--   the original definition still satisfies the relaxed one, so no existing
--   kgiu_entries row can be invalidated. The recreated constraints keep the
--   SAME names so error messages and the down migration stay stable. This is
--   byte-for-byte the maneuver migration 022 performed on vocab_entries'
--   equivalent CHECKs; 'user_mined' kgiu rows use the same book_level
--   sentinel convention ('beginner', meaningless for this corpus).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum type (closed value set — ADR-001 D8). DO block guards creation so
--    the migration is re-runnable; PG 16 has no CREATE TYPE IF NOT EXISTS for
--    enums (mirrors 040's pattern).
--    'pending' is reserved for a future queued/async runner — the current
--    synchronous pipeline claims runs directly as 'running'.
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'upload_extraction_status') THEN
        CREATE TYPE upload_extraction_status AS ENUM ('pending', 'running', 'done', 'failed');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. upload_extractions — one row per extraction run over a page range.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_extractions (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- NULLABLE by design: SET NULL on upload deletion keeps the cost ledger
    -- intact (see header). Every row is INSERTed with a real upload_id.
    upload_id        BIGINT,
    user_id          BIGINT                    NOT NULL,

    status           upload_extraction_status  NOT NULL DEFAULT 'pending',

    -- The requested 1-based inclusive page range (book_pages.page_number).
    page_from        INTEGER                   NOT NULL,
    page_to          INTEGER                   NOT NULL,
    -- How many book_pages rows actually existed in the range at claim time.
    -- This — not (page_to - page_from + 1) — is what the daily Vision-page
    -- cap sums, so a sparse range can't be gamed into free budget.
    pages_requested  INTEGER                   NOT NULL,

    -- Result counts (all 0 until the run settles).
    pages_ocred      INTEGER                   NOT NULL DEFAULT 0,
    pages_failed     INTEGER                   NOT NULL DEFAULT 0,
    vocab_inserted   INTEGER                   NOT NULL DEFAULT 0,
    grammar_inserted INTEGER                   NOT NULL DEFAULT 0,
    words_skipped    INTEGER                   NOT NULL DEFAULT 0,

    -- Failure detail (bounded — an error is a summary, not a stack dump).
    error            TEXT,

    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,

    -- Audit columns (ADR-001 D6)
    created_at       TIMESTAMPTZ               NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ               NOT NULL DEFAULT now(),
    version          INTEGER                   NOT NULL DEFAULT 1,

    -- SET NULL, NOT CASCADE: the run row is the daily cap's cost ledger — it
    -- must outlive its upload or deletion refunds spent Vision budget (see
    -- header "WHY THE LEDGER SURVIVES UPLOAD DELETION").
    CONSTRAINT fk_upload_extractions_upload
        FOREIGN KEY (upload_id) REFERENCES book_uploads(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT fk_upload_extractions_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_upload_extractions_page_from_positive
        CHECK (page_from > 0),
    CONSTRAINT ck_upload_extractions_range_ordered
        CHECK (page_to >= page_from),
    CONSTRAINT ck_upload_extractions_pages_requested
        CHECK (pages_requested > 0 AND pages_requested <= (page_to - page_from + 1)),
    CONSTRAINT ck_upload_extractions_counts_nonnegative
        CHECK (pages_ocred >= 0 AND pages_failed >= 0 AND vocab_inserted >= 0
               AND grammar_inserted >= 0 AND words_skipped >= 0),
    CONSTRAINT ck_upload_extractions_error_length
        CHECK (error IS NULL OR length(error) BETWEEN 1 AND 2000),
    CONSTRAINT ck_upload_extractions_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE upload_extractions IS
    'One row per U2 extraction run (F-108): a bounded page range of a book '
    'upload pushed through Claude Vision OCR and curated into corpus rows '
    'tagged with source_upload_id. The row is the run''s claim (partial UNIQUE '
    'below: one live run per upload), its cost-accounting record (the daily '
    'Vision-page cap sums pages_requested), and its status/result surface for '
    'the client. Survives its upload''s deletion (upload_id SET NULL — the cap '
    'ledger must not be resettable by DELETE /uploads/:id); CASCADEs with its '
    'user.';
COMMENT ON COLUMN upload_extractions.upload_id IS
    'The book upload this run read. NULL = that upload was hard-deleted after '
    'the run (ON DELETE SET NULL) — the row survives as the user''s daily '
    'Vision-page cost record.';
COMMENT ON COLUMN upload_extractions.user_id IS
    'Denormalized owner (always equals the upload''s user_id — written from '
    'the ownership-checked parent row in the same transaction). Exists so the '
    'per-user daily cap query needs no join.';
COMMENT ON COLUMN upload_extractions.status IS
    'pending (reserved for a future async runner) -> running (claimed, OCR in '
    'flight) -> done | failed. The synchronous pipeline claims directly as '
    'running.';
COMMENT ON COLUMN upload_extractions.pages_requested IS
    'COUNT of book_pages rows in [page_from, page_to] at claim time — the '
    'number the daily Vision-page cap charges. Failed runs still count (cost '
    'control, not a usage meter).';
COMMENT ON COLUMN upload_extractions.words_skipped IS
    'OCR words dropped at the curation boundary (blank after sanitization, or '
    'rejected by the shared prompt-injection guard) — surfaced so silent '
    'filtering is visible.';
COMMENT ON COLUMN upload_extractions.error IS
    'Bounded human-readable failure summary for status = failed. NULL '
    'otherwise.';

-- One LIVE run per upload: the claim INSERT arbitrates concurrency — a second
-- concurrent trigger hits this index (23505) and maps to 409, so a double
-- click can never double-charge the Vision budget for the same book.
CREATE UNIQUE INDEX IF NOT EXISTS uq_upload_extractions_upload_live
    ON upload_extractions (upload_id)
    WHERE status IN ('pending', 'running');
COMMENT ON INDEX uq_upload_extractions_upload_live IS
    'At most one pending/running extraction per upload — the claim INSERT is '
    'the concurrency arbiter (POST /uploads/:id/extract maps 23505 to 409).';

-- Query 1: the per-user daily Vision-page cap ("pages requested today") and
-- Query 2: the status view (a user''s runs, newest first).
CREATE INDEX IF NOT EXISTS ix_upload_extractions_user_created
    ON upload_extractions (user_id, created_at DESC);
COMMENT ON INDEX ix_upload_extractions_user_created IS
    'Supports the daily Vision-page cap sum (user_id + created_at >= today) '
    'and GET /uploads/:id/extract''s newest-first run listing.';

CREATE OR REPLACE TRIGGER trg_upload_extractions_updated_at
    BEFORE UPDATE ON upload_extractions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Relax the two kgiu_entries CHECKs to admit 'user_mined' (mirrors
--    migration 022's vocab_entries relaxations — same names, strictly more
--    permissive, so no existing row can be invalidated).
-- -----------------------------------------------------------------------------
ALTER TABLE kgiu_entries
    DROP CONSTRAINT IF EXISTS ck_kgiu_entries_corpus_kgiu_only;

ALTER TABLE kgiu_entries
    ADD CONSTRAINT ck_kgiu_entries_corpus_kgiu_only CHECK (
        corpus IN ('kgiu_beginner', 'kgiu_intermediate', 'kgiu_advanced', 'user_mined')
    );

ALTER TABLE kgiu_entries
    DROP CONSTRAINT IF EXISTS ck_kgiu_entries_level_matches_corpus;

ALTER TABLE kgiu_entries
    ADD CONSTRAINT ck_kgiu_entries_level_matches_corpus CHECK (
        (corpus = 'kgiu_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'kgiu_intermediate' AND book_level = 'intermediate') OR
        (corpus = 'kgiu_advanced'     AND book_level = 'advanced')     OR
        (corpus = 'user_mined')
    );

-- End of 069_upload_extractions.up.sql — runner owns the transaction (ADR-013).
