/**
 * Integration tests for /uploads routes (U1a — PDF book-upload feature).
 *
 * Routes:
 *   POST   /uploads
 *   GET    /uploads
 *   GET    /uploads/:id
 *   GET    /uploads/:id/file  (Range-capable)
 *   DELETE /uploads/:id
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in).
 * The blob store points at a throwaway temp dir (BOOK_UPLOAD_STORAGE_DIR is
 * env-injected before buildTestApp) — never any real storage.
 *
 * Coverage:
 *   - auth required on every route (401 unauthenticated)
 *   - POST happy path: a valid PDF (%PDF- signature) → 201 + row persisted +
 *     blob on disk
 *   - POST rejects: non-PDF bytes (400), missing file (400), oversize (413),
 *     missing/blank title (400), invalid type (400), unknown extra field (400,
 *     .strict())
 *   - POST idempotent replace: re-upload of the SAME (user, title) → 200 (not
 *     201), ONE row, a NEW blob on disk, the OLD blob deleted
 *   - POST daily cap: many distinct titles → 429; a same-title replace at the
 *     cap is exempt
 *   - GET list: user-scoped, newest first
 *   - GET :id: own returns metadata; other user's id → 404; bad id → 400
 *   - GET :id/file: streams the bytes with the right headers; Range slices
 *     (206), unsatisfiable range (416), full body (200); IDOR → 404
 *   - DELETE: removes row + blob; second delete / other user's id → 404
 */
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedBookUpload } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

/** A minimal but VALID (parseable) 1-page PDF — real %PDF- signature + a
 *  trailer, so the magic-byte sniff AND a "does this look like a PDF" smell
 *  test both pass, mirroring what a real scanner/export would send. */
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n' +
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n' +
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>endobj\n' +
    'trailer<< /Size 4 /Root 1 0 R >>\n' +
    '%%EOF',
  'utf8',
);

