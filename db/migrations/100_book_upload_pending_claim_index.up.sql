-- migrate: non-destructive
-- =============================================================================
-- Migration 100 — book_uploads pending-claim index (Phase 2.5 — OOM fix)
--   UP — adds a PARTIAL INDEX on book_uploads (created_at, id)
--        WHERE status = 'pending', matching the ingest runner's claim query
--        exactly (server/src/services/bookIngestRunner.ts):
--          UPDATE book_uploads
--             SET status = 'processing', started_at = now()
--           WHERE id = (
--             SELECT id FROM book_uploads
--              WHERE status = 'pending'
--              ORDER BY created_at, id
--              FOR UPDATE SKIP LOCKED LIMIT 1
--           )
--        Without it the claim's inner SELECT is a Seq Scan over every
--        book_uploads row (ready + failed + pending) on every runner poll —
--        the same reasoning as 090's audio_transcription_jobs reaper index.
--   Reverse: 100_book_upload_pending_claim_index.down.sql
--   Depends on: 099_book_upload_async_ingest (adds the 'pending' value this
--     index's WHERE clause compares against).
--
-- WHY A SEPARATE MIGRATION FROM 099 (THE PG ENUM GOTCHA — mirrors 072/021/016,
-- and 099's own header)
--   `ALTER TYPE book_upload_status ADD VALUE 'pending'` and any expression
--   that USES the literal 'pending' cannot share one transaction — Postgres
--   requires the ADD VALUE to have already committed. `migrate.py` wraps each
--   migration FILE in its own transaction (ADR-013), so this index — whose
--   WHERE clause casts the string 'pending' to book_upload_status — has to be
--   its own migration, running (and committing) strictly after 099's.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write. No CONCURRENTLY —
--   forbidden inside a transaction, and this is a personal/duo-user app's
--   book_uploads table (a handful to a few hundred rows), so a plain CREATE
--   INDEX's brief write lock is acceptable (090's exact reasoning).
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_book_uploads_pending_claim
    ON book_uploads (created_at, id)
    WHERE status = 'pending';

COMMENT ON INDEX ix_book_uploads_pending_claim IS
    'Backs bookIngestRunner.ts''s claim query (WHERE status = ''pending'' '
    'ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1), run on every '
    'runner poll tick. Partial on the ''pending'' slice only — mirrors '
    '090_audio_transcription_jobs_running_index''s reasoning.';

-- End of 100_book_upload_pending_claim_index.up.sql — runner owns the transaction (ADR-013).
