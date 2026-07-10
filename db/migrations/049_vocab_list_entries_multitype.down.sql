-- =============================================================================
-- Migration 049 — vocab_list_entries multi-type (DOWN)
--   Reverses 049_vocab_list_entries_multitype.up.sql back to the 012 shape:
--   vocab-only membership, `entry_id` NOT NULL. The up was an ADD-ONLY expand
--   (no rename, no drop), so this down only removes what 049 added and
--   restores the NOT NULL — the 012 UNIQUE (list_id, entry_id) and the 012 FK
--   were never touched and need no restoration.
--
-- BEST-EFFORT DATA REVERSAL (documented per the 046 precedent):
--   Grammar and hanja memberships have NO pre-049 representation — the 012
--   schema can only hold vocab rows. Rolling back therefore REMOVES every
--   membership row whose target is a kgiu_entries or hanja_characters row.
--   Vocab memberships round-trip losslessly (entry_id was never renamed;
--   their values never move). This loss is confined to list membership — the
--   underlying corpus rows and any vocab_cards are untouched.
--
--   NB: the data loss here is via DELETE + DROP COLUMN, which migrate.py's
--   destructive gate (DROP TABLE / DROP SCHEMA / DROP DATABASE / table
--   truncation) does not match — same caveat as 046.down. Treat any 049
--   rollback as a deliberate decision to discard grammar/hanja memberships.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
-- =============================================================================

-- 1. Remove memberships the 012 schema cannot represent (see header). The XOR
--    guarantees these are exactly the rows with a NULL entry_id, and their
--    removal is what lets SET NOT NULL succeed below.
DELETE FROM vocab_list_entries WHERE entry_id IS NULL;

-- 2. Drop the 049 CHECK + the grammar/hanja columns (their FKs and partial
--    indexes go with the columns).
ALTER TABLE vocab_list_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_list_entries_target_xor;
ALTER TABLE vocab_list_entries DROP COLUMN IF EXISTS kgiu_entry_id;
ALTER TABLE vocab_list_entries DROP COLUMN IF EXISTS hanja_character_id;

-- 3. Drop the 049 vocab-side reverse-lookup index (the kgiu/hanja ones died
--    with their columns above).
DROP INDEX IF EXISTS ix_vocab_list_entries_entry;

-- 4. Restore the 012 NOT NULL (safe: step 1 removed every NULL row). The
--    column name, its FK, and uq_vocab_list_entries_list_entry were never
--    changed by the up, so the 012 shape is now fully restored.
ALTER TABLE vocab_list_entries ALTER COLUMN entry_id SET NOT NULL;

COMMENT ON COLUMN vocab_list_entries.entry_id IS
    'FK to vocab_entries (012 shape, restored by 049 rollback).';
COMMENT ON TABLE vocab_list_entries IS
    'Membership rows for vocab_lists. Hard-deleted on removal (no audit value '
    'worth a deleted_at column). UNIQUE (list_id, entry_id) makes duplicate '
    'adds a 409, not silent.';

-- End of 049_vocab_list_entries_multitype.down.sql — runner owns the transaction (ADR-013).
