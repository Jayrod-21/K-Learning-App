/**
 * Express app factory.
 *
 * Split from `index.ts` so tests can mount the same app without binding a
 * port. Bar §"Structure": dependency injection — the app receives nothing it
 * imports as a global; both DB pool and Claude proxy are looked up lazily so
 * tests can swap them.
 */
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { loadConfig } from './config/index.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { errorHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import lemmatizeRoutes from './routes/lemmatize.js';
import defineRoutes from './routes/define.js';
import enrichRoutes from './routes/enrich.js';
import gradeRoutes from './routes/gradeWriting.js';
import progressRoutes from './routes/progress.js';
import vocabRoutes from './routes/vocab.js';
import vocabListsRoutes from './routes/vocabLists.js';
import conversationRoutes from './routes/conversation.js';
import grammarRoutes from './routes/grammar.js';
import readingRoutes from './routes/reading.js';
import planRoutes from './routes/plan.js';
import diagnosticRoutes from './routes/diagnostic.js';
import topikRoutes from './routes/topik.js';
import hanjaRoutes from './routes/hanja.js';

export function createApp(): Express {
  const cfg = loadConfig();
  const app = express();

  // Behind a reverse proxy / Cloudflare Tunnel — trust the first hop so
  // req.ip and rate-limit keying use the real client address.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: cfg.CLIENT_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(correlationMiddleware);

  // Health is mounted FIRST and is the only unauthenticated, un-rate-limited
  // endpoint. Everything else has an auth gate or a rate limiter (or both).
  app.use('/health', healthRoutes);

  app.use('/auth', authRoutes);
  app.use('/lemmatize', lemmatizeRoutes);
  app.use('/define', defineRoutes);
  app.use('/enrich', enrichRoutes);
  app.use('/grade-writing', gradeRoutes);

  app.use('/progress', progressRoutes);
  // /vocab/lists routes MUST mount before the catch-all /vocab router so
  // their handlers reach Express's matcher first. The `/vocab` router does
  // not define a `/lists` path today; keeping the order explicit also
  // documents the precedence for the next engineer.
  app.use('/vocab/lists', vocabListsRoutes);
  app.use('/vocab', vocabRoutes);
  app.use('/conversation', conversationRoutes);
  app.use('/grammar', grammarRoutes);
  app.use('/reading', readingRoutes);
  app.use('/plan', planRoutes);
  app.use('/diagnostic', diagnosticRoutes);
  app.use('/topik', topikRoutes);
  app.use('/hanja', hanjaRoutes);

  // 404 fallthrough — comes BEFORE the error handler.
  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'not_found', message: 'route not found' },
      correlationId: req.correlationId,
    });
  });

  app.use(errorHandler);
  return app;
}
