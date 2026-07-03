/**
 * Per-route tests for src/routes/grammar.ts (B-FU-2).
 *
 * Routes:
 *   GET  /grammar/kgiu
 *   GET  /grammar/kgiu/:id
 *   POST /grammar/bank
 *   GET  /grammar/bank
 *   POST /grammar/bank/:id/graduate   (migration 033)
 *   POST /grammar/bank/:id/readmit    (migration 033)
 *   POST /grammar/identify   (B4 downstream)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedKgiuEntry } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

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
  await pg.pool.query(
    'TRUNCATE TABLE grammar_entries, sessions, users RESTART IDENTITY CASCADE',
  );
  t = buildTestApp({ connectionString: pg.connectionString });
  // Rate limiters are module singletons — rebuilding the app above does NOT
  // reset them. Without this the /grammar/identify expensive-limiter tests are
  // order-coupled: the RESTART IDENTITY reuses user_id = 1 every test and the
  // 429-burst block would leave the u:1 bucket saturated for any test that runs
  // after it in a shuffled order. Mirrors vocab.test.ts. (C-SF-1, bar §5.3 P0)
  resetLimiters();
});

describe('grammar — auth required', () => {
  it.each([
    ['GET', '/grammar/kgiu'],
    ['GET', '/grammar/kgiu/1'],
    ['POST', '/grammar/bank'],
    ['GET', '/grammar/bank'],
    ['POST', '/grammar/bank/1/graduate'],
    ['POST', '/grammar/bank/1/readmit'],
    ['POST', '/grammar/identify'],
  ])('%s %s unauthenticated → 401', async (method, path) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(path)
        : await request(t.app).post(path).send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /grammar/kgiu — success + validation', () => {
  it('returns entries for a valid corpus filter', async () => {
    await seedKgiuEntry(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu?corpus=kgiu_intermediate');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it('bad corpus enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu?corpus=kgiu_extreme');
    expect(res.status).toBe(400);
  });

  it('limit 400 → 200 (Reference Grammar tab requests one wide page)', async () => {
    await seedKgiuEntry(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu?limit=400');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it('limit 401 → 400 (just past the raised ceiling)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu?limit=401');
    expect(res.status).toBe(400);
  });

  it('excludes structural empty-pattern rows from the list', async () => {
    // kgiu_entries is shared reference data the top-level beforeEach does NOT
    // truncate, so clear it to make the result set deterministic.
    await pg.pool.query('TRUNCATE TABLE kgiu_entries RESTART IDENTITY CASCADE');
    await seedKgiuEntry(pg.pool, { pattern: '-아/어 보이다' });
    // A non-pattern structural row: entry_type='grammar', blank pattern,
    // unit_intro category — must NOT surface in the Reference list.
    await seedKgiuEntry(pg.pool, { pattern: '', category: 'unit_intro' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu?limit=400');
    expect(res.status).toBe(200);
    const patterns = (res.body.entries as Array<{ pattern: string | null }>).map(
      (e) => e.pattern,
    );
    expect(patterns).toContain('-아/어 보이다');
    // No blank/empty pattern leaks into the list.
    expect(patterns.every((p) => p !== null && p.trim().length > 0)).toBe(true);
  });
});

describe('GET /grammar/kgiu/:id', () => {
  it('valid id → 200', async () => {
    const id = await seedKgiuEntry(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/grammar/kgiu/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('missing id → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu/99999999');
    expect(res.status).toBe(404);
  });

  it('non-numeric id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu/abc');
    expect(res.status).toBe(400);
  });
});

describe('POST /grammar/bank — success + validation + upsert', () => {
  const validBody = {
    pattern_key: 'GR-a-eo-boida',
    pattern_display: '-아/어 보이다',
    summary_en: 'appears / seems',
    proficiency: 'L3' as const,
    category: 'aspect',
  };

  it('valid body → 201', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/grammar/bank').send(validBody);
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('number');
  });

  it('repeat with same key → 201 (upsert behaviour)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.post('/grammar/bank').send(validBody);
    const res = await agent.post('/grammar/bank').send(validBody);
    expect(res.status).toBe(201);
  });

  it('pattern_key wrong shape → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grammar/bank')
      .send({ ...validBody, pattern_key: 'not-a-real-key' });
    expect(res.status).toBe(400);
  });

  it('bad proficiency → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grammar/bank')
      .send({ ...validBody, proficiency: 'L9' });
    expect(res.status).toBe(400);
  });

  it('bad register → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grammar/bank')
      .send({ ...validBody, register: 'invalid-register' });
    expect(res.status).toBe(400);
  });
});

describe('GET /grammar/bank', () => {
  it('returns the user’s saved patterns', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.post('/grammar/bank').send({
      pattern_key: 'GR-a-eo-boida',
      pattern_display: '-아/어 보이다',
      summary_en: 'seems',
      proficiency: 'L3',
      category: 'aspect',
    });
    const res = await agent.get('/grammar/bank');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].pattern_key).toBe('GR-a-eo-boida');
  });

  it('each user only sees their own bank (no cross-user leak)', async () => {
    const userA = await registerUser(t.app, pg.pool);
    await userA.agent.post('/grammar/bank').send({
      pattern_key: 'GR-a-only',
      pattern_display: 'A',
      summary_en: 's',
      proficiency: 'L3',
      category: 'c',
    });
    const userB = await registerUser(t.app, pg.pool);
    const res = await userB.agent.get('/grammar/bank');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });
});

describe('POST /grammar/bank/:id/graduate + /readmit (migration 033)', () => {
  const bankBody = {
    pattern_key: 'GR-a-eo-boida',
    pattern_display: '-아/어 보이다',
    summary_en: 'appears / seems',
    proficiency: 'L3' as const,
    category: 'aspect',
  };

  it('migration 033: grammar_entries.graduated_at exists, TIMESTAMPTZ, nullable', async () => {
    const { rows } = await pg.pool.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'grammar_entries' AND column_name = 'graduated_at'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.data_type).toBe('timestamp with time zone');
    expect(rows[0]!.is_nullable).toBe('YES');
  });

  it('graduate sets graduated_at and returns the updated row', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const banked = await agent.post('/grammar/bank').send(bankBody);
    expect(banked.status).toBe(201);
    const id = banked.body.id as number;

    const res = await agent.post(`/grammar/bank/${String(id)}/graduate`);
    expect(res.status).toBe(200);
    expect(res.body.entry.id).toBe(id);
    expect(res.body.entry.pattern_key).toBe('GR-a-eo-boida');
    expect(res.body.entry.graduated_at).not.toBeNull();

    // A fresh row starts active (graduated_at null on the bank list) and the
    // graduated row still appears in GET /grammar/bank — carrying the flag
    // the client splits Active vs Known on.
    const bank = await agent.get('/grammar/bank').expect(200);
    expect(bank.body.entries.length).toBe(1);
    expect(bank.body.entries[0].graduated_at).not.toBeNull();
  });

  it('graduate is idempotent — a repeat keeps the original timestamp', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const banked = await agent.post('/grammar/bank').send(bankBody);
    const id = banked.body.id as number;

    const first = await agent
      .post(`/grammar/bank/${String(id)}/graduate`)
      .expect(200);
    const second = await agent
      .post(`/grammar/bank/${String(id)}/graduate`)
      .expect(200);
    expect(second.body.entry.graduated_at).toBe(first.body.entry.graduated_at);
  });

  it('readmit restores the pattern to active (graduated_at back to null)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const banked = await agent.post('/grammar/bank').send(bankBody);
    const id = banked.body.id as number;
    await agent.post(`/grammar/bank/${String(id)}/graduate`).expect(200);

    const res = await agent.post(`/grammar/bank/${String(id)}/readmit`);
    expect(res.status).toBe(200);
    expect(res.body.entry.graduated_at).toBeNull();

    const bank = await agent.get('/grammar/bank').expect(200);
    expect(bank.body.entries[0].graduated_at).toBeNull();
  });

  it("cannot graduate another user's row → 404 (no existence leak)", async () => {
    const userA = await registerUser(t.app, pg.pool);
    const banked = await userA.agent.post('/grammar/bank').send(bankBody);
    const id = banked.body.id as number;

    const userB = await registerUser(t.app, pg.pool);
    const res = await userB.agent.post(`/grammar/bank/${String(id)}/graduate`);
    expect(res.status).toBe(404);

    // A's row is untouched.
    const bank = await userA.agent.get('/grammar/bank').expect(200);
    expect(bank.body.entries[0].graduated_at).toBeNull();
  });

  it("cannot readmit another user's row → 404", async () => {
    const userA = await registerUser(t.app, pg.pool);
    const banked = await userA.agent.post('/grammar/bank').send(bankBody);
    const id = banked.body.id as number;
    await userA.agent.post(`/grammar/bank/${String(id)}/graduate`).expect(200);

    const userB = await registerUser(t.app, pg.pool);
    const res = await userB.agent.post(`/grammar/bank/${String(id)}/readmit`);
    expect(res.status).toBe(404);
  });

  it('unknown id → 404; non-numeric id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.post('/grammar/bank/99999999/graduate')).status).toBe(404);
    expect((await agent.post('/grammar/bank/99999999/readmit')).status).toBe(404);
    expect((await agent.post('/grammar/bank/abc/graduate')).status).toBe(400);
    expect((await agent.post('/grammar/bank/abc/readmit')).status).toBe(400);
  });
});

describe('GET /grammar/suggestions/weekly', () => {
  // kgiu_entries is shared reference data the per-test beforeEach does NOT
  // truncate; isolate this block by clearing it (CASCADE drops the relation /
  // cross-ref / topik-dependency rows that FK into it) so the LIMIT 15 window
  // contains only the patterns each test seeds.
  beforeEach(async () => {
    await pg.pool.query('TRUNCATE TABLE kgiu_entries RESTART IDENTITY CASCADE');
  });

  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/grammar/suggestions/weekly');
    expect(res.status).toBe(401);
  });

  it('returns KGIU patterns the user has not banked', async () => {
    await seedKgiuEntry(pg.pool, { pattern: '-아/어 보이다' });
    await seedKgiuEntry(pg.pool, { pattern: '-(으)면' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/suggestions/weekly');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.patterns)).toBe(true);
    const patterns = (res.body.patterns as Array<{ pattern: string }>).map((s) => s.pattern);
    expect(patterns).toEqual(expect.arrayContaining(['-아/어 보이다', '-(으)면']));
    expect(typeof res.body.patterns[0].id).toBe('number');
  });

  it('is stable for the same user within the week (deterministic refetch)', async () => {
    for (let i = 0; i < 18; i += 1) {
      await seedKgiuEntry(pg.pool, { pattern: `-패턴${i}` });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const first = await agent.get('/grammar/suggestions/weekly').expect(200);
    const second = await agent.get('/grammar/suggestions/weekly').expect(200);
    const ids1 = (first.body.patterns as Array<{ id: number }>).map((s) => s.id);
    const ids2 = (second.body.patterns as Array<{ id: number }>).map((s) => s.id);
    expect(ids2).toEqual(ids1);
    expect(ids1.length).toBe(15);
  });

  it('excludes a pattern the user has already banked (by display form)', async () => {
    const bankedPattern = '-아/어 보이다';
    const freshPattern = '-(으)ㄹ 수 있다';
    await seedKgiuEntry(pg.pool, { pattern: bankedPattern });
    await seedKgiuEntry(pg.pool, { pattern: freshPattern });
    const { agent } = await registerUser(t.app, pg.pool);
    // Bank the matching pattern via the existing add-to-bank path.
    const banked = await agent.post('/grammar/bank').send({
      pattern_key: 'GR-a-eo-boida',
      pattern_display: bankedPattern,
      summary_en: 'appears / seems',
      proficiency: 'L3',
      category: 'aspect',
    });
    expect(banked.status).toBe(201);
    const res = await agent.get('/grammar/suggestions/weekly').expect(200);
    const patterns = (res.body.patterns as Array<{ pattern: string }>).map((s) => s.pattern);
    expect(patterns).not.toContain(bankedPattern);
    // …while a different, un-banked pattern is still suggested.
    expect(patterns).toContain(freshPattern);
  });

  it('keeps a GRADUATED banked pattern excluded (not re-suggested as study material)', async () => {
    const knownPattern = '-아/어 보이다';
    await seedKgiuEntry(pg.pool, { pattern: knownPattern });
    const { agent } = await registerUser(t.app, pg.pool);
    const banked = await agent.post('/grammar/bank').send({
      pattern_key: 'GR-a-eo-boida',
      pattern_display: knownPattern,
      summary_en: 'appears / seems',
      proficiency: 'L3',
      category: 'aspect',
    });
    expect(banked.status).toBe(201);
    await agent
      .post(`/grammar/bank/${String(banked.body.id)}/graduate`)
      .expect(200);
    // Graduated ≠ unbanked: the pattern the user marked as known must not
    // come back around in the weekly picks.
    const res = await agent.get('/grammar/suggestions/weekly').expect(200);
    const patterns = (res.body.patterns as Array<{ pattern: string }>).map((s) => s.pattern);
    expect(patterns).not.toContain(knownPattern);
  });

  it('excludes structural empty-pattern rows from the weekly picks', async () => {
    await seedKgiuEntry(pg.pool, { pattern: '-(으)ㄹ 텐데' });
    // A blank-pattern structural row (reference category) must never be picked.
    await seedKgiuEntry(pg.pool, { pattern: '', category: 'reference' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/suggestions/weekly').expect(200);
    const patterns = (res.body.patterns as Array<{ pattern: string | null }>).map(
      (s) => s.pattern,
    );
    expect(patterns).toContain('-(으)ㄹ 텐데');
    expect(patterns.every((p) => p !== null && p.trim().length > 0)).toBe(true);
  });

  it('each user sees suggestions independent of another user’s bank', async () => {
    const pattern = '-(으)니까';
    await seedKgiuEntry(pg.pool, { pattern });
    const a = await registerUser(t.app, pg.pool);
    await a.agent.post('/grammar/bank').send({
      pattern_key: 'GR-eunikka',
      pattern_display: pattern,
      summary_en: 'because',
      proficiency: 'L3',
      category: 'reason',
    });
    // User B has banked nothing → still sees the pattern.
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get('/grammar/suggestions/weekly').expect(200);
    const patterns = (res.body.patterns as Array<{ pattern: string }>).map((s) => s.pattern);
    expect(patterns).toContain(pattern);
  });
});

describe('POST /grammar/identify — downstream (B4)', () => {
  it('stubbed proxy → 200 with pattern result', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grammar/identify')
      .send({ highlightSpan: '-아 보이다', fullSentence: '그 사람이 행복해 보여요.' });
    expect(res.status).toBe(200);
    expect(res.body.result.patternKey).toBeDefined();
  });

  it('missing highlightSpan → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grammar/identify')
      .send({ fullSentence: '그 사람이 행복해 보여요.' });
    expect(res.status).toBe(400);
  });

  it('B4 throws → 500 (no leak)', async () => {
    const broken = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        recognizeGrammarPattern: async () => {
          throw new Error('b4 internal');
        },
      },
    });
    try {
      const { agent } = await registerUser(broken.app, pg.pool);
      const res = await agent
        .post('/grammar/identify')
        .send({ highlightSpan: '-아', fullSentence: '안녕하세요' });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('b4 internal');
    } finally {
      await teardownTestApp(broken);
    }
  });

  it('expensive limiter → 429 after burst', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const res = await agent
        .post('/grammar/identify')
        .send({ highlightSpan: '-아', fullSentence: '안녕하세요' });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});

describe('grammar — DB error', () => {
  it('GET /grammar/bank with grammar_entries missing → 500 no leak', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await pg.pool.query('ALTER TABLE grammar_entries RENAME TO grammar_entries_hidden');
    try {
      const res = await agent.get('/grammar/bank');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('grammar_entries_hidden');
    } finally {
      await pg.pool.query('ALTER TABLE grammar_entries_hidden RENAME TO grammar_entries');
    }
  });
});
