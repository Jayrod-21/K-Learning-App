/**
 * Supabase Service Layer
 * Centralized Supabase client initialization and common database operations.
 * All Supabase interactions should go through this service.
 */
const { createClient } = require('@supabase/supabase-js');

/** Supabase admin client (uses service role key — server-side only) */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Get user progress metrics
 * @param {string} userId - Supabase auth user ID
 * @returns {Promise<Array<{metric_type: string, value: object}>>}
 */
async function getUserProgress(userId) {
  const { data, error } = await supabase
    .from('user_progress')
    .select('*')
    .eq('user_id', userId);

  if (error) throw error;
  return data;
}

/**
 * Update or insert a progress metric
 * @param {string} userId - Supabase auth user ID
 * @param {string} metricType - Metric identifier (e.g., 'streak', 'vocab_mastered')
 * @param {object} value - JSONB value for the metric
 */
async function upsertProgress(userId, metricType, value) {
  const { data, error } = await supabase
    .from('user_progress')
    .upsert(
      {
        user_id: userId,
        metric_type: metricType,
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,metric_type' }
    )
    .select();

  if (error) throw error;
  return data;
}

/**
 * Get vocabulary items by deck
 * @param {string} deck - Deck name ('topik1', 'topik2', 'business', 'daily_life', 'slang')
 * @returns {Promise<Array>}
 */
async function getVocabByDeck(deck) {
  const { data, error } = await supabase
    .from('vocabulary_items')
    .select('*')
    .eq('deck', deck);

  if (error) throw error;
  return data;
}

/**
 * Get cards due for review for a user
 * @param {string} userId - Supabase auth user ID
 * @returns {Promise<Array>} Vocab reviews with joined vocabulary item data
 */
async function getDueReviews(userId) {
  const { data, error } = await supabase
    .from('vocab_reviews')
    .select('*, vocabulary_items(*)')
    .eq('user_id', userId)
    .lte('next_review', new Date().toISOString());

  if (error) throw error;
  return data;
}

/**
 * Update a vocab review record after SM-2 calculation
 * @param {string} reviewId - Review record UUID
 * @param {object} sm2Result - SM-2 calculation result
 */
async function updateReview(reviewId, sm2Result) {
  const { error } = await supabase
    .from('vocab_reviews')
    .update({
      interval: sm2Result.interval,
      easiness: sm2Result.easiness,
      repetitions: sm2Result.repetitions,
      next_review: sm2Result.nextReview,
      last_review: new Date().toISOString(),
      consecutive_correct: sm2Result.consecutiveCorrect,
      is_mastered: sm2Result.isMastered,
    })
    .eq('id', reviewId);

  if (error) throw error;
}

/**
 * Log a study session
 * @param {string} userId - Supabase auth user ID
 * @param {number} minutes - Minutes studied
 * @param {object} activity - Activity details
 */
async function logStudySession(userId, minutes, activity) {
  const today = new Date().toISOString().split('T')[0];

  const { data: existing } = await supabase
    .from('study_log')
    .select('*')
    .eq('user_id', userId)
    .eq('date', today)
    .single();

  if (existing) {
    const activities = [...(existing.activities || []), activity];
    const { error } = await supabase
      .from('study_log')
      .update({
        minutes_studied: existing.minutes_studied + minutes,
        activities,
      })
      .eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('study_log').insert({
      user_id: userId,
      date: today,
      minutes_studied: minutes,
      activities: [activity],
    });
    if (error) throw error;
  }
}

module.exports = {
  supabase,
  getUserProgress,
  upsertProgress,
  getVocabByDeck,
  getDueReviews,
  updateReview,
  logStudySession,
};
