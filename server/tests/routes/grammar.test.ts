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
 *   GET  /grammar/mastery             (F-099 — Progress "Grammar" tab)
 *   POST /grammar/identify   (B4 downstream)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedBookUpload, seedKgiuEntry } from '../helpers/seed.js';
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
    ['GET', '/grammar/series'],
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

describe('GET /grammar/kgiu — domain + book_level filters (F-005)', () => {
  // kgiu_entries is shared reference data the file-level beforeEach does NOT
  // truncate; these tests assert exact result sets, so isolate the corpus.
  beforeEach(async () => {
    await pg.pool.query('TRUNCATE TABLE kgiu_entries RESTART IDENTITY CASCADE');
  });

  it('domain filter narrows to matching patterns only', async () => {
    await seedKgiuEntry(pg.pool, { pattern: '-는 반면에' });
    const researchId = await seedKgiuEntry(pg.pool, { pattern: '-에 의하면' });
    // The seed leaves domain at its 'general' default; retag one row so the
    // filter has something to select.
    await pg.pool.query(
      `UPDATE kgiu_entries SET domain = 'research'::content_domain WHERE id = $1`,
      [researchId],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/grammar/kgiu?domain=research');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].pattern).toBe('-에 의하면');

    // Unfiltered still returns both — the param narrows, never re-shapes.
    const all = await agent.get('/grammar/kgiu').expect(200);
    expect(all.body.entries.length).toBe(2);
  });

  it('book_level filter narrows to the matching band', async () => {
    await seedKgiuEntry(pg.pool, { pattern: '-는 중이다' });
    const beginnerId = await seedKgiuEntry(pg.pool, { pattern: '-(으)ㄹ 거예요' });
    // Flip one row to the beginner band. corpus + book_level move together to
    // satisfy the kgiu level-matches-corpus CHECK.
    await pg.pool.query(
      `UPDATE kgiu_entries
          SET corpus = 'kgiu_beginner'::corpus,
              book_level = 'beginner'::book_level
        WHERE id = $1`,
      [beginnerId],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/grammar/kgiu?book_level=beginner');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].pattern).toBe('-(으)ㄹ 거예요');
  });

  it('domain + book_level compose (AND semantics)', async () => {
    // Only one row is research AND beginner.
    const hitId = await seedKgiuEntry(pg.pool, { pattern: '-에 따르면' });
    const researchOnlyId = await seedKgiuEntry(pg.pool, { pattern: '-으로 인해' });
    await seedKgiuEntry(pg.pool, { pattern: '-기는 하지만' });
    await pg.pool.query(
      `UPDATE kgiu_entries
          SET corpus = 'kgiu_beginner'::corpus,
              book_level = 'beginner'::book_level,
              domain = 'research'::content_domain
        WHERE id = $1`,
      [hitId],
    );
    await pg.pool.query(
      `UPDATE kgiu_entries SET domain = 'research'::content_domain WHERE id = $1`,
      [researchOnlyId],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/grammar/kgiu?domain=research&book_level=beginner');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].pattern).toBe('-에 따르면');
  });

  it.each([
    ['bad domain enum', '?domain=sports'],
    ['bad book_level enum', '?book_level=expert'],
  ])('%s → 400', async (_name, qs) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/grammar/kgiu${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('GET /grammar/kgiu — source_upload_id filter (U3a)', () => {
  // kgiu_entries is shared reference data the file-level beforeEach does NOT
  // truncate; these tests assert exact match sets, so isolate the corpus.
  beforeEach(async () => {
    await pg.pool.query('TRUNCATE TABLE kgiu_entries RESTART IDENTITY CASCADE');
  });

  it('narrows to patterns tagged with the given owned upload', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'grammar',
      status: 'ready',
    });
    await seedKgiuEntry(pg.pool, { pattern: '-출처패턴', sourceUploadId: uploadId });
    await seedKgiuEntry(pg.pool, { pattern: '-노출처패턴' });

    const res = await agent.get(`/grammar/kgiu?source_upload_id=${uploadId}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].pattern).toBe('-출처패턴');
  });

  // REVIEW_u3a_tests SF-3: the prior test only pairs a tagged row with an
  // UNTAGGED (source_upload_id IS NULL) control, which cannot catch an
  // implementation that drops the `source_upload_id = $6` equality and keeps
  // only the EXISTS ownership check (i.e. "any upload owned by this user
  // matches", not "THIS upload"). This seeds two uploads the SAME user owns,
  // tags a row to each, and asserts filtering by upload A returns only A's
  // row — a broken equality-dropped predicate would incorrectly also return
  // B's row (B is owned by the same requester too) and this test would fail.
  it('excludes a row tagged to a different upload the same user owns (equality predicate, not just ownership)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadA = await seedBookUpload(pg.pool, userId, { status: 'ready' });
    const uploadB = await seedBookUpload(pg.pool, userId, { status: 'ready' });
    await seedKgiuEntry(pg.pool, { pattern: '-A책패턴', sourceUploadId: uploadA });
    await seedKgiuEntry(pg.pool, { pattern: '-B책패턴', sourceUploadId: uploadB });

    const res = await agent.get(`/grammar/kgiu?source_upload_id=${uploadA}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].pattern).toBe('-A책패턴');
  });

  // REVIEW_u3a_tests SF-1: mirrors vocab.test.ts's equivalent case — the
  // grammar block was missing this boundary the vocab block already covered.
  it('omitting the filter returns both tagged and untagged patterns', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready' });
    await seedKgiuEntry(pg.pool, { pattern: '-태그패턴', sourceUploadId: uploadId });
    await seedKgiuEntry(pg.pool, { pattern: '-노태그패턴' });

    const res = await agent.get('/grammar/kgiu');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(2);
  });

  it("cannot filter by another user's upload — ownership guard returns zero rows", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const ownerUpload = await seedBookUpload(pg.pool, owner.userId, {
      status: 'ready',
    });
    await seedKgiuEntry(pg.pool, { pattern: '-남의패턴', sourceUploadId: ownerUpload });

    const other = await registerUser(t.app, pg.pool);
    const res = await other.agent.get(
      `/grammar/kgiu?source_upload_id=${ownerUpload}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  // REVIEW_u3a_tests SF-2: mirrors vocab.test.ts's equivalent case — the
  // grammar block was missing this boundary the vocab block already covered.
  it('a non-existent upload id is a valid no-op filter (200, empty)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await seedKgiuEntry(pg.pool, { pattern: '-아무거나패턴' });
    const res = await agent.get('/grammar/kgiu?source_upload_id=99999999');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('rejects a garbage source_upload_id at the boundary (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/grammar/kgiu?source_upload_id=abc')).status).toBe(400);
    expect((await agent.get('/grammar/kgiu?source_upload_id=0')).status).toBe(400);
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

  it('detail wire carries the real `unit` value (REVIEW_F018 SF-1)', async () => {
    // Regression pin for the fixture-infidelity class: the detail SELECT
    // omitted `unit`, so every real row's footer rendered "Unit · —" while the
    // client tests passed on mocks that included it. Assert against the REAL
    // route response, with a non-null seeded value, so an omission is a
    // failure here (an unselected column arrives as `undefined`, not null).
    const id = await seedKgiuEntry(pg.pool, {
      unit: 'Ch.7. Expressing Conjecture',
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/grammar/kgiu/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.unit).toBe('Ch.7. Expressing Conjecture');
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

  // Regression (migration 034): the KGIU corpus uses free-text categories
  // (copula, conjecture, contrast, …) that the original 001 whitelist CHECK
  // (ck_grammar_entries_category_known) rejected — so every real Bank click on a
  // corpus pattern 500'd at the DB even though Zod accepted the body. The prior
  // tests only ever used a whitelisted category ('aspect'), so they missed it.
  it('accepts a real KGIU corpus category not in the old whitelist → 201', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grammar/bank')
      .send({ ...validBody, pattern_key: 'GR-copula-example', category: 'copula' });
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

describe('POST /grammar/bank — upload provenance (F-107)', () => {
  const validBody = {
    pattern_key: 'GR-eun-geol',
    pattern_display: '-은걸',
    summary_en: 'mild exclamation / realization',
    proficiency: 'L3' as const,
    category: 'ending',
  };

  it('persists source_upload_id when the caller owns the upload', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      type: 'grammar',
      status: 'ready',
    });
    const res = await agent
      .post('/grammar/bank')
      .send({ ...validBody, source_upload_id: uploadId });
    expect(res.status).toBe(201);
    const row = await pg.pool.query<{ source_upload_id: string | null }>(
      `SELECT source_upload_id FROM grammar_entries WHERE id = $1`,
      [res.body.id],
    );
    expect(Number(row.rows[0]!.source_upload_id)).toBe(uploadId);
  });

  it('a bank without source_upload_id stays untagged (NULL provenance)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/grammar/bank').send(validBody);
    expect(res.status).toBe(201);
    const row = await pg.pool.query<{ source_upload_id: string | null }>(
      `SELECT source_upload_id FROM grammar_entries WHERE id = $1`,
      [res.body.id],
    );
    expect(row.rows[0]!.source_upload_id).toBeNull();
  });

  it('a re-bank without source keeps the original tag (first write wins)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready' });
    const first = await agent
      .post('/grammar/bank')
      .send({ ...validBody, source_upload_id: uploadId });
    expect(first.status).toBe(201);
    // Upsert path: same (user, pattern_key), no provenance this time.
    const again = await agent.post('/grammar/bank').send(validBody);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const row = await pg.pool.query<{ source_upload_id: string | null }>(
      `SELECT source_upload_id FROM grammar_entries WHERE id = $1`,
      [first.body.id],
    );
    expect(Number(row.rows[0]!.source_upload_id)).toBe(uploadId);
  });

  it("cannot tag with another user's upload — 404, and no row persists", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const foreignUpload = await seedBookUpload(pg.pool, owner.userId, {
      status: 'ready',
    });
    const attacker = await registerUser(t.app, pg.pool);
    const res = await attacker.agent
      .post('/grammar/bank')
      .send({ ...validBody, source_upload_id: foreignUpload });
    expect(res.status).toBe(404);
    // The transaction rolled back — the attacker banked nothing.
    const rows = await pg.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM grammar_entries WHERE user_id = $1`,
      [attacker.userId],
    );
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });

  it('a nonexistent upload id → the same 404 as an unowned one (no existence oracle)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grammar/bank')
      .send({ ...validBody, source_upload_id: 99_999_999 });
    expect(res.status).toBe(404);
  });

  it('rejects garbage source_upload_id at the boundary (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    for (const bad of ['abc', -1, 0, 1.5]) {
      const res = await agent
        .post('/grammar/bank')
        .send({ ...validBody, source_upload_id: bad });
      expect(res.status).toBe(400);
    }
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

describe('GET /grammar/bank — production-card schedule (F-111)', () => {
  it('schedule is null for a freshly banked pattern (never drilled)', async () => {
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
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].schedule).toBeNull();
  });

  it('reflects the real FSRS state/stability/due date after a drill submit auto-banks + advances the card', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // FU-NF-42's auto-bank: submitting a drill creates BOTH the grammar_entries
    // row and its production vocab_cards row (see grammarDrill.test.ts's
    // identical scheduling assertions) — no separate POST /grammar/bank is
    // needed, this drill round-trip is the real path that produces a card.
    const gen = await agent
      .post('/grammar-drill')
      .send({
        patternKey: '-아/어 버리다',
        patternDisplay: '-아/어 버리다',
        meaning: 'completion / regret aspectual',
      })
      .expect(201);
    await agent
      .post(`/grammar-drill/${gen.body.attemptId as number}/submit`)
      .send({ answer: '다 먹어 버렸어요.' })
      .expect(200);

    const res = await agent.get('/grammar/bank').expect(200);
    expect(res.body.entries).toHaveLength(1);
    const schedule = res.body.entries[0].schedule;
    expect(schedule).not.toBeNull();
    expect(schedule.state).toBe('learning');
    expect(typeof schedule.stability).toBe('string');
    expect(typeof schedule.dueAt).toBe('string');
    expect(Number.isNaN(Date.parse(schedule.dueAt))).toBe(false);
    // The stub scorer's verdict 'good' + usesPattern true seeds a NEW card
    // 1 day out (mirrors grammarDrill.test.ts's identical scheduling assert).
    const dueMs = new Date(schedule.dueAt).getTime() - Date.now();
    expect(dueMs).toBeGreaterThan(0.5 * 86_400_000);
    expect(dueMs).toBeLessThan(1.5 * 86_400_000);
  });

  it('does not leak another user’s production-card schedule (no cross-user join)', async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const gen = await a.agent
      .post('/grammar-drill')
      .send({
        patternKey: '-아/어 버리다',
        patternDisplay: '-아/어 버리다',
        meaning: 'completion / regret aspectual',
      })
      .expect(201);
    await a.agent
      .post(`/grammar-drill/${gen.body.attemptId as number}/submit`)
      .send({ answer: '다 먹어 버렸어요.' })
      .expect(200);

    // User B independently banks the SAME display pattern (a distinct
    // grammar_entries row, own id) — B's schedule must be null, never A's card.
    await b.agent.post('/grammar/bank').send({
      pattern_key: 'GR-a-eo-beorida',
      pattern_display: '-아/어 버리다',
      summary_en: 'completion / regret',
      proficiency: 'L3',
      category: 'aspect',
    });
    const resB = await b.agent.get('/grammar/bank').expect(200);
    expect(resB.body.entries).toHaveLength(1);
    expect(resB.body.entries[0].schedule).toBeNull();
  });

  // Fix-pass SF-2 (REVIEW_grammar.md): the join-safety property (`face =
  // 'production'` in the ON clause, PLUS `uq_vocab_cards_user_grammar_
  // production`'s partial unique index) is real and DB-enforced, but no
  // existing test seeded a *second*, non-production card for the same
  // (user, grammar_entry) to positively demonstrate the `face` filter — not
  // just the unique index — is what keeps the join from fanning a bank row
  // out to two. A `recognition`-face card is legal at the SAME
  // (user_id, grammar_entry_id): the partial unique index only constrains
  // face='production', so this insert would NOT be rejected by the index —
  // only the route's `vc.face = 'production'` join predicate keeps it from
  // ever being picked up.
  it('a recognition-face card on the same grammar entry does not leak into (or duplicate) the production schedule', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const bank = await agent.post('/grammar/bank').send({
      pattern_key: 'GR-a-eo-boida',
      pattern_display: '-아/어 보이다',
      summary_en: 'seems',
      proficiency: 'L3',
      category: 'aspect',
    });
    expect(bank.status).toBe(201);
    const grammarEntryId = bank.body.id as number;

    // Legal per the schema (the unique index only covers face='production'):
    // a recognition-face card on the SAME grammar_entry_id.
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, grammar_entry_id)
       VALUES ($1, 'recognition'::card_face, $2)`,
      [userId, grammarEntryId],
    );

    const res = await agent.get('/grammar/bank').expect(200);
    // Still exactly ONE bank row (the join did not fan out)...
    expect(res.body.entries).toHaveLength(1);
    // ...and its schedule is still null: no PRODUCTION card exists for this
    // pattern, so the recognition card must never surface as "practiced".
    expect(res.body.entries[0].schedule).toBeNull();
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

  // F-193: /identify now routes proxy failures through the shared
  // mapClaudeError (errors.ts) instead of a bare next(err) — a proxy-origin
  // client fault keeps its status; a 5xx-class proxy error flattens to a
  // whitelisted-message 502. Neither ever carries the raw proxy message.
  it.each([
    [429, 'ClaudeRateLimitError', 429, 'too many requests — please slow down and try again shortly'],
    [400, 'PromptInjectionRejectedError', 400, 'your message could not be processed'],
    [503, 'ClaudeUnavailableError', 502, 'the AI assistant is temporarily unavailable — please try again'],
  ])(
    'proxy httpStatus %s (%s) → %s upstream_error with no raw proxy text (F-193)',
    async (httpStatus, code, wireStatus, wireMessage) => {
      const broken = buildTestApp({
        connectionString: pg.connectionString,
        claudeProxy: {
          recognizeGrammarPattern: async () => {
            const e = new Error('raw proxy failure detail') as Error & {
              httpStatus: number;
              code: string;
            };
            e.httpStatus = httpStatus;
            e.code = code;
            throw e;
          },
        },
      });
      try {
        const { agent } = await registerUser(broken.app, pg.pool);
        const res = await agent
          .post('/grammar/identify')
          .send({ highlightSpan: '-아', fullSentence: '안녕하세요' });
        expect(res.status).toBe(wireStatus);
        expect(res.body.error.code).toBe('upstream_error');
        // Pin the exact whitelisted message (CLAUDE_CLIENT_MESSAGES /
        // DEFAULT_UPSTREAM_MESSAGE in errors.ts) — not just raw-text absence.
        expect(res.body.error.message).toBe(wireMessage);
        expect(JSON.stringify(res.body)).not.toContain('raw proxy failure detail');
      } finally {
        await teardownTestApp(broken);
      }
    },
  );
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

describe('GET /grammar/series — daily drill-score time-series (F-017)', () => {
  /** The UTC calendar day `daysAgo` days back, formatted as the route emits it. */
  async function utcDay(daysAgo: number): Promise<string> {
    const { rows } = await pg.pool.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE 'UTC')::date - $1::int, 'YYYY-MM-DD') AS d`,
      [daysAgo],
    );
    return rows[0]!.d;
  }

  /**
   * Insert a grammar_drill_attempts row. `score: null` models a generated-but-
   * never-submitted attempt (scored_at NULL — must never count); a numeric
   * score models a scored submission `daysAgo` days back.
   */
  async function insertAttempt(
    userId: number,
    opts: { score: number | null; daysAgo?: number },
  ): Promise<void> {
    await pg.pool.query(
      `INSERT INTO grammar_drill_attempts (
          user_id, pattern_key, pattern_display, drill_type, item,
          user_answer, score, verdict, feedback, scored_at)
       VALUES ($1, 'GR-series-test', '-(으)면', 'cloze', '{}'::jsonb,
               CASE WHEN $2::int IS NULL THEN NULL ELSE '답변' END,
               $2::int,
               CASE WHEN $2::int IS NULL THEN NULL ELSE 'good' END,
               CASE WHEN $2::int IS NULL THEN NULL ELSE '{}'::jsonb END,
               CASE WHEN $2::int IS NULL THEN NULL
                    ELSE now() - make_interval(days => $3) END)`,
      [userId, opts.score, opts.daysAgo ?? 0],
    );
  }

  it('averages scores per UTC day (rounded), ascending; unscored attempts never count', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Two days ago: scores 70 + 75 → round(avg 72.5) = 73. Today: 90.
    await insertAttempt(userId, { score: 70, daysAgo: 2 });
    await insertAttempt(userId, { score: 75, daysAgo: 2 });
    await insertAttempt(userId, { score: 90 });
    // Generated but never submitted (scored_at NULL) — excluded from the series.
    await insertAttempt(userId, { score: null });

    const res = await agent.get('/grammar/series');
    expect(res.status).toBe(200);
    expect(res.body.series.metric).toBe('score');
    expect(res.body.series.unit).toBe('pts');
    expect(res.body.series.points).toEqual([
      { date: await utcDay(2), value: 73 },
      { date: await utcDay(0), value: 90 },
    ]);
  });

  it("is user-scoped (no IDOR) — another user's attempts never appear", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await insertAttempt(a.userId, { score: 80 });

    const resB = await b.agent.get('/grammar/series');
    expect(resB.status).toBe(200);
    expect(resB.body.series.points).toEqual([]);

    const resA = await a.agent.get('/grammar/series');
    expect(resA.body.series.points).toEqual([{ date: await utcDay(0), value: 80 }]);
  });

  it('honors the days window (default 30, widenable to 90)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await insertAttempt(userId, { score: 90 });
    await insertAttempt(userId, { score: 40, daysAgo: 40 });

    // Default 30-day window: the 40-day-old attempt is outside it.
    const res = await agent.get('/grammar/series');
    expect(res.status).toBe(200);
    expect(res.body.series.points).toEqual([{ date: await utcDay(0), value: 90 }]);

    // Widening to 90 days surfaces it as its own (older-first) day bucket.
    const wide = await agent.get('/grammar/series?days=90');
    expect(wide.body.series.points).toEqual([
      { date: await utcDay(40), value: 40 },
      { date: await utcDay(0), value: 90 },
    ]);
  });

  it('no activity → 200 with empty points (not an error)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/series');
    expect(res.status).toBe(200);
    expect(res.body.series).toEqual({ metric: 'score', unit: 'pts', points: [] });
  });

  it('pins day buckets to UTC even under a non-UTC DB session TimeZone', async () => {
    // A scored attempt at 00:30 UTC today is YESTERDAY afternoon in
    // America/Anchorage (UTC-9/-8). The route buckets with `(scored_at AT
    // TIME ZONE 'UTC')::date`; a regression to a bare `scored_at::date`
    // would follow the session TimeZone and land this row on yesterday's
    // bucket. The main suite pool runs in UTC (where both expressions
    // agree), so this ephemeral app pins its pool connections to Anchorage
    // to make them disagree.
    const tz = buildTestApp({ connectionString: pg.connectionString });
    tz.pool.on('connect', (client) => {
      client.query("SET TimeZone = 'America/Anchorage'").catch(() => {
        // Swallowed on purpose: the SHOW TimeZone assertion below fails
        // loudly if the pin did not apply.
      });
    });
    try {
      // Prove the pin applied — otherwise this silently degrades tz-neutral.
      const shown = await tz.pool.query('SHOW TimeZone');
      expect(shown.rows[0]).toEqual({ TimeZone: 'America/Anchorage' });

      // Capture "today" (UTC) BEFORE inserting so a midnight rollover
      // between insert and assert can't flake the expected bucket.
      const today = await utcDay(0);
      const { agent, userId } = await registerUser(tz.app, pg.pool);
      await pg.pool.query(
        `INSERT INTO grammar_drill_attempts (
            user_id, pattern_key, pattern_display, drill_type, item,
            user_answer, score, verdict, feedback, scored_at)
         VALUES ($1, 'GR-tz-test', '-(으)면', 'cloze', '{}'::jsonb,
                 '답변', 88, 'good', '{}'::jsonb,
                 ($2::date + time '00:30') AT TIME ZONE 'UTC')`,
        [userId, today],
      );

      const res = await agent.get('/grammar/series');
      expect(res.status).toBe(200);
      expect(res.body.series.points).toEqual([{ date: today, value: 88 }]);
    } finally {
      await teardownTestApp(tz);
    }
  });

  it.each([['days=0'], ['days=91']])('%s → 400 (window is 1..90)', async (qs) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/grammar/series?${qs}`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /grammar/mastery (F-099 — Progress "Grammar" tab)
// ---------------------------------------------------------------------------

describe('GET /grammar/mastery — per-pattern FSRS mastery (F-099)', () => {
  interface MasteryPatternDTO {
    id: number;
    pattern: string;
    summaryEn: string;
    bucket: 'new' | 'learning' | 'reviewing' | 'mastered';
    stability: number | null;
    dueAt: string | null;
  }
  interface MasteryEnvelope {
    summary: {
      new: number;
      learning: number;
      reviewing: number;
      mastered: number;
      total: number;
    };
    patterns: MasteryPatternDTO[];
    total: number;
  }

  /** Bank one pattern via the real add-to-bank path; returns the entry id. */
  async function bank(
    agent: ReturnType<typeof request.agent>,
    key: string,
    display: string,
  ): Promise<number> {
    const res = await agent.post('/grammar/bank').send({
      pattern_key: key,
      pattern_display: display,
      summary_en: `summary of ${display}`,
      proficiency: 'L3',
      category: 'aspect',
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  /** Give a banked pattern a PRODUCTION card in a controlled FSRS state —
   *  the same row shape FU-NF-42's lazy card-create produces. */
  async function setProductionCard(
    userId: number,
    entryId: number,
    state: 'new' | 'learning' | 'relearning' | 'review',
    stability: number,
  ): Promise<void> {
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, grammar_entry_id, fsrs_state, stability)
       VALUES ($1, 'production'::card_face, $2, $3::fsrs_state, $4)`,
      [userId, entryId, state, stability],
    );
  }

  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/grammar/mastery');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('empty bank → 200 with an all-zero summary and no patterns (never an error)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/mastery');
    expect(res.status).toBe(200);
    const body = res.body as MasteryEnvelope;
    expect(body.summary).toEqual({
      new: 0,
      learning: 0,
      reviewing: 0,
      mastered: 0,
      total: 0,
    });
    expect(body.patterns).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('buckets patterns off the production card: no-card → new, learning, review<21d → reviewing, review≥21d → mastered; order is stability DESC NULLS LAST', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const neverDrilled = await bank(agent, 'GR-never-drilled', '-아/어 보이다');
    const learning = await bank(agent, 'GR-learning', '-(으)면');
    const reviewing = await bank(agent, 'GR-reviewing', '-(으)ㄹ 수 있다');
    const mastered = await bank(agent, 'GR-mastered', '-아/어 버리다');
    await setProductionCard(userId, learning, 'learning', 1);
    // 21 days is the mature threshold (mirrors /vocab/mastery): strictly
    // below stays 'reviewing', at/above flips to 'mastered'.
    await setProductionCard(userId, reviewing, 'review', 20.9999);
    await setProductionCard(userId, mastered, 'review', 21);

    const res = await agent.get('/grammar/mastery');
    expect(res.status).toBe(200);
    const body = res.body as MasteryEnvelope;
    expect(body.summary).toEqual({
      new: 1,
      learning: 1,
      reviewing: 1,
      mastered: 1,
      total: 4,
    });
    expect(body.total).toBe(4);

    const byId = new Map(body.patterns.map((p) => [p.id, p]));
    expect(byId.get(neverDrilled)?.bucket).toBe('new');
    expect(byId.get(learning)?.bucket).toBe('learning');
    expect(byId.get(reviewing)?.bucket).toBe('reviewing');
    expect(byId.get(mastered)?.bucket).toBe('mastered');

    // A never-drilled pattern reports stability null (no card) — never a
    // fabricated 0 — and sinks below every real card (NULLS LAST).
    expect(byId.get(neverDrilled)?.stability).toBeNull();
    expect(byId.get(neverDrilled)?.dueAt).toBeNull();
    expect(body.patterns[body.patterns.length - 1]?.id).toBe(neverDrilled);
    // Most-stable first.
    expect(body.patterns[0]?.id).toBe(mastered);
    expect(body.patterns[0]?.stability).toBe(21);

    // Wire shape: pattern text + summary ride along for the list rows.
    expect(byId.get(learning)?.pattern).toBe('-(으)면');
    expect(byId.get(learning)?.summaryEn).toBe('summary of -(으)면');
  });

  it('a GRADUATED pattern counts as mastered even with no card (user marked it known)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await bank(agent, 'GR-known', '-잖아요');
    await agent.post(`/grammar/bank/${String(id)}/graduate`).expect(200);

    const res = await agent.get('/grammar/mastery');
    expect(res.status).toBe(200);
    const body = res.body as MasteryEnvelope;
    expect(body.summary).toEqual({
      new: 0,
      learning: 0,
      reviewing: 0,
      mastered: 1,
      total: 1,
    });
    expect(body.patterns[0]?.bucket).toBe('mastered');
  });

  it('bucket filter narrows the list but never the summary; the summary and filtered counts agree', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await bank(agent, 'GR-fresh-a', '-네요');
    await bank(agent, 'GR-fresh-b', '-군요');
    const drilled = await bank(agent, 'GR-drilled', '-거든요');
    await setProductionCard(userId, drilled, 'learning', 2);

    const res = await agent.get('/grammar/mastery?bucket=new');
    expect(res.status).toBe(200);
    const body = res.body as MasteryEnvelope;
    // Summary stays whole-bank…
    expect(body.summary).toEqual({
      new: 2,
      learning: 1,
      reviewing: 0,
      mastered: 0,
      total: 3,
    });
    // …while the page and its total describe only the filtered bucket.
    expect(body.patterns).toHaveLength(2);
    expect(body.total).toBe(2);
    for (const p of body.patterns) expect(p.bucket).toBe('new');
  });

  it('invalid bucket → 400 (never a silent empty list)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/grammar/mastery?bucket=nope');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('paginates with limit/offset over the stable ordering', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const a = await bank(agent, 'GR-page-a', '-패턴가');
    const b = await bank(agent, 'GR-page-b', '-패턴나');
    const c = await bank(agent, 'GR-page-c', '-패턴다');
    await setProductionCard(userId, a, 'review', 30);
    await setProductionCard(userId, b, 'review', 10);
    await setProductionCard(userId, c, 'review', 5);

    const page1 = await agent.get('/grammar/mastery?limit=2&offset=0');
    expect(page1.status).toBe(200);
    const body1 = page1.body as MasteryEnvelope;
    expect(body1.patterns.map((p) => p.id)).toEqual([a, b]);
    expect(body1.total).toBe(3);

    const page2 = await agent.get('/grammar/mastery?limit=2&offset=2');
    expect(page2.status).toBe(200);
    const body2 = page2.body as MasteryEnvelope;
    expect(body2.patterns.map((p) => p.id)).toEqual([c]);
    expect(body2.total).toBe(3);
  });

  it('is user-isolated: another user’s bank and cards never appear', async () => {
    const a = await registerUser(t.app, pg.pool);
    const drilled = await bank(a.agent, 'GR-a-only', '-아/어 보이다');
    await setProductionCard(a.userId, drilled, 'review', 30);

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get('/grammar/mastery');
    expect(res.status).toBe(200);
    const body = res.body as MasteryEnvelope;
    expect(body.summary.total).toBe(0);
    expect(body.patterns).toEqual([]);
  });

  it('a recognition-face card on the same entry neither buckets the pattern nor fans the row out', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await bank(agent, 'GR-recognition-only', '-지 않다');
    // Legal per the schema (the partial unique index only covers
    // face='production'): a recognition card in review state. Only a
    // PRODUCTION card may drive the mastery bucket — mirrors the F-111
    // join-safety property GET /grammar/bank pins.
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, grammar_entry_id, fsrs_state, stability)
       VALUES ($1, 'recognition'::card_face, $2, 'review'::fsrs_state, 99)`,
      [userId, id],
    );

    const res = await agent.get('/grammar/mastery');
    expect(res.status).toBe(200);
    const body = res.body as MasteryEnvelope;
    expect(body.patterns).toHaveLength(1); // no fan-out
    expect(body.patterns[0]?.bucket).toBe('new'); // honest "not started"
    expect(body.patterns[0]?.stability).toBeNull();
  });

  it('a soft-deleted production card is ignored — the pattern buckets new again', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await bank(agent, 'GR-soft-deleted-card', '-고 말다');
    // A MATURE production card that was since soft-deleted. The join's
    // `vc.deleted_at IS NULL` predicate must exclude it — dropping that
    // predicate would wrongly report this pattern as mastered (stability
    // 99). Legal per the schema: the partial unique index only covers
    // deleted_at IS NULL rows, so a deleted card coexists with none live.
    await pg.pool.query(
      `INSERT INTO vocab_cards
         (user_id, face, grammar_entry_id, fsrs_state, stability, deleted_at)
       VALUES ($1, 'production'::card_face, $2, 'review'::fsrs_state, 99, now())`,
      [userId, id],
    );

    const res = await agent.get('/grammar/mastery');
    expect(res.status).toBe(200);
    const body = res.body as MasteryEnvelope;
    expect(body.summary).toEqual({
      new: 1,
      learning: 0,
      reviewing: 0,
      mastered: 0,
      total: 1,
    });
    expect(body.patterns).toHaveLength(1);
    expect(body.patterns[0]?.bucket).toBe('new'); // honest "not started"
    expect(body.patterns[0]?.stability).toBeNull(); // never the dead card's 99
  });
});
