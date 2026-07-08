/**
 * Per-route tests for src/routes/conversation.ts (B-FU-2 + chat rework Slice 1).
 *
 * Routes:
 *   POST /conversation                              — start session
 *   POST /conversation/:conversationId/messages     — append turn
 *   POST /conversation/:conversationId/image        — append OCR'd image turn
 *   GET  /conversation                              — list user’s convos
 *                                                     (+ 30-day retention sweep)
 *   GET  /conversation/:conversationId              — full message history
 */
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedImageCapture } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

/**
 * A minimal but VALID 1x1 PNG (8-byte signature + IHDR + IDAT + IEND) —
 * same fixture as images.test.ts; what a browser upload would actually send.
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Backdate a conversation's updated_at DESPITE the set_updated_at BEFORE
 * UPDATE trigger (which unconditionally stamps now() and would silently undo
 * a plain UPDATE — a test that skipped this would pass vacuously with a
 * fresh timestamp). Trigger is re-enabled even if the UPDATE throws.
 */
async function backdateConversation(
  pool: Pool,
  conversationId: number,
  interval: string,
): Promise<void> {
  await pool.query(
    'ALTER TABLE conversations DISABLE TRIGGER trg_conversations_updated_at',
  );
  try {
    await pool.query(
      `UPDATE conversations SET updated_at = now() - $2::interval WHERE id = $1`,
      [conversationId, interval],
    );
  } finally {
    await pool.query(
      'ALTER TABLE conversations ENABLE TRIGGER trg_conversations_updated_at',
    );
  }
}

beforeAll(async () => {
  pg = await startPostgres();
  // The image-turn tests write real blobs — point the store at a throwaway
  // temp dir BEFORE buildTestApp so the config picks it up (mirrors
  // images.test.ts).
  process.env.IMAGE_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-conv-images-test-${process.pid}-${Date.now()}`,
  );
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE image_words, image_captures, conversations, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('conversation — auth required', () => {
  it.each([
    ['GET', '/conversation'],
    ['GET', '/conversation/1'],
    ['POST', '/conversation'],
    ['POST', '/conversation/1/messages'],
    ['POST', '/conversation/1/image'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(p)
        : await request(t.app).post(p).send({});
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

describe('GET /conversation/:id — full history (chat rework Slice 1)', () => {
  it('returns the owner’s full message history + metadata', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent
      .post('/conversation')
      .send({ mode: 'casual', target_register: '해요체' });
    const id = start.body.conversation.id;
    // Append a real turn pair so the history is non-trivial.
    await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: '안녕하세요', expected_version: 1 });

    const res = await agent.get(`/conversation/${id}`);
    expect(res.status).toBe(200);
    const conv = res.body.conversation;
    expect(conv.id).toBe(id);
    expect(conv.mode).toBe('casual');
    expect(conv.target_register).toBe('해요체');
    expect(conv.version).toBe(2);
    expect(Array.isArray(conv.messages)).toBe(true);
    expect(conv.messages.length).toBe(2);
    expect(conv.messages[0]).toMatchObject({ role: 'user', content: '안녕하세요' });
    expect(conv.messages[1].role).toBe('assistant');
    expect(typeof conv.messages[1].content).toBe('string');
    expect(conv.messages[1].content.length).toBeGreaterThan(0);
    // Timestamps ride as ISO strings.
    expect(new Date(conv.created_at).getTime()).not.toBeNaN();
    expect(new Date(conv.updated_at).getTime()).not.toBeNaN();
  });

  it('returns 404 for another user’s conversation (IDOR, not 403)', async () => {
    const userA = await registerUser(t.app, pg.pool);
    const start = await userA.agent.post('/conversation').send({ mode: 'casual' });
    const idA = start.body.conversation.id;
    const userB = await registerUser(t.app, pg.pool);
    const res = await userB.agent.get(`/conversation/${idA}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a missing id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/conversation/9999999');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted conversation', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    await pg.pool.query(
      'UPDATE conversations SET deleted_at = now() WHERE id = $1',
      [id],
    );
    const res = await agent.get(`/conversation/${id}`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id with 400 (not 500)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/conversation/not-a-number');
    expect(res.status).toBe(400);
  });

  it('rejects an int8-overflowing id with 400 (not 500)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/conversation/99999999999999999999');
    expect(res.status).toBe(400);
  });
});

