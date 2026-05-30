-- =============================================================================
-- Migration 012 — User-defined vocab lists (Pass 3, Review → Lists tab)
--   UP — adds `vocab_lists` (parent) + `vocab_list_entries` (membership) so a
--        user can curate themed sets of vocab_entries for the Review screen's
--        Lists tab. Standard parent/child pattern; per-user isolation enforced
--        by FK to users + every read scoped to user_id at the application
--        layer (see Repository/server/src/routes/vocabLists.ts).
--   Reverse: 012_vocab_lists.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()),
--               002_darakwon_corpora (vocab_entries).
--
-- DESIGN NOTES
--   * `vocab_lists` rows are SOFT-deleted. A list can be referenced from study
--     history (FU candidate: a future `vocab_list_studied_at` log row), and
--     hard-deleting would orphan that audit trail. Soft delete keeps the row;
--     hard purge is an admin operation (mirrors `users.deleted_at`).
--   * `vocab_list_entries` is hard-deleted on removal. Membership is transient;
--     no audit value worth a `deleted_at` column. UNIQUE on (list_id,
--     entry_id) makes "add an entry already in the list" a 409, not a silent
--     duplicate (Bar §"Idempotency": every state-changing op is idempotent).
--   * `position` is INT NOT NULL with no UNIQUE constraint inside a list. Two
--     entries can share a position (e.g., after a remove-and-reorder race).
--     Reorder UX in Pass Final will rewrite positions; until then, ties break
--     by `added_at` ASC, then `entry_id` ASC. Adding a UNIQUE here would force
--     all callers to renumber on every removal, which is the kind of brittle
--     business rule the bar says belongs in code, not the DB (Bar §1 "No
--     business logic in the DB").
--   * `kind` is a TEXT + CHECK (open-set style) rather than a Postgres enum:
--      'vocab' and 'grammar' and 'hanja' are the design's three "review
--      tracks" today; 'mixed' is the catch-all for cross-track lists. We
--      expect more (e.g. 'reading_passage') so a TEXT + CHECK is cheaper to
--      grow than an enum that needs ALTER TYPE migrations.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. vocab_lists — one row per user-curated list
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vocab_lists (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- Korean display name (the field the design shows large on the list card).
    name_kr         TEXT        NOT NULL,
    -- Optional English label (the small caption under the Korean name).
    name_en         TEXT,

    -- Track this list belongs to. Pass 3 only wires vocab; the schema is
    -- forward-compatible.
    kind            TEXT        NOT NULL DEFAULT 'vocab',

    -- Audit columns (ADR-001 D6)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    -- Soft delete — lists are referenced from study history.
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT fk_vocab_lists_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_vocab_lists_name_kr_length
        CHECK (length(name_kr) BETWEEN 1 AND 120),
    CONSTRAINT ck_vocab_lists_name_en_length
        CHECK (name_en IS NULL OR length(name_en) BETWEEN 1 AND 120),
    CONSTRAINT ck_vocab_lists_kind
        CHECK (kind IN ('vocab', 'grammar', 'hanja', 'mixed')),
    CONSTRAINT ck_vocab_lists_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE vocab_lists IS
    'User-defined collections of vocab_entries. Powers Review screen "Lists" '
    'tab. Soft-deleted so study history can keep referring back. Per-user '
    'isolation enforced at the route layer (every read filters by user_id).';
COMMENT ON COLUMN vocab_lists.name_kr IS 'Korean display name (1–120 chars).';
COMMENT ON COLUMN vocab_lists.name_en IS 'Optional English caption (1–120 chars).';
COMMENT ON COLUMN vocab_lists.kind IS
    'Review track. CHECK constrains to vocab/grammar/hanja/mixed; TEXT (not '
    'enum) so adding a track later is a CHECK swap, not an ALTER TYPE.';
COMMENT ON COLUMN vocab_lists.deleted_at IS
    'Soft delete. When set, the list is treated as deleted. Studied-list '
    'history can still join to this row via id (FK RESTRICT on future tables).';

-- Query 1: "list a user's live lists, newest first". Partial on deleted_at IS NULL
-- because the listing view filters them out and most rows are live.
CREATE INDEX IF NOT EXISTS ix_vocab_lists_user_updated
    ON vocab_lists (user_id, updated_at DESC)
    WHERE deleted_at IS NULL;
COMMENT ON INDEX ix_vocab_lists_user_updated IS
    'Supports GET /vocab/lists — "list user lists, recent first" with the live '
    'filter. Partial on deleted_at IS NULL because the listing endpoint always '
    'excludes soft-deleted rows.';

CREATE OR REPLACE TRIGGER trg_vocab_lists_updated_at
    BEFORE UPDATE ON vocab_lists
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. vocab_list_entries — membership: vocab_lists ←→ vocab_entries
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vocab_list_entries (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    list_id         BIGINT      NOT NULL,
    entry_id        BIGINT      NOT NULL,

    -- 0-based ordinal within the list. See module comment for "why not UNIQUE
    -- inside a list". Always non-negative.
    position        INTEGER     NOT NULL,

    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_vocab_list_entries_list
        FOREIGN KEY (list_id) REFERENCES vocab_lists(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- vocab_entries is reference data — deleting a corpus row underneath a
    -- user-curated list is a footgun. RESTRICT forces the deletion to
    -- explicitly clean up memberships first. Matches the existing
    -- vocab_cards.vocab_entry_id FK posture (ADR-007 + bar §1).
    CONSTRAINT fk_vocab_list_entries_entry
        FOREIGN KEY (entry_id) REFERENCES vocab_entries(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT uq_vocab_list_entries_list_entry
        UNIQUE (list_id, entry_id),
    CONSTRAINT ck_vocab_list_entries_position_nonneg
        CHECK (position >= 0)
);

COMMENT ON TABLE vocab_list_entries IS
    'Membership rows for vocab_lists. Hard-deleted on removal (no audit value '
    'worth a deleted_at column). UNIQUE (list_id, entry_id) makes duplicate '
    'adds a 409, not silent.';
COMMENT ON COLUMN vocab_list_entries.position IS
    '0-based ordinal within the list. Not UNIQUE — ties break by added_at '
    'then entry_id at read time.';

-- Query 1: "list entries of a list, in display order".
CREATE INDEX IF NOT EXISTS ix_vocab_list_entries_list_position
    ON vocab_list_entries (list_id, position, added_at);
COMMENT ON INDEX ix_vocab_list_entries_list_position IS
    'Supports GET /vocab/lists/:id — entries in display order, ties broken by '
    'added_at. (list_id, position, added_at) matches the ORDER BY.';

-- End of 012_vocab_lists.up.sql — runner owns the transaction (ADR-013).
