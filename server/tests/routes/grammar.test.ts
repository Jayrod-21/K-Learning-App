/**
 * Per-route tests for src/routes/grammar.ts (B-FU-2).
 *
 * Routes:
 *   GET  /grammar/kgiu
 *   GET  /grammar/kgiu/:id
 *   POST /grammar/bank
 *   GET  /grammar/bank
 *   POST /grammar/identify   (B4 downstream)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedKgiuEntry } from '../helpers/seed.js';

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
});

describe('grammar — auth required', () => {
  it.each([
    ['GET', '/grammar/kgiu'],
    ['GET', '/grammar/kgiu/1'],
    ['POST', '/grammar/bank'],
    ['GET', '/grammar/bank'],
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

  it('limit > 100 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/kgiu?limit=500');
    expect(res.status).toBe(400);
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