beforeAll(async () => {
  pg = await startPostgres();
  // Point the blob store at a throwaway temp dir so saveBlob/readBlob/deleteBlob
  // exercise real filesystem I/O without polluting the repo. Set BEFORE
  // buildTestApp so the config picks it up (BOOK_UPLOAD_STORAGE_DIR has a
  // default otherwise).
  process.env.BOOK_UPLOAD_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-uploads-test-${process.pid}-${Date.now()}`,
  );
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  delete process.env.BOOK_UPLOAD_STORAGE_DIR;
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  // users CASCADE clears book_uploads (user_id FK). RESTART IDENTITY keeps
  // ids small/predictable across tests.
  await pg.pool.query(
    'TRUNCATE TABLE book_uploads, vocab_cards, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

/** GET a binary URL with the body captured as a raw Buffer (mirrors
 *  ttmik.test.ts's getAudio — supertest doesn't auto-buffer application/pdf). */
function getBinary(agent: ReturnType<typeof request.agent>, url: string, range?: string) {
  const req = agent.get(url).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return range === undefined ? req : req.set('Range', range);
}

describe('uploads — auth required', () => {
  it.each([
    ['GET', '/uploads'],
    ['GET', '/uploads/1'],
    ['GET', '/uploads/1/file'],
    ['POST', '/uploads'],
    ['DELETE', '/uploads/1'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(p)
        : method === 'DELETE'
          ? await request(t.app).delete(p)
          : await request(t.app).post(p);
    expect(res.status).toBe(401);
  });
});

describe('POST /uploads — upload a PDF', () => {
  it('uploads a valid PDF, persists the row, and writes the blob to disk (201)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const res = await agent
      .post('/uploads')
      .field('title', 'KGIU Beginner Scan')
      .field('type', 'grammar')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    const up = res.body.upload;
    expect(up.id).toBeTruthy();
    expect(up.title).toBe('KGIU Beginner Scan');
    expect(up.type).toBe('grammar');
    expect(up.status).toBe('processing');
    expect(up.page_count).toBeNull();
    expect(up.byte_size).toBe(TINY_PDF.length);

    // Persisted: one row for this user.
    const rows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_uploads WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows[0]?.n).toBe('1');

    // The blob is really on disk with the exact bytes.
    const blobRow = await pg.pool.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM book_uploads WHERE id = $1`,
      [up.id],
    );
    const blobRef = blobRow.rows[0]!.blob_ref;
    expect(blobRef).toMatch(new RegExp(`^${userId}/[0-9a-f-]{36}\\.pdf$`));
    const onDisk = await readFile(
      path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, blobRef),
    );
    expect(Buffer.compare(onDisk, TINY_PDF)).toBe(0);
  });

  it('rejects a file whose bytes are not a PDF despite a pdf mime (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const notAPdf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

    const res = await agent
      .post('/uploads')
      .field('title', 'Fake Book')
      .field('type', 'vocab')
      .attach('file', notAPdf, { filename: 'evil.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    const rows = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM book_uploads`);
    expect(rows.rows[0]?.n).toBe('0');
  });

  it('rejects a disallowed declared mime (text/plain) at the fileFilter (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Not A PDF')
      .field('type', 'vocab')
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('rejects a request with no file (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/uploads').field('title', 'No File').field('type', 'vocab');
    expect(res.status).toBe(400);
  });

  it('rejects an oversize upload with 413 Payload Too Large, not 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // 15 MiB + 1 byte, leading bytes a valid %PDF- signature so the size limit
    // — not the magic-byte sniff — is what rejects it.
    const oversize = Buffer.concat([
      TINY_PDF,
      Buffer.alloc(15 * 1024 * 1024 + 1 - TINY_PDF.length, 0),
    ]);
    const res = await agent
      .post('/uploads')
      .field('title', 'Huge Book')
      .field('type', 'vocab')
      .attach('file', oversize, { filename: 'huge.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(413);
    expect(res.body?.error?.code).toBe('payload_too_large');
    const rows = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM book_uploads`);
    expect(rows.rows[0]?.n).toBe('0');
  });

  it('rejects a blank title (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', '   ')
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing title field (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing type field (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Some Book')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid type enum value (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Some Book')
      .field('type', 'not_a_real_type')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown extra body field (mass-assignment defense, 400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Some Book')
      .field('type', 'vocab')
      .field('status', 'ready') // not a writable field
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('re-uploading the SAME (user, title) REPLACES: one row, new blob, old blob deleted (200)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const first = await agent
      .post('/uploads')
      .field('title', 'My Book')
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'v1.pdf', contentType: 'application/pdf' });
    expect(first.status).toBe(201);
    const firstBlobRow = await pg.pool.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM book_uploads WHERE id = $1`,
      [first.body.upload.id],
    );
    const firstBlobRef = firstBlobRow.rows[0]!.blob_ref;
    const firstBlobPath = path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, firstBlobRef);
    await expect(readFile(firstBlobPath)).resolves.toBeInstanceOf(Buffer);

    const secondPdf = Buffer.concat([TINY_PDF, Buffer.from('\n% v2 padding')]);
    const second = await agent
      .post('/uploads')
      .field('title', 'My Book') // same title
      .field('type', 'grammar') // type may change too
      .attach('file', secondPdf, { filename: 'v2.pdf', contentType: 'application/pdf' });

    expect(second.status).toBe(200); // replace, not create
    expect(second.body.upload.id).toBe(first.body.upload.id); // same row
    expect(second.body.upload.type).toBe('grammar');
    expect(second.body.upload.byte_size).toBe(secondPdf.length);

    const rows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_uploads WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows[0]?.n).toBe('1'); // still exactly one row

    const secondBlobRow = await pg.pool.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM book_uploads WHERE id = $1`,
      [first.body.upload.id],
    );
    const secondBlobRef = secondBlobRow.rows[0]!.blob_ref;
    expect(secondBlobRef).not.toBe(firstBlobRef); // a fresh UUID blob

    // The new blob holds the new bytes.
    const onDisk = await readFile(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, secondBlobRef));
    expect(Buffer.compare(onDisk, secondPdf)).toBe(0);

    // The OLD blob file was deleted (orphan cleanup after the replace commits).
    await expect(readFile(firstBlobPath)).rejects.toThrow();
  });

  it('enforces the per-user daily cap on NEW titles (429)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Default cap is 10 — seed that many distinct-titled rows dated today.
    for (let i = 0; i < 10; i += 1) {
      await seedBookUpload(pg.pool, userId, { title: `cap-book-${i}` });
    }
    const res = await agent
      .post('/uploads')
      .field('title', 'One Too Many')
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(429);
  });

  it('does NOT count a same-title replace against the daily cap', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    for (let i = 0; i < 10; i += 1) {
      await seedBookUpload(pg.pool, userId, { title: `cap-book-${i}` });
    }
    // Re-uploading an EXISTING title at the cap must still succeed (replace).
    const res = await agent
      .post('/uploads')
      .field('title', 'cap-book-0')
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
  });
});

describe('GET /uploads — list, user-scoped, newest first', () => {
  it("returns the user's uploads newest first", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const first = await seedBookUpload(pg.pool, userId, { title: 'first' });
    const second = await seedBookUpload(pg.pool, userId, { title: 'second' });

    const res = await agent.get('/uploads');
    expect(res.status).toBe(200);
    const ids = res.body.uploads.map((u: { id: string }) => Number(u.id));
    expect(ids).toEqual([second, first]);
  });

  it("does not list another user's uploads", async () => {
    const other = await registerUser(t.app, pg.pool);
    await seedBookUpload(pg.pool, other.userId);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/uploads');
    expect(res.status).toBe(200);
    expect(res.body.uploads.length).toBe(0);
  });
});

describe('GET /uploads/:id — single upload, user-scoped', () => {
  it('returns the upload metadata', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, userId, {
      title: 'Some Book',
      type: 'literature',
      status: 'ready',
      pageCount: 250,
    });

    const res = await agent.get(`/uploads/${id}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.upload.id)).toBe(id);
    expect(res.body.upload.title).toBe('Some Book');
    expect(res.body.upload.type).toBe('literature');
    expect(res.body.upload.status).toBe('ready');
    expect(res.body.upload.page_count).toBe(250);
  });

  it("returns 404 for another user's upload (IDOR)", async () => {
    const other = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, other.userId);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(`/uploads/${id}`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/uploads/abc');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/uploads/999999');
    expect(res.status).toBe(404);
  });
});

