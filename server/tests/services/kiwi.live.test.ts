/**
 * kiwi.live.test.ts — REAL km-kiwi integration smoke test (F-218).
 *
 * WHY THIS FILE EXISTS:
 *   The B-039 prod bug (server `KiwiTokenSchema` drifted to
 *   `{form, lemma, tag, start, length}` while the real service emits
 *   `{surface, lemma, pos, start, end}`) survived every gate because all
 *   kiwi tests MOCKED the service. `tests/services/kiwi.test.ts` now pins a
 *   hand-copied fixture of the contract, but a fixture can drift in lockstep
 *   with the schema. This test closes the loop: it BUILDS the real km-kiwi
 *   image from `services/kiwi/Dockerfile` (testcontainers — the same Docker
 *   the pg suites already require), boots it, and calls the REAL
 *   `/lemmatize` through the server's own `lemmatize()` client, whose
 *   `KiwiResponseSchema.parse` gate rejects any shape drift on EITHER side:
 *     - service changes its Token shape → the live response fails the parse;
 *     - server schema drifts from the service → the live response fails the
 *       parse just the same.
 *
 * COST: one docker build of services/kiwi (layer-cached locally; a few
 * minutes cold in CI) + a model load (~seconds for the base model). That is
 * the price of the only test in the repo that exercises the real contract.
 *
 * Uses the same env/config reset pattern as tests/services/kiwi.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { lemmatize } from '../../src/services/kiwi';
import {
  TEST_TOTP_SECRET_ENC_KEY,
  resetConfig,
} from '../../src/config/index';

const KIWI_CONTEXT = path.resolve(__dirname, '../../../services/kiwi');
const KIWI_PORT = 8000;

/** Docker build + model load can be slow on a cold cache — be generous. */
const STARTUP_TIMEOUT_MS = 10 * 60_000;

let container: StartedTestContainer;

beforeAll(async () => {
  const image = await GenericContainer.fromDockerfile(KIWI_CONTEXT).build();
  container = await image
    .withExposedPorts(KIWI_PORT)
    // /health responds 200 immediately but reports `model_loaded:false`
    // (`status:"starting"`) until the Kiwi model finishes loading — gate on
    // the flag, not the status code.
    .withWaitStrategy(
      Wait.forHttp('/health', KIWI_PORT).forResponsePredicate((body) => {
        try {
          return (JSON.parse(body) as { model_loaded?: boolean }).model_loaded === true;
        } catch {
          return false;
        }
      }),
    )
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  // Point the server's kiwi client at the live container (minimal valid app
  // config env, mirroring tests/services/kiwi.test.ts).
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.KIWI_URL = `http://${container.getHost()}:${container.getMappedPort(KIWI_PORT)}`;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  process.env.TOTP_SECRET_ENC_KEY =
    process.env.TOTP_SECRET_ENC_KEY ?? TEST_TOTP_SECRET_ENC_KEY;
  process.env.LOG_LEVEL = 'silent';
  resetConfig();
}, STARTUP_TIMEOUT_MS);

afterAll(async () => {
  resetConfig();
  if (container) await container.stop();
});

describe('lemmatize ↔ real km-kiwi (schema-drift smoke, F-218)', () => {
  it('the live /lemmatize response passes KiwiResponseSchema and lemmatizes 먹었다', async () => {
    // `lemmatize()` itself runs KiwiResponseSchema.parse on the live body —
    // reaching the assertions below proves the real wire shape and the
    // server schema agree. 「먹었다」 is the same probe sentence the mocked
    // contract test pins.
    const out = await lemmatize({ text: '먹었다' }, 'kiwi-live-1');
    expect(out.tokens.length).toBeGreaterThan(0);
    // Semantic sanity on the real analyzer: the verb stem lemmatizes to 먹다.
    expect(out.tokens[0]!.lemma).toBe('먹다');
    expect(out.tokens[0]!.pos).toBe('VV');
    // Offset contract: UTF-16 code units into the input, end exclusive.
    for (const token of out.tokens) {
      expect(token.start).toBeGreaterThanOrEqual(0);
      expect(token.end).toBeGreaterThanOrEqual(token.start);
      expect(token.end).toBeLessThanOrEqual('먹었다'.length);
    }
  }, 60_000);

  it('field-level cross-check: a RAW live token carries exactly the contract fields', async () => {
    // Belt to the parse's suspender: zod strips unknown keys on parse, so
    // the parsed output can never reveal fields the service ADDED. Hit the
    // service directly and pin the raw key set to the documented contract
    // ({surface, lemma, pos, start, end} — models.py `Token`,
    // extra="forbid") so drift on either side is a conscious decision, not
    // an accident.
    const res = await fetch(`${process.env.KIWI_URL}/lemmatize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '학교에 갔다' }),
    });
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    expect(raw.tokens.length).toBeGreaterThan(0);
    expect(Object.keys(raw.tokens[0]!).sort()).toEqual([
      'end',
      'lemma',
      'pos',
      'start',
      'surface',
    ]);
  }, 60_000);
});
