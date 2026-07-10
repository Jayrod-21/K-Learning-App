-- =============================================================================
-- Migration 049 — vocab_list_entries goes multi-type (F-048 / F-060 / F-061)
--   UP — widens list membership from vocab-only to a vocab / grammar / hanja
--        target XOR, mirroring the `vocab_cards` polymorphic-target pattern
--        (001: exactly-one-non-NULL CHECK across the target ids + per-target
--        partial indexes). ADD-ONLY EXPAND — no rename, no drop:
--          * `entry_id` (the 012 vocab target) KEEPS its name; only its
--            NOT NULL is dropped (the XOR CHECK takes over presence
--            enforcement);
--          * ADD `kgiu_entry_id`  BIGINT → kgiu_entries(id)      (grammar);
--          * ADD `hanja_character_id` BIGINT → hanja_characters(id) (hanja —
--            the surrogate PK, NOT the natural `char` key; `hanja_progress`
--            deliberately decouples via TEXT, but list membership is transient
--            and hard-deleted, so the FK is the right tool here);
--          * exactly-one-non-NULL CHECK across the three target columns;
--          * per-target partial UNIQUE indexes for the NEW columns — one
--            membership per (list, target). The vocab leg keeps 012's
--            UNIQUE (list_id, entry_id): under Postgres's NULLs-distinct
--            semantics it already IS the per-target guarantee for vocab
--            (grammar/hanja rows carry entry_id NULL and never collide);
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
--   * BACK-COMPAT: every pre-049 row is a vocab membership. `entry_id` keeps
--     its name and its values in place; the two new columns default to NULL,
--     so every existing row satisfies the new XOR CHECK without a data
--     transform.
--   * NAMING: `entry_id` deliberately does NOT become `vocab_entry_id`
--     (vocab_cards-style). A live-column RENAME is invisible to migrate.py's
--     destructive gate yet breaks every pre-049 query the still-serving old
--     color runs (42703) — an expand/contract violation the blue/green flow
--     cannot survive. Naming uniformity is aesthetics; zero-downtime is
--     correctness. If the rename is ever wanted, it ships as its own
--     contract-phase migration once no pre-rename code can be serving.
--   * `vocab_lists.kind` needs NO change — 012 already CHECKs it to
--     vocab/grammar/hanja/mixed, anticipating exactly this widening. `kind`
--     stays an advisory display hint: the DB does not force a list's
--     memberships to match its kind (012's bar: business rules that the UX
--     may still bend — e.g. a 'vocab' list the user drops one hanja into —
--     live in code, not in the schema).
--   * FK posture:
--       - entry_id keeps 012's fk_vocab_list_entries_entry untouched
--         (ON DELETE RESTRICT). Changing it would silently alter documented
--         012 behavior for existing data, and the orphan-check flow around
--         vocab corpus reloads relies on it.
--       - kgiu_entry_id / hanja_character_id are ON DELETE CASCADE (per the
--         F-048/F-060/F-061 spec): membership is transient with no audit
--         value (012's own rationale for hard delete), so when a grammar or
--         hanja reference row is purged the membership row simply goes with
--         it. SET NULL is not an option — it would trip the XOR CHECK and
--         abort the parent DELETE with a confusing error (the same reasoning
--         as 001's fk_vocab_cards_grammar_entry comment, resolved the other
--         way because these memberships, unlike cards, carry no FSRS state
--         worth protecting).
--   * The 012 UNIQUE (list_id, entry_id) constraint is KEPT, not swapped for
--     a partial index: NULLs-distinct means it constrains exactly the rows
--     with entry_id set (one vocab membership per (list, word)) and ignores
--     grammar/hanja rows entirely — identical enforcement, zero churn, and
--     any old-color code paths that rely on the constraint keep working.
--     Each new target type dedupes independently via its own partial UNIQUE
--     (vocab id 7 and kgiu id 7 may both live in one list).
--   * Idempotence: ADD CONSTRAINT has no IF NOT EXISTS form, so FKs are
--     guarded by catalog lookups in DO blocks — re-applying this body is a
--     no-op, matching the house pattern (002 §9, 020).
--   * DEPLOYMENT: expand/contract-compliant (ADD COLUMN / ADD CONSTRAINT /
--     DROP NOT NULL only). Pre-049 server code keeps working unmodified while
--     this is applied: its INSERTs set only entry_id (satisfying the XOR),
--     its SELECTs still resolve, and its INNER JOIN to vocab_entries simply
--     skips any grammar/hanja rows a newer color may have written. Ships via
--     the standard zero-downtime blue/green flow; rollback-by-flip stays
--     valid.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the bookkeeping write. (No CREATE INDEX
--   CONCURRENTLY — forbidden in a tx; the table is tiny, single-user app.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. entry_id: presence enforcement moves to the XOR CHECK (below) — exactly
--    one target set per row. The column itself is untouched otherwise.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_list_entries ALTER COLUMN entry_id DROP NOT NULL;

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

COMMENT ON COLUMN vocab_list_entries.entry_id IS
    'Target: a corpus vocab word (vocab_entries.id). Exactly one of '
    'entry_id / kgiu_entry_id / hanja_character_id is set per row '
    '(ck_vocab_list_entries_target_xor). Keeps its 012 name — deliberately '
    'NOT renamed to vocab_entry_id (expand/contract; see the 049 up header).';
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
        (CASE WHEN entry_id           IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN kgiu_entry_id      IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN hanja_character_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    );

-- -----------------------------------------------------------------------------
-- 4. Per-target partial UNIQUE indexes for the NEW columns — one membership
--    per (list, target). The vocab leg needs nothing: 012's
--    uq_vocab_list_entries_list_entry (kept) already enforces one vocab
--    membership per (list, word), and NULLs-distinct means grammar/hanja rows
--    (entry_id NULL) never collide under it.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 5. Entry-column indexes (the "missing index"): reverse lookups + FK scans.
--    012 shipped no index leading on entry_id, so "which lists hold word X"
--    and the referenced-side delete checks (RESTRICT probe on vocab_entries;
--    CASCADE scan on kgiu_entries / hanja_characters) were sequential scans.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_vocab_list_entries_entry
    ON vocab_list_entries (entry_id)
    WHERE entry_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_list_entries_entry IS
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
    'Hard-deleted on removal (no audit value). Per-target uniqueness (the 012 '
    'UNIQUE for vocab; partial UNIQUE indexes for grammar/hanja) makes a '
    'duplicate add a 409, not silent.';

-- End of 049_vocab_list_entries_multitype.up.sql — runner owns the transaction (ADR-013).
