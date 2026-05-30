/**
 * Health endpoint — must be unauthenticated and report DB status.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from './helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from './helpers/app.js';

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

describe('GET /health', () => {
  it('returns 200 with db=ok when Postgres is reachable', async () => {
    const res = await request(t.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.db).toBe('ok');
  });
});
