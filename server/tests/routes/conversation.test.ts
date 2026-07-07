/**
 * Per-route tests for src/routes/conversation.ts (B-FU-2).
 *
 * Routes:
 *   POST /conversation                              — start session
 *   POST /conversation/:conversationId/messages     — append turn
 *   GET  /conversation                              — list user’s convos
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
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
    'TRUNCATE TABLE conversations, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('conversation — auth required', () => {
  it.each([
    ['GET', '/conversation'],
    ['POST', '/conversation'],
    ['POST', '/conversation/1/messages'],
  ])('%s %s unauthenticated → 401', async (method, path) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(path)
        : await request(t.app).post(path).send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /conversation — success + validation', () => {
  it('valid mode → 201 with conversation id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/conversation').send({ mode: 'casual' });
    expect(res.status).toBe(201);
    expect(typeof res.body.conversation.id).toBe('number');
  });

  it('valid mode + register → 201', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/conversation')
      .send({ mode: 'register_drill', target_register: '해요체' });
    expect(res.status).toBe(201);
  });

  it('invalid mode → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/conversation').send({ mode: 'random_mode' });
    expect(res.status).toBe(400);
  });

  it('invalid register → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/conversation')
      .send({ mode: 'casual', target_register: 'not-a-register' });
    expect(res.status).toBe(400);
  });

  it('missing mode → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/conversation').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /conversation/:id/messages — success + concurrency + 404', () => {
  it('appends a turn and bumps version', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    const res = await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: '안녕하세요', expected_version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
  });

  it('unknown conversation id → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/conversation/9999999/messages')
      .send({ content: 'hi', expected_version: 1 });
    expect(res.status).toBe(404);
  });

  it('stale expected_version → 409', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    // Advance the version once.
    await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: 'first', expected_version: 1 });
    const stale = await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: 'second', expected_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('conflict');
  });

  it('content empty → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    const res = await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: '', expected_version: 1 });
    expect(res.status).toBe(400);
  });

  it('content too long → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    const res = await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: 'x'.repeat(5000), expected_version: 1 });
    expect(res.status).toBe(400);
  });

  it('non-numeric conversationId → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/conversation/not-a-number/messages')
      .send({ content: 'hi', expected_version: 1 });
    expect(res.status).toBe(400);
  });

  it('cross-user message append → 404 (not 200, not 403-leak)', async () => {
    const userA = await registerUser(t.app, pg.pool);
    const start = await userA.agent.post('/conversation').send({ mode: 'casual' });
    const idA = start.body.conversation.id;
    const userB = await registerUser(t.app, pg.pool);
    const res = await userB.agent
      .post(`/conversation/${idA}/messages`)
      .send({ content: '안녕', expected_version: 1 });
    expect(res.status).toBe(404);
  });
});

describe('GET /conversation', () => {
  it('returns user’s own conversations only', async () => {
    const userA = await registerUser(t.app, pg.pool);
    await userA.agent.post('/conversation').send({ mode: 'casual' });
    const userB = await registerUser(t.app, pg.pool);
    const res = await userB.agent.get('/conversation');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([]);
  });

  it('cheap-bucket exceeded → 429', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let got429 = false;
    for (let i = 0; i < 200; i++) {
      const r = await agent.get('/conversation');
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});

describe('POST /conversation/:id/messages/stream — SSE (Pass 3, FU-NF-4)', () => {
  it('streams deltas and persists the assistant turn', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    const res = await agent
      .post(`/conversation/${id}/messages/stream`)
      .send({ content: '안녕하세요', expected_version: 1 });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/event-stream/);
    // Body is the raw SSE byte stream.
    const body = res.text as string;
    expect(body).toMatch(/data: \{"event":"start"/);
    expect(body).toMatch(/data: \{"event":"delta"/);
    expect(body).toMatch(/data: \{"event":"done"/);
    // Persistence check — the conversation row should now hold version=2
    // with two appended turns (user + assistant).
    const fetched = await pg.pool.query<{
      version: number;
      messages: unknown[];
    }>(
      `SELECT version, messages FROM conversations WHERE id = $1`,
      [id],
    );
    expect(fetched.rows[0]?.version).toBe(2);
    expect((fetched.rows[0]?.messages as unknown[]).length).toBe(2);
  });

  it('stale expected_version → 409', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    // Burn through version=1 with the non-streaming endpoint.
    await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: 'first', expected_version: 1 });
    const res = await agent
      .post(`/conversation/${id}/messages/stream`)
      .send({ content: 'second', expected_version: 1 });
    expect(res.status).toBe(409);
  });

  it('idempotent replay when X-Request-Id matches a persisted turn', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    const requestId = 'req-abcdef';
    // First call — persists the turn with request_id.
    const first = await agent
      .post(`/conversation/${id}/messages/stream`)
      .set('X-Request-Id', requestId)
      .send({ content: '안녕', expected_version: 1 });
    expect(first.status).toBe(200);
    // Second call with the same id at the SAME version should replay.
    const second = await agent
      .post(`/conversation/${id}/messages/stream`)
      .set('X-Request-Id', requestId)
      .send({ content: '안녕', expected_version: 1 });
    expect(second.status).toBe(200);
    expect(second.text as string).toMatch(/idempotent_replay":true/);
    // Conversation row should still be at version=2 — no second persistence.
    const fetched = await pg.pool.query<{ version: number }>(
      `SELECT version FROM conversations WHERE id = $1`,
      [id],
    );
    expect(fetched.rows[0]?.version).toBe(2);
  });

  it('unauthenticated → 401', async () => {
    const res = await request(t.app)
      .post('/conversation/1/messages/stream')
      .send({ content: 'hi', expected_version: 1 });
    expect(res.status).toBe(401);
  });

  it('persistence failure after a successful stream sends a REDACTED error frame (routes sweep #5)', async () => {
    // A raw pg error message on the SSE wire would leak schema/constraint
    // names, bypassing the central errorHandler's opaque-500 rule. Force the
    // persist UPDATE to fail with a distinctive message via a trigger and
    // assert the frame carries a fixed message — while recovered_text still
    // lets the client offer a manual retry.
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    await pg.pool.query(
      `CREATE OR REPLACE FUNCTION test_conv_persist_bomb() RETURNS trigger AS $fn$
       BEGIN
         RAISE EXCEPTION 'SECRET_INTERNAL_DETAIL: relation conversations, constraint ck_x';
       END;
       $fn$ LANGUAGE plpgsql`,
    );
    await pg.pool.query(
      `CREATE TRIGGER trg_test_conv_persist_bomb
         BEFORE UPDATE ON conversations
         FOR EACH ROW EXECUTE FUNCTION test_conv_persist_bomb()`,
    );
    try {
      const res = await agent
        .post(`/conversation/${id}/messages/stream`)
        .send({ content: '안녕하세요', expected_version: 1 });
      // Headers were already sent when persistence failed → 200 + error frame.
      expect(res.status).toBe(200);
      const body = res.text as string;
      expect(body).toMatch(/"event":"error"/);
      expect(body).toMatch(/"code":"persistence_error"/);
      expect(body).toMatch(/"message":"persistence failed"/);
      expect(body).toMatch(/"recovered_text"/);
      expect(body).not.toContain('SECRET_INTERNAL_DETAIL');
    } finally {
      await pg.pool.query(
        'DROP TRIGGER IF EXISTS trg_test_conv_persist_bomb ON conversations',
      );
      await pg.pool.query('DROP FUNCTION IF EXISTS test_conv_persist_bomb()');
    }
  });
});

describe('conversation — DB error', () => {
  it('GET /conversation with conversations table missing → 500 no leak', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await pg.pool.query('ALTER TABLE conversations RENAME TO conversations_hidden');
    try {
      const res = await agent.get('/conversation');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('conversations_hidden');
    } finally {
      await pg.pool.query('ALTER TABLE conversations_hidden RENAME TO conversations');
    }
  });
});
