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

// Byte-shaped like the real km-kiwi service output for「먹었다」— the contract
// is services/kiwi/src/kiwi_service/models.py (Token: surface/lemma/pos/start/end).
const OK_BODY = JSON.stringify({
  tokens: [
    { surface: '먹', lemma: '먹다', pos: 'VV', start: 0, end: 1 },
    { surface: '었', lemma: '었', pos: 'EP', start: 1, end: 2 },
    { surface: '다', lemma: '다', pos: 'EF', start: 2, end: 3 },
  ],
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

describe('lemmatize — km-kiwi contract (drift guard)', () => {
  // Regression guard for the schema-drift prod bug: KiwiTokenSchema once
  // expected `{form, lemma, tag, start, length}` while the real km-kiwi
  // service (services/kiwi/src/kiwi_service/models.py, `Token`) emits
  // `{surface, lemma, pos, start, end}`. Every valid response was rejected as
  // malformed, /lemmatize 502'd, and tap-to-define silently fell back to the
  // raw tapped form. The drift survived because tests mocked Kiwi with the
  // WRONG shape — these tests pin the schema to the real contract instead.

  it('accepts a payload byte-shaped like the real service output and returns the lemma', async () => {
    // Exactly what the live service returns for 「먹었다」.
    responses = [
      {
        status: 200,
        body: JSON.stringify({
          tokens: [
            { surface: '먹', lemma: '먹다', pos: 'VV', start: 0, end: 1 },
            { surface: '었', lemma: '었', pos: 'EP', start: 1, end: 2 },
            { surface: '다', lemma: '다', pos: 'EF', start: 2, end: 3 },
          ],
        }),
      },
    ];
    const out = await lemmatize({ text: '먹었다' }, 'cid-contract-1');
    expect(out.tokens).toHaveLength(3);
    expect(out.tokens[0]).toEqual({
      surface: '먹',
      lemma: '먹다',
      pos: 'VV',
      start: 0,
      end: 1,
    });
  });

  it('rejects the pre-fix {form, tag, length} shape as malformed', async () => {
    // The OLD (wrong) TS-side shape. It lacks surface/pos/end, so the schema
    // must refuse it — if this test starts passing a payload through, the
    // schema has drifted away from models.py again.
    responses = [
      {
        status: 200,
        body: JSON.stringify({
          tokens: [{ form: '먹었다', lemma: '먹다', tag: 'VV', start: 0, length: 3 }],
        }),
      },
    ];
    const err = await lemmatize({ text: '먹었다' }, 'cid-contract-2').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe('kiwi returned malformed payload');
  });

  it('rejects inverted offsets (end < start), mirroring the Pydantic validator', async () => {
    responses = [
      {
        status: 200,
        body: JSON.stringify({
          tokens: [{ surface: '먹', lemma: '먹다', pos: 'VV', start: 2, end: 1 }],
        }),
      },
    ];
    const err = await lemmatize({ text: '먹었다' }, 'cid-contract-3').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe('kiwi returned malformed payload');
  });
});

describe('lemmatize — F-195: no raw upstream detail on thrown errors', () => {
  // The generic errorHandler forwards `AppError.details` to the client
  // verbatim, so ANY upstream-derived text attached here becomes a wire leak.
  // Every error thrown by kiwi.ts must carry NO details; the raw body/cause
  // is server-side log-only.

  it('a 5xx error carries no details and none of the upstream body text', async () => {
    responses = [{ status: 500, body: '{"error":"secret upstream detail"}' }];
    const err = await lemmatize({ text: '안녕' }, 'cid-4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).details).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain('secret upstream detail');
  });

  it('a 400 ValidationError carries no details and none of the upstream body text', async () => {
    responses = [{ status: 400, body: '{"error":"reflected user input 먹었어요"}' }];
    const err = await lemmatize({ text: '먹었어요' }, 'cid-5').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain('reflected user input');
  });

  it('a malformed-payload error carries no details (no Zod issues on the wire)', async () => {
    responses = [{ status: 200, body: '{"tokens":"not an array"}' }];
    const err = await lemmatize({ text: '안녕' }, 'cid-6').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).details).toBeUndefined();
  });

  it('an upstream body carrying a numeric `status` key can no longer override our 502', async () => {
    // Regression for the latent status-override hole: UpstreamError honors a
    // numeric `details.status` — an upstream body `{"status": 200}` used to
    // be passed as details and would have rewritten the wire status.
    responses = [{ status: 500, body: '{"status": 200, "error":"boom"}' }];
    const err = await lemmatize({ text: '안녕' }, 'cid-7').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(502);
  });
});
