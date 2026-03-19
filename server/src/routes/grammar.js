/**
 * Grammar Routes
 * Endpoints for grammar lessons and completions.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { supabase } = require('../services/supabaseService');
const { explainGrammar } = require('../services/claudeService');

/**
 * GET /api/grammar/lessons
 * Get all grammar lessons, optionally filtered by level
 */
router.get('/lessons', async (req, res) => {
  try {
    let query = supabase.from('grammar_lessons').select('*').order('order_index');

    if (req.query.level) {
      query = query.eq('level', req.query.level);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch grammar lessons' });
  }
});

/**
 * GET /api/grammar/lessons/:id
 * Get a single grammar lesson by ID
 */
router.get('/lessons/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('grammar_lessons')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch lesson' });
  }
});

/**
 * POST /api/grammar/completions
 * Record a lesson completion
 */
router.post('/completions', requireAuth, async (req, res) => {
  try {
    const { lessonId, score } = req.body;
    const { data, error } = await supabase
      .from('lesson_completions')
      .insert({
        user_id: req.user.id,
        lesson_id: lessonId,
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

/**
 * POST /api/grammar/explain
 * Get an AI explanation for a grammar pattern
 */
router.post('/explain', requireAuth, async (req, res) => {
  try {
    const { pattern } = req.body;
    const explanation = await explainGrammar(pattern);
    res.json(explanation);
  } catch (err) {
    res.status(500).json({ error: 'Failed to explain grammar pattern' });
  }
});

module.exports = router;
