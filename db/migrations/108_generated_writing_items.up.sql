-- migrate: non-destructive
-- =============================================================================
-- Migration 108 — generated_writing_items (F-220 P4: generated, copyright-
--   clean TOPIK II WRITING item bank — the last F-220 generation slice)
--   UP — creates `generated_writing_items`: app-owned, shared reference rows
--        (no user_id — same posture as generated_items/topik_items/
--        reading_questions) holding CONSTRUCTED-RESPONSE writing items
--        authored by Claude from a bare, copyright-clean topic seed (the
--        SAME `readingTopics.ts` list slices 2/3 already reuse — never real
--        TOPIK/Darakwon/TTMIK prompt/chart/essay text). This slice's only
--        writer is the `generate-item-bank` CLI's `--section=writing
--        --ingest` mode (server/src/scripts/generate-item-bank.ts), which
--        Zod-validates each item against `WritingItemGenResultSchema`
--        (services/claude/models.ts).
--   Reverse: 108_generated_writing_items.down.sql
--   Depends on: 001_core_schema (set_updated_at()).
--
-- WHY A NEW TABLE, NOT generated_items (F-220 P4 build brief's locked design)
--   `generated_items` hard-requires `choices JSONB NOT NULL` (CHECK: array,
--   exactly 4 elements) + `answer_index INTEGER NOT NULL` — an invariant the
--   live diagnostic draw AND the P3 generated-mock assembler both depend on
--   (pickGeneratedItem / pickGeneratedItemOfKind / pickGeneratedStimulusGroup,
--   services/diagnostic/generatedBank.ts). A writing item has NO choices and
--   NO single correct index — it is graded against a RUBRIC (grade_writing's
--   3-dimension scoring), not scored by exact-match. Relaxing generated_items'
--   choices/answer_index NOT NULL to accommodate a choice-less row would widen
--   that invariant for every existing reading/listening/paired-stimulus
--   consumer just to serve a structurally unrelated content type — this table
--   keeps that invariant untouched (byte-identical) by never touching it at
--   all.
--
-- WHY NO user_id (mirrors generated_items/topik_items/reading_questions)
--   A generated writing item is shared reference content, not per-user data —
--   every learner served a writing task draws from the same approved bank.
--
-- STATUS AS THE REVIEW GATE
--   Every row is born 'draft' (created_by 'claude-batch' from the
--   emit->ingest CLI). Only 'approved' rows are eligible for the draw path
--   (`pickGeneratedWritingItem`, services/diagnostic/generatedBank.ts) — an
--   admin review surface that flips draft->approved is a later slice, same
--   as generated_items' own review gate. 'rejected' (rather than
--   generated_items' 'retired') is the correct terminal-negative state HERE
--   because every writing item needs a human read-through before it can ever
--   be served at all (an open constructed-response prompt/rubric pair is not
--   machine-checkable for quality the way a 4-choice MCQ's shape is) — a
--   draft an admin declines is REJECTED, not retired-after-service.
--
-- SHIPS DARK (F-220 P4 build brief)
--   This migration lays the bank down; `pickGeneratedWritingItem` (the draw
--   fn) is built and tested in this same slice but wired into NO route or
--   surface yet — a writing slot inside the P3 generated mock would need a
--   METERED `grade_writing` call at submit time, which breaks P3's "no
--   metered spend at exam time" guarantee (generated_mock_attempts, migration
--   107's header). That wiring decision is deliberately deferred to a later
--   slice.
--
-- IDEMPOTENCY — prompt_hash (mirrors 101 exactly)
--   `prompt_hash` is the SHA-256 hex digest of the exact generation request
--   (route|model|systemText|userText — the same `hashCacheKey` shape
--   claude_cache/004 uses), computed by the CLI at --emit-batch time and
--   re-verified at --ingest time. UNIQUE means re-ingesting the same
--   work-order file can never duplicate a row — `ON CONFLICT (prompt_hash)
--   DO NOTHING` is the CLI's whole idempotency story.
--
-- WHY min_words/max_words ARE NULLABLE, PER KIND (not a CHECK against `kind`)
--   `kind` is deliberately OPEN TEXT (mirrors 101's kind column — never a
--   fixed enum), so this migration does not hard-code which kind requires
--   which nullable field via a kind-naming CHECK (that would defeat the
--   open-set design the moment a 4th writing kind is ever added). The actual
--   per-kind field-presence contract (short-answer-blanks: stimulus +
--   model_answer required, min/max_words absent; chart-description: stimulus
--   + min/max_words required, model_answer absent; essay: min/max_words
--   required, stimulus + model_answer absent) is enforced at the CLI ingest
--   boundary (server/src/scripts/generate-item-bank.ts), exactly the same
--   posture as 101's section<->kind contract being an APPLICATION guard, not
--   a schema one. The CHECK below only pins the KIND-AGNOSTIC invariant that
--   is always true regardless of which fields a given kind uses: when both
--   are present, max_words must be >= min_words.
--
-- FORWARD-COMPAT COLUMNS (model_id, source_ref) — deviation from the P4
--   build brief's literal column list, added to mirror 101's identical
--   audit-trail/provenance columns (same rationale 101's own header
--   documents for its own deviation from ITS brief): `source_ref` traces a
--   row back to its `readingTopics.ts` synthetic topic ref (`topic-<level>-
--   <n>`, exactly like generated_items' reading/listening rows), and
--   `model_id` records which Claude model authored it. Both are free TEXT,
--   optional, and change nothing about the brief's locked column list —
--   pure audit/observability additions.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write.
--
-- Manual application: psql -v ON_ERROR_STOP=1 -1 -f 108_generated_writing_items.up.sql
-- (NOT recommended in production — use migrate.py; manual psql application
-- desyncs schema_migrations and breaks the next deploy.)
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

CREATE TABLE IF NOT EXISTS generated_writing_items (
    id                 BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Always 'writing' — this table exists for exactly one section (mirrors
    -- generated_items' full forward-compat `section` set, narrowed here to
    -- a single fixed value since a SEPARATE table, not a shared one, is
    -- what backs this section).
    section            TEXT        NOT NULL DEFAULT 'writing',
    -- Target proficiency band — TOPIK II only (no TOPIK I writing section;
    -- TOPIK_STRUCTURE_ANALYSIS.md §3).
    level              TEXT        NOT NULL,
    -- Item kind: short-answer-blanks (#51/52) | chart-description (#53) |
    -- essay (#54). Kept OPEN TEXT + length CHECK (mirrors generated_items'
    -- kind column) rather than a closed enum, so a future 4th writing shape
    -- needs no migration.
    kind               TEXT        NOT NULL,

    -- The task directive the learner reads.
    prompt             TEXT        NOT NULL,
    -- short-answer-blanks: the short functional text with two labeled
    -- blanks. chart-description: the synthetic invented chart/statistic
    -- description. NULL for essay (the prompt itself carries the full task).
    stimulus           TEXT,
    -- Grading rubric: { kind, maxScore, criteria: [{ name, maxScore,
    -- descriptor }] } — WritingItemRubricSchema (services/claude/models.ts).
    rubric             JSONB       NOT NULL,
    -- short-answer-blanks: a reference filled answer for both blanks. NULL/
    -- optional for chart-description/essay (an open descriptive/
    -- argumentative task has no single reference answer).
    model_answer       TEXT,
    -- Target length band in Korean CHARACTERS (자, not English words —
    -- mirrors generation.ts's lengthHint unit): chart-description ~200-300,
    -- essay ~600-700. NULL for short-answer-blanks (no length target).
    min_words          INTEGER,
    max_words          INTEGER,

    -- Review gate. Only 'approved' rows are drawn (pickGeneratedWritingItem).
    status             TEXT        NOT NULL DEFAULT 'draft',
    -- Free-text writer identity (e.g. 'claude-batch' for the CLI's --ingest
    -- writes). Not a FK — provenance metadata, not a user account.
    created_by         TEXT        NOT NULL,
    -- Which Claude model authored this item (provenance). Free TEXT (not the
    -- closed claude_model enum) — mirrors generated_items.model_id exactly.
    model_id           TEXT,
    -- Provenance: the readingTopics.ts synthetic topic ref this item was
    -- generated from (e.g. 'topic-L4-0007') — mirrors
    -- generated_items.source_ref's reading/listening usage.
    source_ref         TEXT,
    -- SHA-256 hex digest of the exact generation request — the idempotency
    -- key. See "IDEMPOTENCY" above.
    prompt_hash        TEXT        NOT NULL,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT uq_generated_writing_items_prompt_hash UNIQUE (prompt_hash),

    CONSTRAINT ck_generated_writing_items_section
        CHECK (section = 'writing'),
    CONSTRAINT ck_generated_writing_items_level
        CHECK (level IN ('L3', 'L4', 'L5+')),
    CONSTRAINT ck_generated_writing_items_kind_len
        CHECK (char_length(kind) BETWEEN 1 AND 50),
    CONSTRAINT ck_generated_writing_items_prompt_len
        CHECK (char_length(prompt) BETWEEN 1 AND 1000),
    CONSTRAINT ck_generated_writing_items_stimulus_len
        CHECK (stimulus IS NULL OR char_length(stimulus) BETWEEN 1 AND 4000),
    -- Element-shape (per-criterion name/maxScore/descriptor, per-kind
    -- name/count contract, criteria-sum-equals-maxScore) is NOT pinned here
    -- (unlike generated_items.choices' fixed 4-element CHECK) — rubric.
    -- criteria is a variable-length array (1..6 entries) whose exact shape
    -- IS Zod-validated at ingest (WritingItemRubricSchema.superRefine,
    -- services/claude/models.ts). This CHECK only pins the two structural
    -- facts a JSONB-level guard can cheaply verify without hard-coding
    -- arity: `rubric` is an object, AND it actually carries a `criteria`
    -- array key (an empty `{}` or a criteria-less object no longer passes)
    -- — defense-in-depth against a non-object OR skeleton write, mirroring
    -- the "type guard before any deeper structural guard" reasoning 101/086
    -- document.
    -- COALESCE is load-bearing, not decoration: `rubric -> 'criteria'` is
    -- SQL NULL (not a jsonb null) when the key is absent, so
    -- `jsonb_typeof(NULL) = 'array'` evaluates to NULL/unknown rather than
    -- FALSE — and Postgres CHECK constraints treat an unknown result as a
    -- PASS, not a violation. Without the COALESCE, `{}` and any other
    -- criteria-less object would silently satisfy this CHECK, which is
    -- exactly the gap this constraint exists to close.
    CONSTRAINT ck_generated_writing_items_rubric_object
        CHECK (
            jsonb_typeof(rubric) = 'object'
            AND COALESCE(jsonb_typeof(rubric -> 'criteria'), '') = 'array'
        ),
    CONSTRAINT ck_generated_writing_items_model_answer_len
        CHECK (model_answer IS NULL OR char_length(model_answer) BETWEEN 1 AND 4000),
    CONSTRAINT ck_generated_writing_items_min_words_positive
        CHECK (min_words IS NULL OR min_words > 0),
    CONSTRAINT ck_generated_writing_items_max_words_positive
        CHECK (max_words IS NULL OR max_words > 0),
    -- Kind-agnostic ordering invariant (see the header's "WHY min_words/
    -- max_words" note for why this is the only DB-level cross-field CHECK).
    CONSTRAINT ck_generated_writing_items_words_order
        CHECK (min_words IS NULL OR max_words IS NULL OR max_words >= min_words),
    CONSTRAINT ck_generated_writing_items_status
        CHECK (status IN ('draft', 'approved', 'rejected')),
    CONSTRAINT ck_generated_writing_items_created_by_len
        CHECK (char_length(created_by) BETWEEN 1 AND 100),
    CONSTRAINT ck_generated_writing_items_source_ref_len
        CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
    CONSTRAINT ck_generated_writing_items_prompt_hash_shape
        CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_generated_writing_items_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE generated_writing_items IS
    'F-220 P4 app-generated, copyright-clean TOPIK II WRITING item bank '
    '(constructed-response — no choices/answer_index; SEPARATE from '
    'generated_items, whose 4-choice-MCQ invariant this table never touches). '
    'No user_id — shared reference content. `status` is the review gate: only '
    '''approved'' rows are ever drawn by pickGeneratedWritingItem '
    '(services/diagnostic/generatedBank.ts); rows are born ''draft'' from the '
    'generate-item-bank CLI''s --section=writing --ingest. `prompt_hash` '
    'dedups re-generation/re-ingest (UNIQUE). Ships DARK — built and tested '
    'here, wired into no route/surface yet (see the migration header).';
COMMENT ON COLUMN generated_writing_items.kind IS
    'short-answer-blanks (#51/52) | chart-description (#53) | essay (#54) — '
    'open TEXT + length CHECK (mirrors generated_items.kind), never a closed '
    'enum, so a future 4th writing shape needs no migration.';
COMMENT ON COLUMN generated_writing_items.rubric IS
    '{ kind, maxScore, criteria: [{ name, maxScore, descriptor }] } — '
    'WritingItemRubricSchema (services/claude/models.ts). Criteria maxScores '
    'sum to rubric.maxScore, and rubric.kind''s expected criteria '
    'name/count set is present, by construction (Zod-validated via '
    'WritingItemRubricSchema.superRefine at ingest); the DB CHECK only pins '
    'JSONB object-ness + a `criteria` array key as defense-in-depth, not '
    'element-shape or arity.';
COMMENT ON COLUMN generated_writing_items.min_words IS
    'Target length band LOWER bound in Korean CHARACTERS (자), NOT English '
    'words, despite the column name — mirrors generation.ts''s lengthHint '
    'unit and WritingItemGenResultSchema.minWords'' documented semantics '
    '(services/claude/models.ts). NULL for short-answer-blanks (no length '
    'target, only two blanks to fill). A future direct-SQL consumer of this '
    'column (admin dashboard, analytics script, second writer) MUST treat '
    'this as a character count, not a word count.';
COMMENT ON COLUMN generated_writing_items.max_words IS
    'Target length band UPPER bound in Korean CHARACTERS (자), NOT English '
    'words — see the min_words column comment for the full rationale. '
    'chart-description ~200-300, essay ~600-700; NULL for '
    'short-answer-blanks.';
COMMENT ON COLUMN generated_writing_items.status IS
    'Review gate: draft (born here, not yet reviewed) -> approved (eligible '
    'for pickGeneratedWritingItem) | rejected (declined, never served — '
    'every writing item needs a human read-through before serving, unlike a '
    'shape-checkable MCQ, so the terminal-negative state here is a review '
    'outcome, not a later retirement). The draft->approved/rejected '
    'transition is a later admin-surface slice; this migration only lays the '
    'column + CHECK down.';
COMMENT ON COLUMN generated_writing_items.prompt_hash IS
    'SHA-256 hex digest of the exact generation request (route|model|'
    'systemText|userText — the same shape claude_cache/004''s hashCacheKey '
    'uses), computed by generate-item-bank.ts. UNIQUE — the idempotency key '
    'for --emit-batch/--ingest re-runs.';

CREATE OR REPLACE TRIGGER trg_generated_writing_items_updated_at
    BEFORE UPDATE ON generated_writing_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backs the draw query: SELECT ... WHERE level = $1 AND kind = $2 AND
-- status = 'approved' ORDER BY random() LIMIT 1 (pickGeneratedWritingItem).
-- `section` is omitted from the index (this table only ever holds
-- section='writing' — the CHECK above pins that, so filtering on it in the
-- index would add no selectivity).
CREATE INDEX IF NOT EXISTS ix_generated_writing_items_draw
    ON generated_writing_items (level, kind, status);
COMMENT ON INDEX ix_generated_writing_items_draw IS
    'Backs pickGeneratedWritingItem''s draw query (services/diagnostic/'
    'generatedBank.ts): WHERE level = ? AND kind = ? AND status = '
    '''approved'' — ships dark in F-220 P4 (built/tested, not yet wired into '
    'a live route/surface).';

-- End of 108_generated_writing_items.up.sql — runner owns the transaction
-- (ADR-013).
