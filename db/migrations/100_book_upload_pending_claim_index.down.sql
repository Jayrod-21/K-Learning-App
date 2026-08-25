-- migrate: non-destructive
-- =============================================================================
-- Migration 100 — book_uploads pending-claim index (DOWN)
--   Drops the partial index. IF EXISTS so a partial/repeated rollback is a
--   no-op. Purely additive up, so the down is purely subtractive — no data
--   loss, nothing else to reconcile. Marked non-destructive (unlike 099's
--   down): dropping an INDEX loses no data, only a query-plan optimization
--   (mirrors 090's down classification exactly).
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP INDEX IF EXISTS ix_book_uploads_pending_claim;

-- End of 100_book_upload_pending_claim_index.down.sql — runner owns the transaction (ADR-013).
