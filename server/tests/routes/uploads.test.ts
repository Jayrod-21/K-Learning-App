/**
 * Integration tests for /uploads routes (U1a — book-upload feature, reworked
 * to the PAGE-IMAGE model; see db/docs/PDF_UPLOAD_DESIGN.md §"REVISION
 * (2026-07-08)"), now on the Phase 2.5 ASYNC ingest contract (the OOM fix —
 * see services/bookIngestRunner.ts's header).
 *
 * Routes:
 *   POST   /uploads
 *   GET    /uploads
 *   GET    /uploads/:id
 *   GET    /uploads/:id/page/:n
 *   GET    /uploads/:id/pages
 *   PATCH  /uploads/:id/pages/order
 *   DELETE /uploads/:id
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in).
 * The blob store points at a throwaway temp dir (BOOK_UPLOAD_STORAGE_DIR is
 * env-injected before buildTestApp) — never any real storage.
 *
 * THE ASYNC CONTRACT (Phase 2.5): `POST /uploads` no longer decodes anything —
 * multer writes the raw file to disk and the handler enqueues a `'pending'`
 * `book_uploads` row, returning **202** immediately (no `book_pages` exist
 * yet). The in-process runner (`services/bookIngestRunner.ts`) does the
 * actual decode; tests drive it deterministically via `runBookIngestTick`
 * (no timers) — the same pattern `tests/services/bookIngestRunner.test.ts`
 * uses. A single `runBookIngestTick` call fully claims-decodes-settles ONE
 * pending upload (idle/done/failed), so `POST` + one tick reaches the same
 * end state the old synchronous `201` response used to reach in one step.
 *
 * The ZIP-of-images path is exercised with a REAL, hand-built zip archive
 * (tests/helpers/zip.ts + the real `yauzl` parser via services/
 * zipPageExtract.ts — see tests/services/zipPageExtract.test.ts for the
 * dedicated zip-bomb-guard unit tests). The PDF path mocks
 * services/pdfPageRender.ts's `streamPdfPagesToJpegFromFile` (the runner's
 * real entry point) — the test container doesn't have poppler-utils
 * installed (see that module's header and tests/services/pdfPageRender.test.ts,
 * a self-skipping real-poppler smoke test).
 *
 * Coverage:
 *   - auth required on every route (401 unauthenticated)
 *   - POST enqueue (zip): a real multi-image zip → 202 pending, NO book_pages
 *     yet → one runner tick → 'ready', pages in NATURAL FILENAME ORDER, each
 *     page's blob on disk with the exact bytes
 *   - POST enqueue (pdf): mocked streamPdfPagesToJpegFromFile → 202 pending →
 *     tick → 'ready', pages persisted
 *   - POST rejects SYNCHRONOUSLY (before any book_uploads row exists): bad
 *     magic bytes (400), disallowed declared mime (400), missing file (400),
 *     oversize (413), missing/blank title (400), invalid type (400), unknown
 *     extra field (400, .strict()), over the daily cap (429)
 *   - POST rejects ASYNCHRONOUSLY (enqueues 202, the runner settles 'failed'
 *     on tick): zip with 0 usable pages, a zip-bomb-guard trip, a PDF that
 *     renders to 0 pages
 *   - POST conflict: a second POST for the SAME (user, title) while the
 *     existing row is pending/processing → 409, no second row
 *   - POST idempotent replace: re-upload of a TERMINAL (ready/failed) same
 *     (user, title) row → 202 (reset to pending, NOT a new row); daily cap is
 *     exempt for a replace
 *   - GET list: user-scoped, newest first
 *   - GET :id: own returns metadata incl. page_count + error; other user's id
 *     → 404; bad id → 400
 *   - GET :id/page/:n: streams the right page's bytes + headers; IDOR → 404;
 *     out-of-range n → 404; bad n → 400
 *   - GET :id/pages: ordered {id, page_number} list for the owner; IDOR →
 *     404; bad id → 400; round-trips into PATCH :id/pages/order (the ids
 *     this route returns are exactly the ids that route accepts)
 *   - PATCH :id/pages/order: re-sequences page_number atomically; IDOR → 404;
 *     mismatched/foreign page_ids → 400; duplicate ids → 400
 *   - DELETE: removes row + ALL pages' blobs (cascade); IDOR → 404; second
 *     delete → 404
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedBookPage, seedBookUpload } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { BOOK_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '../../src/services/bookUploadIngest.js';
import { buildStoredZip } from '../helpers/zip.js';
import { runBookIngestTick } from '../../src/services/bookIngestRunner.js';
import { getLogger } from '../../src/logging.js';

// The PDF path shells out to `pdftoppm`, which the test container doesn't
// have (see services/pdfPageRender.ts's header) — mock the runner's real
// entry point so the PDF-upload tests are deterministic without poppler.
// `streamPdfPagesToJpegFromFile` (Phase 2.5) is an async generator that
// yields one rendered JPEG page Buffer at a time, called with the raw
// upload's ABSOLUTE PATH on disk (never a Buffer — see that module's header).
vi.mock('../../src/services/pdfPageRender.js', () => ({
  streamPdfPagesToJpegFromFile: vi.fn(),
}));
import { streamPdfPagesToJpegFromFile } from '../../src/services/pdfPageRender.js';

let pg: PgHandle;
let t: TestApp;

/** A minimal but VALID (parseable) 1-page PDF — real %PDF- signature + a
 *  trailer, so the magic-byte sniff AND a "does this look like a PDF" smell
 *  test both pass, mirroring what a real scanner/export would send. Only
 *  used to reach the mocked streamPdfPagesToJpegFromFile — its actual bytes
 *  are never rendered in this suite. */
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n' +
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n' +
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>endobj\n' +
    'trailer<< /Size 4 /Root 1 0 R >>\n' +
    '%%EOF',
  'utf8',
);

/** A minimal but VALID (decodable) 1x1 PNG — same fixture as
 *  tests/routes/images.test.ts's TINY_PNG. The magic-byte sniff only checks
 *  the leading 8 bytes; appending a distinguishing marker after it (see
 *  `markedPng`) keeps every "page" byte-for-byte distinct for assertions
 *  without breaking that check. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function markedPng(marker: string): Buffer {
  return Buffer.concat([TINY_PNG, Buffer.from(`-${marker}`, 'utf8')]);
}

/** A single-page zip — the generic "any valid upload" body for tests that
 *  don't care about zip specifics (mass-assignment, cap, validation, etc.). */
function minimalZip(): Buffer {
  return buildStoredZip([{ name: '001.png', data: TINY_PNG }]);
}

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
  // users CASCADE clears book_uploads (user_id FK), which CASCADEs
  // book_pages (upload_id FK, migration 041). RESTART IDENTITY keeps ids
  // small/predictable across tests.
  await pg.pool.query(
    'TRUNCATE TABLE book_uploads, vocab_cards, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
  vi.mocked(streamPdfPagesToJpegFromFile).mockReset();
});

/** GET a binary URL with the body captured as a raw Buffer (mirrors
 *  ttmik.test.ts's getAudio — supertest doesn't auto-buffer image bytes). */