describe('GET /conversation — 30-day retention sweep (chat rework Slice 1)', () => {
  it('soft-deletes a 31-day-old conversation on list but keeps a 29-day-old', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const stale = (await agent.post('/conversation').send({ mode: 'casual' }))
      .body.conversation.id;
    const fresh = (await agent.post('/conversation').send({ mode: 'business' }))
      .body.conversation.id;
    await backdateConversation(pg.pool, stale, '31 days');
    await backdateConversation(pg.pool, fresh, '29 days');

    const res = await agent.get('/conversation');
    expect(res.status).toBe(200);
    const ids = res.body.conversations.map((c: { id: number }) => c.id);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(stale);

    // The stale row is soft-deleted (deleted_at stamped), not hard-deleted;
    // the fresh row is untouched.
    const rows = await pg.pool.query<{ id: string; deleted_at: Date | null }>(
      'SELECT id, deleted_at FROM conversations ORDER BY id',
    );
    const byId = new Map(rows.rows.map((r) => [Number(r.id), r.deleted_at]));
    expect(byId.get(stale)).not.toBeNull();
    expect(byId.get(fresh)).toBeNull();

    // The swept conversation is gone from direct fetch too (reads filter
    // deleted_at IS NULL).
    const direct = await agent.get(`/conversation/${stale}`);
    expect(direct.status).toBe(404);
  });

  it('is idempotent — a second list is unchanged and errors nothing', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const stale = (await agent.post('/conversation').send({ mode: 'casual' }))
      .body.conversation.id;
    await backdateConversation(pg.pool, stale, '31 days');

    const first = await agent.get('/conversation');
    expect(first.status).toBe(200);
    const stamped = await pg.pool.query<{ deleted_at: Date }>(
      'SELECT deleted_at FROM conversations WHERE id = $1',
      [stale],
    );
    const firstStamp = stamped.rows[0]!.deleted_at.getTime();

    const second = await agent.get('/conversation');
    expect(second.status).toBe(200);
    expect(second.body.conversations).toEqual(first.body.conversations);
    // The deleted_at stamp was not re-written by the second sweep.
    const restamped = await pg.pool.query<{ deleted_at: Date }>(
      'SELECT deleted_at FROM conversations WHERE id = $1',
      [stale],
    );
    expect(restamped.rows[0]!.deleted_at.getTime()).toBe(firstStamp);
  });

  it('is user-scoped — listing never sweeps another user’s stale conversations', async () => {
    const userA = await registerUser(t.app, pg.pool);
    const staleA = (await userA.agent.post('/conversation').send({ mode: 'casual' }))
      .body.conversation.id;
    await backdateConversation(pg.pool, staleA, '40 days');

    const userB = await registerUser(t.app, pg.pool);
    const res = await userB.agent.get('/conversation');
    expect(res.status).toBe(200);

    // User B's list ran the sweep for B only — A's stale row is still live.
    const rows = await pg.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM conversations WHERE id = $1',
      [staleA],
    );
    expect(rows.rows[0]!.deleted_at).toBeNull();
  });
});

