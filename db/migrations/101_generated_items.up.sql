-- migrate: non-destructive
-- =============================================================================
-- Migration 101 — generated_items (F-220 slice 1: generated, copyright-clean
--   assessment-item bank)
--   UP — creates `generated_items`: app-owned, shared reference rows (no
--        user_id — same posture as topik_items/reading_questions) holding
--        assessment items authored by Claude from copyright-clean seeds
--        (vocab_entries headwords; grammar canonical PATTERN keys — never
--        Darakwon/kgiu_entries prose). This slice's only writer is the
--        `generate-item-bank` CLI's --ingest mode
--        (server/src/scripts/generate-item-bank.ts), which Zod-validates
--        each item against `DiagnosticItemResultSchema`
--        (services/claude/models.ts) and applies the SAME exactly-one-
--        correct + `shuffleGeneratedChoices` guards the live diagnostic
--        generation path uses (routes/diagnostic.ts) before writing.
--   Reverse: 101_generated_items.down.sql
--   Depends on: 001_core_schema (set_updated_at()).
--
-- WHY NO user_id (mirrors topik_items / reading_questions)
--   A generated item is shared reference content, not per-user data — every
--   learner who is served the diagnostic draws from the same approved bank.
--   Ownership/access has no per-row scoping question to answer.
--
-- STATUS AS THE REVIEW GATE
--   Every row is born 'draft' (created_by 'claude-batch' from the emit→ingest
--   CLI). Only 'approved' rows are ever eligible for the draw path
--   (`pickGeneratedItem`, services/diagnostic/generatedBank.ts) — an admin
--   review surface that flips draft→approved is a later slice; this
--   migration only lays the status column + CHECK down. 'retired' lets a
--   later admin pull a bad item out of rotation without deleting the
--   historical row.
--
-- IDEMPOTENCY — prompt_hash
--   `prompt_hash` is the SHA-256 hex digest of the exact generation request
--   (route|model|systemText|userText — the same `hashCacheKey` shape
--   claude_cache/004 uses), computed by the CLI at --emit-batch time and
--   re-verified at --ingest time. The UNIQUE constraint means re-ingesting
--   the same work-order file (or re-emitting the same seed at the same
--   level/model) can never duplicate a row — `ON CONFLICT (prompt_hash) DO
--   NOTHING` is the CLI's whole idempotency story.
--
-- WHY choices IS JSONB, NOT A CHILD TABLE (mirrors 086_reading_questions)
--   Fixed arity (exactly 4), never queried per-choice, written once as a
--   whole array by the ingest CLI. The CHECK below pins array-ness, arity,
--   and each element's { kr: string, en?: string } shape as defense-in-depth
--   behind the CLI's Zod validation — the same posture 086 documents.
--
-- FORWARD-COMPAT COLUMNS (audio_source_id/audio_start_ms/audio_end_ms,
--   passage, and the 'reading'/'listening'/'writing' section+level CHECK
--   values) exist so the F-220 reading/listening/audio slices need no new
--   migration — this slice's CLI writes vocab/grammar rows only (both NULL
--   passage and NULL audio_*).
--
-- AUDIT COLUMNS (updated_at/version) — deviation from the slice-1 build
--   brief's column list, added to match this repo's stated convention
--   ("Audit columns on every entity table", db/migrations/README.md
--   Conventions) ahead of the admin approve/retire workflow (a later slice)
--   that will UPDATE `status` on existing rows.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write.
--
-- Manual application: psql -v ON_ERROR_STOP=1 -1 -f 101_generated_items.up.sql
-- (NOT recommended in production — use migrate.py; manual psql application
-- desyncs schema_migrations and breaks the next deploy.)
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