function getBinary(agent: ReturnType<typeof request.agent>, url: string) {
  return agent.get(url).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

async function bookPageRows(uploadId: string | number) {
  const { rows } = await pg.pool.query<{ id: string; page_number: number; blob_ref: string }>(
    `SELECT id, page_number, blob_ref FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
    [uploadId],
  );
  return rows;
}

/** List filenames under BOOK_UPLOAD_STORAGE_DIR/raw/{userId}/ — `[]` (not a
 *  thrown ENOENT) if the directory doesn't exist yet, i.e. no upload for
 *  this user has ever reached multer's diskStorage `destination` callback.
 *  Used to assert a POST rejection leaves NO orphan raw file behind (Bug 2
 *  fix — see routes/uploads.ts's POST handler doc). */
async function listRawUploadFiles(userId: number): Promise<string[]> {
  try {
    return await readdir(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, 'raw', String(userId)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Drive the runner exactly one tick (no timers — the deterministic pattern
 *  tests/services/bookIngestRunner.test.ts uses). With at most one pending
 *  upload in play (the norm in this suite — beforeEach truncates), one call
 *  fully claims → decodes → settles it. */
function tick() {
  return runBookIngestTick(getLogger());
}

/** GET /uploads/:id and return the parsed upload DTO — used after a tick to
 *  read back the settled state through the real read path (dogfooding the
 *  route under test rather than only asserting against raw DB rows). */
async function fetchUpload(agent: ReturnType<typeof request.agent>, id: string | number) {
  const res = await agent.get(`/uploads/${id}`);
  expect(res.status).toBe(200);
  return res.body.upload as {
    id: string;
    title: string;
    type: string;
    status: string;
    page_count: number | null;
    byte_size: number;
    error: string | null;
    created_at: string;
  };
}

describe('uploads — auth required', () => {
  it.each([
    ['GET', '/uploads'],
    ['GET', '/uploads/shared'],
    ['GET', '/uploads/1'],
    ['GET', '/uploads/1/page/1'],
    ['GET', '/uploads/1/pages'],
    ['POST', '/uploads'],
    ['PATCH', '/uploads/1/pages/order'],
    ['DELETE', '/uploads/1'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const res =
      method === 'GET'
        ? await request(t.app).get(p)
        : method === 'DELETE'
          ? await request(t.app).delete(p)
          : method === 'PATCH'
            ? await request(t.app).patch(p).send({ page_ids: [1] })
            : await request(t.app).post(p);
    expect(res.status).toBe(401);
  });
});

describe('POST /uploads — zip-of-images upload (async: 202 → runner tick → ready)', () => {
  it('enqueues a real multi-image zip as 202 pending (no pages yet), then the runner orders pages by NATURAL filename sort and writes every page blob to disk', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Deliberately out of append order (mirrors a vFlat retake landing out of
    // sequence) AND non-zero-padded (010 before 002 lexically) to prove
    // natural sort, not append order or plain lexical sort, seeds page_number.
    const pageA = markedPng('A'); // should end up page 1 ("001.png")
    const pageB = markedPng('B'); // should end up page 2 ("002.png")
    const pageC = markedPng('C'); // should end up page 3 ("010.png")
    const zip = buildStoredZip([
      { name: '010.png', data: pageC },
      { name: '001.png', data: pageA },
      { name: '002.png', data: pageB },
    ]);

    const res = await agent
      .post('/uploads')
      .field('title', 'Vocab 2000 Advanced')
      .field('type', 'vocab')
      .attach('file', zip, { filename: 'book.zip', contentType: 'application/zip' });

    expect(res.status).toBe(202);
    const enqueued = res.body.upload;
    expect(enqueued.title).toBe('Vocab 2000 Advanced');
    expect(enqueued.status).toBe('pending');
    expect(enqueued.page_count).toBeNull();
    expect(enqueued.error).toBeNull();
    expect(enqueued.byte_size).toBe(zip.length);

    // No decode has happened yet — the response IS immediate.
    expect(await bookPageRows(enqueued.id)).toEqual([]);

    await expect(tick()).resolves.toBe('done');

    const settled = await fetchUpload(agent, enqueued.id);
    expect(settled.status).toBe('ready');
    expect(settled.page_count).toBe(3);
    expect(settled.error).toBeNull();

    const pages = await bookPageRows(enqueued.id);
    expect(pages.length).toBe(3);
    expect(pages.map((p) => p.page_number)).toEqual([1, 2, 3]);

    const onDiskA = await readFile(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[0]!.blob_ref));
    const onDiskB = await readFile(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[1]!.blob_ref));
    const onDiskC = await readFile(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[2]!.blob_ref));
    expect(Buffer.compare(onDiskA, pageA)).toBe(0);
    expect(Buffer.compare(onDiskB, pageB)).toBe(0);
    expect(Buffer.compare(onDiskC, pageC)).toBe(0);

    // Blob filenames are server UUIDs under the user's own subdirectory.
    for (const p of pages) {
      expect(p.blob_ref).toMatch(new RegExp(`^${userId}/[0-9a-f-]{36}\\.png$`));
    }
  });

  it('ignores non-image entries and still settles ready with only the real pages counted', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const zip = buildStoredZip([
      { name: 'metadata.json', data: Buffer.from('{"title":"x"}') },
      { name: '001.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
    ]);
    const res = await agent
      .post('/uploads')
      .field('title', 'With Metadata File')
      .field('type', 'grammar')
      .attach('file', zip, { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(202);
    expect(res.body.upload.status).toBe('pending');

    await expect(tick()).resolves.toBe('done');
    const settled = await fetchUpload(agent, res.body.upload.id);
    expect(settled.status).toBe('ready');
    expect(settled.page_count).toBe(2);
  });

  it('a zip with zero usable image pages enqueues fine (202) but the runner settles it FAILED — the row survives with a bounded error, no book_pages', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const zip = buildStoredZip([{ name: 'readme.txt', data: Buffer.from('no images') }]);
    const res = await agent
      .post('/uploads')
      .field('title', 'Empty Book')
      .field('type', 'vocab')
      .attach('file', zip, { filename: 'book.zip', contentType: 'application/zip' });
    // 202, not 400 — the decode (and therefore this validation) happens
    // async, in the runner, not in the request.
    expect(res.status).toBe(202);
    expect(res.body.upload.status).toBe('pending');

    await expect(tick()).resolves.toBe('failed');

    const settled = await fetchUpload(agent, res.body.upload.id);
    expect(settled.status).toBe('failed');
    expect(settled.page_count).toBeNull();
    expect(settled.error).toBeTruthy();
    expect(await bookPageRows(res.body.upload.id)).toEqual([]);

    // The row itself is NOT rolled back — unlike the old synchronous 400,
    // the enqueue already committed before the runner ever saw the file.
    const rows = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM book_uploads`);
    expect(rows.rows[0]?.n).toBe('1');
  });

  it('a zip that lies about an entry size past the zip-bomb guard enqueues fine (202) but the runner settles it FAILED', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const zip = buildStoredZip([
      { name: '001.png', data: TINY_PNG, declaredUncompressedSize: 200 * 1024 * 1024 },
    ]);
    const res = await agent
      .post('/uploads')
      .field('title', 'Bomb Book')
      .field('type', 'vocab')
      .attach('file', zip, { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(202);

    await expect(tick()).resolves.toBe('failed');

    const settled = await fetchUpload(agent, res.body.upload.id);
    expect(settled.status).toBe('failed');
    expect(settled.error).toContain('possible zip bomb');
    expect(await bookPageRows(res.body.upload.id)).toEqual([]);
  });
});

