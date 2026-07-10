-- =============================================================================
-- Migration 049 — vocab_list_entries goes multi-type (F-048 / F-060 / F-061)
--   UP — widens list membership from vocab-only to a vocab / grammar / hanja
--        target XOR, mirroring the `vocab_cards` polymorphic-target pattern
--        (001: exactly-one-non-NULL CHECK across the target ids + per-target
--        partial indexes):
--          * RENAME `entry_id` → `vocab_entry_id` (aligns the column with the
--            vocab_cards naming so the XOR trio reads uniformly);
--          * ADD `kgiu_entry_id`  BIGINT → kgiu_entries(id)      (grammar);
--          * ADD `hanja_character_id` BIGINT → hanja_characters(id) (hanja —
--            the surrogate PK, NOT the natural `char` key; `hanja_progress`
--            deliberately decouples via TEXT, but list membership is transient
--            and hard-deleted, so the FK is the right tool here);
--          * exactly-one-non-NULL CHECK across the three target columns;
--          * per-target partial UNIQUE indexes — one membership per
--            (list, target) — replacing the old two-column UNIQUE constraint;
--          * per-target partial indexes on the entry columns (the "missing
--            index": reverse lookups — "which lists contain X" — plus the
--            referenced-side delete scans for the FKs).
--   Reverse: 049_vocab_list_entries_multitype.down.sql (best-effort — grammar
--            and hanja memberships have no pre-049 representation and are
--            removed; vocab memberships round-trip losslessly).
--   Depends on: 012_vocab_lists (vocab_lists, vocab_list_entries),
--               002_darakwon_corpora (kgiu_entries),
--               016_hanja (hanja_characters).
--
-- DESIGN NOTES
--   * BACK-COMPAT: every pre-049 row is a vocab membership. The rename keeps
--     its value in place; the two new columns default to NULL, so every
--     existing row satisfies the new XOR CHECK without a data transform.
--   * `vocab_lists.kind` needs NO change — 012 already CHECKs it to
--     vocab/grammar/hanja/mixed, anticipating exactly this widening. `kind`
--     stays an advisory display hint: the DB does not force a list's
--     memberships to match its kind (012's bar: business rules that the UX
--     may still bend — e.g. a 'vocab' list the user drops one hanja into —
--     live in code, not in the schema).
--   * FK posture:
--       - vocab_entry_id keeps 012's ON DELETE RESTRICT. Changing it would
--         silently alter documented 012 behavior for existing data, and the
--         orphan-check flow around vocab corpus reloads relies on it.
--       - kgiu_entry_id / hanja_character_id are ON DELETE CASCADE (per the
--         F-048/F-060/F-061 spec): membership is transient with no audit
--         value (012's own rationale for hard delete), so when a grammar or
--         hanja reference row is purged the membership row simply goes with
--         it. SET NULL is not an option — it would trip the XOR CHECK and
--         abort the parent DELETE with a confusing error (the same reasoning
--         as 001's fk_vocab_cards_grammar_entry comment, resolved the other
--         way because these memberships, unlike cards, carry no FSRS state
--         worth protecting).
--   * The old UNIQUE (list_id, entry_id) constraint is replaced by per-target
--     partial UNIQUE indexes so a NULL in the target column never weakens the
--     guarantee, and each target type dedupes independently (vocab id 7 and
--     kgiu id 7 may both live in one list). The new indexes are created
--     BEFORE the old constraint is dropped so uniqueness never lapses even
--     conceptually (the whole body is one runner-owned tx regardless).
--   * Idempotence: renames and ADD CONSTRAINT have no IF [NOT] EXISTS form,
--     so they are guarded by catalog lookups in DO blocks — re-applying this
--     body is a no-op, matching the house pattern (002 §9, 020).
--   * DEPLOYMENT: NOT expand/contract — the rename breaks pre-049 server
--     code that reads `entry_id`. Apply together with the matching server
--     release (046-style brief-downtime window), not while an old color is
--     still serving.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the bookkeeping write. (No CREATE INDEX
--   CONCURRENTLY — forbidden in a tx; the table is tiny, single-user app.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rename entry_id → vocab_entry_id (+ its FK constraint name).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'vocab_list_entries'
                  AND column_name = 'entry_id') THEN
        ALTER TABLE vocab_list_entries RENAME COLUMN entry_id TO vocab_entry_id;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'fk_vocab_list_entries_entry'
                  AND conrelid = 'vocab_list_entries'::regclass) THEN
        ALTER TABLE vocab_list_entries
            RENAME CONSTRAINT fk_vocab_list_entries_entry
                          TO fk_vocab_list_entries_vocab_entry;
    END IF;
END $$;

