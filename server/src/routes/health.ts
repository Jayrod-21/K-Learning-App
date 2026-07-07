/**
 * GET /health — liveness + DB connectivity.
 *
 * Two reasons this is its own file:
 *   1. Health checks deserve to be cheap, unauthenticated, and not
 *      rate-limited so a load balancer doesn't get throttled.
 *   2. A failing DB ping should show in the health JSON, NOT take down the
 *      process — that's what supervisor restarts are for.
 */
import { Router } from 'express';
import { query } from '../db/pool.js';

const router = Router();

router.get('/', async (req, res) => {
  let dbOk = false;
  let dbError: string | null = null;
  try {
    await query('SELECT 1');
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
    req.log?.warn({ err: dbError }, 'health check db ping failed');
  }
  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'korean-master-api',
    checks: {
      // Fixed string only: /health is unauthenticated + un-rate-limited, and
      // raw pg connect errors embed internal host/port/db names ("connect
      // ECONNREFUSED 172.x.x.x:5432") — a topology leak (routes sweep #4).
      // The real error stays in the log line above.
      db: dbOk ? 'ok' : 'fail',
    },
  });
});

export default router;
