-- =============================================================================
-- Migration 020 — one production card per (user, grammar pattern) (DOWN)
--   Drops the partial unique index. IF EXISTS so a partial/repeated rollback is
--   a no-op.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner wraps
-- the down body in a single transaction.
-- =============================================================================

DROP INDEX IF EXISTS uq_vocab_cards_user_grammar_production;

-- Restore the 001 discovered_via CHECK WITHOUT 'drill'. NOTE: this will fail if
-- any grammar_entries row was banked with discovered_via = 'drill' while the up
-- migration was applied — that is correct behaviour: a down migration must not
-- silently strip a value rows still depend on. Purge or re-stamp those rows
-- before rolling back. DROP IF EXISTS keeps a repeated rollback idempotent.
ALTER TABLE grammar_entries
    DROP CONSTRAINT IF EXISTS ck_grammar_entries_discovered_via_known;
ALTER TABLE grammar_entries
    ADD CONSTRAINT ck_grammar_entries_discovered_via_known CHECK (discovered_via IN (
        'manual', 'reading_highlight', 'listening_highlight', 'topik_item',
        'diagnostic', 'conversation', 'import'
    ));

-- Restore the 001 pattern_key shape (the stricter GR-… regex). NOTE: this will
-- fail if any grammar_entries row was banked with a non-GR-… key (e.g. a drill
-- auto-bank with a 'KGIU-…' / 'mock:…' key) while the up migration was applied —
-- correct behaviour: a down migration must not silently strip rows it cannot
-- represent. Purge or re-key those rows before rolling back.
ALTER TABLE grammar_entries
    DROP CONSTRAINT IF EXISTS ck_grammar_entries_pattern_key_shape;
ALTER TABLE grammar_entries
    ADD CONSTRAINT ck_grammar_entries_pattern_key_shape
        CHECK (pattern_key ~ '^GR-[a-z0-9_-]{1,64}$');

-- End of 020_grammar_production_card_uniq.down.sql — runner owns the transaction (ADR-013).
