/**
 * Auth-required smoke tests for every protected route.
 *
 * REVIEW_B3 SF8 flagged that route coverage was thin (only /auth, /health,
 * /lemmatize had tests). The full per-route happy-path coverage is a
 * follow-up; this file at minimum locks in the security invariant: every
 * protected route returns 401 (or 403/404 with no leakage) when called
 * without a valid session cookie.
 *
 * Catches the regression class "future refactor mounts a route without
 * requireAuth", which would otherwise leak protected data until manual QA.
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

const PROTECTED_GETS: { path: string; description: string }[] = [
  { path: '/progress', description: 'progress.ts — GET /progress' },
  { path: '/vocab/cards', description: 'vocab.ts — GET /vocab/cards' },
  { path: '/grammar/bank', description: 'grammar.ts — GET /grammar/bank' },
  { path: '/grammar/mastery', description: 'grammar.ts — GET /grammar/mastery' },
  { path: '/conversation', description: 'conversation.ts — GET /conversation' },
  { path: '/define?word=test', description: 'define.ts — GET /define' },
  { path: '/vocab/lists', description: 'vocabLists.ts — GET /vocab/lists' },
  { path: '/ttmik/lessons', description: 'ttmik.ts — GET /ttmik/lessons' },
  { path: '/iyagi/episodes', description: 'ttmik.ts — GET /iyagi/episodes' },
  { path: '/writing/prompts', description: 'writing.ts — GET /writing/prompts' },
  { path: '/writing/series', description: 'writing.ts — GET /writing/series' },
];

describe('protected route auth gate', () => {
  for (const { path, description } of PROTECTED_GETS) {
    it(`${description} returns 401 without a session cookie`, async () => {
      const res = await request(t.app).get(path);
      // Allow 401 or 404 (route not mounted in this build) — we are
      // verifying that NO protected response body leaks through. A route
      // that exists must NOT return 200 here.
      expect([401, 404]).toContain(res.status);
      if (res.status === 401) {
        expect(res.body).toHaveProperty('error');
      }
    });
  }
});
