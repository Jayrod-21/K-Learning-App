/**
 * Conversation Routes
 * Endpoints for AI conversation partner (Claude API).
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { conversationPartner } = require('../services/claudeService');
const { supabase } = require('../services/supabaseService');

/**
 * POST /api/conversation
 * Send a message to the AI conversation partner
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { messages, mode, conversationId } = req.body;
    const response = await conversationPartner(messages, mode);

    // Persist conversation if an ID is provided
    if (conversationId) {
      const updatedMessages = [...messages, { role: 'assistant', content: response }];
      await supabase
        .from('conversations')
        .update({ messages: updatedMessages, updated_at: new Date().toISOString() })
        .eq('id', conversationId);
    }

    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: 'Conversation request failed' });
  }
});

/**
 * POST /api/conversation/new
 * Start a new conversation session
 */
router.post('/new', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body;
    const { data, error } = await supabase
      .from('conversations')
      .insert({
        user_id: req.user.id,
        mode,
        messages: [],
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

/**
 * GET /api/conversation/history
 * Get conversation history for the authenticated user
 */
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch conversation history' });
  }
});

module.exports = router;
