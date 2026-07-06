-- 037 (up): topik_attempts — resume an in-progress TOPIK mock test (F-007).
--
-- Feature: the mock exam (POST /topik/mock) is answer-stripped and taken over a
-- countdown timer; the picks / current index / remaining time live in React
-- state and are lost on reload. This table persists ONE in-progress attempt per
-- user so the mock-select screen can offer to resume it.
--
-- We do NOT snapshot the exam's items: POST /topik/mock with an explicit
-- `source_test` is deterministic (ORDER BY item_number LIMIT 50), so resume
-- re-fetches the IDENTICAL exam and restores the saved picks / index / timer.
--
-- Lifecycle: upserted as the user answers (one row per user — a new mock replaces
-- the old via ON CONFLICT); DELETEd on submit or when abandoned. No grading data
-- lives here — that stays in topik_responses, written on submit.
CREATE TABLE IF NOT EXISTS topik_attempts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT        NOT NULL,

    -- The mock section. Mock supports reading + listening only (writing mock is
    -- FU-NF-47) — enforced by the CHECK below even though the enum allows writing.
    section         topik_section NOT NULL,
    -- The test_number the exam was assembled from — replayed on resume so the
    -- deterministic re-fetch returns the identical item set.
    source_test     INTEGER       NOT NULL,
    -- 0-based index of the item the user was viewing.
    current_idx     INTEGER       NOT NULL DEFAULT 0,
    -- Picks so far: { "<topik_item_id>": "a"|"b"|"c"|"d" }.
    picks           JSONB         NOT NULL DEFAULT '{}'::jsonb,
    -- Milliseconds left on the countdown when last saved.
    remaining_ms    INTEGER       NOT NULL,

    -- Audit columns (ADR-001 §D6). updated_at is maintained by the trigger below.
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    version         INTEGER       NOT NULL DEFAULT 1,

    CONSTRAINT fk_topik_attempts_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_topik_attempts_section
        CHECK (section IN ('reading', 'listening')),
    CONSTRAINT ck_topik_attempts_current_idx_nonneg
        CHECK (current_idx >= 0),
    CONSTRAINT ck_topik_attempts_remaining_nonneg
        CHECK (remaining_ms >= 0),
    CONSTRAINT ck_topik_attempts_source_test_positive
        CHECK (source_test > 0),
    CONSTRAINT ck_topik_attempts_picks_object
        CHECK (jsonb_typeof(picks) = 'object'),
    CONSTRAINT ck_topik_attempts_version_positive
        CHECK (version >= 1)
);

-- One in-progress attempt per user: the resume banner shows a single test, and a
-- new mock upserts onto this key (ON CONFLICT (user_id)). A row's mere existence
-- means "in progress" — it is deleted on submit / abandon, so no status column.
CREATE UNIQUE INDEX IF NOT EXISTS uq_topik_attempts_user
    ON topik_attempts (user_id);

CREATE TRIGGER trg_topik_attempts_updated_at
    BEFORE UPDATE ON topik_attempts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