describe('POST /conversation/:id/image — OCR image turn (chat rework Slice 1)', () => {
  it('uploads a photo, appends an OCR image turn, and the turn round-trips via history', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;

    const res = await agent
      .post(`/conversation/${id}/image`)
      .field('expected_version', '1')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
    const turn = res.body.turn;
    expect(turn.role).toBe('user');
    // content is the OCR'd Korean text (stub caption).
    expect(turn.content).toBe('책상 위의 메뉴판');
    expect(typeof turn.image.capture_id).toBe('number');
    expect(turn.image.blob_url).toBe(`/images/${turn.image.capture_id}/blob`);
    expect(turn.image.caption_kr).toBe('책상 위의 메뉴판');
    expect(turn.image.caption_en).toBe('a menu on the desk');

    // The capture + its mined words persisted through the shared pipeline.
    const caps = await pg.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM image_captures WHERE user_id = $1',
      [userId],
    );
    expect(caps.rows[0]?.n).toBe('1');
    const words = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM image_words
        WHERE capture_id = $1`,
      [turn.image.capture_id],
    );
    expect(words.rows[0]?.n).toBe('3'); // stub returns 3 content words

    // The blob is fetchable through the existing authed image route.
    const blob = await agent.get(turn.image.blob_url);
    expect(blob.status).toBe(200);
    expect(blob.headers['content-type']).toContain('image/png');

    // Round-trip: the image turn is in the conversation history.
    const history = await agent.get(`/conversation/${id}`);
    expect(history.status).toBe(200);
    expect(history.body.conversation.version).toBe(2);
    expect(history.body.conversation.messages.length).toBe(1);
    expect(history.body.conversation.messages[0]).toMatchObject({
      role: 'user',
      content: '책상 위의 메뉴판',
      image: {
        capture_id: turn.image.capture_id,
        blob_url: turn.image.blob_url,
        caption_kr: '책상 위의 메뉴판',
        caption_en: 'a menu on the desk',
      },
    });
  });

  it('rejects a request with no file (400) and persists nothing', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;

    const res = await agent
      .post(`/conversation/${id}/image`)
      .field('expected_version', '1');
    expect(res.status).toBe(400);

    const conv = await pg.pool.query<{ version: number }>(
      'SELECT version FROM conversations WHERE id = $1',
      [id],
    );
    expect(conv.rows[0]?.version).toBe(1);
    const caps = await pg.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM image_captures',
    );
    expect(caps.rows[0]?.n).toBe('0');
  });

  it('rejects a missing expected_version field (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    const res = await agent
      .post(`/conversation/${id}/image`)
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('enforces the per-user daily Vision cap (429) without touching the conversation', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    // Same cap the /images/ocr route enforces (default 20) — shared pipeline.
    for (let i = 0; i < 20; i += 1) {
      await seedImageCapture(pg.pool, userId, { words: [] });
    }

    const res = await agent
      .post(`/conversation/${id}/image`)
      .field('expected_version', '1')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(429);

    const conv = await pg.pool.query<{ version: number; messages: unknown[] }>(
      'SELECT version, messages FROM conversations WHERE id = $1',
      [id],
    );
    expect(conv.rows[0]?.version).toBe(1);
    expect((conv.rows[0]?.messages as unknown[]).length).toBe(0);
  });

  it('rejects a stale expected_version with 409 and persists no capture', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    // Burn version 1 with a text turn.
    await agent
      .post(`/conversation/${id}/messages`)
      .send({ content: '안녕', expected_version: 1 });

    const res = await agent
      .post(`/conversation/${id}/image`)
      .field('expected_version', '1')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(409);

    const caps = await pg.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM image_captures',
    );
    expect(caps.rows[0]?.n).toBe('0');
  });

  it('returns 404 for another user’s conversation (IDOR) and spends no Vision budget', async () => {
    const userA = await registerUser(t.app, pg.pool);
    const start = await userA.agent.post('/conversation').send({ mode: 'casual' });
    const idA = start.body.conversation.id;
    const userB = await registerUser(t.app, pg.pool);

    const res = await userB.agent
      .post(`/conversation/${idA}/image`)
      .field('expected_version', '1')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(404);

    const caps = await pg.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM image_captures',
    );
    expect(caps.rows[0]?.n).toBe('0');
  });

  it('rejects a non-numeric conversation id (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/conversation/abc/image')
      .field('expected_version', '1')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('rejects bytes that are not a real image despite a png mime (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/conversation').send({ mode: 'casual' });
    const id = start.body.conversation.id;
    const notAnImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');

    const res = await agent
      .post(`/conversation/${id}/image`)
      .field('expected_version', '1')
      .attach('image', notAnImage, { filename: 'evil.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    const caps = await pg.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM image_captures',
    );
    expect(caps.rows[0]?.n).toBe('0');
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