-- The XOR (below) takes over presence enforcement — exactly one target set.
ALTER TABLE vocab_list_entries ALTER COLUMN vocab_entry_id DROP NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. New target columns + FKs.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_list_entries ADD COLUMN IF NOT EXISTS kgiu_entry_id       BIGINT;
ALTER TABLE vocab_list_entries ADD COLUMN IF NOT EXISTS hanja_character_id  BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'fk_vocab_list_entries_kgiu_entry'
                      AND conrelid = 'vocab_list_entries'::regclass) THEN
        ALTER TABLE vocab_list_entries
            ADD CONSTRAINT fk_vocab_list_entries_kgiu_entry
                FOREIGN KEY (kgiu_entry_id) REFERENCES kgiu_entries(id)
                ON DELETE CASCADE ON UPDATE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'fk_vocab_list_entries_hanja_character'
                      AND conrelid = 'vocab_list_entries'::regclass) THEN
        ALTER TABLE vocab_list_entries
            ADD CONSTRAINT fk_vocab_list_entries_hanja_character
                FOREIGN KEY (hanja_character_id) REFERENCES hanja_characters(id)
                ON DELETE CASCADE ON UPDATE RESTRICT;
    END IF;
END $$;

COMMENT ON COLUMN vocab_list_entries.vocab_entry_id IS
    'Target: a corpus vocab word (vocab_entries.id). Exactly one of '
    'vocab_entry_id / kgiu_entry_id / hanja_character_id is set per row '
    '(ck_vocab_list_entries_target_xor). Renamed from entry_id in 049.';
COMMENT ON COLUMN vocab_list_entries.kgiu_entry_id IS
    'Target: a grammar pattern (kgiu_entries.id). NULL unless this membership '
    'is a grammar item. ON DELETE CASCADE — membership is transient (012).';
COMMENT ON COLUMN vocab_list_entries.hanja_character_id IS
    'Target: a hanja character (hanja_characters.id — the surrogate PK, not '
    'the natural char key). NULL unless this membership is a hanja item. '
    'ON DELETE CASCADE — membership is transient (012).';

-- -----------------------------------------------------------------------------
-- 3. Exactly-one-non-NULL target CHECK (mirrors ck_vocab_cards_target_xor).
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_list_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_list_entries_target_xor;
ALTER TABLE vocab_list_entries
    ADD CONSTRAINT ck_vocab_list_entries_target_xor CHECK (
        (CASE WHEN vocab_entry_id     IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN kgiu_entry_id      IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN hanja_character_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    );

-- -----------------------------------------------------------------------------
-- 4. Per-target partial UNIQUE indexes — one membership per (list, target) —
--    then retire the old two-column UNIQUE constraint they replace.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_list_entries_list_vocab
    ON vocab_list_entries (list_id, vocab_entry_id)
    WHERE vocab_entry_id IS NOT NULL;
COMMENT ON INDEX uq_vocab_list_entries_list_vocab IS
    'One vocab membership per (list, word). Partial — rows targeting grammar/'
    'hanja are excluded. Replaces uq_vocab_list_entries_list_entry (012).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_list_entries_list_kgiu
    ON vocab_list_entries (list_id, kgiu_entry_id)
    WHERE kgiu_entry_id IS NOT NULL;
COMMENT ON INDEX uq_vocab_list_entries_list_kgiu IS
    'One grammar membership per (list, pattern). Partial per the target XOR.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_list_entries_list_hanja
    ON vocab_list_entries (list_id, hanja_character_id)
    WHERE hanja_character_id IS NOT NULL;
COMMENT ON INDEX uq_vocab_list_entries_list_hanja IS
    'One hanja membership per (list, character). Partial per the target XOR.';

ALTER TABLE vocab_list_entries
    DROP CONSTRAINT IF EXISTS uq_vocab_list_entries_list_entry;

-- -----------------------------------------------------------------------------
-- 5. Entry-column indexes (the "missing index"): reverse lookups + FK scans.
--    012 shipped no index on entry_id, so "which lists hold word X" and the
--    referenced-side delete checks (RESTRICT probe on vocab_entries; CASCADE
--    scan on kgiu_entries / hanja_characters) were sequential scans.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_vocab_list_entries_vocab_entry
    ON vocab_list_entries (vocab_entry_id)
    WHERE vocab_entry_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_list_entries_vocab_entry IS
    'Reverse lookup ("lists containing word X") + the RESTRICT-FK orphan probe '
    'on vocab_entries deletes. Partial — most rows may target other types.';

CREATE INDEX IF NOT EXISTS ix_vocab_list_entries_kgiu_entry
    ON vocab_list_entries (kgiu_entry_id)
    WHERE kgiu_entry_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_list_entries_kgiu_entry IS
    'Reverse lookup + CASCADE-FK delete scan for kgiu_entries. Partial.';

CREATE INDEX IF NOT EXISTS ix_vocab_list_entries_hanja_character
    ON vocab_list_entries (hanja_character_id)
    WHERE hanja_character_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_list_entries_hanja_character IS
    'Reverse lookup + CASCADE-FK delete scan for hanja_characters. Partial.';

COMMENT ON TABLE vocab_list_entries IS
    'Membership rows for vocab_lists — polymorphic target (vocab word / KGIU '
    'grammar pattern / hanja character), exactly one *_id set per row (049). '
    'Hard-deleted on removal (no audit value). Per-target partial UNIQUE '
    'indexes make a duplicate add a 409, not silent.';

-- End of 049_vocab_list_entries_multitype.up.sql — runner owns the transaction (ADR-013).
