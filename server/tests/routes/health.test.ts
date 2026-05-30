/**
 * Per-route tests for src/routes/health.ts (B-FU-2).
 *
 * Health must be UNAUTH, UN-RATE-LIMITED, and resilient to DB failure:
 * - happy path: 200 + db=ok
 * - DB failure: 503 + db=fail:<msg>, NEVER 500
 * - never requires auth
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(() => {
  // Health doesn't touch user tables; no truncation needed.
});

const HealthBodySchema = z.object({
  status: z.union([z.literal('ok'), z.literal('degraded')]),
  service: z.string(),
  checks: z.object({ db: z.string() }),
});

describe('GET /health — success', () => {
  it('returns 200 with db=ok when Postgres is reachable', async () => {
    const res = await request(t.app).get('/health');
    expect(res.status).toBe(200);
    const parsed = HealthBodySchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.db).toBe('ok');
  });

  it('does NOT require authentication (no cookie → still 200)', async () => {
    const res = await request(t.app).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /health — DB error', () => {
  it('returns 503 (not 500) when the DB ping fails', async () => {
    // Build a SECOND test app whose pool points at a closed pool — that way
    // SELECT 1 fails without breaking the shared `t` instance used elsewhere.
    // We use a deliberately bad connection string to a port nothing listens on.
    const broken = buildTestApp({
      connectionString: 'postgres://nobody:nobody@127.0.0.1:1/no_such_db',
    });
    try {
      const res = await request(broken.app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.checks.db).toMatch(/^fail:/);
    } finally {
      await teardownTestApp(broken);
      // Re-attach the real pool to the module-scoped `t` so subsequent tests
      // don't reuse the broken one. buildTestApp swaps the module-scoped pool
      // via setPoolForTesting().
      buildTestApp({ connectionString: pg.connectionString });
    }
  });
});
