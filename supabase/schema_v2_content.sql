-- 한국어 마스터 — Schema v2: Content Sources Layer
-- Run AFTER schema.sql. Adds tables for ingested books, podcasts, lessons, and audio.
-- Idempotent: safe to re-run (uses IF NOT EXISTS where supported).

-- ============================================================
-- SOURCES: top-level provenance for any content
-- ============================================================
-- One row per book, podcast series, lesson series, or test set.
CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('book', 'podcast', 'lesson_series', 'test_set', 'textbook')),
  slug TEXT UNIQUE NOT NULL,            -- e.g. 'ttmik-level-1', 'darakwon-2000-beginner', 'topik-91'
  title TEXT NOT NULL,                  -- 'TTMIK Level 1'
  title_korean TEXT,                    -- e.g. '이야기'
  publisher TEXT,                       -- 'Talk To Me In Korean', 'Darakwon'
  level TEXT,                           -- 'beginner', 'intermediate', 'advanced', 'topik1', 'topik2'
  copyright_status TEXT DEFAULT 'personal_use_only' CHECK (copyright_status IN ('personal_use_only', 'public_domain', 'cc')),
  metadata JSONB DEFAULT '{}',          -- arbitrary: original_filename, page_count, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SOURCE_UNITS: chapters / lessons / episodes within a source
-- ============================================================
-- One row per chapter (book), lesson (lesson series), episode (podcast), or test paper (test set).
CREATE TABLE IF NOT EXISTS source_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('chapter', 'lesson', 'episode', 'test_paper', 'unit')),
  ordinal INTEGER NOT NULL,             -- 1, 2, 3... for sorting
  title TEXT,                           -- 'Lesson 5: -아/어/여요'
  title_korean TEXT,
  audio_url TEXT,                       -- signed R2 URL for the whole-unit audio
  audio_duration_seconds INTEGER,
  transcript_pdf_page_start INTEGER,    -- for tracing back to source PDF
  transcript_pdf_page_end INTEGER,
  metadata JSONB DEFAULT '{}',
  UNIQUE(source_id, kind, ordinal)
);

-- ============================================================
-- SENTENCES: the smallest unit of content
-- ============================================================
-- Every Korean sentence pulled from any source. This is what we surface in flashcards,
-- conversation prompts, reading practice, etc. Audio timestamps are optional —
-- if present, we can click-to-play just this sentence within the unit audio.
CREATE TABLE IF NOT EXISTS sentences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID REFERENCES source_units(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,             -- position within the unit
  korean TEXT NOT NULL,
  english TEXT,                         -- translation if available in source
  romanization TEXT,                    -- e.g. 'annyeonghaseyo' (often present in TTMIK)
  notes TEXT,                           -- grammar notes, cultural context, etc. from source
  audio_start_ms INTEGER,               -- offset into the unit's audio_url; NULL = no alignment yet
  audio_end_ms INTEGER,
  content_hash TEXT NOT NULL,           -- sha256 of korean+english — for idempotent re-ingest
  difficulty TEXT,                      -- 'beginner', 'topik1', 'topik2', 'advanced'
  tags TEXT[],                          -- ['business', 'daily', 'grammar:eo-yo', 'iyagi']
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(unit_id, content_hash)
);

-- ============================================================
-- VOCAB_OCCURRENCES: link vocab items to the sentences they appear in
-- ============================================================
-- Lets us say "show me the 5 sentences where this word appears" or
-- "what new vocab is in this lesson's sentences?"
CREATE TABLE IF NOT EXISTS vocab_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vocab_id UUID NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  sentence_id UUID NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  surface_form TEXT,                    -- the conjugated form as it appears (e.g. '갔어요' for base '가다')
  UNIQUE(vocab_id, sentence_id)
);

-- ============================================================
-- Extend vocabulary_items with source provenance
-- ============================================================
ALTER TABLE vocabulary_items
  ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES sources(id),
  ADD COLUMN IF NOT EXISTS first_seen_sentence_id UUID REFERENCES sentences(id),
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Backfill content_hash for existing rows (md5 of korean+english as a fallback)
UPDATE vocabulary_items
SET content_hash = md5(korean || '|' || english)
WHERE content_hash IS NULL;

ALTER TABLE vocabulary_items
  ADD CONSTRAINT vocabulary_items_content_hash_unique UNIQUE (content_hash);

-- ============================================================
-- Extend topik_tests with source provenance
-- ============================================================
-- Existing topik_tests.questions JSONB stays as the canonical store;
-- this just links a test paper back to the source set (e.g. TOPIK 91).
ALTER TABLE topik_tests
  ADD COLUMN IF NOT EXISTS source_unit_id UUID REFERENCES source_units(id);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_source_units_source ON source_units(source_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_sentences_unit ON sentences(unit_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_sentences_korean_trgm ON sentences USING gin (korean gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_vocab_occurrences_sentence ON vocab_occurrences(sentence_id);
CREATE INDEX IF NOT EXISTS idx_vocab_occurrences_vocab ON vocab_occurrences(vocab_id);

-- Enable trigram extension for fuzzy Korean search (used by idx above)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- RLS: content is readable by any authenticated user (single-user app, but defense in depth)
-- ============================================================
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentences ENABLE ROW LEVEL SECURITY;
ALTER TABLE vocab_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read sources" ON sources
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can read source_units" ON source_units
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can read sentences" ON sentences
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can read vocab_occurrences" ON vocab_occurrences
  FOR SELECT USING (auth.role() = 'authenticated');

-- Ingest scripts use the service_role key, which bypasses RLS, so no insert policy needed here.
