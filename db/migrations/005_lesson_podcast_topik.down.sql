-- =============================================================================
-- Migration 005 — Lesson / Podcast / TOPIK corpora (DOWN)
-- =============================================================================
-- Reverses 005_lesson_podcast_topik.up.sql cleanly. Drops dependent tables
-- before their parents, drops triggers/functions/enums last.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — runner owns it.
-- =============================================================================

-- Drop loader bookkeeping
DROP TABLE IF EXISTS load_state CASCADE;

-- TOPIK
DROP TRIGGER IF EXISTS trg_topik_items_tsv        ON topik_items;
DROP TRIGGER IF EXISTS trg_topik_items_updated_at ON topik_items;
DROP TABLE IF EXISTS topik_items CASCADE;

DROP TRIGGER IF EXISTS trg_topik_tests_updated_at ON topik_tests;
DROP TABLE IF EXISTS topik_tests CASCADE;

DROP FUNCTION IF EXISTS topik_items_tsv_refresh();

-- Iyagi
DROP TRIGGER IF EXISTS trg_iyagi_sentences_tsv        ON iyagi_sentences;
DROP TRIGGER IF EXISTS trg_iyagi_sentences_updated_at ON iyagi_sentences;
DROP TABLE IF EXISTS iyagi_sentences CASCADE;

DROP TRIGGER IF EXISTS trg_iyagi_episodes_updated_at ON iyagi_episodes;
DROP TABLE IF EXISTS iyagi_episodes CASCADE;

DROP FUNCTION IF EXISTS iyagi_sentences_tsv_refresh();

-- TTMIK
DROP TRIGGER IF EXISTS trg_ttmik_sentences_tsv        ON ttmik_sentences;
DROP TRIGGER IF EXISTS trg_ttmik_sentences_updated_at ON ttmik_sentences;
DROP TABLE IF EXISTS ttmik_sentences CASCADE;

DROP TRIGGER IF EXISTS trg_ttmik_lessons_updated_at ON ttmik_lessons;
DROP TABLE IF EXISTS ttmik_lessons CASCADE;

DROP FUNCTION IF EXISTS ttmik_sentences_tsv_refresh();

-- Enums introduced by this migration (drop last — types depend on tables above)
DROP TYPE IF EXISTS topik_item_type;
