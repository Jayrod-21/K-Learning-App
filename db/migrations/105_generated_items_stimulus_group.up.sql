-- migrate: non-destructive
-- =============================================================================
-- Migration 105 — generated_items stimulus-group columns (F-220 P1:
--   PAIRED-STIMULUS reading/listening items — one generated passage/dialogue
--   shared by 2-3 comprehension questions, the largest question family in a
--   real TOPIK section — see the build brief's TOPIK_STRUCTURE_ANALYSIS §5/§6)
--   UP — adds TWO nullable columns to `generated_items` (101):
--          §1 `stimulus_group_id TEXT` — several rows sharing this value form
--             ONE stimulus group: one passage for a paired-reading block
--             (kind='paired-passage-mc'), one shared audio clip for a
--             paired-listening block (kind='paired-audio-mc'). NULL for every
--             standalone single-item row (ALL rows before this slice, and
--             every vocab/grammar/passage-mc/audio-mc row after it).
--          §2 `stimulus_group_ordinal INT` — the row's 1-based position
--             WITHIN its group (1..N, N = 2 or 3 today), for deterministic
--             serving order (`pickGeneratedStimulusGroup`,
--             services/diagnostic/generatedBank.ts, orders by this column).
--             NULL exactly when `stimulus_group_id` is NULL (both together —
--             see the CHECK below).
--          §3 a partial index on (stimulus_group_id, stimulus_group_ordinal)
--             WHERE stimulus_group_id IS NOT NULL — backs both the group-draw
--             query's per-group ORDER BY and the ingest CLI's per-row
--             idempotency lookups; the WHERE clause keeps the index small
--             (only paired rows are ever indexed here — every standalone row
--             is excluded, exactly the ix_generated_items_draw pattern this
--             migration mirrors for a different predicate).
--   NO NEW COLUMN for the shared stimulus payload itself: a paired-reading
--   group's shared passage rides the EXISTING `passage` column (101),
--   denormalized identically onto every row in the group (mirrors how a
--   standalone reading row already stores its own passage); a paired-
--   listening group's shared audio rides the EXISTING `audio_source_id`
--   column (103) — the synth CLI stamps the SAME audio_sources id onto every
--   row in the group in one synthesis pass (see
--   scripts/synthesize-listening-audio.ts). No schema gap on either axis; the
--   only genuine gap was the group KEY itself, which this migration adds.
--   Reverse: 105_generated_items_stimulus_group.down.sql
--   Depends on: 101_generated_items (generated_items table itself),
--               103_generated_items_audio (audio_source_id — reused, not
--               modified, by the paired-listening shape).
--
-- WHY TEXT, NOT UUID (mirrors 101's prompt_hash rationale loosely, but this
--   is a plain grouping key, not a content hash)
--   The ingest CLI (scripts/generate-item-bank.ts) derives `stimulus_group_id`
--   DETERMINISTICALLY from the group's own request hash (the first 32 hex
--   characters of the SAME `hashCacheKey` value used to compute the group's
--   per-row `prompt_hash`es) rather than a fresh `randomUUID()` per ingest
--   run — so re-ingesting the SAME work-order file (a retry after a partial
--   failure) reproduces the IDENTICAL group id for the rows that still need
--   writing, keeping a partially-landed group completable rather than
--   fragmenting into two group ids. A hex hash prefix is not a UUID, hence
--   TEXT with a length bound rather than the `uuid` type.
--
-- WHY stimulus_group_ordinal IS PLAIN INT, NOT PART OF A COMPOSITE UNIQUE KEY
--   `prompt_hash` (101) is ALREADY unique per row (derived from
--   `stimulus_group_id` + ordinal at ingest time — see
--   generate-item-bank.ts's `rowPromptHash`), so a SEPARATE
--   UNIQUE(stimulus_group_id, stimulus_group_ordinal) constraint would be
--   redundant enforcement of the same invariant through a second key. The
--   partial index below is for QUERY performance (the group-draw's ORDER BY),
--   not uniqueness.
--
-- WHY THE CHECK TIES THE TWO COLUMNS TOGETHER (both NULL or both set)
--   A row can never be "half in a group" — an ordinal with no group id is
--   meaningless, and a group id with no ordinal breaks the group's serving
--   order. Tying them in one CHECK makes that invariant a database guarantee,
--   not just an ingest-CLI convention.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write.
--
-- Manual application: psql -v ON_ERROR_STOP=1 -1 -f 105_generated_items_stimulus_group.up.sql
-- (NOT recommended in production — use migrate.py; manual psql application
-- desyncs schema_migrations and breaks the next deploy.)
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

ALTER TABLE generated_items ADD COLUMN IF NOT EXISTS stimulus_group_id TEXT;
ALTER TABLE generated_items ADD COLUMN IF NOT EXISTS stimulus_group_ordinal INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_generated_items_stimulus_group_id_len'
                     AND conrelid = 'generated_items'::regclass) THEN
        ALTER TABLE generated_items
            ADD CONSTRAINT ck_generated_items_stimulus_group_id_len
            CHECK (stimulus_group_id IS NULL
                   OR char_length(stimulus_group_id) BETWEEN 1 AND 64);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_generated_items_stimulus_group_ordinal_positive'
                     AND conrelid = 'generated_items'::regclass) THEN
        ALTER TABLE generated_items
            ADD CONSTRAINT ck_generated_items_stimulus_group_ordinal_positive
            CHECK (stimulus_group_ordinal IS NULL OR stimulus_group_ordinal >= 1);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_generated_items_stimulus_group_paired'
                     AND conrelid = 'generated_items'::regclass) THEN
        ALTER TABLE generated_items
            ADD CONSTRAINT ck_generated_items_stimulus_group_paired
            CHECK ((stimulus_group_id IS NULL) = (stimulus_group_ordinal IS NULL));
    END IF;
