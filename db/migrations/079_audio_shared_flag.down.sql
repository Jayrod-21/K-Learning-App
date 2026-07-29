-- migrate: destructive
-- =============================================================================
-- Migration 079 — shared-corpus flag (DOWN)
--   Reverses 079_audio_shared_flag.up.sql: drops `is_shared` from
--   `audio_sources` and `book_uploads`.
--
--   Marked destructive explicitly: DROP COLUMN is a data drop the legacy
--   keyword-sniff would MISS (F-088's marker — 063/077/078's downs took the
--   same posture).
--
-- LOSSY BY DESIGN, TRIVIALLY RECOVERABLE
--   Rolling back discards which sets/books were flagged shared. That is a
--   handful of operator-set booleans re-established by re-running the
--   idempotent phase-2 cutover script after a re-up — no user data is
--   involved. Post-079 route code (the widened audio read paths) must not
--   run against a pre-079 schema (035/078's contract).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this down body in its
--   own transaction together with the bookkeeping DELETE.
-- =============================================================================

ALTER TABLE audio_sources
    DROP COLUMN IF EXISTS is_shared;

ALTER TABLE book_uploads
    DROP COLUMN IF EXISTS is_shared;

-- End of 079_audio_shared_flag.down.sql — runner owns the transaction (ADR-013).
