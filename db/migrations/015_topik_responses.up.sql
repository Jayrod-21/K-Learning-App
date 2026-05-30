-- =============================================================================
-- Migration 015 — TOPIK Prep answer log (Pass 6, TOPIK Prep Study mode + Mock)
--   UP — adds `topik_responses`, an APPEND-ONLY attempt log: one row per
--        graded answer the user submits via POST /topik/:itemId/answer. A user
--        may re-attempt the same item any number of times (study is a drill, not
--        a one-shot exam), so this is a log, not a per-(user, item) state row —
--        every attempt is a new row, never an update.
--   Reverse: 015_topik_responses.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()),
--               005_lesson_podcast_topik (topik_items).
--
-- DESIGN NOTES
--   * APPEND-ONLY, no soft delete, no optimistic-concurrency gate on writes.
--     The route never UPDATEs a response: an answer is a fact ("at time T the
--     user picked 'b', which was wrong") that does not mutate. Re-answering the
--     same item is a brand-new row with a later `answered_at`. Analytics
--     ("accuracy over time", "items most often missed") read this log; rewriting
--     history would corrupt them. There is therefore nothing for a `version`
--     bump or a `deleted_at` to protect — but the audit columns are still
--     present for schema consistency with every other entity table (ADR-001 §D6)
--     and to leave room for a future admin redaction without a migration.
--   * topik_item_id → topik_items(id) ON DELETE RESTRICT. `topik_items` is
--     curated reference data (migration 005). RESTRICT means a corpus item that
--     a learner has already answered cannot be silently hard-deleted out from
--     under its response rows — the deletion must explicitly clean up (or, in
--     practice, never happen: the corpus is append/upsert-only). This mirrors the
--     existing reference-data FK posture (vocab_cards.topik_item_id,
--     vocab_list_entries.entry_id) per Bar §1 ("RESTRICT for reference data").
--   * user_id → users(id) ON DELETE CASCADE. A response belongs to its user; when
--     the account is hard-purged the answer log goes with it (it has no value
--     detached from the user, unlike the reference item it points at).
--   * `picked` is TEXT + CHECK in ('a','b','c','d') rather than an enum: the
--     choice-id set is tiny and stable, but a TEXT + CHECK keeps it co-located
--     with the table (no cross-migration enum to coordinate) and matches how the
--     diagnostic stores `correct_answer`/`picked` as a bare choice id. There is
--     no 'skip'/null pick here: TOPIK study always commits one of the four
--     choices (the client disables submit until a choice is selected); a future
--     skip would widen the CHECK, not require a schema rebuild.
--   * `mode` is TEXT + CHECK in ('study','mock'): which assembly the answer came
--     from, so analytics can separate low-stakes drilling from full mock runs.
--     Defaults to 'study' (the only LIVE mode this pass; mock is a server route
--     whose client UI is deferred to FU-NF-39).
--   * `time_ms` is NULLABLE (the only nullable non-audit column): the client may
--     not always have a reliable per-item timer (e.g. resumed after a reload), so
--     "unknown" is a real, distinct value from "0 ms". CHECK keeps it non-negative
--     when present.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- topik_responses — append-only log of graded TOPIK answers.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topik_responses (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,
    topik_item_id   BIGINT      NOT NULL,

    -- The choice id the user committed: 'a'|'b'|'c'|'d'.
    picked          TEXT        NOT NULL,
    -- Server-side grade of `picked` against the item's 1-based `answer`.
    is_correct      BOOLEAN     NOT NULL,
    -- Which assembly served the item: 'study' (shuffled cross-test draw) or
    -- 'mock' (full original-order test). Default 'study' — the only live mode.
    mode            TEXT        NOT NULL DEFAULT 'study',
    -- Optional client-reported time-on-item, milliseconds. NULL = unknown
    -- (distinct from 0). See module note.
    time_ms         INTEGER,
    -- When the answer was submitted (the analytics time axis).
    answered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Audit columns (ADR-001 §D6). Present for schema consistency even though the
    -- table is append-only and the route never UPDATEs a row.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_topik_responses_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Reference data — never orphan-delete a corpus item beneath a response.
    CONSTRAINT fk_topik_responses_topik_item
        FOREIGN KEY (topik_item_id) REFERENCES topik_items(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT ck_topik_responses_picked
        CHECK (picked IN ('a', 'b', 'c', 'd')),
    CONSTRAINT ck_topik_responses_mode
        CHECK (mode IN ('study', 'mock')),
    CONSTRAINT ck_topik_responses_time_ms_nonneg
        CHECK (time_ms IS NULL OR time_ms >= 0),
    CONSTRAINT ck_topik_responses_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE topik_responses IS
    'Append-only log of graded TOPIK Prep answers (Pass 6). One row per submitted '
    'answer via POST /topik/:itemId/answer; a user may re-attempt an item, so '
    'duplicate (user_id, topik_item_id) pairs are expected and intended — this is '
    'a log, not per-item state. Powers accuracy/weak-area analytics. Per-user '
    'isolation enforced at the route layer (every write stamped with the session '
    'user via getUserId, never a client-supplied id).';
COMMENT ON COLUMN topik_responses.picked IS
    'Choice id the user committed: a|b|c|d. CHECK constrains the set; TEXT (not '
    'enum) keeps the tiny, stable set co-located with the table.';
COMMENT ON COLUMN topik_responses.is_correct IS
    'Server-side grade: picked === (the item''s 1-based answer mapped to a 0-based '
    'choice index). The client never sends this flag; the server derives it.';
COMMENT ON COLUMN topik_responses.mode IS
    'Assembly the answer came from: study (shuffled cross-test draw) or mock '
    '(full original-order test). Default study — the only LIVE mode this pass.';
COMMENT ON COLUMN topik_responses.time_ms IS
    'Optional client-reported time-on-item (ms). NULL = unknown (distinct from 0). '
    'CHECK enforces non-negative when present.';
COMMENT ON COLUMN topik_responses.answered_at IS
    'Submission time — the analytics time axis. Defaults to now() at insert.';

DROP TRIGGER IF EXISTS trg_topik_responses_updated_at ON topik_responses;
CREATE TRIGGER trg_topik_responses_updated_at
    BEFORE UPDATE ON topik_responses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Query 1: "this user's attempts at this item" (per-item accuracy, "have I seen
-- this before / how did I do"). The (user_id, topik_item_id) lead matches the
-- equality predicate analytics joins on.
CREATE INDEX IF NOT EXISTS ix_topik_responses_user_item
    ON topik_responses (user_id, topik_item_id);
COMMENT ON INDEX ix_topik_responses_user_item IS
    'Supports per-(user, item) attempt lookups (accuracy, repeat-attempt history) '
    'for the TOPIK Prep analytics surface. Lead column user_id is the tenant '
    'predicate; topik_item_id narrows to one item.';

-- Query 2: "this user's recent answers, newest first" (activity feed, rolling
-- accuracy window). DESC matches the ORDER BY the activity view will use.
CREATE INDEX IF NOT EXISTS ix_topik_responses_user_answered_at
    ON topik_responses (user_id, answered_at DESC);
COMMENT ON INDEX ix_topik_responses_user_answered_at IS
    'Supports "this user''s recent answers, newest first" (rolling-accuracy / '
    'activity views). (user_id, answered_at DESC) matches the tenant predicate + '
    'reverse-chronological ORDER BY.';

-- End of 015_topik_responses.up.sql — runner owns the transaction (ADR-013).