describe('GET /uploads/:id/file — streams the PDF, Range-capable', () => {
  async function uploadOne(agent: ReturnType<typeof request.agent>, title = 'Streamed Book') {
    const res = await agent
      .post('/uploads')
      .field('title', title)
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    return res.body.upload.id as string;
  }

  it('no Range header → 200 with the full PDF + the right headers', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadOne(agent);

    const res = await getBinary(agent, `/uploads/${id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(TINY_PDF.length));
    expect(res.headers['content-range']).toBeUndefined();
    expect(Buffer.compare(res.body as Buffer, TINY_PDF)).toBe(0);
  });

  it('Range: bytes=0-3 → 206 with Content-Range and the exact slice', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadOne(agent);

    const res = await getBinary(agent, `/uploads/${id}/file`, 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-3/${TINY_PDF.length}`);
    expect(res.headers['content-length']).toBe('4');
    expect(Buffer.compare(res.body as Buffer, TINY_PDF.subarray(0, 4))).toBe(0);
  });

  it('open-ended Range: bytes=10- → 206 to EOF', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadOne(agent);

    const res = await getBinary(agent, `/uploads/${id}/file`, 'bytes=10-');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-${TINY_PDF.length - 1}/${TINY_PDF.length}`);
    expect(Buffer.compare(res.body as Buffer, TINY_PDF.subarray(10))).toBe(0);
  });

  it('unsatisfiable Range (start past EOF) → 416 with total-size Content-Range', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadOne(agent);

    const res = await getBinary(agent, `/uploads/${id}/file`, `bytes=${TINY_PDF.length + 100}-`);
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${TINY_PDF.length}`);
  });

  it("returns 404 for another user's upload (IDOR)", async () => {
    const other = await registerUser(t.app, pg.pool);
    const id = await uploadOne(other.agent, 'Other Book');
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(`/uploads/${id}/file`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the row exists but the blob file is missing', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, userId); // no real blob written
    const res = await agent.get(`/uploads/${id}/file`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /uploads/:id — removes row + blob', () => {
  it('deletes the row and the on-disk blob', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadRes = await agent
      .post('/uploads')
      .field('title', 'To Delete')
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    const id = uploadRes.body.upload.id as string;
    const blobRow = await pg.pool.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM book_uploads WHERE id = $1`,
      [id],
    );
    const blobPath = path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, blobRow.rows[0]!.blob_ref);
    await expect(readFile(blobPath)).resolves.toBeInstanceOf(Buffer);

    const res = await agent.delete(`/uploads/${id}`);
    expect(res.status).toBe(204);

    const rows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_uploads WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows[0]?.n).toBe('0');
    await expect(readFile(blobPath)).rejects.toThrow();
  });

  it("returns 404 for another user's upload (IDOR) and does not delete it", async () => {
    const other = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, other.userId);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.delete(`/uploads/${id}`);
    expect(res.status).toBe(404);

    const rows = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM book_uploads WHERE id = $1`, [
      id,
    ]);
    expect(rows.rows[0]?.n).toBe('1'); // untouched
  });

  it('a second delete of the same id → 404 (already gone)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, userId);

    const first = await agent.delete(`/uploads/${id}`);
    expect(first.status).toBe(204);
    const secondRes = await agent.delete(`/uploads/${id}`);
    expect(secondRes.status).toBe(404);
  });
});
