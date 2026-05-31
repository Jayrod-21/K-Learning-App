-- =============================================================================
-- Migration 020 — one production card per (user, grammar pattern) (FU-NF-42)
--   UP — adds a PARTIAL UNIQUE INDEX on vocab_cards (user_id, grammar_entry_id)
--        scoped to the grammar PRODUCTION face. This lets the grammar-drill
--        submit handler (routes/grammarDrill.ts) resolve-or-create a STABLE
--        production card per pattern to advance on each drill, and prevents a
--        concurrent double-submit from creating two cards for the same pattern.
--   Reverse: 020_grammar_production_card_uniq.down.sql
--   Depends on: 001_core_schema (vocab_cards, grammar_entries, card_face enum).
--
-- DESIGN NOTES (FU-NF-42, 2026-05-31)
--   * Server-derived scheduling for grammar drills (a DELIBERATE divergence from
--     ADR-003's client-computes model — justified because an auto-scored
--     production attempt has no client self-rating step) advances ONE production
--     card per grammar pattern. Without a uniqueness guard the submit upsert
--     ("SELECT … else INSERT") could race a concurrent submit and bank two cards
--     for the same (user, pattern), splitting the FSRS history. This index makes
--     that a DB-level invariant.
--   * PARTIAL on (face = 'production' AND grammar_entry_id IS NOT NULL AND
--     deleted_at IS NULL):
--       - face = 'production'        — recognition / cloze faces are unaffected;
--                                       a user may legitimately hold a recognition
--                                       AND a production card for the same target.
--       - grammar_entry_id IS NOT NULL — the XOR target CHECK (001) leaves
--                                       grammar_entry_id NULL for vocab / sentence
--                                       / topik cards; excluding NULLs keeps the
--                                       index off every non-grammar production
--                                       card (e.g. a future vocab production card).
--       - deleted_at IS NULL          — a soft-deleted card must not block banking
--                                       a fresh one for the same pattern.
--     Matches the partial-index idiom already used by ix_vocab_cards_due_queue /
--     ix_vocab_cards_grammar_entry (001) and ix_image_captures_user_created (017).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write. (No CONCURRENTLY here — it
--   is forbidden inside a transaction and the table is small at this stage.)
--
-- KNOWN LIMITATION — pattern_key NAMESPACE SPLIT (tracked: FU-NF-46)
--   The drill auto-banks under the KGIU key the Grammar list + drill share
--   (e.g. 'KGIU-INT-007'), while the manual /grammar/bank route mints 'GR-…'
--   keys from Claude's recognize output. The same conceptual pattern banked via
--   BOTH paths would split into two grammar_entries rows → two production cards →
--   split FSRS history. It cannot happen today (the only 'GR-…'-minting surface,
--   Reading-highlight banking, is local-only and never reaches the server), but
--   it will once a Reading→server grammar-bank lands. Unifying the namespaces is
--   FU-NF-46, not this migration.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_cards_user_grammar_production
    ON vocab_cards (user_id, grammar_entry_id)
    WHERE face = 'production' AND grammar_entry_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX uq_vocab_cards_user_grammar_production IS
    'One production card per (user, grammar pattern). Lets the drill-submit upsert resolve a stable card to advance. FU-NF-42.';

-- -----------------------------------------------------------------------------
-- Extend grammar_entries.discovered_via to allow 'drill'
-- -----------------------------------------------------------------------------
-- The grammar-drill submit handler (FU-NF-42) AUTO-BANKS a grammar_entries row
-- on the learner's first production drill of a pattern, stamping the origin as
-- 'drill'. The 001 CHECK list (manual / reading_highlight / listening_highlight
-- / topik_item / diagnostic / conversation / import) does NOT include it, so the
-- auto-bank INSERT would fail the CHECK. 001's own comment establishes the
-- convention: "Adding a category = update the CHECK constraint." We drop and
-- recreate the named CHECK with 'drill' appended (DROP … IF EXISTS keeps the
-- migration re-runnable). Constraint name is preserved so the down migration and
-- any future edits stay stable.
ALTER TABLE grammar_entries
    DROP CONSTRAINT IF EXISTS ck_grammar_entries_discovered_via_known;
ALTER TABLE grammar_entries
    ADD CONSTRAINT ck_grammar_entries_discovered_via_known CHECK (discovered_via IN (
        'manual', 'reading_highlight', 'listening_highlight', 'topik_item',
        'diagnostic', 'conversation', 'import', 'drill'
    ));

-- -----------------------------------------------------------------------------
-- Widen grammar_entries.pattern_key to the drill key namespace
-- -----------------------------------------------------------------------------
-- The grammar-drill submit auto-bank (FU-NF-42) maps the DRILL's `pattern_key`
-- DIRECTLY onto grammar_entries.pattern_key (the contract's "patternKey maps
-- directly" — keys dedupe across the two surfaces by exact match). But the
-- drill's pattern_key namespace is NOT the manual grammar-bank's `GR-…`
-- namespace: real drill keys are corpus identifiers like 'KGIU-INT-007' or the
-- 🅂/mock keys 'mock:transformation'. The 001 CHECK
-- (pattern_key ~ '^GR-[a-z0-9_-]{1,64}$') would REJECT every such key and roll
-- back the submit, so we relax it to a general, BOUNDED, single-line printable
-- key that still admits the legacy GR-… shape:
--   * length 1..120 — matches the drill route's Zod cap (patternKey max 120) and
--     grammar_drill_attempts.pattern_key (free text, no DB shape constraint), so
--     a key that the attempt row accepted cannot be rejected here.
--   * no ASCII control chars and no leading/trailing/only whitespace — a key is
--     an identifier, not free prose; this blocks injection-ish / blank keys while
--     allowing Hangul, ':' (mock:), '-' (KGIU-INT-007), digits, etc.
-- The manual /grammar/bank route keeps its OWN stricter `^GR-…` Zod regex
-- (server/src/routes/grammar.ts) — this only loosens the DB backstop so BOTH the
-- manual GR-… keys AND the drill keys are storable in one table.
ALTER TABLE grammar_entries
    DROP CONSTRAINT IF EXISTS ck_grammar_entries_pattern_key_shape;
ALTER TABLE grammar_entries
    ADD CONSTRAINT ck_grammar_entries_pattern_key_shape CHECK (
        length(pattern_key) BETWEEN 1 AND 120
        AND pattern_key !~ '[[:cntrl:]]'
        AND btrim(pattern_key) = pattern_key
        AND length(btrim(pattern_key)) > 0
    );

-- End of 020_grammar_production_card_uniq.up.sql — runner owns the transaction (ADR-013).
