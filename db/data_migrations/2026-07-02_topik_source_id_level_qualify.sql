-- Data migration (one-off) — level-qualify pre-existing TOPIK item source_ids.
-- Date: 2026-07-02
-- Author: fix-pass for REVIEW_TOPIK_LOAD_A SHOULD-FIX 2.
--
-- THIS IS NOT A SCHEMA MIGRATION. It is intentionally OUTSIDE db/migrations/ so
-- the numbered migration runner (db/migrate.py) never applies it automatically:
-- it mutates data, not schema, and it is needed ONLY by environments that
-- already hold pre-fix TOPIK data. A FRESH environment never needs it — the
-- current loader (tools/ingest/loaders/load_topik.py) plus the level-qualified
-- ids in the source JSON reproduce the target state from scratch. Run this by
-- hand (psql -v ON_ERROR_STOP=1 -1 -f <this file>) only against a database that
-- was loaded BEFORE the level token was added to topik_items.source_id.
--
-- WHY IT EXISTS
-- -------------
-- The old id scheme was `topik<test>-<section>-<NNN>` (e.g. topik98-listen-001),
-- which is NOT unique across levels: a single sitting has both a TOPIK-I and a
-- TOPIK-II paper for the same section, each numbering its questions from 1. The
-- fixed scheme qualifies the id with the level: `topik<test>-<I|II>-<section>-<NNN>`
-- (see tools/ingest/TOPIK_OCR_PLAYBOOK.md and migration 029). Every pre-fix
-- source_id in the wild is TOPIK-I data (TOPIK-II was not yet loaded when the
-- collision was found), so the correct qualifier to inject is `-I-`.
--
-- Renaming in place (rather than deleting + reloading) lets the loader's
-- `ON CONFLICT (corpus, source_id)` upsert MATCH the existing rows on the next
-- run — it updates them instead of inserting parallel duplicates. Because
-- topik_responses.topik_item_id references topik_items(id) (the surrogate key,
-- not source_id), keeping the same rows preserves those FK rows unchanged; a
-- delete+reload would orphan or churn them.
--
-- IDEMPOTENT / GUARDED
-- --------------------
-- The WHERE clause matches ONLY the old (unqualified) shape
-- `^topik\d+-(listen|read|write)-`. After the rename a source_id looks like
-- `topik98-I-listen-001`, which no longer matches (the segment after the digits
-- is `-I-`, not `-listen-`), so re-running this script is a guaranteed no-op.
-- Rows already on the new scheme (any TOPIK-II data, or a fresh load) are never
-- touched. Safe to run more than once and safe to run on a fresh DB (0 rows).

UPDATE topik_items
   SET source_id = regexp_replace(
                     source_id,
                     '^(topik[0-9]+)-(listen|read|write)-',
                     '\1-I-\2-'
                   )
 WHERE corpus = 'topik'
   AND source_id ~ '^topik[0-9]+-(listen|read|write)-';
