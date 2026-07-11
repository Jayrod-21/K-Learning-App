-- =============================================================================
-- Migration 058 — tickets.source_page (F-127, global "!" feedback FAB)
--   UP — adds `tickets.source_page` TEXT NULL: the app page the ticket was
--        filed from, captured client-side when the new top-right "!" FAB
--        (client/src/components/FeedbackFab.tsx) navigates to /tickets and
--        POSTs the caller's current `location.pathname`.
--   Reverse: 058_ticket_source_page.down.sql
--   Depends on: 048_tickets (tickets table).
--
-- DESIGN NOTES
--   * Nullable, no default — every pre-058 ticket (and any future ticket
--     filed without going through the FAB, e.g. the Settings "Beta feedback"
--     tile) stays valid with source_page = NULL. Add-only expand, same
--     posture as 055's conversations.title.
--   * The CHECK bounds length the same way 048 bounds title/body — the
--     route layer's Zod schema (server/src/routes/tickets.ts) is the
--     primary gate, but per the "test with real corpus data" lesson the DB
--     constraint is the floor an API schema must never be looser than.
--     200 chars comfortably covers any real in-app pathname (the longest
--     nav.ts route + a plausible detail-id suffix) with headroom.
--   * `source_page` stores the raw PATHNAME (e.g. `/learn/writing`), never a
--     human label — labels live in nav.ts and can be renamed; the path is
--     the stable key. The client re-derives a friendly display name from
--     the stored path at render time (`pageNameForPath`, lib/nav.ts) so the
--     two can never drift apart.
--   * source_page is client-reported UI CONTEXT, not author identity — it
--     carries no user_id/email-shaped data and does not touch the F-023
--     anonymity contract (routes/tickets.ts's community SELECTs already
--     exclude user_id; this column is orthogonal and safe to expose on both
--     the owner and community reads).
--
-- DEPLOYMENT
--   Expand/contract-compliant: ADD COLUMN (nullable, no default → no table
--   rewrite). Pre-058 server code never references `source_page` and keeps
--   working while this applies; ships via the standard zero-downtime
--   blue/green flow; rollback-by-flip stays valid.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the schema_migrations bookkeeping write.
-- =============================================================================

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_page TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_tickets_source_page_length'
                      AND conrelid = 'tickets'::regclass) THEN
        ALTER TABLE tickets
            ADD CONSTRAINT ck_tickets_source_page_length CHECK (
                source_page IS NULL
                OR (char_length(source_page) BETWEEN 1 AND 200)
            );
    END IF;
END $$;

COMMENT ON COLUMN tickets.source_page IS
    'App pathname (e.g. /learn/writing) the ticket was filed from (F-127, the '
    'global "!" FAB). NULL = filed without page context (pre-058 rows, or the '
    'Settings "Beta feedback" tile). Client-reported UI context, NOT '
    'author-identifying — orthogonal to the F-023 anonymity contract. Stores '
    'the raw path, never a label; the client re-derives the display name via '
    '`pageNameForPath` (lib/nav.ts) so a later nav.ts rename can''t drift out '
    'of sync with already-filed tickets.';

-- End of 058_ticket_source_page.up.sql — runner owns the transaction (ADR-013).
