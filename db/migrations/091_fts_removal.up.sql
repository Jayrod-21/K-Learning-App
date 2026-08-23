-- migrate: non-destructive
-- =============================================================================
-- Migration 091 — remove the orphaned full-text-search subsystem (audit §4.2)
--
--   Drops the `search_tsv` tsvector subsystem from the six content tables it
--   was built on: krdict_entries (003), kgiu_entries + vocab_entries (002),
--   and ttmik_sentences + iyagi_sentences + topik_items (005). For each table
--   this removes four objects:
--       * the BEFORE INSERT/UPDATE trigger  trg_<t>_tsv
--       * the trigger function              <t>_tsv_refresh()
--       * the GIN index                     ix_<t>_search_tsv
--       * the column                        search_tsv (tsvector)
--
--   WHY: the subsystem is never queried. A full-codebase audit found zero
--   live callers — no `@@`, `to_tsquery`, `plainto_tsquery`,
--   `websearch_to_tsquery`, `ts_rank`, or any read of `search_tsv` in
--   server/src or tools/ (only doc examples in tools/ingest/*.md reference it).
--   The vocab / grammar / krdict search endpoints use substring/prefix
--   (ILIKE) + column filters, not tsvector. No planned feature uses it either
--   (F-050 is first-character + genre search; F-054 REMOVES a search feature;
--   the vocab/kgiu search follow-ups add `domain`/`book_level` WHERE filters).
--   Meanwhile the trigger fires on EVERY write to the six largest content
--   tables, and the columns + GIN indexes occupy ~43 MiB (~17% of the
--   database), 14 MiB of it on the 53,978-row krdict_entries alone.
--
--   NON-DESTRUCTIVE classification: `search_tsv` holds NO original data — it
--   is fully DERIVED from each table's source columns by <t>_tsv_refresh()
--   (e.g. vocab_entries: korean/english/example_korean/example_english). The
--   down migration recreates every object AND backfills search_tsv with the
--   identical setweight() expressions, so the drop is completely recoverable —
--   there is no irrecoverable data loss, which is what the destructive gate
--   (F-088 / ADR-010) guards against. Hence the explicit `non-destructive`
--   directive, matching the precedent of the column-dropping migrations 063
--   and 066.
--
--   SUPERSEDES ADR-006 (tsvector language config) and ADR-015 (the planned
--   `search_tsv_kiwi` Kiwi-segmented successor) — both are marked Superseded
--   by this migration in db/docs/. Reintroducing full-text search is a fresh
--   design, not a revival of this subsystem.
--
--   STORAGE RECLAIM (operational, NOT part of this migration): DROP COLUMN
--   only marks the column dropped; the ~43 MiB returns to the OS only after a
--   table rewrite. After this migration applies, reclaim it in a deploy window
--   (each VACUUM FULL takes a brief ACCESS EXCLUSIVE lock on its table):
--       VACUUM (FULL, ANALYZE) krdict_entries;
--       VACUUM (FULL, ANALYZE) kgiu_entries;
--       VACUUM (FULL, ANALYZE) vocab_entries;
--       VACUUM (FULL, ANALYZE) ttmik_sentences;
--       VACUUM (FULL, ANALYZE) iyagi_sentences;
--       VACUUM (FULL, ANALYZE) topik_items;
--   VACUUM cannot run inside a transaction, so it is intentionally kept out of
--   the migration body (the runner wraps migrations in one transaction —
--   ADR-013).
--
--   Reverse: 091_fts_removal.down.sql (recreates + backfills all 24 objects).
--   Depends on: 002_darakwon_corpora, 003_krdict, 005_lesson_podcast_topik.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps this body in a single transaction. Every DROP here is transactional.
-- =============================================================================

-- krdict_entries (003) ---------------------------------------------------------
DROP TRIGGER IF EXISTS trg_krdict_entries_tsv ON krdict_entries;
DROP FUNCTION IF EXISTS krdict_entries_tsv_refresh();
DROP INDEX IF EXISTS ix_krdict_entries_search_tsv;
ALTER TABLE krdict_entries DROP COLUMN IF EXISTS search_tsv;

-- kgiu_entries (002) -----------------------------------------------------------
DROP TRIGGER IF EXISTS trg_kgiu_entries_tsv ON kgiu_entries;
DROP FUNCTION IF EXISTS kgiu_entries_tsv_refresh();
DROP INDEX IF EXISTS ix_kgiu_entries_search_tsv;
ALTER TABLE kgiu_entries DROP COLUMN IF EXISTS search_tsv;

-- vocab_entries (002) ----------------------------------------------------------
DROP TRIGGER IF EXISTS trg_vocab_entries_tsv ON vocab_entries;
DROP FUNCTION IF EXISTS vocab_entries_tsv_refresh();
DROP INDEX IF EXISTS ix_vocab_entries_search_tsv;
ALTER TABLE vocab_entries DROP COLUMN IF EXISTS search_tsv;

-- ttmik_sentences (005) --------------------------------------------------------
DROP TRIGGER IF EXISTS trg_ttmik_sentences_tsv ON ttmik_sentences;
DROP FUNCTION IF EXISTS ttmik_sentences_tsv_refresh();
DROP INDEX IF EXISTS ix_ttmik_sentences_search_tsv;
ALTER TABLE ttmik_sentences DROP COLUMN IF EXISTS search_tsv;

-- iyagi_sentences (005) --------------------------------------------------------
DROP TRIGGER IF EXISTS trg_iyagi_sentences_tsv ON iyagi_sentences;
DROP FUNCTION IF EXISTS iyagi_sentences_tsv_refresh();
DROP INDEX IF EXISTS ix_iyagi_sentences_search_tsv;
ALTER TABLE iyagi_sentences DROP COLUMN IF EXISTS search_tsv;

-- topik_items (005) ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_topik_items_tsv ON topik_items;
DROP FUNCTION IF EXISTS topik_items_tsv_refresh();
DROP INDEX IF EXISTS ix_topik_items_search_tsv;
ALTER TABLE topik_items DROP COLUMN IF EXISTS search_tsv;

-- End of 091_fts_removal.up.sql — runner owns the transaction (ADR-013).
