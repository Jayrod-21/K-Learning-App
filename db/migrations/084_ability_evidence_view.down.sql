-- migrate: destructive
-- =============================================================================
-- Migration 084 — ability_evidence view (DOWN)
--   Reverses 084_ability_evidence_view.up.sql: drops the view.
--
-- Marked destructive by CONVENTION (a DROP always gates on
-- --allow-destructive), but no DATA is lost: ability_evidence is a pure
-- derivation over the six base logs, all of which are untouched here —
-- re-upping rebuilds the identical view from the same rows.
--
-- Post-084 server code (server/src/services/ability/) must not run against a
-- pre-084 schema (035/078's contract): its reads SELECT from this view.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

DROP VIEW IF EXISTS ability_evidence;

-- End of 084_ability_evidence_view.down.sql — runner owns the transaction (ADR-013).
