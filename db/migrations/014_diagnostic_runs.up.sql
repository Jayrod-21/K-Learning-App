-- =============================================================================
-- Migration 014 — Diagnostic runs + responses (Pass 5, "Diagnostic goes live")
--   UP — adds the two tables that back the live, server-graded, CAT-lite
--        diagnostic flow:
--          * `diagnostic_runs`      — one row per started run (the CAT session).
--          * `diagnostic_responses` — one row per item served within a run.
--        The FINISHED estimates still land in `diagnostic_snapshots` (migration
--        001); a run points at the snapshot it produced via `snapshot_id`. We
--        do NOT recreate `diagnostic_snapshots` — only FK to it.
--   Reverse: 014_diagnostic_runs.down.sql
--   Depends on: 001_core_schema (users, diagnostic_snapshots, set_updated_at()).
--
-- DESIGN NOTES
--   * Two tables, parent/child. `diagnostic_runs` is the session; an item is a
--     `diagnostic_responses` row, served then later answered/skipped. We split
--     them (rather than a JSONB array on the run) so each served item is a
--     first-class row with its own UNIQUE (run_id, ordinal) ordering guarantee,
--     its own `correct_answer` private column, and a clean per-item answer
--     transition — exactly the 3NF the bar asks for.
--   * `correct_answer` is a COLUMN, never part of the JSONB the client receives.
--     This is THE security property of the pass: grading is server-side and the
--     correct choice is withheld until the answer round-trip reveals it. The
--     client's `item_payload` view is answer-stripped at the route layer; the
--     raw correct choice id lives only here. See SECURITY.md §13
--     (answer-tampering defense).
--   * Runs are HARD-deleted with the user (ON DELETE CASCADE) — a run in flight
--     has no standalone audit value; the durable record of a *finished*
--     diagnostic is the `diagnostic_snapshots` row, which is soft-deleted and
--     survives independently (`snapshot_id` is ON DELETE SET NULL so dropping a
--     snapshot never cascades back into run history).
--   * `ability_estimate` is the running CAT θ on the 0–6 TOPIK scale, NULL until
--     the first answer updates it. `target_item_count` defaults to 8 (the locked
--     product decision: 2 each of reading/listening/vocab/grammar) but is a
--     column so a future longer/shorter diagnostic needs no migration.
--   * `picked` NULL is overloaded: NULL + `answered_at` NULL  = not yet answered;
--     NULL + `answered_at` set = an explicit SKIP. The route distinguishes the
--     two via `answered_at`; `is_correct` is set FALSE on skip so scoring needs
--     no special-case.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. diagnostic_runs — one row per started CAT-lite diagnostic session
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic_runs (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             BIGINT      NOT NULL,

    -- Lifecycle. A run is 'in_progress' from creation until /finish flips it to
    -- 'finished'; 'abandoned' is reserved for a future explicit-abandon endpoint
    -- (Pass 5 does not write it — exit mid-run simply leaves the row in
    -- 'in_progress').
    status              TEXT        NOT NULL DEFAULT 'in_progress',

    -- Running CAT ability estimate θ on the 0–6 TOPIK scale. NULL until the
    -- first graded answer; thereafter the latest θ after the staircase update.
    ability_estimate    NUMERIC(3, 2),

    -- How many items this run intends to serve. Default 8 = 2 each of
    -- reading/listening/vocab/grammar (locked product decision). A column, not a
    -- literal, so a longer/shorter diagnostic is config, not a migration.
    target_item_count   INTEGER     NOT NULL DEFAULT 8,

    -- The snapshot this run produced on /finish. NULL while in progress. SET
    -- NULL (not CASCADE) on snapshot delete: soft-deleting a snapshot must not
    -- destroy the run history that references it.
    snapshot_id         BIGINT,

    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,

    -- Audit columns (ADR-001 §D6)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_diagnostic_runs_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_diagnostic_runs_snapshot
        FOREIGN KEY (snapshot_id) REFERENCES diagnostic_snapshots(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT ck_diagnostic_runs_status
        CHECK (status IN ('in_progress', 'finished', 'abandoned')),
    CONSTRAINT ck_diagnostic_runs_ability_range
        CHECK (ability_estimate IS NULL OR ability_estimate BETWEEN 0 AND 6),
    CONSTRAINT ck_diagnostic_runs_target_count_range
        CHECK (target_item_count BETWEEN 1 AND 40),
    CONSTRAINT ck_diagnostic_runs_version_positive
        CHECK (version >= 1),
    -- A finished run must carry its finish timestamp, and only a finished run
    -- may carry one. Keeps the lifecycle honest at the DB layer.
    CONSTRAINT ck_diagnostic_runs_finished_at
        CHECK (
            (status = 'finished' AND finished_at IS NOT NULL)
            OR (status <> 'finished' AND finished_at IS NULL)
        )
);

COMMENT ON TABLE diagnostic_runs IS
    'One row per started CAT-lite diagnostic session. Hard-deleted with the user '
    '(in-flight runs have no standalone audit value); the durable record of a '
    'finished diagnostic is the soft-deleted diagnostic_snapshots row this points '
    'at. Per-user isolation enforced at the route layer (every read filters by '
    'user_id; runId is never trusted for ownership alone).';
COMMENT ON COLUMN diagnostic_runs.ability_estimate IS
    'Running CAT θ on the 0–6 TOPIK scale. NULL until the first graded answer; '
    'thereafter the latest θ after the staircase-with-decay update (see '
    'services/diagnostic/cat.ts). The full θ trajectory is persisted into the '
    'snapshot evidence on finish.';
COMMENT ON COLUMN diagnostic_runs.target_item_count IS
    'Items this run intends to serve. Default 8 = 2 each reading/listening/vocab/'
    'grammar. A column (not a literal) so a longer/shorter diagnostic is config.';
COMMENT ON COLUMN diagnostic_runs.snapshot_id IS
    'The diagnostic_snapshots row produced on /finish. NULL while in progress. '
    'ON DELETE SET NULL — soft-deleting a snapshot must not cascade into run '
    'history.';
COMMENT ON COLUMN diagnostic_runs.status IS
    'Lifecycle: in_progress → finished. abandoned is reserved for a future '
    'explicit-abandon endpoint; Pass 5 never writes it.';

-- Query: "the latest run(s) for a user, newest first" — /diagnostic/latest and
-- idempotent /finish lookups walk a user's runs by recency.
CREATE INDEX IF NOT EXISTS ix_diagnostic_runs_user_started
    ON diagnostic_runs (user_id, started_at DESC);
COMMENT ON INDEX ix_diagnostic_runs_user_started IS
    'Supports per-user run lookup newest-first (resume / finish-idempotency / '
    'most-recent-run checks). (user_id, started_at DESC) matches the ORDER BY.';

CREATE OR REPLACE TRIGGER trg_diagnostic_runs_updated_at
    BEFORE UPDATE ON diagnostic_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. diagnostic_responses — one row per item served within a run
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic_responses (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id              BIGINT      NOT NULL,

    -- 1-based order served within the run. UNIQUE (run_id, ordinal) so the CAT
    -- schedule can never double-serve a slot, and the route can address "the
    -- current unanswered item" by ordinal deterministically.
    ordinal             INTEGER     NOT NULL,

    -- Diagnostic dimension this item probes. NOTE: 'vocab'/'grammar' are NOT
    -- members of the topik_section enum (which is reading/listening/writing
    -- only), so this is a TEXT + CHECK, not the enum — the four diagnostic
    -- dimensions are a superset of the corpus sections.
    section             TEXT        NOT NULL,

    -- Where the item came from. 'topik' = a row pulled from topik_items
    -- (reading/listening); 'generated' = a Claude-authored item seeded from a
    -- vocab_entries / kgiu_entries row (vocab/grammar).
    source_kind         TEXT        NOT NULL,

    -- topik_items.id::text when source_kind='topik'; the seed entry id when
    -- 'generated'. Nullable: a generated item that picked no seed (empty pool)
    -- still records a response with a NULL ref.
    source_ref          TEXT,

    -- Served item difficulty on the 0–6 scale (= band(θ) at serve time).
    difficulty          NUMERIC(3, 2) NOT NULL,

    -- DiagnosticItemKind: cloze/synonym/pattern/passage-mc/inference/audio-mc.
    -- Open set (the kinds may grow), so TEXT, not an enum.
    kind                TEXT        NOT NULL,

    -- Full server-side copy of the served item: prompt, passage, audio, choices,
    -- AND explain. The client receives an answer-stripped subset built at the
    -- route layer — this column and `correct_answer` below never reach the wire
    -- before reveal.
    item_payload        JSONB       NOT NULL,

    -- The correct choice id ('a'|'b'|'c'|'d'). COLUMN-PRIVATE: never serialized
    -- into a ClientItem. Grading compares the user's `picked` against this
    -- server-side. This is the answer-tampering defense (SECURITY.md §13).
    correct_answer      TEXT        NOT NULL,

    -- The user's chosen choice id. NULL until answered; NULL + answered_at set
    -- also encodes an explicit SKIP (see module note).
    picked              TEXT,
    -- Grading result. NULL until answered; a skip resolves to FALSE so scoring
    -- needs no special-case.
    is_correct          BOOLEAN,
    -- Client-reported think time in ms. Best-effort; never trusted for anything
    -- but analytics, hence nullable and only range-checked.
    time_ms             INTEGER,

    served_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at         TIMESTAMPTZ,

    CONSTRAINT fk_diagnostic_responses_run
        FOREIGN KEY (run_id) REFERENCES diagnostic_runs(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_diagnostic_responses_run_ordinal
        UNIQUE (run_id, ordinal),
    CONSTRAINT ck_diagnostic_responses_ordinal_pos
        CHECK (ordinal >= 1),
    CONSTRAINT ck_diagnostic_responses_section
        CHECK (section IN ('vocab', 'grammar', 'reading', 'listening')),
    CONSTRAINT ck_diagnostic_responses_source_kind
        CHECK (source_kind IN ('topik', 'generated')),
    CONSTRAINT ck_diagnostic_responses_difficulty_range
        CHECK (difficulty BETWEEN 0 AND 6),
    CONSTRAINT ck_diagnostic_responses_time_ms
        CHECK (time_ms IS NULL OR time_ms >= 0),
    CONSTRAINT ck_diagnostic_responses_payload_object
        CHECK (jsonb_typeof(item_payload) = 'object')
);

COMMENT ON TABLE diagnostic_responses IS
    'One row per item served within a diagnostic run. Cascades with the run. '
    'Holds the full server-side item copy plus the column-private correct_answer '
    'so grading happens server-side and the answer is never sent to the client '
    'before reveal (answer-tampering defense, SECURITY.md §13).';
COMMENT ON COLUMN diagnostic_responses.correct_answer IS
    'Correct choice id (a|b|c|d). COLUMN-PRIVATE — never serialized into a '
    'ClientItem. Withheld until the answer round-trip reveals it. THE security '
    'property of Pass 5: grading is server-side, the client cannot tamper the '
    'verdict because it never holds the key.';
COMMENT ON COLUMN diagnostic_responses.item_payload IS
    'Full server copy of the served item (prompt/passage/audio/choices/explain). '
    'The client gets an answer-stripped subset assembled at the route layer.';
COMMENT ON COLUMN diagnostic_responses.picked IS
    'Chosen choice id. NULL until answered. NULL + answered_at set = explicit '
    'SKIP (the route distinguishes via answered_at).';
COMMENT ON COLUMN diagnostic_responses.is_correct IS
    'Grading result. NULL until answered; a skip resolves to FALSE so per-dim '
    'scoring needs no special-case.';
COMMENT ON COLUMN diagnostic_responses.source_ref IS
    'topik_items.id::text when source_kind=topik; seed entry id when generated. '
    'Nullable: a generated item with no available seed records a NULL ref.';

-- Query: "the items of a run in serve order" — every /answer and /finish call
-- walks a run's responses by ordinal. The UNIQUE constraint already provides
-- the (run_id, ordinal) B-tree, but we name it explicitly via COMMENT here for
-- the next engineer; the UNIQUE index IS the supporting index.
CREATE INDEX IF NOT EXISTS ix_diagnostic_responses_run_ordinal
    ON diagnostic_responses (run_id, ordinal);
COMMENT ON INDEX ix_diagnostic_responses_run_ordinal IS
    'Supports walking a run''s served items in order (answer-grading, '
    'finish-scoring, current-item lookup). (run_id, ordinal) matches the ORDER BY.';

-- End of 014_diagnostic_runs.up.sql — runner owns the transaction (ADR-013).
