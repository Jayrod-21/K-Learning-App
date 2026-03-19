/**
 * Reading Routes
 * Endpoints for reading passages and completions.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { supabase } = require('../services/supabaseService');
const { generateReadingPassage } = require('../services/claudeService');

/**
 * GET /api/reading/passages
 * Get reading passages, optionally filtered by level
 */
router.get('/passages', async (req, res) => {
  try {
    let query = supabase.from('reading_passages').select('*');

    if (req.query.level) {
      query = query.eq('level', req.query.level);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch passages' });
  }
});

/**
 * POST /api/reading/generate
 * Generate a new AI reading passage
 */
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { level, mode } = req.body;
    const passage = await generateReadingPassage(level, mode);

    // Persist the generated passage
    const { data, error } = await supabase
      .from('reading_passages')
      .insert({
        title: passage.title,
        content: passage.content,
        level,
        source_type: 'ai_generated',
        mode_tags: [mode],
        comprehension_questions: passage.questions,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ ...data, translation: passage.translation });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate passage' });
  }
});

/**
 * POST /api/reading/completions
 * Record a reading completion
 */
router.post('/completions', requireAuth, async (req, res) => {
  try {
    const { passageId, score } = req.body;
    const { data, error } = await supabase
      .from('reading_completions')
      .insert({
        user_id: req.user.id,
        passage_id: passageId,
        score,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record completion' });
  }
});

module.exports = router;
