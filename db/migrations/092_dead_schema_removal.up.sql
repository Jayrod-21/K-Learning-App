-- migrate: non-destructive
-- =============================================================================
-- Migration 092 — dead-schema removal (audit §4.3)
--
--   Drops confirmed-dead schema surface found by the phase-4 audit: 2 tables,
--   2 redundant indexes, and 18 all-NULL columns. Every object here was
--   re-verified immediately before this migration was written (git grep
--   across server/src, tools/, client/src — see BUILD_REPORT_deadschema.md).
--
--   TABLES (0 rows, no reader, no writer in server/src, tools/, or client/src):
--       * lets_check_exercises  (migration 002) — review-exercise pages.
--         Its parent-discriminator enum `lets_check_parent_kind` is left in
--         place: it becomes orphaned by this drop but dropping enum types is
--         out of this migration's scope (not in the audited list; a future
--         housekeeping pass can pick it up).
--       * hanja_extensions      (migration 002) — "Korean through Chinese
--         Characters" mind-map pages.
--
--   INDEXES (prefix-subsumed by a UNIQUE index on the same leading columns —
--   the planner can use the UNIQUE index for the same lookups):
--       * ix_hanja_compounds_character   (hanja_compounds, migration 016) —
--         subsumed by uq_hanja_compounds_character_word (character_id, word_kr).
--       * ix_topik_dependencies_item     (topik_dependencies, migration 008) —
--         subsumed by uq_topik_dependencies_natural_key (topik_item_id,
--         dep_type, COALESCE(grammar_entry_id,0), COALESCE(vocab_entry_id,0)).
--         NOTE: topik_dependencies the TABLE is explicitly KEPT (0 rows but a
--         live writer — tools/ingest/link_topik_dependencies.py — and
--         integration tests). Only this one redundant index is dropped.
--
--   COLUMNS (all-NULL, re-verified unreferenced by server/src or tools/
--   loader INSERT/SELECT — see per-column notes below):
--     vocab_entries (10, migration 002): audio_track, japanese, case_marker,
--       irregular_class, passive_form, causative_form, basic_form,
--       honorific_form, humble_form, contracted_form.
--       (These are DENORMALIZED inline copies — the canonical relational
--       model for the same word-form relations lives in
--       vocab_entry_relations, which is untouched, still written by
--       tools/ingest/resolver/*, and reads the SAME field names from the
--       *source JSON*, not from these DB columns. Dropping these columns
--       does not affect vocab_entry_relations.)
--     krdict_entries (1, migration 003): register.
--     krdict_senses (2, migration 003): sense_domain, sense_register.
--     topik_items (1, migration 005): skill_tag_raw.
--       (skill_tag is DELIBERATELY NOT dropped here even though the audit
--       listed it — tools/ingest/link_topik_dependencies.py:364 SELECTs
--       ti.skill_tag and feeds it to strategy_a_skill_tag(), which WRITES to
--       topik_dependencies, an explicit KEEP table with live writers +
--       integration tests. Today the column is all-NULL in production so
--       that strategy is a no-op in practice, but the code path is live and
--       covered by tests/test_link_topik_dependencies.py — dropping the
--       column would break it. See BUILD_REPORT_deadschema.md "STOP" note.)
--     book_pages (2, migration 041): width, height.
--     conversations (1, migration 001): last_grading.
--     corpus_sources (1, migration 002): version_tag.
--
--   DEPENDENT-OBJECT NOTE: three of the 18 columns carry a CHECK constraint
--   that Postgres auto-drops along with the column (DROP COLUMN cascades to
--   dependent CHECKs and, for topik_items.skill_tag specifically — untouched
--   here — the partial index ix_topik_items_skill_tag would also cascade,
--   but that column is kept so that index is unaffected):
--       * book_pages:    ck_book_pages_width_positive, ck_book_pages_height_positive
--       * conversations: ck_conversations_grading_object
--   The down migration recreates both the column and its CHECK verbatim.
--
--   NON-DESTRUCTIVE classification: every dropped table/column holds NO live
--   data (0 rows / all-NULL, re-verified above) and the down migration below
--   recreates every dropped object's exact structure (CREATE TABLE with all
--   original constraints/comments; ADD COLUMN with the original type; CREATE
--   INDEX with the original definition/comment) — there is no irrecoverable
--   data loss, which is what the destructive gate (F-088 / ADR-010) guards
--   against. This mirrors the precedent set by migrations 063, 066, and 091.
--   Separately: `db/migrate.py`'s DESTRUCTIVE_PATTERNS sniff DOES match
--   `DROP TABLE` (this migration contains two), so without this explicit
--   directive the sniff would force --allow-destructive; the deploy runner
--   `Deploy/azure-deploy-inactive.sh` NEVER passes --allow-destructive (by
--   design — see its own comments), so an un-directived destructive-sniffed
--   migration would hard-block the automated deploy pipeline entirely,
--   requiring the out-of-band operator procedure. Given the verified-empty /
--   fully-recoverable analysis above, marking this `non-destructive` is the
--   accurate classification, not a workaround.
--
--   STORAGE RECLAIM (operational, NOT part of this migration): DROP COLUMN/
--   DROP TABLE only marks space reclaimable; a table rewrite is needed to
--   return it to the OS. All dropped columns are all-NULL and the two
--   dropped tables are 0-row, so the reclaim here is negligible — a routine
--   autovacuum is sufficient; no VACUUM FULL is warranted (contrast with
--   migration 091's ~43 MiB tsvector reclaim).
--
--   Reverse: 092_dead_schema_removal.down.sql (recreates all 22 objects).
--   Depends on: 001_core_schema, 002_darakwon_corpora, 003_krdict,
--               005_lesson_podcast_topik, 008_topik_dependencies,
--               016_hanja, 041_book_pages.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps this body in a single transaction. Every DROP here is transactional.
-- =============================================================================

-- 1. Dead tables (0 rows, no writer, no reader) -------------------------------
DROP TABLE IF EXISTS lets_check_exercises;
DROP TABLE IF EXISTS hanja_extensions;

-- 2. Redundant indexes (prefix-subsumed by a UNIQUE) --------------------------
DROP INDEX IF EXISTS ix_hanja_compounds_character;
DROP INDEX IF EXISTS ix_topik_dependencies_item;

-- 3. Dead columns (all-NULL, unreferenced) ------------------------------------

-- vocab_entries (10) — denormalized inline form-variant copies.
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS audio_track;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS japanese;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS case_marker;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS irregular_class;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS passive_form;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS causative_form;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS basic_form;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS honorific_form;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS humble_form;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS contracted_form;

-- krdict_entries (1)
ALTER TABLE krdict_entries DROP COLUMN IF EXISTS register;

-- krdict_senses (2)
ALTER TABLE krdict_senses DROP COLUMN IF EXISTS sense_domain;
ALTER TABLE krdict_senses DROP COLUMN IF EXISTS sense_register;

-- topik_items (1) — skill_tag_raw only; skill_tag is KEPT (live reader).
ALTER TABLE topik_items DROP COLUMN IF EXISTS skill_tag_raw;

-- book_pages (2) — DROP COLUMN cascades to ck_book_pages_width_positive /
-- ck_book_pages_height_positive automatically.
ALTER TABLE book_pages DROP COLUMN IF EXISTS width;
ALTER TABLE book_pages DROP COLUMN IF EXISTS height;

-- conversations (1) — DROP COLUMN cascades to ck_conversations_grading_object.
ALTER TABLE conversations DROP COLUMN IF EXISTS last_grading;

-- corpus_sources (1)
ALTER TABLE corpus_sources DROP COLUMN IF EXISTS version_tag;

-- End of 092_dead_schema_removal.up.sql — runner owns the transaction (ADR-013).
