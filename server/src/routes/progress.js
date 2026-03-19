/**
 * Progress Routes
 * Endpoints for user progress metrics and study logging.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getUserProgress, upsertProgress, logStudySession } = require('../services/supabaseService');

/**
 * GET /api/progress
 * Retrieve all progress metrics for the authenticated user
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const data = await getUserProgress(req.user.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

/**
 * PUT /api/progress/:metricType
 * Update a specific progress metric
 */
router.put('/:metricType', requireAuth, async (req, res) => {
  try {
    const data = await upsertProgress(req.user.id, req.params.metricType, req.body.value);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

/**
 * POST /api/progress/study-log
 * Log a study session
 */
router.post('/study-log', requireAuth, async (req, res) => {
  try {
    const { minutes, activity } = req.body;
    await logStudySession(req.user.id, minutes, activity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log study session' });
  }
});

module.exports = router;