END $$;

COMMENT ON COLUMN generated_items.stimulus_group_id IS
    'F-220 P1: groups 2-3 rows sharing ONE generated stimulus — a passage '
    '(paired-reading, kind=''paired-passage-mc'', the shared text also '
    'denormalized per row onto the existing `passage` column) or an audio '
    'clip (paired-listening, kind=''paired-audio-mc'', the shared clip is the '
    'existing `audio_source_id`, stamped identically onto every row in the '
    'group by the synth CLI). NULL for every standalone single-item row. '
    'Deterministically derived from the group''s own request hash by '
    'generate-item-bank.ts (NOT a fresh randomUUID per ingest run) so a '
    'retried ingest of the same work-order file reproduces the identical '
    'group id. Read by pickGeneratedStimulusGroup '
    '(services/diagnostic/generatedBank.ts).';
COMMENT ON COLUMN generated_items.stimulus_group_ordinal IS
    'F-220 P1: this row''s 1-based position within its stimulus_group_id '
    '(1..N). NULL exactly when stimulus_group_id is NULL (CHECK '
    'ck_generated_items_stimulus_group_paired). Orders the group''s '
    'questions for deterministic serving (pickGeneratedStimulusGroup ORDER '
    'BY); the ordinal=1 row also carries the group''s ONE settled '
    'audio_cost_estimate_usd for a paired-listening group (see '
    'scripts/synthesize-listening-audio.ts — a group''s shared audio is '
    'synthesized and billed ONCE, never once per row).';

-- Backs pickGeneratedStimulusGroup's per-group row fetch (ORDER BY
-- stimulus_group_ordinal) and the ingest CLI's per-row idempotency checks.
-- Partial (WHERE stimulus_group_id IS NOT NULL) so every standalone row —
-- the overwhelming majority of the table — is never indexed here, mirroring
-- ix_generated_items_draw's own scoped-index reasoning (101).
CREATE INDEX IF NOT EXISTS ix_generated_items_stimulus_group
    ON generated_items (stimulus_group_id, stimulus_group_ordinal)
    WHERE stimulus_group_id IS NOT NULL;
COMMENT ON INDEX ix_generated_items_stimulus_group IS
    'F-220 P1: backs pickGeneratedStimulusGroup''s per-group ordered row '
    'fetch (services/diagnostic/generatedBank.ts) — WHERE stimulus_group_id '
    '= ? ORDER BY stimulus_group_ordinal. Partial: only paired rows are ever '
    'indexed here (mirrors ix_generated_items_draw''s scoped-index posture).';

-- End of 105_generated_items_stimulus_group.up.sql — runner owns the
-- transaction (ADR-013).
