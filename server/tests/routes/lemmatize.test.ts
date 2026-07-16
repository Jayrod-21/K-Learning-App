/**
 * Per-route tests for src/routes/lemmatize.ts (B-FU-2).
 *
 * Covers: success, validation rejection, rate-limit, auth-required, downstream
 * (Kiwi) error mapping. The existing top-level lemmatize.test.ts already covers
 * the happy path against a fake server; this file expands on:
 *   - Kiwi 500 → 502 upstream_error (after retry)
 *   - Kiwi 400 → 400 validation_error
 *   - Kiwi connect-refused → 502 upstream_error
 *   - Expensive-limiter 429
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;
let kiwiServer: Server;
type KiwiMode = 'ok' | '400' | '500' | 'hang';
let kiwiMode: KiwiMode = 'ok';

beforeAll(async () => {
  pg = await startPostgres();
  kiwiServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (kiwiMode === '400') {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'bad input' }));
        return;
      }
      if (kiwiMode === '500') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      if (kiwiMode === 'hang') {
        // Don't respond — supertest call should rely on the route's own timeout/handling.
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          tokens: [{ form: '먹었어요', lemma: '먹다', tag: 'VV', start: 0, length: 4 }],
        }),
      );
      // Use body only to silence the unused-var lint; we don't assert on it here.
      void body;
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
  kiwiMode = 'ok';
  resetLimiters();
});

describe('POST /lemmatize — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).post('/lemmatize').send({ text: '안녕' });
    expect(res.status).toBe(401);
  });
});

describe('POST /lemmatize — success', () => {
  it('200 with parsed tokens', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: '먹었어요' });
    expect(res.status).toBe(200);
    expect(res.body.tokens[0].lemma).toBe('먹다');
  });
});

describe('POST /lemmatize — validation rejection', () => {
  it('empty text → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('oversized text → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: 'x'.repeat(5_000) });
    expect(res.status).toBe(400);
  });

  it('wrong type → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: 12345 });
    expect(res.status).toBe(400);
  });
});

describe('POST /lemmatize — downstream error', () => {
  it('Kiwi 400 → 400 validation_error from us (input rejected upstream)', async () => {
    kiwiMode = '400';
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: '먹었어요' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    // F-195: the upstream 400 body ('bad input') is server-side log-only.
    expect(res.text).not.toContain('bad input');
  });

  it('Kiwi 500 → 502 upstream_error (after internal retry)', async () => {
    kiwiMode = '500';
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: '먹었어요' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('upstream_error');
  });

  it('F-195: the raw upstream error body never reaches the client', async () => {
    // Pre-fix, kiwi.ts attached the upstream response body (and, for network
    // failures, a serialized {name, message}) to the error's `details`, which
    // the generic errorHandler forwards verbatim — the fake upstream's 'boom'
    // text appeared in the 502 response. The wire must carry only the fixed
    // server-minted message.
    kiwiMode = '500';
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/lemmatize').send({ text: '먹었어요' });
    expect(res.status).toBe(502);
    expect(res.text).not.toContain('boom');
    expect(res.body.error.details).toBeUndefined();
  });

  it('Kiwi unreachable → 502 upstream_error', async () => {
    // Point a fresh app at an unused port.
    const dead = buildTestApp({
      connectionString: pg.connectionString,
      kiwiUrl: 'http://127.0.0.1:1', // port 1 not listening
    });
    try {
      // Re-register the user against the new app so the cookie matches.
      const { agent } = await registerUser(dead.app, pg.pool);
      const res = await agent.post('/lemmatize').send({ text: '먹었어요' });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('upstream_error');
      // F-195: the network-error cause ({name, message} naming host/port) is
      // server-side log-only — never forwarded as details.
      expect(res.text).not.toContain('ECONNREFUSED');
      expect(res.body.error.details).toBeUndefined();
    } finally {
      await teardownTestApp(dead);
      // Restore the shared app — buildTestApp swaps module-scoped state.
      t = buildTestApp({
        connectionString: pg.connectionString,
        kiwiUrl: `http://127.0.0.1:${(kiwiServer.address() as { port: number }).port}`,
      });
    }
  }, 30_000);
});

describe('POST /lemmatize — rate limit', () => {
  it('exceeds RATE_LIMIT_EXPENSIVE_MAX in the window → 429', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const res = await agent.post('/lemmatize').send({ text: '안녕' });
      if (res.status === 429) {
        expect(res.body.error.code).toBe('rate_limited');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});
