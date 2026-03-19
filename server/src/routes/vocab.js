/**
 * Vocabulary Routes
 * Endpoints for vocabulary items and SM-2 review management.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getVocabByDeck, getDueReviews, updateReview, supabase } = require('../services/supabaseService');

/**
 * GET /api/vocab/deck/:deckName
 * Get all vocabulary items in a deck
 */
router.get('/deck/:deckName', async (req, res) => {
  try {
    const data = await getVocabByDeck(req.params.deckName);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vocabulary' });
  }
});

/**
 * GET /api/vocab/reviews/due
 * Get all cards due for review for the authenticated user
 */
router.get('/reviews/due', requireAuth, async (req, res) => {
  try {
    const data = await getDueReviews(req.user.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch due reviews' });
  }
});

/**
 * PUT /api/vocab/reviews/:reviewId
 * Update a review record after SM-2 calculation
 */
router.put('/reviews/:reviewId', requireAuth, async (req, res) => {
  try {
    await updateReview(req.params.reviewId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update review' });
  }
});

/**
 * POST /api/vocab/reviews/init
 * Initialize review records for a user starting a new deck
 */
router.post('/reviews/init', requireAuth, async (req, res) => {
  try {
    const { deckName } = req.body;
    const vocabItems = await getVocabByDeck(deckName);

    const reviews = vocabItems.map((item) => ({
      user_id: req.user.id,
      vocab_id: item.id,
      interval: 1,
      easiness: 2.5,
      repetitions: 0,
      next_review: new Date().toISOString(),
      consecutive_correct: 0,
      is_mastered: false,
    }));

    const { error } = await supabase.from('vocab_reviews').insert(reviews);
    if (error) throw error;

    res.json({ success: true, count: reviews.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initialize reviews' });
  }
});

module.exports = router;