describe('POST /uploads — PDF upload (async: mocked streamPdfPagesToJpegFromFile)', () => {
  it('enqueues a PDF as 202 pending, then the runner renders pages via the streaming decoder and persists them in order', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const jpegPage1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    const jpegPage2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2]);
    // Capture the raw file's bytes INSIDE the mock (called mid-decode, before
    // the runner's post-settle cleanup) — a successful settle deletes the raw
    // file (deleteRawFileBestEffort) before this tick() call even returns, so
    // reading it back afterward would race a file that's already gone.
    let capturedRawBytes: Buffer | null = null;
    vi.mocked(streamPdfPagesToJpegFromFile).mockImplementation(async function* (rawPath: string) {
      capturedRawBytes = await readFile(rawPath);
      yield jpegPage1;
      yield jpegPage2;
    });

    const res = await agent
      .post('/uploads')
      .field('title', 'KGIU Scan')
      .field('type', 'grammar')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(202);
    expect(res.body.upload.status).toBe('pending');
    // The decoder hasn't been asked for anything yet — it only runs on tick.
    expect(vi.mocked(streamPdfPagesToJpegFromFile)).not.toHaveBeenCalled();

    await expect(tick()).resolves.toBe('done');

    // Called once, with the RAW FILE'S PATH on disk (Phase 2.5's streaming-
    // from-file contract — never a Buffer of the PDF). Verify it's really
    // the raw file multer wrote, by the exact bytes read off disk mid-decode.
    expect(vi.mocked(streamPdfPagesToJpegFromFile)).toHaveBeenCalledTimes(1);
    const [calledPath] = vi.mocked(streamPdfPagesToJpegFromFile).mock.calls[0]!;
    expect(typeof calledPath).toBe('string');
    expect(capturedRawBytes).toEqual(TINY_PDF);

    const settled = await fetchUpload(agent, res.body.upload.id);
    expect(settled.status).toBe('ready');
    expect(settled.page_count).toBe(2);

    const pages = await bookPageRows(res.body.upload.id);
    expect(pages.length).toBe(2);
    const onDisk1 = await readFile(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[0]!.blob_ref));
    const onDisk2 = await readFile(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[1]!.blob_ref));
    expect(Buffer.compare(onDisk1, jpegPage1)).toBe(0);
    expect(Buffer.compare(onDisk2, jpegPage2)).toBe(0);
    // PDF pages are always stored as .jpg (streamPdfPagesToJpegFromFile's contract).
    expect(pages[0]!.blob_ref.endsWith('.jpg')).toBe(true);
  });

  it('a PDF that renders to zero pages enqueues fine (202) but the runner settles it FAILED', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    vi.mocked(streamPdfPagesToJpegFromFile).mockImplementation(async function* () {
      // yields nothing
    });
    const res = await agent
      .post('/uploads')
      .field('title', 'Blank PDF')
      .field('type', 'vocab')
      .attach('file', TINY_PDF, { filename: 'book.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(202);

    await expect(tick()).resolves.toBe('failed');

    const settled = await fetchUpload(agent, res.body.upload.id);
    expect(settled.status).toBe('failed');
    expect(settled.error).toContain('PDF contains no pages');
    expect(await bookPageRows(res.body.upload.id)).toEqual([]);
  });
});

