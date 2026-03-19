/** Core type definitions for 한국어 마스터 */

/** User progress metric types */
export type MetricType =
  | 'streak'
  | 'vocab_mastered'
  | 'reading_level'
  | 'topik1_readiness'
  | 'topik2_readiness'
  | 'korean_age';

/** Progress record from Supabase */
export interface UserProgress {
  id: string;
  user_id: string;
  metric_type: MetricType;
  value: Record<string, unknown>;
  updated_at: string;
}

/** Vocabulary item */
export interface VocabularyItem {
  id: string;
  korean: string;
  english: string;
  example_sentence_korean: string;
  example_sentence_english: string;
  deck: 'topik1' | 'topik2' | 'business' | 'daily_life' | 'slang';
  topik_level: number | null;
  difficulty: number;
}

/** SM-2 review record from Supabase */
export interface VocabReview {
  id: string;
  user_id: string;
  vocab_id: string;
  interval: number;
  easiness: number;
  repetitions: number;
  next_review: string;
  last_review: string | null;
  consecutive_correct: number;
  is_mastered: boolean;
  vocabulary_items?: VocabularyItem;
}

/** Grammar lesson */
export interface GrammarLesson {
  id: string;
  title: string;
  title_korean: string;
  level: 'beginner' | 'topik1' | 'topik2' | 'advanced';
  content: {
    explanation: string;
    examples: Array<{ korean: string; english: string }>;
    practice_sentences: string[];
    quiz: Array<{
      question: string;
      options: string[];
      correct: number;
    }>;
  };
  topik_frequency: number | null;
  order_index: number;
  mode_tags: string[];
}

/** Lesson completion record */
export interface LessonCompletion {
  id: string;
  user_id: string;
  lesson_id: string;
  completed_at: string;
  score: number;
}

/** TOPIK test */
export interface TopikTest {
  id: string;
  level: 1 | 2;
  section: 'reading' | 'listening' | 'writing';
  title: string | null;
  questions: Array<{
    question: string;
    options: string[];
    correct: number;
    explanation?: string;
  }>;
  time_limit_minutes: number;
}

/** Test attempt record */
export interface TestAttempt {
  id: string;
  user_id: string;
  test_id: string;
  score: number;
  max_score: number;
  answers: Record<string, unknown>;
  taken_at: string;
  duration_seconds: number;
}

/** Reading passage */
export interface ReadingPassage {
  id: string;
  title: string;
  content: string;
  level: 'elementary' | 'middle' | 'high' | 'adult';
  source_type: 'real' | 'ai_generated';
  mode_tags: string[];
  word_count: number | null;
  comprehension_questions: Array<{
    question: string;
    options?: string[];
    correct?: number;
  }>;
}

/** AI conversation session */
export interface Conversation {
  id: string;
  user_id: string;
  mode: 'casual' | 'business' | 'topik_prep';
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  created_at: string;
  updated_at: string;
}

/** Study log entry */
export interface StudyLogEntry {
  id: string;
  user_id: string;
  date: string;
  minutes_studied: number;
  activities: Array<{
    type: string;
    detail: string;
  }>;
  goal_met: boolean;
}

/** Korean mode for context-aware learning */
export type KoreanMode = 'business' | 'daily' | 'academic' | 'casual';

/** Reading level progression */
export type ReadingLevel = '유아' | '초등' | '중등' | '고등' | '성인';