CREATE TABLE IF NOT EXISTS generated_items (
    id                 BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Which diagnostic dimension this item probes. Full forward-compat set;
    -- this slice's CLI only ever writes 'vocab'/'grammar'.
    section            TEXT        NOT NULL,
    -- Target proficiency band — matches DiagnosticTargetLevel
    -- (services/claude/models.ts).
    level              TEXT        NOT NULL,
    -- Item kind. vocab -> synonym|cloze, grammar -> pattern
    -- (DiagnosticGenKindSchema); later slices add reading/listening kinds
    -- (passage-mc/inference/audio-mc, routes/diagnostic.ts's buildTopikItem
    -- kind values) — kept open TEXT + length CHECK rather than a closed set.
    kind               TEXT        NOT NULL,
    -- The question stem/prompt the learner reads.
    stem               TEXT        NOT NULL,
    -- Reading passage body. NULL for vocab/grammar (this slice always NULL).
    passage            TEXT,
    -- Exactly 4 { kr: string, en?: string } choices — the
    -- DiagnosticItemResultSchema choice shape, POST shuffleGeneratedChoices
    -- (so the stored order is the order a draw serves verbatim).
    choices            JSONB       NOT NULL,
    -- Index (0..3) of the single correct choice, in the STORED (already
    -- shuffled) choices order.
    answer_index       INTEGER     NOT NULL,
    -- Explanation, revealed only after the learner answers (mirrors
    -- ServerItem.explain's column-private posture at the route layer).
    explain            TEXT,
    -- Forward-compat: listening slice wires these to a shared audio source
    -- row + a playable window, mirroring topik_items' F-119/F-206
    -- audio_start_ms/audio_end_ms shape. Always NULL for vocab/grammar.
    audio_source_id    BIGINT,
    audio_start_ms     INTEGER,
    audio_end_ms       INTEGER,
    -- Free-form skill tag (mirrors topik_items.skill_tag) — no fixed values.
    skill_tag          TEXT,
    -- Provenance: the seed row this item was generated from (a vocab_entries
    -- id for section='vocab', a canonical_grammar id for section='grammar').
    -- Copyright audit trail — lets an operator trace any item back to its
    -- copyright-clean seed.
    source_ref         TEXT,
    -- Review gate. Only 'approved' rows are drawn (pickGeneratedItem).
    status             TEXT        NOT NULL DEFAULT 'draft',
    -- Free-text writer identity (e.g. 'claude-batch' for the CLI's --ingest
    -- writes). Not a FK — this is provenance metadata, not a user account.
    created_by         TEXT        NOT NULL,
    -- Which Claude model authored this item (provenance/observability) —
    -- free TEXT (not the closed claude_model enum) because the work-order
    -- file's meta.model is operator-supplied and must never fail an ingest
    -- on an enum mismatch the way a typed column would.
    model_id           TEXT,
    -- SHA-256 hex digest of the generation request — the idempotency key.
    -- See "IDEMPOTENCY" above.
    prompt_hash        TEXT        NOT NULL,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT uq_generated_items_prompt_hash UNIQUE (prompt_hash),

    CONSTRAINT ck_generated_items_section
        CHECK (section IN ('vocab', 'grammar', 'reading', 'listening', 'writing')),
    CONSTRAINT ck_generated_items_level
        CHECK (level IN ('L1', 'L2', 'L3', 'L4', 'L5+')),
    CONSTRAINT ck_generated_items_kind_len
        CHECK (char_length(kind) BETWEEN 1 AND 50),
    CONSTRAINT ck_generated_items_stem_len
        CHECK (char_length(stem) BETWEEN 1 AND 2000),
    CONSTRAINT ck_generated_items_passage_len
        CHECK (passage IS NULL OR char_length(passage) BETWEEN 1 AND 20000),
    -- Array-ness + arity: exactly 4 choices, always. jsonb_array_length
    -- raises on a non-array, so the typeof guard must come first — Postgres
    -- evaluates CHECKs in declaration order and stops at the first
    -- violation (086_reading_questions's exact reasoning), so a
    -- non-array/wrong-arity `choices` never reaches the element-shape CHECK
    -- below.
    CONSTRAINT ck_generated_items_choices_shape
        CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) = 4),
    -- Each element carries at least a non-empty Korean choice string. `en`
    -- is optional (DiagnosticGenChoiceSchema) so it is NOT required here.
    -- Positional (choices->0..3) because a CHECK may not contain a
    -- subquery/jsonb_array_elements — arity-4-safe per the declaration-order
    -- reasoning above. Each term COALESCEd to false so a missing/wrong-typed
    -- key can only ever surface as a clean CHECK violation, never a
    -- silently-passing NULL.
    CONSTRAINT ck_generated_items_choices_element_shape
        CHECK (
          COALESCE(jsonb_typeof(choices->0->'kr') = 'string', false)
          AND COALESCE(char_length(choices->0->>'kr') > 0, false)
          AND COALESCE(jsonb_typeof(choices->1->'kr') = 'string', false)
          AND COALESCE(char_length(choices->1->>'kr') > 0, false)
          AND COALESCE(jsonb_typeof(choices->2->'kr') = 'string', false)
          AND COALESCE(char_length(choices->2->>'kr') > 0, false)
          AND COALESCE(jsonb_typeof(choices->3->'kr') = 'string', false)
          AND COALESCE(char_length(choices->3->>'kr') > 0, false)
        ),
    CONSTRAINT ck_generated_items_answer_index
        CHECK (answer_index BETWEEN 0 AND 3),
    CONSTRAINT ck_generated_items_explain_len
        CHECK (explain IS NULL OR char_length(explain) BETWEEN 1 AND 800),
    CONSTRAINT ck_generated_items_audio_start_nonneg
        CHECK (audio_start_ms IS NULL OR audio_start_ms >= 0),
    CONSTRAINT ck_generated_items_audio_end_after_start
        CHECK (
          audio_end_ms IS NULL
          OR audio_start_ms IS NULL
          OR audio_end_ms > audio_start_ms
        ),
    CONSTRAINT ck_generated_items_source_ref_len
        CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
    CONSTRAINT ck_generated_items_status
        CHECK (status IN ('draft', 'approved', 'retired')),
    CONSTRAINT ck_generated_items_created_by_len
        CHECK (char_length(created_by) BETWEEN 1 AND 100),
    CONSTRAINT ck_generated_items_prompt_hash_shape
        CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_generated_items_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE generated_items IS
    'F-220 app-generated, copyright-clean assessment-item bank. One row per '
    'authored item (vocab/grammar this slice; reading/listening/writing are '
    'later slices). No user_id — shared reference content, same posture as '
    'topik_items/reading_questions. `status` is the review gate: only '
    '''approved'' rows are ever drawn by pickGeneratedItem '
    '(services/diagnostic/generatedBank.ts); rows are born ''draft'' from '
    'the generate-item-bank CLI''s --ingest. `prompt_hash` dedups '
    're-generation/re-ingest (UNIQUE).';
COMMENT ON COLUMN generated_items.section IS
    'Diagnostic dimension. Full forward-compat set '
    '(vocab/grammar/reading/listening/writing); this slice writes '
    'vocab/grammar only.';
COMMENT ON COLUMN generated_items.level IS
    'Target proficiency band — DiagnosticTargetLevel (L1..L5+).';
COMMENT ON COLUMN generated_items.choices IS
    'Exactly 4 { kr: string, en?: string } choices, JSONB array, in the '
    'STORED (post shuffleGeneratedChoices) order — a draw serves this order '
    'verbatim. Array-ness/arity/element-shape pinned by CHECK as '
    'defense-in-depth behind the ingest CLI''s Zod validation (mirrors '
    '086_reading_questions''s reasoning).';
COMMENT ON COLUMN generated_items.answer_index IS
    'Index (0..3) of the correct choice within the STORED choices array.';
COMMENT ON COLUMN generated_items.source_ref IS
    'Provenance: the copyright-clean seed row this item was generated from '
    '(vocab_entries.id for section=vocab; canonical_grammar.id for '
    'section=grammar — the pattern-key dedup layer, NEVER a kgiu_entries '
    'id, since kgiu_entries carries Darakwon-derived explanation prose).';
COMMENT ON COLUMN generated_items.status IS
    'Review gate: draft (born here, not yet reviewed) -> approved (eligible '
    'for pickGeneratedItem) -> retired (pulled from rotation, row kept for '
    'history). The draft->approved transition is a later admin-surface '
    'slice; this migration only lays the column + CHECK down.';
COMMENT ON COLUMN generated_items.prompt_hash IS
    'SHA-256 hex digest of the exact generation request (route|model|'
    'systemText|userText — the same shape claude_cache/004''s '
    'hashCacheKey uses), computed by generate-item-bank.ts. UNIQUE — the '
    'idempotency key for --emit-batch/--ingest re-runs.';
COMMENT ON COLUMN generated_items.model_id IS
    'Claude model id that generated this row (provenance). Free TEXT, not '
    'the closed claude_model enum — the work-order file''s meta.model is '
    'operator-supplied and an ingest must never fail on an enum mismatch.';

CREATE OR REPLACE TRIGGER trg_generated_items_updated_at
    BEFORE UPDATE ON generated_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backs the draw query: SELECT ... WHERE section = $1 AND level = $2 AND
-- status = 'approved' ORDER BY random() LIMIT 1 (pickGeneratedItem).
CREATE INDEX IF NOT EXISTS ix_generated_items_draw
    ON generated_items (section, level, status);
COMMENT ON INDEX ix_generated_items_draw IS
    'Backs pickGeneratedItem''s draw query (services/diagnostic/'
    'generatedBank.ts): WHERE section = ? AND level = ? AND status = '
    '''approved'' — the diagnostic''s per-item generated-bank lookup, one '
    'per vocab/grammar item served when DIAGNOSTIC_USE_GENERATED_BANK=true.';

-- End of 101_generated_items.up.sql — runner owns the transaction (ADR-013).
