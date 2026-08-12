-- migrate: destructive
-- =============================================================================
-- Migration 080 — cloze prompts (DOWN)
--   Reverses 080_cloze_prompts.up.sql: drops the `cloze_prompts` table.
--
--   Marked destructive explicitly: DROP TABLE is a data drop (F-088's marker
--   posture — same as 063/077/078/079's downs).
--
-- LOSSY BY DESIGN, TRIVIALLY RECOVERABLE
--   Rolling back discards the pre-computed cloze prompts. They are DERIVED
--   data — re-running the idempotent seeder (POST /vocab/cloze/seed) after a
--   re-up rebuilds every row from vocab_entries + Kiwi; no user data (cards,
--   reviews, FSRS state) is involved. Post-080 route code (the cloze-aware
--   due queue + grade route) must not run against a pre-080 schema
--   (035/078's contract).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this down body in its own
--   transaction together with the bookkeeping DELETE.
-- =============================================================================

DROP TABLE IF EXISTS cloze_prompts;

-- End of 080_cloze_prompts.down.sql — runner owns the transaction (ADR-013).
