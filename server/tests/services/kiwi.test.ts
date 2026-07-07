/**
 * kiwi.ts — upstream-error labeling + retry behavior.
 *
 * Regression (SWEEP_server_services, verified-clean nit): when both attempts
 * against a REACHABLE Kiwi end in 5xx, the pre-fix code threw
 * `UpstreamError('kiwi unreachable')` — mislabeling a live-but-erroring
 * upstream as a network problem. It must rethrow the recorded
 * `UpstreamError('kiwi <status>')` instead.
 *
 * Uses a real local HTTP server (same pattern as tests/lemmatize.test.ts) so
 * undici's behavior is exercised for real — no module mocking.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { lemmatize } from '../../src/services/kiwi';
import {
  TEST_TOTP_SECRET_ENC_KEY,
  resetConfig,
} from '../../src/config/index';
import { UpstreamError, ValidationError } from '../../src/middleware/errors';

let server: Server;
let requestCount = 0;
/** Per-test script: each entry handles one request in order; last repeats. */
let responses: Array<{ status: number; body: string }> = [];

const OK_BODY = JSON.stringify({
  tokens: [{ form: '먹었어요', lemma: '먹다', tag: 'VV', start: 0, length: 4 }],
});

beforeAll(async () => {
  server = createServer((_req, res) => {
    const spec =
      responses[Math.min(requestCount, responses.length - 1)] ??
      ({ status: 200, body: OK_BODY } as const);
    requestCount += 1;
    res.statusCode = spec.status;
    res.setHeader('content-type', 'application/json');
    res.end(spec.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  // Minimal valid app config env; loadConfig() re-parses after resetConfig().
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.KIWI_URL = `http://127.0.0.1:${port}`;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  process.env.TOTP_SECRET_ENC_KEY =
    process.env.TOTP_SECRET_ENC_KEY ?? TEST_TOTP_SECRET_ENC_KEY;
  process.env.LOG_LEVEL = 'silent';
  resetConfig();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Leave no memoized config pointing at the dead server for later suites.
  resetConfig();
});

beforeEach(() => {
  requestCount = 0;
  responses = [];
});

describe('lemmatize — upstream error labeling', () => {
  it('rethrows "kiwi 500" (NOT "kiwi unreachable") when a reachable upstream keeps 5xx-ing', async () => {
    responses = [{ status: 500, body: '{"error":"boom"}' }];
    const err = await lemmatize({ text: '안녕' }, 'cid-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe('kiwi 500');
    expect((err as Error).message).not.toContain('unreachable');
    expect(requestCount).toBe(2); // both attempts were made
  });

  it('retries once after a 5xx and succeeds on the second attempt', async () => {
    responses = [
      { status: 503, body: '{"error":"warming up"}' },
      { status: 200, body: OK_BODY },
    ];
    const out = await lemmatize({ text: '먹었어요' }, 'cid-2');
    expect(out.tokens[0]!.lemma).toBe('먹다');
    expect(requestCount).toBe(2);
  });

  it('maps a 400 to ValidationError without retrying', async () => {
    responses = [{ status: 400, body: '{"error":"bad input"}' }];
    const err = await lemmatize({ text: '안녕' }, 'cid-3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(requestCount).toBe(1);
  });
});
