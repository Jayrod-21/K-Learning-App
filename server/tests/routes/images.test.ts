/**
 * Integration tests for /images routes (Pass 8 — Images screen / OCR mining).
 *
 * Routes:
 *   POST /images/ocr        (multer upload + Vision OCR + persist)
 *   GET  /images
 *   GET  /images/:id
 *   GET  /images/:id/blob
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in). The
 * Claude Vision proxy is the deterministic `ocrImage` STUB from makeStubProxy
 * (fixed caption + 3 words) so the upload happy-path runs without Anthropic.
 *
 * Coverage:
 *   - auth required on every route (401 unauthenticated)
 *   - POST happy path: upload a valid PNG → 201 + capture persisted + words +
 *     the stub caption; the blob is written and GET /:id/blob returns the bytes
 *   - magic-byte reject (a .png-declared non-image) → 400
 *   - mime reject (declared text/plain) → 400
 *   - missing file → 400
 *   - daily cap → 429
 *   - GET list: user-scoped, newest first, soft-deleted excluded, no words
 *   - GET :id: own returns capture+words; other user's id → 404
 *   - GET :id/blob: own returns bytes + content-type + nosniff; other user → 404
 */
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedImageCapture } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

/**
 * A minimal but VALID 1x1 PNG (8-byte signature + IHDR + IDAT + IEND). The
 * magic-byte sniff only checks the leading 8 bytes, but a real decodable PNG
 * keeps the test honest end-to-end (it is what a browser would send).
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  pg = await startPostgres();
  // Point the blob store at a throwaway temp dir so saveBlob/readBlob exercise
  // real filesystem I/O without polluting the repo. Set BEFORE buildTestApp so
  // the config picks it up (IMAGE_STORAGE_DIR has a default otherwise).
  process.env.IMAGE_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-images-test-${process.pid}-${Date.now()}`,
  );
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  // users CASCADE clears image_captures (user FK) which CASCADE-clears
  // image_words. RESTART IDENTITY keeps ids small/predictable across tests.
  await pg.pool.query(
    'TRUNCATE TABLE image_words, image_captures, vocab_cards, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('images — auth required', () => {
  it.each([
    ['GET', '/images'],
    ['GET', '/images/1'],
    ['GET', '/images/1/blob'],
    ['POST', '/images/ocr'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(p)
        : await request(t.app).post(p);
    expect(res.status).toBe(401);
  });
});

describe('POST /images/ocr — upload + OCR + persist', () => {
  it('uploads a valid PNG, persists the capture + words, returns the stub caption', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const res = await agent
      .post('/images/ocr')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    const cap = res.body.capture;
    expect(cap.id).toBeTruthy();
    expect(cap.name).toBe('menu.png');
    expect(cap.caption_kr).toBe('책상 위의 메뉴판'); // stub caption
    expect(cap.caption_en).toBe('a menu on the desk');
    expect(cap.blobUrl).toBe(`/images/${cap.id}/blob`);
    expect(cap.words.length).toBe(3); // stub returns 3 content words
    expect(cap.words[0]).toEqual({
      kr: '메뉴',
      en: 'menu',
      gloss: 'a list of dishes',
      pos: 'n.',
    });

    // Persisted: one capture for this user + three words.
    const caps = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM image_captures WHERE user_id = $1`,
      [userId],
    );
    expect(caps.rows[0]?.n).toBe('1');
    const words = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM image_words
        WHERE capture_id = (SELECT id FROM image_captures WHERE user_id = $1)`,
      [userId],
    );
    expect(words.rows[0]?.n).toBe('3');

    // The blob is on disk and served back with the right content-type.
    const blob = await agent.get(cap.blobUrl);
    expect(blob.status).toBe(200);
    expect(blob.headers['content-type']).toContain('image/png');
    expect(blob.headers['x-content-type-options']).toBe('nosniff');
    expect(blob.headers['cache-control']).toContain('private');
    expect(Buffer.from(blob.body).length).toBe(TINY_PNG.length);
  });

  it('rejects a file whose bytes are not an image despite a png mime (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const notAnImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

    const res = await agent
      .post('/images/ocr')
      .attach('image', notAnImage, { filename: 'evil.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    // Nothing persisted.
    const caps = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM image_captures`,
    );
    expect(caps.rows[0]?.n).toBe('0');
  });

  it('rejects a disallowed declared mime (text/plain) at the fileFilter (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/images/ocr')
      .attach('image', Buffer.from('hello'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
    // fileFilter drops the file → no req.file → 400.
    expect(res.status).toBe(400);
  });

  it('rejects a request with no file (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/images/ocr');
    expect(res.status).toBe(400);
  });

  it('rejects an oversize upload with 413 Payload Too Large, not 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // 8 MiB + 1 byte: trips multer's fileSize limit (LIMIT_FILE_SIZE). The
    // leading bytes are a valid PNG signature so the size limit — not the
    // magic-byte sniff — is what rejects it. The client keys its "image is too
    // large" copy off 413, so the size-limit path MUST be 413 (not 400, which
    // the client maps to "unsupported image").
    const oversize = Buffer.concat([
      TINY_PNG,
      Buffer.alloc(8 * 1024 * 1024 + 1 - TINY_PNG.length, 0),
    ]);
    const res = await agent
      .post('/images/ocr')
      .attach('image', oversize, { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.body?.error?.code).toBe('payload_too_large');
    // Nothing persisted.
    const caps = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM image_captures`,
    );
    expect(caps.rows[0]?.n).toBe('0');
  });

  it('enforces the per-user daily cap (429)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Pre-seed the cap worth of captures dated today so the next upload trips it.
    // Read the configured cap from the route's view by seeding generously; the
    // default is 20, so seed 20.
    for (let i = 0; i < 20; i += 1) {
      await seedImageCapture(pg.pool, userId, { words: [] });
    }
    const res = await agent
      .post('/images/ocr')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(429);
  });

  it('counts soft-deleted captures toward the daily cap (cost control)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    for (let i = 0; i < 20; i += 1) {
      await seedImageCapture(pg.pool, userId, { deleted: true, words: [] });
    }
    const res = await agent
      .post('/images/ocr')
      .attach('image', TINY_PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(429);
  });
});

describe('GET /images — list, user-scoped, newest first, no soft-deleted', () => {
  it('returns the user\'s live captures newest first, without words', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const first = await seedImageCapture(pg.pool, userId, { captionEn: 'first' });
    const second = await seedImageCapture(pg.pool, userId, { captionEn: 'second' });
    await seedImageCapture(pg.pool, userId, { captionEn: 'gone', deleted: true });

    const res = await agent.get('/images');
    expect(res.status).toBe(200);
    const ids = res.body.captures.map((c: { id: string }) => Number(c.id));
    expect(ids).toEqual([second, first]); // newest first; soft-deleted excluded
    // Summaries carry no words.
    expect(res.body.captures[0].words).toBeUndefined();
    expect(res.body.captures[0].blobUrl).toBe(`/images/${second}/blob`);
  });

  it('does not list another user\'s captures', async () => {
    const other = await registerUser(t.app, pg.pool);
    await seedImageCapture(pg.pool, other.userId);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/images');
    expect(res.status).toBe(200);
    expect(res.body.captures.length).toBe(0);
  });
});

describe('GET /images/:id — single capture + words, user-scoped', () => {
  it('returns the capture with its words in order', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await seedImageCapture(pg.pool, userId, {
      words: [
        { kr: '하나', en: 'one', gloss: 'the number one', pos: 'n.' },
        { kr: '둘', en: 'two', gloss: 'the number two', pos: null },
      ],
    });

    const res = await agent.get(`/images/${id}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.capture.id)).toBe(id);
    expect(res.body.capture.words.map((w: { kr: string }) => w.kr)).toEqual(['하나', '둘']);
    // A null pos maps to '' in the DTO.
    expect(res.body.capture.words[1].pos).toBe('');
  });

  it('returns 404 for another user\'s capture (IDOR)', async () => {
    const other = await registerUser(t.app, pg.pool);
    const id = await seedImageCapture(pg.pool, other.userId);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(`/images/${id}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted capture', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await seedImageCapture(pg.pool, userId, { deleted: true });
    const res = await agent.get(`/images/${id}`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/images/abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /images/:id/blob — bytes, user-scoped', () => {
  it('returns 404 for another user\'s blob (IDOR)', async () => {
    const other = await registerUser(t.app, pg.pool);
    const id = await seedImageCapture(pg.pool, other.userId);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(`/images/${id}/blob`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the row exists but the blob file is missing', async () => {
    // seedImageCapture writes a row whose blob_path points at no real file.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await seedImageCapture(pg.pool, userId);
    const res = await agent.get(`/images/${id}/blob`);
    expect(res.status).toBe(404);
  });
});