describe('POST /uploads — shared validation (zip/pdf-agnostic, all still SYNCHRONOUS 4xx/413 — before any book_uploads row is written)', () => {
  it('rejects a file whose bytes are neither a zip nor a PDF, despite an allowed declared mime (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const notAZipOrPdf = Buffer.from('just some plain bytes, not an archive', 'utf8');
    const res = await agent
      .post('/uploads')
      .field('title', 'Fake Book')
      .field('type', 'vocab')
      .attach('file', notAZipOrPdf, { filename: 'evil.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
    const rows = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM book_uploads`);
    expect(rows.rows[0]?.n).toBe('0');
  });

  it('rejects a disallowed declared mime (text/plain) at the fileFilter (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Not Zip Or PDF')
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
    const oversize = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0);
    const res = await agent
      .post('/uploads')
      .field('title', 'Huge Book')
      .field('type', 'vocab')
      .attach('file', oversize, { filename: 'huge.zip', contentType: 'application/zip' });

    expect(res.status).toBe(413);
    expect(res.body?.error?.code).toBe('payload_too_large');
    const rows = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM book_uploads`);
    expect(rows.rows[0]?.n).toBe('0');
  }, 30_000);

  it('rejects a blank title (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', '   ')
      .field('type', 'vocab')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
  });

  it('a blank-title (validation-stage) rejection leaves NO orphan raw file on disk (Bug 2 fix)', async () => {
    // BUG 2 (Phase 2.5 diskStorage regression, fixed): multer's diskStorage
    // writes the raw file to disk BEFORE body validation ever runs.
    // Previously, `validateBody(UploadBodySchema)` called `next(err)`
    // directly on a Zod failure — skipping the handler's own try/catch
    // (which unlinks `file.path` on every other post-multer failure)
    // entirely, so a blank title (or any other schema rejection) leaked the
    // just-written raw file with NO book_uploads row for jobRetention.ts to
    // ever reach. The fix moved the UploadBodySchema parse INLINE into the
    // handler's own try block (routes/uploads.ts), so this failure now hits
    // the exact same cleanup path as bad magic bytes / the daily cap / a 409.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', '   ')
      .field('type', 'vocab')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
    expect(await listRawUploadFiles(userId)).toEqual([]);
    const rows = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM book_uploads`);
    expect(rows.rows[0]?.n).toBe('0');
  });

  it('a `.strict()` mass-assignment rejection ALSO leaves NO orphan raw file on disk (Bug 2 fix)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Some Book')
      .field('type', 'vocab')
      .field('status', 'ready') // not a writable field — .strict() rejects
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
    expect(await listRawUploadFiles(userId)).toEqual([]);
  });

  it('rejects a missing title field (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('type', 'vocab')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing type field (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Some Book')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid type enum value (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Some Book')
      .field('type', 'not_a_real_type')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown extra body field (mass-assignment defense, 400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', 'Some Book')
      .field('type', 'vocab')
      .field('status', 'ready') // not a writable field
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
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
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(429);
  });

  it('does NOT count a same-title replace against the daily cap (still 202, reset to pending)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    for (let i = 0; i < 10; i += 1) {
      await seedBookUpload(pg.pool, userId, { title: `cap-book-${i}` });
    }
    // Re-uploading an EXISTING (terminal) title at the cap must still
    // succeed (replace, not a new title) — the async contract's success
    // status is ALWAYS 202 (enqueue), never a synchronous 200/201.
    const res = await agent
      .post('/uploads')
      .field('title', 'cap-book-0')
      .field('type', 'vocab')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(202);
    expect(res.body.upload.status).toBe('pending');
  });
});

describe('POST /uploads — conflict vs idempotent replace (Phase 2.5 async contract)', () => {
  it('a second POST for the SAME (user, title) while the first is still PENDING → 409, no second row, the first row untouched', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const firstZip = buildStoredZip([{ name: '001.png', data: TINY_PNG }]);
    const first = await agent
      .post('/uploads')
      .field('title', 'My Book')
      .field('type', 'vocab')
      .attach('file', firstZip, { filename: 'v1.zip', contentType: 'application/zip' });
    expect(first.status).toBe(202);
    expect(first.body.upload.status).toBe('pending');

    // Deliberately do NOT tick — the row is still 'pending' when the second
    // POST arrives. This is exactly the race the 409 exists to prevent: a
    // second upload clobbering raw_blob_ref out from under a row the runner
    // might already be mid-decode of (routes/uploads.ts's ATOMICITY note).
    const secondZip = buildStoredZip([
      { name: '001.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
    ]);
    const second = await agent
      .post('/uploads')
      .field('title', 'My Book')
      .field('type', 'grammar')
      .attach('file', secondZip, { filename: 'v2.zip', contentType: 'application/zip' });
    expect(second.status).toBe(409);

    const countRows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_uploads WHERE user_id = $1 AND title = 'My Book'`,
      [userId],
    );
    expect(countRows.rows[0]?.n).toBe('1');

    const row = (
      await pg.pool.query<{ type: string; status: string }>(
        `SELECT type::text AS type, status::text AS status FROM book_uploads WHERE id = $1`,
        [first.body.upload.id],
      )
    ).rows[0]!;
    expect(row.type).toBe('vocab'); // untouched by the rejected second request
    expect(row.status).toBe('pending');
  });

  it('a second POST for the SAME (user, title) while the existing row is PROCESSING → 409 too', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Simulate the runner having already claimed the row (status flipped to
    // 'processing') — a real mid-decode state a tick call in this
    // single-threaded test suite can't otherwise pause at.
    await seedBookUpload(pg.pool, userId, {
      title: 'Mid Decode',
      status: 'processing',
      rawBlobRef: 'raw/x/does-not-matter.raw',
    });

    const res = await agent
      .post('/uploads')
      .field('title', 'Mid Decode')
      .field('type', 'vocab')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(409);
  });

  it("re-uploading the SAME (user, title) after the first settles READY replaces it: 202 pending (same row, reset), the runner decodes the NEW pages after clearing the old book_pages rows", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const firstZip = buildStoredZip([
      { name: '001.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
    ]);
    const first = await agent
      .post('/uploads')
      .field('title', 'My Book')
      .field('type', 'vocab')
      .attach('file', firstZip, { filename: 'v1.zip', contentType: 'application/zip' });
    expect(first.status).toBe(202);
    await expect(tick()).resolves.toBe('done');
    const firstReady = await fetchUpload(agent, first.body.upload.id);
    expect(firstReady.status).toBe('ready');

    const firstPages = await bookPageRows(first.body.upload.id);
    expect(firstPages.length).toBe(2);
    const firstBlobPaths = firstPages.map((p) =>
      path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, p.blob_ref),
    );
    for (const p of firstBlobPaths) {
      await expect(readFile(p)).resolves.toBeInstanceOf(Buffer);
    }

    const secondZip = buildStoredZip([
      { name: '001.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
      { name: '003.png', data: TINY_PNG },
    ]);
    const second = await agent
      .post('/uploads')
      .field('title', 'My Book') // same title
      .field('type', 'grammar') // type may change too
      .attach('file', secondZip, { filename: 'v2.zip', contentType: 'application/zip' });

    // 202 (enqueue), never 200/201 — the async contract has exactly ONE
    // success status regardless of new-insert vs terminal-row reset.
    expect(second.status).toBe(202);
    expect(second.body.upload.id).toBe(first.body.upload.id); // same row
    expect(second.body.upload.status).toBe('pending'); // reset back to pending
    expect(second.body.upload.type).toBe('grammar');
    expect(second.body.upload.page_count).toBeNull(); // cleared on reset
    expect(second.body.upload.error).toBeNull();

    const rows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_uploads WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows[0]?.n).toBe('1'); // still exactly one row

    // Deliberate UX behavior (bookIngestRunner.ts's documented idempotency
    // trade-off): the enqueue-time reset does NOT clear book_pages — the
    // OLD book stays viewable while the replacement is queued. Only the
    // runner's idempotency step (immediately before the fresh decode) wipes
    // the old page rows.
    expect((await bookPageRows(second.body.upload.id)).length).toBe(2);

    await expect(tick()).resolves.toBe('done');
    const secondReady = await fetchUpload(agent, second.body.upload.id);
    expect(secondReady.status).toBe('ready');
    expect(secondReady.page_count).toBe(3);

    const secondPages = await bookPageRows(second.body.upload.id);
    expect(secondPages.length).toBe(3);
    expect(secondPages.map((p) => p.blob_ref)).not.toEqual(
      expect.arrayContaining(firstPages.map((p) => p.blob_ref)),
    );

    // FIX VERIFIED (src/services/bookIngestRunner.ts's `clearPagesAndBlobs`,
    // shared by the idempotency-wipe, stale-reap, and settle-race-clear
    // sites): the runner's idempotency step no longer just deletes the OLD
    // book_pages ROWS — it captures each row's blob_ref via `DELETE ...
    // RETURNING blob_ref` and best-effort unlinks every one of those FILES
    // too, mirroring routes/uploads.ts's DELETE handler. A same-title
    // replace no longer orphans the prior version's page-image files.
    for (const p of firstBlobPaths) {
      await expect(readFile(p)).rejects.toThrow(); // no longer orphaned — unlinked by the fresh decode's idempotency clear
    }
  });
});

describe("POST /uploads — 'comic' type (Track P, picture/comic/manga)", () => {
  it("BOOK_UPLOAD_TYPES carries 'comic' (the tuple UploadBodySchema's z.enum is built from)", () => {
    // The Zod enum in routes/uploads.ts is `z.enum(BOOK_UPLOAD_TYPES)` — the
    // tuple IS the validation surface, mirrored to the DB enum (migration
    // 072). If 'comic' ever falls out of it, the route 400s every comic
    // upload while the DB happily accepts the value — assert at the source.
    expect(BOOK_UPLOAD_TYPES).toContain('comic');
  });

  it("accepts type 'comic' end-to-end: 202 pending → runner settles ready, the row persists type='comic', pages land as images", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/uploads')
      .field('title', '만화책')
      .field('type', 'comic')
      .attach('file', minimalZip(), { filename: 'manhwa.zip', contentType: 'application/zip' });

    expect(res.status).toBe(202);
    expect(res.body.upload.type).toBe('comic');
    expect(res.body.upload.status).toBe('pending');

    await expect(tick()).resolves.toBe('done');
    const settled = await fetchUpload(agent, res.body.upload.id);
    expect(settled.status).toBe('ready');
    expect(settled.page_count).toBe(1);

    // The DB enum (072) actually stores the value — not just the DTO echo.
    const { rows } = await pg.pool.query<{ type: string }>(
      'SELECT type::text AS type FROM book_uploads WHERE id = $1',
      [res.body.upload.id],
    );
    expect(rows[0]!.type).toBe('comic');
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
  it('returns the upload metadata, including page_count and error', async () => {
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
    expect(res.body.upload.error).toBeNull();
  });

  it('returns a pending/failed upload with its error surfaced (Phase 2.5)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const failedId = await seedBookUpload(pg.pool, userId, {
      title: 'Broke Book',
      status: 'failed',
      error: 'zip archive contained no usable image pages (jpg/png)',
    });

    const res = await agent.get(`/uploads/${failedId}`);
    expect(res.status).toBe(200);
    expect(res.body.upload.status).toBe('failed');
    expect(res.body.upload.page_count).toBeNull();
    expect(res.body.upload.error).toBe('zip archive contained no usable image pages (jpg/png)');
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

describe('GET /uploads/:id/page/:n — streams a page image, user-scoped', () => {
  /** Upload a real 3-page zip via the route, then drive it to 'ready' with
   *  one runner tick — the async equivalent of the old synchronous helper. */
  async function uploadThreePages(agent: ReturnType<typeof request.agent>, title = 'Paged Book') {
    const zip = buildStoredZip([
      { name: '001.png', data: markedPng('one') },
      { name: '002.png', data: markedPng('two') },
      { name: '003.png', data: markedPng('three') },
    ]);
    const res = await agent
      .post('/uploads')
      .field('title', title)
      .field('type', 'vocab')
      .attach('file', zip, { filename: 'book.zip', contentType: 'application/zip' });
    expect(res.status).toBe(202);
    await expect(tick()).resolves.toBe('done');
    return res.body.upload.id as string;
  }

  it('streams page 1 with the right bytes and headers', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadThreePages(agent);

    const res = await getBinary(agent, `/uploads/${id}/page/1`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('private');
    expect(Buffer.compare(res.body as Buffer, markedPng('one'))).toBe(0);
  });

  it('streams page 3 with the right (different) bytes', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadThreePages(agent);

    const res = await getBinary(agent, `/uploads/${id}/page/3`);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, markedPng('three'))).toBe(0);
  });

  it('returns 404 for a page number past the end of the book', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadThreePages(agent);
    const res = await getBinary(agent, `/uploads/${id}/page/4`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-positive/non-integer page number', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const id = await uploadThreePages(agent);
    const zero = await getBinary(agent, `/uploads/${id}/page/0`);
    expect(zero.status).toBe(400);
    const nonNumeric = await getBinary(agent, `/uploads/${id}/page/abc`);
    expect(nonNumeric.status).toBe(400);
  });

  it("returns 404 for another user's upload (IDOR)", async () => {
    const other = await registerUser(t.app, pg.pool);
    const id = await uploadThreePages(other.agent, 'Other Book');
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await getBinary(agent, `/uploads/${id}/page/1`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the row exists but the blob file is missing', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 1 });
    await seedBookPage(pg.pool, uploadId, 1); // no real blob written on disk
    const res = await getBinary(agent, `/uploads/${uploadId}/page/1`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a page on a still-'pending' upload (nothing decoded yet)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'pending', pageCount: null });
    const res = await getBinary(agent, `/uploads/${uploadId}/page/1`);
    expect(res.status).toBe(404);
  });
});

