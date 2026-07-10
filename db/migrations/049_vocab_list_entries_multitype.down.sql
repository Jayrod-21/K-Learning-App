-- =============================================================================
-- Migration 049 — vocab_list_entries multi-type (DOWN)
--   Reverses 049_vocab_list_entries_multitype.up.sql back to the 012 shape:
--   vocab-only membership, `entry_id` NOT NULL, UNIQUE (list_id, entry_id).
--
-- BEST-EFFORT DATA REVERSAL (documented per the 046 precedent):
--   Grammar and hanja memberships have NO pre-049 representation — the 012
--   schema can only hold vocab rows. Rolling back therefore REMOVES every
--   membership row whose target is a kgiu_entries or hanja_characters row.
--   Vocab memberships round-trip losslessly (the rename is reversed; their
--   values never move). This loss is confined to list membership — the
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
--    guarantees these are exactly the rows with a NULL vocab_entry_id, and
--    their removal is what lets SET NOT NULL succeed below.
DELETE FROM vocab_list_entries WHERE vocab_entry_id IS NULL;

-- 2. Drop the 049 CHECK + the grammar/hanja columns (their FKs and partial
--    indexes go with the columns).
ALTER TABLE vocab_list_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_list_entries_target_xor;
ALTER TABLE vocab_list_entries DROP COLUMN IF EXISTS kgiu_entry_id;
ALTER TABLE vocab_list_entries DROP COLUMN IF EXISTS hanja_character_id;

-- 3. Drop the 049 vocab-side indexes (the kgiu/hanja ones died with their
--    columns above).
DROP INDEX IF EXISTS uq_vocab_list_entries_list_vocab;
DROP INDEX IF EXISTS ix_vocab_list_entries_vocab_entry;

-- 4. Restore the 012 column shape: NOT NULL, original name, original FK
--    constraint name, original UNIQUE constraint.
ALTER TABLE vocab_list_entries ALTER COLUMN vocab_entry_id SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'vocab_list_entries'
                  AND column_name = 'vocab_entry_id') THEN
        ALTER TABLE vocab_list_entries RENAME COLUMN vocab_entry_id TO entry_id;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'fk_vocab_list_entries_vocab_entry'
                  AND conrelid = 'vocab_list_entries'::regclass) THEN
        ALTER TABLE vocab_list_entries
            RENAME CONSTRAINT fk_vocab_list_entries_vocab_entry
                          TO fk_vocab_list_entries_entry;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'uq_vocab_list_entries_list_entry'
                      AND conrelid = 'vocab_list_entries'::regclass) THEN
        ALTER TABLE vocab_list_entries
            ADD CONSTRAINT uq_vocab_list_entries_list_entry
                UNIQUE (list_id, entry_id);
    END IF;
END $$;

COMMENT ON COLUMN vocab_list_entries.entry_id IS
    'FK to vocab_entries (012 shape, restored by 049 rollback).';
COMMENT ON TABLE vocab_list_entries IS
    'Membership rows for vocab_lists. Hard-deleted on removal (no audit value '
    'worth a deleted_at column). UNIQUE (list_id, entry_id) makes duplicate '
    'adds a 409, not silent.';

-- End of 049_vocab_list_entries_multitype.down.sql — runner owns the transaction (ADR-013).
