-- =============================================================================
-- Migration 058 (down) — remove tickets.source_page
--   Reverses: 058_ticket_source_page.up.sql
--
--   * `tickets.source_page` is dropped (with its CHECK). This is LOSSY for
--     any source-page context recorded since 058 applied — accepted: it is
--     display-only provenance ("Reported from: ..."), never load-bearing for
--     any ticket workflow (filing, editing, commenting, status). No other
--     column or row depends on it. DROP COLUMN does NOT trip migrate.py's
--     destructive gate (that gate covers DROP TABLE/SCHEMA/DATABASE/
--     TRUNCATE) — matching 049/050/055's down posture for add-only column
--     expands. It IS data-lossy in the ordinary sense (stored text is gone),
--     just not gate-classified as destructive.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the schema_migrations bookkeeping delete.
-- =============================================================================

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS ck_tickets_source_page_length;
ALTER TABLE tickets DROP COLUMN IF EXISTS source_page;

-- End of 058_ticket_source_page.down.sql — runner owns the transaction (ADR-013).
