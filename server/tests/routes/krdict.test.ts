/**
 * Per-route tests for src/routes/krdict.ts (Pass: Resources / Dictionary tab).
 *
 * Routes:
 *   GET /krdict/search?q=&limit=&offset=
 *
 * Covers: auth-required, headword-prefix + definition-fallback matching,
 * pagination + total, LIKE-metacharacter escaping, validation rejection, the
 * shared-availability 503 path (migration 003 absent), and DB-error no-leak.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedKrdictEntry } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { resetKrdictReadyCache } from '../../src/routes/define.js';

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

beforeEach(async () => {
  // krdict_entries is reference data; clear it so each test controls the corpus
  // exactly. CASCADE drops krdict_senses / krdict_examples that FK into it.
  await pg.pool.query('TRUNCATE TABLE krdict_entries RESTART IDENTITY CASCADE');
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  resetLimiters();
  // Shared availability cache (owned by define.ts) — reset so a prior test's
  // hidden-table state never bleeds in.
  resetKrdictReadyCache();
});

describe('GET /krdict/search — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/krdict/search?q=먹');
    expect(res.status).toBe(401);
  });
});

describe('GET /krdict/search — matching', () => {
  // NOTE: the seed helper's default Korean definition contains '먹', so tests
  // that assert an exact `total` pass an explicit non-colliding `definitionKo`
  // to keep the corpus's match set deterministic.
  it('matches a headword by prefix', async () => {
    await seedKrdictEntry(pg.pool, {
      headword: '먹다',
      definitionEn: 'to eat',
      definitionKo: '음식을 입에 넣다',
    });
    await seedKrdictEntry(pg.pool, {
      headword: '먹이',
      definitionEn: 'feed',
      definitionKo: '동물의 밥',
    });
    await seedKrdictEntry(pg.pool, {
      headword: '가다',
      definitionEn: 'to go',
      definitionKo: '한 곳에서 다른 곳으로 움직이다',
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=먹');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const heads = (res.body.entries as Array<{ headword: string }>).map((e) => e.headword);
    expect(heads).toEqual(expect.arrayContaining(['먹다', '먹이']));
    expect(heads).not.toContain('가다');
    expect(typeof res.body.entries[0].id).toBe('number');
  });

  it('falls back to the English definition (gloss search)', async () => {
    await seedKrdictEntry(pg.pool, {
      headword: '사과',
      definitionEn: 'an apple, the fruit',
      definitionKo: '과일의 한 종류',
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=apple');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].headword).toBe('사과');
  });

  it('ranks headword-prefix matches ahead of definition-only matches', async () => {
    // '국' is a headword-prefix match; '나라' has '국' only in its definition
    // (fallback match), so the prefix match must sort first.
    await seedKrdictEntry(pg.pool, { headword: '국', definitionEn: 'soup', definitionKo: '액체 음식' });
    await seedKrdictEntry(pg.pool, { headword: '나라', definitionEn: 'country', definitionKo: '국 단위의 영역' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=국');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // Prefix match sorts first.
    expect(res.body.entries[0].headword).toBe('국');
  });

  it('paginates with offset and reports the full total', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedKrdictEntry(pg.pool, { headword: `검색${i}`, definitionEn: 'x', definitionKo: '설명' });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=검색&limit=2&offset=2');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.entries.length).toBe(2);
    expect(res.body.offset).toBe(2);
  });

  it('escapes LIKE metacharacters — "_" matches literally, not as a wildcard', async () => {
    await seedKrdictEntry(pg.pool, { headword: 'a_b', definitionEn: 'literal underscore' });
    await seedKrdictEntry(pg.pool, { headword: 'axb', definitionEn: 'wildcard would match' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/krdict/search?q=${encodeURIComponent('a_b')}`);
    expect(res.status).toBe(200);
    // A naive prefix pattern would let '_' match any char and pull in 'axb'.
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].headword).toBe('a_b');
  });

  it('no match → 200 with empty entries and total 0', async () => {
    await seedKrdictEntry(pg.pool, { headword: '있음' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=절대없는단어');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /krdict/search — browse-all (q absent / empty)', () => {
  it('absent q → 200 browse list with rows and the full table total', async () => {
    await seedKrdictEntry(pg.pool, { headword: '가다', definitionKo: '움직이다' });
    await seedKrdictEntry(pg.pool, { headword: '나다', definitionKo: '생기다' });
    await seedKrdictEntry(pg.pool, { headword: '다니다', definitionKo: '오가다' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search');
    expect(res.status).toBe(200);
    // No query → browse the whole corpus (count is the whole table).
    expect(res.body.total).toBe(3);
    expect(res.body.entries.length).toBe(3);
    expect(res.body.q).toBe('');
  });

  it('empty q → 200 browse list (same as absent q)', async () => {
    await seedKrdictEntry(pg.pool, { headword: '가다' });
    await seedKrdictEntry(pg.pool, { headword: '나다' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.entries.length).toBe(2);
  });

  it('browse paginates with offset and reports the full total', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedKrdictEntry(pg.pool, { headword: `목록${i}` });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?limit=2&offset=2');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.entries.length).toBe(2);
    expect(res.body.offset).toBe(2);
  });

  it('browse returns headword order (deterministic page)', async () => {
    await seedKrdictEntry(pg.pool, { headword: 'cherry' });
    await seedKrdictEntry(pg.pool, { headword: 'apple' });
    await seedKrdictEntry(pg.pool, { headword: 'banana' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search');
    expect(res.status).toBe(200);
    const heads = (res.body.entries as Array<{ headword: string }>).map((e) => e.headword);
    // COLLATE "C" byte-order sort: lowercase ASCII sorts alphabetically.
    expect(heads).toEqual(['apple', 'banana', 'cherry']);
  });
});

describe('GET /krdict/search — validation rejection', () => {
  it('oversized q → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/krdict/search?q=${'x'.repeat(100)}`);
    expect(res.status).toBe(400);
  });

  it('limit above ceiling → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=먹&limit=999');
    expect(res.status).toBe(400);
  });

  it('negative offset → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/krdict/search?q=먹&offset=-1');
    expect(res.status).toBe(400);
  });
});

describe('GET /krdict/search — unavailable (migration 003 absent)', () => {
  it('degrades to 503 when krdict_entries is missing', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await pg.pool.query('ALTER TABLE krdict_entries RENAME TO krdict_entries_hidden');
    try {
      const res = await agent.get('/krdict/search?q=먹');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('krdict_unavailable');
    } finally {
      await pg.pool.query('ALTER TABLE krdict_entries_hidden RENAME TO krdict_entries');
      resetKrdictReadyCache();
    }
  });
});

describe('GET /krdict/search — DB error', () => {
  it('returns a non-2xx with no SQL leakage when the table drops behind the cache', async () => {
    await seedKrdictEntry(pg.pool, { headword: '먹다' });
    const { agent } = await registerUser(t.app, pg.pool);
    // Prime the shared availability cache to ready=true, then drop the table.
    const primed = await agent.get('/krdict/search?q=먹');
    expect(primed.status).toBe(200);
    await pg.pool.query('ALTER TABLE krdict_entries RENAME TO krdict_entries_hidden');
    try {
      const res = await agent.get('/krdict/search?q=먹');
      // 500 (cache still primed, route SELECTs and 42P01s) or 503 (TTL re-check).
      expect([500, 503]).toContain(res.status);
      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toMatch(/krdict_entries_hidden/);
      expect(bodyText).not.toMatch(/at Object\./i);
    } finally {
      await pg.pool.query('ALTER TABLE krdict_entries_hidden RENAME TO krdict_entries');
      resetKrdictReadyCache();
    }
  });
});
