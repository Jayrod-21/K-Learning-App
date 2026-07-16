-- migrate: non-destructive
-- =============================================================================
-- Migration 068 — user-saved upload provenance on grammar_entries (F-107)
--   UP — adds a nullable `source_upload_id` FK on `grammar_entries`, mirroring
--        the column migration 040 put on `vocab_entries` / `kgiu_entries`.
--   Reverse: 068_grammar_entries_source_upload.down.sql
--   Depends on: 001_core_schema (grammar_entries), 040_book_uploads
--     (book_uploads).
--
-- WHY grammar_entries AND NOT kgiu_entries: F-107 records *user-saved*
-- provenance ("the user banked this pattern while reading THIS upload"),
-- which is distinct from F-108's *extracted-corpus* provenance (U2 tagging
-- the shared `kgiu_entries` reference rows it digitises). The user's save
-- path (`POST /grammar/bank`) writes `grammar_entries` — a USER-scoped table
-- (`user_id` + `UNIQUE (user_id, pattern_key)`) — so per-user provenance
-- belongs here. The vocab side needs no counterpart column: `POST
-- /vocab/mine` upserts `vocab_entries`, which already carries
-- `source_upload_id` from migration 040.
--
-- SEMANTICS (mirror 040 exactly):
--   * Nullable — every pre-existing row, and every save made outside an
--     upload context, stays NULL.
--   * ON DELETE SET NULL — deleting the upload un-tags the banked pattern
--     rather than deleting it (the user's bank outlives the source PDF).
--   * The route layer validates the referenced upload BELONGS TO the saving
--     user before persisting (server/src/routes/grammar.ts POST /bank), so a
--     cross-user id can never be tagged; the FK here only enforces
--     existence/lifecycle, not ownership.
--
-- MARKER (F-088): declared non-destructive — ADD COLUMN (nullable, no
-- backfill) and CREATE INDEX only create, never destroy. Contrast the down
-- file, which DROPs the column and is declared destructive.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps this body in a single transaction together with the bookkeeping
-- write.
-- =============================================================================

ALTER TABLE grammar_entries
    ADD COLUMN IF NOT EXISTS source_upload_id BIGINT
        CONSTRAINT fk_grammar_entries_source_upload
        REFERENCES book_uploads(id) ON DELETE SET NULL ON UPDATE RESTRICT;

COMMENT ON COLUMN grammar_entries.source_upload_id IS
    'FK -> book_uploads (F-107, user-saved provenance): the upload the user '
    'was working from when they banked this pattern. NULL for saves made '
    'outside an upload context and for all pre-068 rows. ON DELETE SET NULL: '
    'deleting the upload un-tags the pattern rather than deleting it. The '
    'route validates ownership (upload belongs to the saving user) before '
    'persisting.';

-- "This user's saved-from-uploads patterns, grouped by upload" reads. Partial
-- — the overwhelming majority of bank rows carry no upload provenance
-- (mirrors ix_vocab_entries_source_upload / ix_kgiu_entries_source_upload).
CREATE INDEX IF NOT EXISTS ix_grammar_entries_source_upload
    ON grammar_entries (source_upload_id)
    WHERE source_upload_id IS NOT NULL;
COMMENT ON INDEX ix_grammar_entries_source_upload IS
    'Partial index (most rows are NULL). Supports saved-from-uploads grouping '
    'reads and the FK''s ON DELETE SET NULL scan when an upload is removed.';

-- End of 068_grammar_entries_source_upload.up.sql — runner owns the
-- transaction (ADR-013).
