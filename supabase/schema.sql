-- 한국어 마스터 (Hangugeo Master) — Database Schema
-- Supabase PostgreSQL
-- Users handled by Supabase Auth (auth.users)

-- User progress metrics
CREATE TABLE user_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  metric_type TEXT NOT NULL, -- 'streak', 'vocab_mastered', 'reading_level', 'topik1_readiness', 'topik2_readiness', 'korean_age'
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vocabulary items
CREATE TABLE vocabulary_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  korean TEXT NOT NULL,
  english TEXT NOT NULL,
  example_sentence_korean TEXT NOT NULL,
  example_sentence_english TEXT NOT NULL,
  deck TEXT NOT NULL, -- 'topik1', 'topik2', 'business', 'daily_life', 'slang'
  topik_level INTEGER, -- 1 or 2
  difficulty INTEGER DEFAULT 1 -- 1-5
);

-- SM-2 review records
CREATE TABLE vocab_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  vocab_id UUID REFERENCES vocabulary_items(id),
  interval INTEGER DEFAULT 1,
  easiness FLOAT DEFAULT 2.5,
  repetitions INTEGER DEFAULT 0,
  next_review TIMESTAMPTZ DEFAULT NOW(),
  last_review TIMESTAMPTZ,
  consecutive_correct INTEGER DEFAULT 0,
  is_mastered BOOLEAN DEFAULT FALSE
);

-- Grammar lessons
CREATE TABLE grammar_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  title_korean TEXT NOT NULL,
  level TEXT NOT NULL, -- 'beginner', 'topik1', 'topik2', 'advanced'
  content JSONB NOT NULL, -- { explanation, examples[], practice_sentences[], quiz[] }
  topik_frequency INTEGER, -- how often this pattern appears in TOPIK
  order_index INTEGER,
  mode_tags TEXT[] -- ['business', 'daily', 'academic', 'casual']
);

-- Lesson completions
CREATE TABLE lesson_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES grammar_lessons(id),
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  score INTEGER -- 0-100
);

-- TOPIK practice tests
CREATE TABLE topik_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level INTEGER NOT NULL, -- 1 or 2
  section TEXT NOT NULL, -- 'reading', 'listening', 'writing'
  title TEXT,
  questions JSONB NOT NULL, -- array of question objects
  time_limit_minutes INTEGER
);

-- Test attempts
CREATE TABLE test_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  test_id UUID REFERENCES topik_tests(id),
  score INTEGER,
  max_score INTEGER,
  answers JSONB,
  taken_at TIMESTAMPTZ DEFAULT NOW(),
  duration_seconds INTEGER
);

-- Reading passages
CREATE TABLE reading_passages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  level TEXT NOT NULL, -- 'elementary', 'middle', 'high', 'adult'
  source_type TEXT NOT NULL, -- 'real', 'ai_generated'
  mode_tags TEXT[], -- ['business', 'daily', 'academic', 'casual']
  word_count INTEGER,
  comprehension_questions JSONB
);

-- Reading completions
CREATE TABLE reading_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  passage_id UUID REFERENCES reading_passages(id),
  score INTEGER,
  completed_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Conversation sessions
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, -- 'casual', 'business', 'topik_prep'
  messages JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily study log
CREATE TABLE study_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  minutes_studied INTEGER DEFAULT 0,
  activities JSONB DEFAULT '[]',
  goal_met BOOLEAN DEFAULT FALSE
);

-- Indexes for common queries
CREATE INDEX idx_user_progress_user ON user_progress(user_id);
CREATE INDEX idx_vocab_reviews_user ON vocab_reviews(user_id);
CREATE INDEX idx_vocab_reviews_next ON vocab_reviews(next_review);
CREATE INDEX idx_vocabulary_deck ON vocabulary_items(deck);
CREATE INDEX idx_lesson_completions_user ON lesson_completions(user_id);
CREATE INDEX idx_test_attempts_user ON test_attempts(user_id);
CREATE INDEX idx_reading_completions_user ON reading_completions(user_id);
CREATE INDEX idx_conversations_user ON conversations(user_id);
CREATE INDEX idx_study_log_user_date ON study_log(user_id, date);
CREATE INDEX idx_grammar_lessons_level ON grammar_lessons(level);

-- Row Level Security (RLS)
ALTER TABLE user_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE vocab_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies: users can only access their own data
CREATE POLICY "Users can manage their own progress" ON user_progress
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own reviews" ON vocab_reviews
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own completions" ON lesson_completions
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own test attempts" ON test_attempts
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own reading completions" ON reading_completions
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own conversations" ON conversations
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own study log" ON study_log
  FOR ALL USING (auth.uid() = user_id);

-- Public read access for content tables
CREATE POLICY "Anyone can read vocabulary" ON vocabulary_items
  FOR SELECT USING (true);
ALTER TABLE vocabulary_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read grammar lessons" ON grammar_lessons
  FOR SELECT USING (true);
ALTER TABLE grammar_lessons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read TOPIK tests" ON topik_tests
  FOR SELECT USING (true);
ALTER TABLE topik_tests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read reading passages" ON reading_passages
  FOR SELECT USING (true);
ALTER TABLE reading_passages ENABLE ROW LEVEL SECURITY;
