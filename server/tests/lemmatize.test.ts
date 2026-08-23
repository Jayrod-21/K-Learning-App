/**
 * Lemmatize integration — verify we proxy correctly, mock the Kiwi HTTP call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from './helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from './helpers/app.js';
import { registerUser } from './helpers/seed.js';

let pg: PgHandle;
let t: TestApp;
let kiwiServer: Server;
let lastKiwiBody: string | null = null;

beforeAll(async () => {
  pg = await startPostgres();
  // Fake Kiwi server. Returns a deterministic payload; records the body so
  // we can assert the request was relayed correctly.
  kiwiServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastKiwiBody = Buffer.concat(chunks).toString('utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          // Real km-kiwi shape (services/kiwi/src/kiwi_service/models.py Token).
          tokens: [
            { surface: '먹었어요', lemma: '먹다', pos: 'VV', start: 0, end: 4 },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => kiwiServer.listen(0, '127.0.0.1', resolve));
  const port = (kiwiServer.address() as { port: number }).port;
  t = buildTestApp({
    connectionString: pg.connectionString,
    kiwiUrl: `http://127.0.0.1:${port}`,
  });
});

afterAll(async () => {
  await teardownTestApp(t);
  await new Promise<void>((resolve) => kiwiServer.close(() => resolve()));
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  lastKiwiBody = null;
});

describe('POST /lemmatize', () => {
  it('requires auth', async () => {
    const res = await request(t.app).post('/lemmatize').send({ text: '안녕' });
    expect(res.status).toBe(401);
  });

  it('proxies to Kiwi and returns parsed tokens', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: '먹었어요' });
    expect(res.status).toBe(200);
    expect(res.body.tokens[0].lemma).toBe('먹다');
    expect(JSON.parse(lastKiwiBody!).text).toBe('먹었어요');
  });

  it('rejects oversized input at the zod boundary', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
  });
});