describe('GET /uploads/:id/pages — ordered page-id list, user-scoped', () => {
  it('returns every page in page_number order with its stable id', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 3 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);
    const p3 = await seedBookPage(pg.pool, uploadId, 3);

    const res = await agent.get(`/uploads/${uploadId}/pages`);
    expect(res.status).toBe(200);
    expect(res.body.pages).toEqual([
      { id: String(p1), page_number: 1 },
      { id: String(p2), page_number: 2 },
      { id: String(p3), page_number: 3 },
    ]);
  });

  it('returns pages in page_number order even when inserted out of order', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 3 });
    // Insert in reverse page_number order — the route must sort by
    // page_number, not by insertion/id order.
    const p3 = await seedBookPage(pg.pool, uploadId, 3);
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);

    const res = await agent.get(`/uploads/${uploadId}/pages`);
    expect(res.status).toBe(200);
    expect(res.body.pages.map((p: { id: string }) => p.id)).toEqual([
      String(p1),
      String(p2),
      String(p3),
    ]);
    expect(res.body.pages.map((p: { page_number: number }) => p.page_number)).toEqual([1, 2, 3]);
  });

  it('returns an empty list for an owned upload with no pages yet (still pending/processing)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'processing', pageCount: null });

    const res = await agent.get(`/uploads/${uploadId}/pages`);
    expect(res.status).toBe(200);
    expect(res.body.pages).toEqual([]);
  });

  it("returns 404 for another user's upload (IDOR)", async () => {
    const other = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, other.userId, { status: 'ready', pageCount: 2 });
    await seedBookPage(pg.pool, uploadId, 1);
    await seedBookPage(pg.pool, uploadId, 2);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(`/uploads/${uploadId}/pages`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a nonexistent id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/uploads/999999/pages');
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/uploads/abc/pages');
    expect(res.status).toBe(400);
  });

  it('round-trips into PATCH :id/pages/order: the ids GET /pages returns are exactly the ids the reorder PATCH accepts', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 3 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);
    const p3 = await seedBookPage(pg.pool, uploadId, 3);

    const listRes = await agent.get(`/uploads/${uploadId}/pages`);
    expect(listRes.status).toBe(200);
    const fetchedIds = listRes.body.pages.map((p: { id: string }) => Number(p.id));
    expect(new Set(fetchedIds)).toEqual(new Set([p1, p2, p3]));

    // Submit the fetched ids back in a new order (reverse) — this is exactly
    // the reorder tool's flow: load ids via listPages, then submit a full
    // permutation of that SAME set via reorderPages.
    const reversed = [...fetchedIds].reverse();
    const patchRes = await agent
      .patch(`/uploads/${uploadId}/pages/order`)
      .send({ page_ids: reversed });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.pages).toEqual([
      { id: String(reversed[0]), page_number: 1 },
      { id: String(reversed[1]), page_number: 2 },
      { id: String(reversed[2]), page_number: 3 },
    ]);
  });
});

