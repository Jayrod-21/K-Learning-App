-- =============================================================================
-- Migration 042 — vocab_2000_advanced corpus enum value (U2 book uploads)
--   UP — extends the `corpus` enum with 'vocab_2000_advanced': the corpus under
--        which vocab extracted (U2) from an uploaded "2000 Essential Korean
--        Words — Advanced" book is loaded, alongside the existing
--        vocab_2000_beginner / vocab_2000_intermediate corpora.
--   Reverse: 042_vocab_2000_advanced_corpus.down.sql
--   Depends on: 001_core_schema (defines the `corpus` enum).
--
-- WHY THIS MIGRATION DOES NOTHING ELSE — THE PG ENUM GOTCHA (mirrors 021 / 016)
--   A newly added enum value CANNOT be USED in the SAME transaction that added
--   it, and migrate.py wraps each migration body in ONE transaction together
--   with the bookkeeping write (ADR-013). So this migration ONLY adds the value;
--   migration 043 — a SEPARATE migration, therefore a SEPARATE transaction — is
--   the first to USE it (relaxing the vocab_entries CHECKs). Combining them in
--   one file would put the ADD VALUE and its first use in the same runner
--   transaction and fail at apply time. `ADD VALUE IF NOT EXISTS` makes
--   re-applying a no-op.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level transaction control — migrate.py owns the transaction.
-- =============================================================================

ALTER TYPE corpus ADD VALUE IF NOT EXISTS 'vocab_2000_advanced';

-- End of 042_vocab_2000_advanced_corpus.up.sql — runner owns the transaction.
