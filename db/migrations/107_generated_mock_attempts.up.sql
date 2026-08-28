-- migrate: non-destructive
-- =============================================================================
-- Migration 107 — generated_mock_attempts (F-220 P3: the generated-bank mock-
--   exam surface — assembling approved `generated_items` P1 paired-stimulus
--   groups + P2 single-item types + the P0 base passage-mc/audio-mc into an
--   authentic-shaped TOPIK section, behind the default-off
--   TOPIK_MOCK_USE_GENERATED_BANK flag)
--   UP — creates `generated_mock_attempts`: ONE row per learner's generated-
--        mock sitting, holding a byte-for-byte SNAPSHOT of the assembled item
--        set (server-side answers + client-safe fields, ordered per the
--        blueprint — see server/src/services/topik/generatedMock.ts) so
--        resume and grading are STABLE even if the underlying bank changes
--        between "start" and "submit" (the same reason `diagnostic_snapshots`
--        / `diagnostic_responses.item_payload` snapshot-by-value instead of
--        re-querying at grade time).
--   Reverse: 107_generated_mock_attempts.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()).
--
-- WHY A NEW TABLE, NOT topik_attempts/topik_responses (ADR-013 clean
--   separation, per the F-220 P3 build brief)
--   topik_attempts.source_test is a REAL `topik_tests.test_number` and
--   topik_responses.topik_item_id is a HARD FK to topik_items(id) — a
--   generated_items id (or a synthesized paired-stimulus-group question,
--   which has no single generated_items row of its own) cannot be written
--   into either column without corrupting the copyrighted-mock semantics
--   those two tables exist to keep clean (RECON_mock_exams.md "Structural
--   mismatches"). `diagnostic_responses` solved the identical problem
--   (source_kind/source_ref/item_payload, no FK) — this table is that same
--   snapshot-by-value pattern, applied at the ATTEMPT granularity (one row
--   per sitting, not one row per answer) because the generated mock, like
--   the real one, needs resume state (current_index/remaining_ms/picks) in
--   addition to the graded outcome.
--
-- WHY ONE ROW PER (user, tier, section) IN-PROGRESS SITTING, PARTIAL UNIQUE
--   Mirrors `topik_attempts`' `uq_topik_attempts_user` posture (037), scoped
--   one step further to `(user_id, tier, section)` — the build brief's locked
--   design is "One in-progress attempt per (user, section+tier)", not one
--   per user across every tier/section combination, since a learner may
--   reasonably have a TOPIK I reading generated-mock in progress at the same
--   time as a TOPIK II listening one; they are unrelated sittings.
--
-- WHY item_set/picks ARE JSONB, NOT CHILD TABLES
--   `item_set` is written ONCE at assembly time (POST .../generated) and read
--   back whole on every resume/submit — never queried per-element server-side
--   (the assembler already resolved every field; grading walks the array in
--   application code, exactly like topik_attempts.picks / diagnostic_
--   snapshots.raw_json). A child table would buy nothing but join overhead
--   for a payload that is always read/written as one unit per attempt.
--
-- WHY score_percentage/band/finished_at ARE NULLABLE, TIED TO status BY A
--   CHECK (not split into a separate "results" table)
--   Mirrors topik_attempts' completed/active split (046) but folded into ONE
--   row per attempt (no separate history table exists yet for the generated
--   surface — P3 is the mock-taking flow itself, not attempt history/A1
--   parity, which is a later slice if ever built). The CHECK enforces "graded
--   fields exist iff status='completed'" as a database guarantee, not just an
--   application convention — the same shape 105's stimulus-group-pair CHECK
--   uses for a different pair of columns.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write.
--
-- Manual application: psql -v ON_ERROR_STOP=1 -1 -f 107_generated_mock_attempts.up.sql
-- (NOT recommended in production — use migrate.py; manual psql application
-- desyncs schema_migrations and breaks the next deploy.)
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

CREATE TABLE IF NOT EXISTS generated_mock_attempts (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      NOT NULL,

    -- TOPIK I vs TOPIK II — the tier discriminator for the generated-bank
    -- composition (server's GeneratedMockTier: tier I pools generated_items
    -- level L1/L2, tier II pools L3/L4/L5+ — see generatedMock.ts). Deliberately
    -- 'I'/'II', NOT the real mock's 'TOPIK I'/'TOPIK II' string — this row
    -- names a GENERATED composition, never a real topik_tests paper, and the
    -- distinct value shape keeps the two surfaces impossible to confuse at a
    -- glance in any shared query/log.
    tier             TEXT        NOT NULL,
    section          TEXT        NOT NULL,

    -- The assembled, ORDERED item snapshot: server-side answers (correctChoiceId,
    -- explanation) + every client-safe field (id, kind, prompt, passage?,
    -- audioUrl?/audioStartMs?/audioEndMs?, choices) — see SnapshotMockItem in
    -- generatedMock.ts. Written ONCE by POST /topik/mock/generated; read back
    -- whole by the resume GET path (folded into the client response), the
    -- progress PUT (re-validated against, never trusted from the client), and
    -- the submit POST (the ONLY source of truth for grading — the client's
    -- picks are graded against THIS array, never re-drawn from generated_items,
    -- so a bank edit/retirement between start and submit cannot change an
    -- in-flight exam's questions or answer key).
    item_set         JSONB       NOT NULL,
    -- Picks so far: { "<SnapshotMockItem.id>": "a"|"b"|"c"|"d" }. Mirrors
    -- topik_attempts.picks exactly, keyed by the snapshot's own string item
    -- ids (generated items have no single numeric row id once flattened
    -- through a paired-stimulus group — see generatedMock.ts's id scheme).
    picks            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    current_index    INTEGER     NOT NULL DEFAULT 0,
    remaining_ms     INTEGER     NOT NULL,

    -- 'in_progress' (the resumable sitting; at most one per (user, tier,
    -- section) — see the partial unique below) -> 'completed' (graded via
    -- POST .../:id/submit, retained as history). No 'abandoned' state in this
    -- slice (P3 is the taking flow itself; an abandon/history-list surface is
    -- a later slice if ever built — the real mock's DELETE /topik/attempt
    -- equivalent is intentionally out of scope here).
    status           TEXT        NOT NULL DEFAULT 'in_progress',
    -- Server-computed at submit time (bandForPercentage's percentage input) —
    -- NEVER a client-asserted value. NULL until status='completed' (CHECK below).
    score_percentage NUMERIC(5,1),
    -- Server-computed readiness label (bandForPercentage) — NULL until
    -- status='completed' (CHECK below).
    band             TEXT,

    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    version          INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_generated_mock_attempts_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_generated_mock_attempts_tier
        CHECK (tier IN ('I', 'II')),
    CONSTRAINT ck_generated_mock_attempts_section
        CHECK (section IN ('reading', 'listening')),
    CONSTRAINT ck_generated_mock_attempts_status
        CHECK (status IN ('in_progress', 'completed')),
    CONSTRAINT ck_generated_mock_attempts_item_set_array
        CHECK (jsonb_typeof(item_set) = 'array'),
    CONSTRAINT ck_generated_mock_attempts_picks_object
        CHECK (jsonb_typeof(picks) = 'object'),
    CONSTRAINT ck_generated_mock_attempts_current_index_nonneg
        CHECK (current_index >= 0),
    CONSTRAINT ck_generated_mock_attempts_remaining_nonneg
        CHECK (remaining_ms >= 0),
    CONSTRAINT ck_generated_mock_attempts_score_range
        CHECK (score_percentage IS NULL
               OR (score_percentage >= 0 AND score_percentage <= 100)),
    CONSTRAINT ck_generated_mock_attempts_band_len
        CHECK (band IS NULL OR char_length(band) BETWEEN 1 AND 50),
    CONSTRAINT ck_generated_mock_attempts_version_positive
        CHECK (version >= 1),
    -- Ties the graded-outcome columns to `status` as a database guarantee
    -- (mirrors 105's stimulus-group both-or-neither CHECK, applied to a
    -- three-column group instead of two): an 'in_progress' row can never
    -- carry a score/band/finished_at, and a 'completed' row can never be
    -- missing one.
    CONSTRAINT ck_generated_mock_attempts_completion_fields
        CHECK (
          (status = 'completed'
           AND finished_at IS NOT NULL
           AND score_percentage IS NOT NULL
           AND band IS NOT NULL)
          OR
          (status = 'in_progress'
           AND finished_at IS NULL
           AND score_percentage IS NULL
           AND band IS NULL)
        )
);

COMMENT ON TABLE generated_mock_attempts IS
    'F-220 P3: one row per learner''s generated-bank mock-exam sitting. '
    'item_set is a byte-for-byte SNAPSHOT (server answers + client-safe '
    'fields) of the assembled item set, taken once at assembly time, so '
    'resume/submit are stable against later generated_items edits — the '
    'diagnostic_responses.item_payload snapshot-by-value pattern applied at '
    'attempt granularity. Cleanly separate from topik_attempts/'
    'topik_responses (which hold the REAL, copyrighted-corpus mock) by '
    'design — see the migration header.';
COMMENT ON COLUMN generated_mock_attempts.tier IS
    '''I''/''II'' — the generated-bank composition tier (pools generated_items '
    'level L1/L2 for I, L3/L4/L5+ for II). Deliberately distinct in shape from '
    'topik_attempts'' real ''TOPIK I''/''TOPIK II'' so the two surfaces can '
    'never be confused in a shared query/log.';
COMMENT ON COLUMN generated_mock_attempts.item_set IS
    'Ordered snapshot of the assembled mock: each element carries the '
    'server-only correct answer + explanation alongside every client-safe '
    'field (prompt/passage?/audioUrl?/choices) — see SnapshotMockItem '
    '(server/src/services/topik/generatedMock.ts). The ONLY source of truth '
    'for grading (POST .../:id/submit reads answers from here, never '
    're-queries generated_items) and for what GET/resume serves the client '
    '(with the answer fields stripped at the DTO boundary).';
COMMENT ON COLUMN generated_mock_attempts.picks IS
    '{ "<item_set[].id>": "a"|"b"|"c"|"d" } — the learner''s picks so far, '
    'keyed by the snapshot''s own synthetic item ids (mirrors '
    'topik_attempts.picks, keyed differently since a paired-stimulus '
    'question has no single generated_items row id once flattened).';
COMMENT ON COLUMN generated_mock_attempts.status IS
    '''in_progress'' (resumable; at most one per (user, tier, section) — see '
    'uq_generated_mock_attempts_active) -> ''completed'' (graded, retained). '
    'No ''abandoned'' state in this slice.';

CREATE OR REPLACE TRIGGER trg_generated_mock_attempts_updated_at
    BEFORE UPDATE ON generated_mock_attempts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One in-progress sitting per (user, tier, section) — mirrors
-- uq_topik_attempts_user (037), scoped one step further per the build
-- brief's locked design ("One in-progress attempt per (user, section+tier)").
-- Partial (WHERE status = 'in_progress'): a user's completed history rows
-- never collide with this arbiter, so starting a new tier/section sitting
-- after finishing a previous one always succeeds.
CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_mock_attempts_active
    ON generated_mock_attempts (user_id, tier, section)
    WHERE status = 'in_progress';
COMMENT ON INDEX uq_generated_mock_attempts_active IS
    'F-220 P3: at most one in_progress generated-mock sitting per (user, '
    'tier, section) — the assemble route upserts onto this key; a different '
    'tier/section, or the same one after completion, always starts fresh.';

-- Backs "the caller's active sittings" / "the caller's completed history"
-- lookups (POST .../generated's resume-or-assemble check; a later history
-- surface, if built, would also use this).
CREATE INDEX IF NOT EXISTS ix_generated_mock_attempts_user_status
    ON generated_mock_attempts (user_id, status, updated_at DESC);
COMMENT ON INDEX ix_generated_mock_attempts_user_status IS
    'F-220 P3: backs per-user attempt lookups by status (the assemble '
    'route''s resume check; a future history surface).';

-- End of 107_generated_mock_attempts.up.sql — runner owns the transaction
-- (ADR-013).
