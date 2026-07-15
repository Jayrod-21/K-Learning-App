-- =============================================================================
-- Migration 059 (down) — remove hanja_attempts
--   Reverses: 059_hanja_attempts.up.sql
--
--   Drops `hanja_attempts` (and its index, dropped implicitly with the
--   table). IF EXISTS so a partial/repeated rollback is a no-op. This IS
--   data-lossy (attempt history is gone) but not load-bearing for any other
--   table's data or write path — no other row references hanja_attempts, and
--   POST /hanja/cards/:cardId/reviews' own FSRS write (vocab_cards +
--   card_reviews) is unaffected: the attempt-log insert is an ADDITIONAL
--   statement in that transaction, not a dependency of it (see
--   services/cardReview.ts — a rollback here only means new reviews stop
--   being logged, never that reviews themselves stop working).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — the runner wraps the down body in a single
--   transaction together with the schema_migrations bookkeeping delete.
-- =============================================================================

DROP TABLE IF EXISTS hanja_attempts;

-- End of 059_hanja_attempts.down.sql — runner owns the transaction (ADR-013).