describe('PATCH /uploads/:id/pages/order — reorder, user-scoped, transactional', () => {
  it('re-sequences page_number to match the submitted order', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 3 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);
    const p3 = await seedBookPage(pg.pool, uploadId, 3);

    // New order: p3, p1, p2 (a vFlat-retake-style correction).
    const res = await agent.patch(`/uploads/${uploadId}/pages/order`).send({
      page_ids: [p3, p1, p2],
    });
    expect(res.status).toBe(200);
    expect(res.body.pages).toEqual([
      { id: String(p3), page_number: 1 },
      { id: String(p1), page_number: 2 },
      { id: String(p2), page_number: 3 },
    ]);

    const rows = await pg.pool.query<{ id: string; page_number: number }>(
      `SELECT id, page_number FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
      [uploadId],
    );
    expect(rows.rows.map((r) => Number(r.id))).toEqual([p3, p1, p2]);
    expect(rows.rows.map((r) => r.page_number)).toEqual([1, 2, 3]);
  });

  it("returns 404 for another user's upload (IDOR) and does not touch its pages", async () => {
    const other = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, other.userId, { status: 'ready', pageCount: 2 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.patch(`/uploads/${uploadId}/pages/order`).send({ page_ids: [p2, p1] });
    expect(res.status).toBe(404);

    const rows = await pg.pool.query<{ id: string; page_number: number }>(
      `SELECT id, page_number FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
      [uploadId],
    );
    expect(rows.rows.map((r) => Number(r.id))).toEqual([p1, p2]); // untouched
  });

  it('rejects a page_ids set that omits an existing page (400)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 2 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    await seedBookPage(pg.pool, uploadId, 2);

    const res = await agent.patch(`/uploads/${uploadId}/pages/order`).send({ page_ids: [p1] });
    expect(res.status).toBe(400);
  });

  it('rejects a page_ids array containing a foreign page id (400)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 2 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);

    const otherUploadId = await seedBookUpload(pg.pool, userId, { title: 'other', status: 'ready', pageCount: 1 });
    const foreignPageId = await seedBookPage(pg.pool, otherUploadId, 1);

    const res = await agent
      .patch(`/uploads/${uploadId}/pages/order`)
      .send({ page_ids: [p1, foreignPageId] }); // wrong length AND foreign id
    expect(res.status).toBe(400);

    const rows = await pg.pool.query<{ page_number: number }>(
      `SELECT page_number FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
      [uploadId],
    );
    expect(rows.rows.map((r) => r.page_number)).toEqual([1, 2]); // untouched
    void p2;
  });

  it('rejects duplicate ids in page_ids (400)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 2 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    await seedBookPage(pg.pool, uploadId, 2);

    const res = await agent.patch(`/uploads/${uploadId}/pages/order`).send({ page_ids: [p1, p1] });
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric upload id (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.patch('/uploads/abc/pages/order').send({ page_ids: [1] });
    expect(res.status).toBe(400);
  });
});

// A-S2 regression: the reorder handler's correctness rests on `SELECT ...
// FOR UPDATE` locking `book_uploads` then `book_pages` (routes/uploads.ts) to
// serialize concurrent mutation of the same upload's page order — but until
// now nothing actually FIRED two overlapping requests at it; the guarantee
// was argued from reading the code, not demonstrated. These tests fire real
// concurrent `Promise.all` requests (mirrors the racing-recovery-code /
// racing-mfa-confirm pattern in tests/routes/auth.mfa.test.ts) and assert
// the DB-visible invariant the locks exist to protect — not a specific
// "winner" (which request wins the race is legitimately non-deterministic;
// pinning it would make the test flaky, exactly what auth.mfa.test.ts's own
// comments warn against).
describe('PATCH /uploads/:id/pages/order — concurrency (SELECT ... FOR UPDATE serialization)', () => {
  it('two concurrent PATCHes on the same upload both succeed and the final order is EXACTLY one of the two submissions, never an interleaved mix', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 3 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);
    const p3 = await seedBookPage(pg.pool, uploadId, 3);

    // Both submissions carry the SAME id set (only order differs), so both
    // pass the exact-set check regardless of which acquires the lock first
    // — the lock only serializes them, it doesn't reject a "loser" the way
    // the unique-flip races in auth.mfa.test.ts do.
    const orderA = [p1, p2, p3]; // identity order
    const orderB = [p3, p2, p1]; // full reverse — maximally different from A

    // Same agent (session cookie) fires both — a supertest agent doesn't
    // serialize its own concurrent requests, it just attaches the same
    // stored cookie to each independent HTTP request, so `Promise.all` here
    // genuinely races two in-flight PATCHes against the SAME upload.
    const [resA, resB] = await Promise.all([
      agent.patch(`/uploads/${uploadId}/pages/order`).send({ page_ids: orderA }),
      agent.patch(`/uploads/${uploadId}/pages/order`).send({ page_ids: orderB }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const rows = await pg.pool.query<{ id: string; page_number: number }>(
      `SELECT id, page_number FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
      [uploadId],
    );
    const finalOrder = rows.rows.map((r) => Number(r.id));
    const matchesA = orderA.every((id, i) => id === finalOrder[i]);
    const matchesB = orderB.every((id, i) => id === finalOrder[i]);
    // Sanity: A and B are genuinely different orderings of the same 3 ids —
    // otherwise "matches exactly one" would be a vacuous assertion.
    expect(orderA).not.toEqual(orderB);
    // The two-phase placeholder renumber + the lock together must produce
    // EXACTLY one submitter's full order — never a row-by-row interleave of
    // both (which an unlocked or partially-locked implementation could
    // produce if the second UPDATE's placeholder phase overlapped the
    // first's final-assignment phase).
    expect(matchesA || matchesB).toBe(true);

    // Constraint invariants hold post-race regardless of which order won.
    expect(new Set(rows.rows.map((r) => r.page_number))).toEqual(new Set([1, 2, 3]));
    expect(rows.rows.every((r) => r.page_number > 0)).toBe(true);
  });

  it('a PATCH racing a DELETE on the same upload never 500s: the PATCH either commits before the delete or 404s after it, and the delete always wins the eventual outcome', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { status: 'ready', pageCount: 3 });
    const p1 = await seedBookPage(pg.pool, uploadId, 1);
    const p2 = await seedBookPage(pg.pool, uploadId, 2);
    const p3 = await seedBookPage(pg.pool, uploadId, 3);

    const [patchRes, deleteRes] = await Promise.all([
      agent.patch(`/uploads/${uploadId}/pages/order`).send({ page_ids: [p3, p1, p2] }),
      agent.delete(`/uploads/${uploadId}`),
    ]);

    // DELETE has no precondition on upload content, so whichever order the
    // two transactions actually interleaved in, DELETE finds a row to
    // remove (either the pre-reorder or the just-reordered one) — it always
    // succeeds. The PATCH's own `book_uploads ... FOR UPDATE` either runs
    // BEFORE the delete commits (200, reorder applied, then the row is
    // deleted out from under it) or AFTER (404 — the lock-ordering
    // discipline, `book_uploads` before `book_pages` in BOTH handlers, is
    // exactly what rules out the alternative: a deadlock surfacing as 500).
    expect(deleteRes.status).toBe(204);
    expect([200, 404]).toContain(patchRes.status);

    const uploadRows = await pg.pool.query(`SELECT id FROM book_uploads WHERE id = $1`, [uploadId]);
    expect(uploadRows.rows).toHaveLength(0);
    const pageRows = await pg.pool.query(`SELECT id FROM book_pages WHERE upload_id = $1`, [uploadId]);
    expect(pageRows.rows).toHaveLength(0); // CASCADE — no orphaned pages regardless of the race outcome.
  });
});

describe('DELETE /uploads/:id — removes row + every page blob (cascade)', () => {
  it('deletes the row, all book_pages rows, and every on-disk page blob', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const zip = buildStoredZip([
      { name: '001.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
    ]);
    const uploadRes = await agent
      .post('/uploads')
      .field('title', 'To Delete')
      .field('type', 'vocab')
      .attach('file', zip, { filename: 'book.zip', contentType: 'application/zip' });
    expect(uploadRes.status).toBe(202);
    await expect(tick()).resolves.toBe('done');

    const id = uploadRes.body.upload.id as string;
    const pages = await bookPageRows(id);
    const blobPaths = pages.map((p) => path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, p.blob_ref));
    for (const p of blobPaths) {
      await expect(readFile(p)).resolves.toBeInstanceOf(Buffer);
    }

    const res = await agent.delete(`/uploads/${id}`);
    expect(res.status).toBe(204);

    const uploadRows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_uploads WHERE user_id = $1`,
      [userId],
    );
    expect(uploadRows.rows[0]?.n).toBe('0');

    const pageRows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_pages WHERE upload_id = $1`,
      [id],
    );
    expect(pageRows.rows[0]?.n).toBe('0');

    for (const p of blobPaths) {
      await expect(readFile(p)).rejects.toThrow();
    }
  });

  it('deletes a still-PENDING upload cleanly too (nothing decoded yet, no book_pages to cascade)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, userId, {
      status: 'pending',
      rawBlobRef: 'raw/does/not-matter.raw',
    });

    const res = await agent.delete(`/uploads/${id}`);
    expect(res.status).toBe(204);

    const uploadRows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM book_uploads WHERE id = $1`,
      [id],
    );
    expect(uploadRows.rows[0]?.n).toBe('0');
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

// ---------------------------------------------------------------------------
// F-207 phase 3a — shared curated books: the access-control threat-model
// tests (mirrors audio.test.ts's F-207 phase-1 block; plan §5). The contract:
// shared = READABLE (meta + page bytes) by every account, MUTABLE by no one
// but the owner; a PRIVATE book of another user stays a uniform 404 on every
// surface (no existence oracle); the owner's shared book leaves their own
// "Books" list (decision #2). is_shared is OPERATOR-SET ONLY — no route
// writes it — so tests flip it exactly the way the phase-2 cutover script
// does: a keyed UPDATE on the row.
// ---------------------------------------------------------------------------

/** Flip one book into the shared curated corpus (the cutover script's shape). */
async function shareBook(uploadId: number | string): Promise<void> {
  await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [uploadId]);
}

/** Upload a real 2-page book as `agent` (route path — writes real page blobs,
 *  so the page-stream tests exercise the full chain), then drive it to
 *  'ready' with one runner tick (Phase 2.5's async contract). */
async function uploadTwoPageBook(agent: ReturnType<typeof request.agent>, title: string) {
  const zip = buildStoredZip([
    { name: '001.png', data: markedPng('shared-one') },
    { name: '002.png', data: markedPng('shared-two') },
  ]);
  const res = await agent
    .post('/uploads')
    .field('title', title)
    .field('type', 'literature')
    .attach('file', zip, { filename: 'book.zip', contentType: 'application/zip' });
  expect(res.status).toBe(202);
  await expect(tick()).resolves.toBe('done');
  return res.body.upload.id as string;
}

describe('F-207 phase 3a — cross-account READ of a shared book (meta + pages)', () => {
  it("a NON-owner reads a shared book's metadata: 200, exact DTO, and NO owner identity in the response", async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, a.userId, {
      title: 'Shared Folktales',
      type: 'literature',
      status: 'ready',
      pageCount: 2,
    });
    await shareBook(id);

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get(`/uploads/${id}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.upload.id)).toBe(id);
    expect(res.body.upload.title).toBe('Shared Folktales');
    expect(res.body.upload.type).toBe('literature');
    // No-owner-PII contract: the DTO is served cross-account, so it must
    // carry NOTHING that says whose row this is — assert the exact key set,
    // not just the absence of the two known-dangerous fields. (Phase 2.5:
    // `error` joined the DTO alongside every other surface — still no
    // user_id/email/raw_blob_ref.)
    expect(Object.keys(res.body.upload).sort()).toEqual([
      'byte_size',
      'created_at',
      'error',
      'id',
      'page_count',
      'status',
      'title',
      'type',
    ]);
  });

  it("a NON-owner streams a shared book's page bytes: 200 + the exact bytes + nosniff", async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await uploadTwoPageBook(a.agent, 'Shared Paged Book');
    await shareBook(id);

    const b = await registerUser(t.app, pg.pool);
    const res = await getBinary(b.agent, `/uploads/${id}/page/1`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, markedPng('shared-one'))).toBe(0);
  });

  it("a NON-owner's probe of a PRIVATE book stays a uniform 404 on meta AND pages (no existence oracle)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const privateId = await uploadTwoPageBook(a.agent, 'Private Book');
    // NOT shared — is_shared stays the migration-079 default (false).

    const b = await registerUser(t.app, pg.pool);
    // Byte-identical error payload to a genuinely-missing id on BOTH read
    // routes — nothing distinguishes "exists but private" from "does not
    // exist" (mirrors audio.test.ts's phase-1 body-equality pin).
    const ghostMeta = await b.agent.get('/uploads/99999999');
    const privMeta = await b.agent.get(`/uploads/${privateId}`);
    expect(ghostMeta.status).toBe(404);
    expect(privMeta.status).toBe(404);
    expect(ghostMeta.body.error).toMatchObject({ code: 'not_found' }); // non-vacuous
    expect(privMeta.body.error).toEqual(ghostMeta.body.error);

    // The page route 404s as JSON too (only its 200 is binary), so the same
    // body-equality pin applies.
    const ghostPage = await b.agent.get('/uploads/99999999/page/1');
    const privPage = await b.agent.get(`/uploads/${privateId}/page/1`);
    expect(ghostPage.status).toBe(404);
    expect(privPage.status).toBe(404);
    expect(ghostPage.body.error).toMatchObject({ code: 'not_found' }); // non-vacuous
    expect(privPage.body.error).toEqual(ghostPage.body.error);
  });

  it('the OWNER still reads their own shared book (meta + page 200) — sharing never locks the owner out of reads', async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await uploadTwoPageBook(a.agent, 'Owner Shared Book');
    await shareBook(id);

    expect((await a.agent.get(`/uploads/${id}`)).status).toBe(200);
    const page = await getBinary(a.agent, `/uploads/${id}/page/2`);
    expect(page.status).toBe(200);
    expect(Buffer.compare(page.body as Buffer, markedPng('shared-two'))).toBe(0);
  });
});

describe('F-207 — GET /uploads lists the owner OWN books (shared or not); a non-owner still sees only their own', () => {
  it("the owner sees BOTH their shared and private books in their own GET /uploads (sharing must not hide an owner's own library)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const privateId = await seedBookUpload(pg.pool, a.userId, { title: 'My Private Book' });
    const sharedId = await seedBookUpload(pg.pool, a.userId, { title: 'My Curated Book' });
    await shareBook(sharedId);

    const res = await a.agent.get('/uploads');
    expect(res.status).toBe(200);
    const ids = res.body.uploads.map((u: { id: string }) => Number(u.id));
    // Both listed — sharing is a read-access flag for OTHER accounts, it must
    // never remove the owner's own book from their Reading page. Newest-first
    // (created_at DESC, id DESC) → the later-seeded shared book leads.
    expect(ids).toEqual([sharedId, privateId]);
  });

  it("a NON-owner's GET /uploads never lists anyone's shared book either — shared books surface via GET /uploads/shared (F-217), not this list", async () => {
    const a = await registerUser(t.app, pg.pool);
    const sharedId = await seedBookUpload(pg.pool, a.userId, { title: 'Curated Book' });
    await shareBook(sharedId);

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get('/uploads');
    expect(res.status).toBe(200);
    expect(res.body.uploads).toEqual([]);
  });
});

describe('F-217 — GET /uploads/shared (the shared-books browse list)', () => {
  it('lists every is_shared book to a NON-owner — exact no-owner-PII DTO, newest first', async () => {
    const a = await registerUser(t.app, pg.pool);
    const olderShared = await seedBookUpload(pg.pool, a.userId, {
      title: 'Shared Folktales',
      type: 'literature',
      status: 'ready',
      pageCount: 12,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const newerShared = await seedBookUpload(pg.pool, a.userId, {
      title: 'Shared Comics',
      type: 'comic',
      status: 'ready',
      pageCount: 24,
      createdAt: new Date('2026-08-10T00:00:00Z'),
    });
    await shareBook(olderShared);
    await shareBook(newerShared);
    // A's PRIVATE book must never leak into the shared listing.
    await seedBookUpload(pg.pool, a.userId, { title: 'My Private Book' });

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get('/uploads/shared');
    expect(res.status).toBe(200);
    // Only the shared pair, newest first (created_at DESC, id DESC).
    expect(res.body.uploads.map((u: { id: string }) => Number(u.id))).toEqual([
      newerShared,
      olderShared,
    ]);
    expect(res.body.uploads.map((u: { title: string }) => u.title)).toEqual([
      'Shared Comics',
      'Shared Folktales',
    ]);
    // No-owner-PII contract (the GET /uploads/:id shared-read pin, applied
    // to the LIST): these are another account's rows served cross-account,
    // so assert the exact key set — no user_id, no email, no blob_ref.
    for (const upload of res.body.uploads as Record<string, unknown>[]) {
      expect(Object.keys(upload).sort()).toEqual([
        'byte_size',
        'created_at',
        'error',
        'id',
        'page_count',
        'status',
        'title',
        'type',
      ]);
    }
  });

  it("serves ONLY ready shared books — a processing/failed shared book's title/metadata never reaches a non-owner", async () => {
    // Pins the server-side `AND status = 'ready'` filter (review nit): the
    // client filters to ready too, but a cross-account list must not rely on
    // client-side filtering. A mutant dropping the status clause fails here.
    const a = await registerUser(t.app, pg.pool);
    const readyShared = await seedBookUpload(pg.pool, a.userId, {
      title: 'Ready Shared Book',
      status: 'ready',
    });
    const processingShared = await seedBookUpload(pg.pool, a.userId, {
      title: 'Still Processing Shared Book',
      status: 'processing',
    });
    const failedShared = await seedBookUpload(pg.pool, a.userId, {
      title: 'Failed Shared Book',
      status: 'failed',
    });
    await shareBook(readyShared);
    await shareBook(processingShared);
    await shareBook(failedShared);

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get('/uploads/shared');
    expect(res.status).toBe(200);
    // The ready shared book IS listed; the non-ready shared pair is NOT.
    expect(res.body.uploads.map((u: { id: string }) => Number(u.id))).toEqual([readyShared]);
    // Belt-and-suspenders: no non-ready title leaks anywhere in the payload.
    const titles = res.body.uploads.map((u: { title: string }) => u.title);
    expect(titles).toEqual(['Ready Shared Book']);
  });

  it("no shared books → 200 with an empty list, proving the literal /shared route resolves (not '/:id' capturing \"shared\" → 400/404)", async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/uploads/shared');
    // Declaration-order pin: were `/:id` to capture "shared",
    // IdParamsSchema's numeric coercion would 400 before any handler ran —
    // this 200 + envelope is only reachable through the literal route.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploads: [] });
  });

  it("the OWNER's own shared book lists here too (one shared library for every account; the client de-dupes against the owner list)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, a.userId, {
      title: 'My Curated Book',
      status: 'ready',
    });
    await shareBook(id);

    const res = await a.agent.get('/uploads/shared');
    expect(res.status).toBe(200);
    expect(res.body.uploads.map((u: { id: string }) => Number(u.id))).toEqual([id]);
  });
});

describe('F-207 phase 3a — every book mutation (and owner-workflow read) stays owner-only on a SHARED book', () => {
  it("a NON-owner cannot DELETE a shared book: uniform 404, row + pages + blobs survive", async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await uploadTwoPageBook(a.agent, 'Undeletable Shared Book');
    await shareBook(id);

    const b = await registerUser(t.app, pg.pool);
    expect((await b.agent.delete(`/uploads/${id}`)).status).toBe(404);

    const upload = await pg.pool.query<{ is_shared: boolean }>(
      `SELECT is_shared FROM book_uploads WHERE id = $1`,
      [id],
    );
    expect(upload.rows[0]?.is_shared).toBe(true); // still there, still shared
    expect((await bookPageRows(id)).length).toBe(2); // pages intact
  });

  it('a NON-owner cannot REORDER a shared book: 404, page order untouched', async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await uploadTwoPageBook(a.agent, 'Unreorderable Shared Book');
    await shareBook(id);
    const before = await bookPageRows(id);

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent
      .patch(`/uploads/${id}/pages/order`)
      .send({ page_ids: before.map((p) => Number(p.id)).reverse() });
    expect(res.status).toBe(404);
    expect(await bookPageRows(id)).toEqual(before); // untouched
  });

  it('a NON-owner cannot trigger or read OCR extraction on a shared book: POST + GET /extract both 404', async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, a.userId, { status: 'ready', pageCount: 2 });
    await shareBook(id);

    const b = await registerUser(t.app, pg.pool);
    // runExtraction's ownership gate (WHERE id AND user_id) 404s before any
    // range logic, cap spend, or Vision call — extraction is the OWNER's
    // costed workflow, never a shared-reader affordance.
    expect((await b.agent.post(`/uploads/${id}/extract`).send({})).status).toBe(404);
    expect((await b.agent.get(`/uploads/${id}/extract`)).status).toBe(404);

    // Side-effect guard (same shape as the delete/reorder tests): the 404'd
    // POST claimed no run row — extraction state is untouched.
    const runs = await pg.pool.query(
      `SELECT id FROM upload_extractions WHERE upload_id = $1`,
      [id],
    );
    expect(runs.rows).toHaveLength(0);
  });

  it('the /pages id-listing (the reorder tool feed) stays owner-only too: a NON-owner gets 404 even on a shared book', async () => {
    const a = await registerUser(t.app, pg.pool);
    const id = await seedBookUpload(pg.pool, a.userId, { status: 'ready', pageCount: 1 });
    await seedBookPage(pg.pool, id, 1);
    await shareBook(id);

    const b = await registerUser(t.app, pg.pool);
    // Deliberate: /pages exists solely to feed the owner-only reorder PATCH
    // (stable book_pages.id values). The shared Read surface paginates by
    // page NUMBER via meta.page_count + /page/:n and never needs page ids.
    expect((await b.agent.get(`/uploads/${id}/pages`)).status).toBe(404);
  });

  it('a shared-book upload replay cannot be hijacked: POSTing the same title as another user creates a NEW private (pending → ready) book for the caller, never touching the shared row', async () => {
    const a = await registerUser(t.app, pg.pool);
    const sharedId = await uploadTwoPageBook(a.agent, 'Collision Title');
    await shareBook(sharedId);

    // B uploads under the SAME title — the idempotent-replace key is
    // (user_id, title), so this lands as B's OWN new private row; A's shared
    // book is not replaced, and B's row is not shared.
    const b = await registerUser(t.app, pg.pool);
    const bId = await uploadTwoPageBook(b.agent, 'Collision Title');
    expect(Number(bId)).not.toBe(Number(sharedId));

    const rows = await pg.pool.query<{ id: string; is_shared: boolean }>(
      `SELECT id, is_shared FROM book_uploads WHERE title = 'Collision Title' ORDER BY id`,
      [],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => Number(r.id) === Number(sharedId))?.is_shared).toBe(true);
    expect(rows.rows.find((r) => Number(r.id) === Number(bId))?.is_shared).toBe(false);
  });

  it('share-flag hijack via upload is impossible: an is_shared body field is REJECTED (.strict() → 400) and a clean upload lands private', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const smuggle = await agent
      .post('/uploads')
      .field('title', 'Smuggled Share')
      .field('type', 'vocab')
      .field('is_shared', 'true')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    expect(smuggle.status).toBe(400);

    const clean = await agent
      .post('/uploads')
      .field('title', 'Clean Upload')
      .field('type', 'vocab')
      .attach('file', minimalZip(), { filename: 'book.zip', contentType: 'application/zip' });
    // Async contract: a clean, ACCEPTED upload enqueues as 202 (pending),
    // never 201 — the row commits before any decode runs.
    expect(clean.status).toBe(202);
    const { rows } = await pg.pool.query<{ is_shared: boolean }>(
      `SELECT is_shared FROM book_uploads WHERE id = $1`,
      [clean.body.upload.id],
    );
    expect(rows[0]?.is_shared).toBe(false); // 079's default — private
  });
});
