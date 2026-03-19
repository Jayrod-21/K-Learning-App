/**
 * Hangugeo Master — Express Server Entry Point
 * Serves the API for the Korean learning application.
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const progressRoutes = require('./routes/progress');
const vocabRoutes = require('./routes/vocab');
const conversationRoutes = require('./routes/conversation');
const grammarRoutes = require('./routes/grammar');
const readingRoutes = require('./routes/reading');

const app = express();
const PORT = process.env.PORT || 3001;

/* Middleware */
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());

/* Rate limiting for AI-powered endpoints */
const aiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 50,
  message: { error: 'AI request limit reached. Try again tomorrow.' },
});

/* Routes */
app.use('/api/progress', progressRoutes);
app.use('/api/vocab', vocabRoutes);
app.use('/api/conversation', aiLimiter, conversationRoutes);
app.use('/api/grammar', grammarRoutes);
app.use('/api/reading', readingRoutes);

/* Health check */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hangugeo-master-api' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${PORT}`);
});
