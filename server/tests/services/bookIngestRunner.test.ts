/**
 * Tests for src/services/bookIngestRunner.ts (Phase 2.5 — async book-upload
 * ingest pipeline, the OOM fix).
 *
 * The runner is driven DETERMINISTICALLY: no timers — each test calls
 * `runBookIngestTick` directly, against a real Postgres (testcontainers) and
 * a throwaway blob-store temp dir (BOOK_UPLOAD_STORAGE_DIR env-injected
 * before buildTestApp — same posture as tests/routes/uploads.test.ts).
 *
 * Coverage:
 *   - idle when nothing is pending
 *   - happy path (REAL zip fixture, tests/helpers/zip.ts + the real yauzl
 *     parser): claims, streams pages, persists book_pages in natural-sort
 *     order with real bytes on disk, settles 'ready', raw file deleted +
 *     raw_blob_ref cleared
 *   - happy path (REAL 1-page PDF fixture, real pdftoppm — this sandbox has
 *     poppler-utils; self-skips like pdfPageRender.test.ts if it doesn't)
 *   - corrupt file (valid zip magic bytes, garbage body) → 'failed', bounded
 *     error message, raw file still deleted, no book_pages
 *   - IDEMPOTENCY: a 'pending' row that already has LEFTOVER book_pages
 *     (simulating a crashed prior attempt manually reset to pending) is
 *     decoded WITHOUT duplicating rows — old pages are gone, only the fresh
 *     decode's pages remain
 *   - stale-'processing' reap: settles 'failed' + clears any partial
 *     book_pages the crashed run left behind; a fresh 'pending' row is
 *     UNTOUCHED by the reap and gets claimed+processed normally in the same
 *     tick
 *   - blue/green gate: the idle color reaps but never claims 'pending' work
 *   - BOOK_INGEST_RUNNERS_ENABLED=false: neither reaps... no, reap still
 *     runs (time-based); claim never runs — see the gate test
 *
 * Bounded memory itself can't be unit-asserted at this level (that's
 * zipPageExtract.test.ts / pdfPageRender.test.ts's job — this suite proves
 * the runner USES the streaming generators correctly and settles the DB
 * state correctly around them, not that memory stays flat).
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedBookPage, seedBookUpload } from '../helpers/seed.js';
import { buildStoredZip } from '../helpers/zip.js';
import { runBookIngestTick } from '../../src/services/bookIngestRunner.js';
import { bookUploadRawRelPath } from '../../src/services/bookUploadIngest.js';
import { _setConfigForTesting, loadConfig } from '../../src/config/index.js';
import { getLogger } from '../../src/logging.js';

const execFileAsync = promisify(execFile);

let pg: PgHandle;
let t: TestApp;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
function markedPng(marker: string): Buffer {
  return Buffer.concat([TINY_PNG, Buffer.from(`-${marker}`, 'utf8')]);
}

const TINY_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n' +
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n' +
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>endobj\n' +
    'trailer<< /Size 4 /Root 1 0 R >>\n' +
    '%%EOF',
  'utf8',
);

async function hasPdftoppm(): Promise<boolean> {
  try {
    await execFileAsync('pdftoppm', ['-v']);
    return true;
  } catch {
    return false;
  }
}

/** Write `bytes` as a raw upload file under BOOK_UPLOAD_STORAGE_DIR/raw/{userId}/,
 *  mirroring what multer's diskStorage actually writes, and return the
 *  RELATIVE path (`book_uploads.raw_blob_ref`'s shape). */
async function writeRawFixture(userId: number, filename: string, bytes: Buffer): Promise<string> {
  const dir = path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, 'raw', String(userId));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), bytes);
  return bookUploadRawRelPath(userId, filename);
}

async function rawFileExists(rawBlobRef: string): Promise<boolean> {
  try {
    await readFile(path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, rawBlobRef));
    return true;
  } catch {
    return false;
  }
}

async function bookPageRows(uploadId: number) {
  const { rows } = await pg.pool.query<{ id: string; page_number: number; blob_ref: string }>(
    `SELECT id, page_number, blob_ref FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
    [uploadId],
  );
  return rows;
}

async function uploadRow(uploadId: number) {
  const { rows } = await pg.pool.query<{
    status: string;
    page_count: number | null;
    error: string | null;
    raw_blob_ref: string | null;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT status, page_count, error, raw_blob_ref, started_at, finished_at
       FROM book_uploads WHERE id = $1`,
    [uploadId],
  );
  return rows[0]!;
}

beforeAll(async () => {
  process.env.BOOK_UPLOAD_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-book-ingest-test-${process.pid}-${Date.now()}`,
  );
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
  delete process.env.BOOK_UPLOAD_STORAGE_DIR;
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE book_pages, book_uploads, sessions, users RESTART IDENTITY CASCADE',
  );
  await rm(process.env.BOOK_UPLOAD_STORAGE_DIR!, { recursive: true, force: true });
});

describe('runBookIngestTick', () => {
  it('returns idle when nothing is pending', async () => {
    await expect(runBookIngestTick(getLogger())).resolves.toBe('idle');
  });

  it('happy path (real zip): claims, streams pages in natural-sort order, persists real bytes, settles ready, deletes the raw file', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const pageA = markedPng('A'); // "001.png"
    const pageB = markedPng('B'); // "002.png"
    const zip = buildStoredZip([
      { name: '002.png', data: pageB },
      { name: '001.png', data: pageA },
    ]);
    const rawBlobRef = await writeRawFixture(userId, 'a.raw', zip);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      title: 'Two Page Book',
      status: 'pending',
      byteSize: zip.length,
      rawBlobRef,
    });

    await expect(runBookIngestTick(getLogger())).resolves.toBe('done');

    const row = await uploadRow(uploadId);
    expect(row.status).toBe('ready');
    expect(row.page_count).toBe(2);
    expect(row.error).toBeNull();
    expect(row.raw_blob_ref).toBeNull();
    expect(row.started_at).not.toBeNull();
    expect(row.finished_at).not.toBeNull();

    const pages = await bookPageRows(uploadId);
    expect(pages.length).toBe(2);
    expect(pages.map((p) => p.page_number)).toEqual([1, 2]);
    const onDiskA = await readFile(
      path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[0]!.blob_ref),
    );
    const onDiskB = await readFile(
      path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[1]!.blob_ref),
    );
    expect(Buffer.compare(onDiskA, pageA)).toBe(0);
    expect(Buffer.compare(onDiskB, pageB)).toBe(0);
    for (const p of pages) {
      expect(p.blob_ref).toMatch(new RegExp(`^${userId}/[0-9a-f-]{36}\\.png$`));
    }

    // The raw upload file is gone — fully decoded, no reason to keep it.
    expect(await rawFileExists(rawBlobRef)).toBe(false);
  });

  it('happy path (real pdftoppm): renders directly from the raw file path, persists the page, settles ready', async () => {
    if (!(await hasPdftoppm())) {
      // eslint-disable-next-line no-console
      console.warn('pdftoppm not found on PATH — skipping real-poppler runner test');
      return;
    }
    const { userId } = await registerUser(t.app, pg.pool);
    const rawBlobRef = await writeRawFixture(userId, 'b.raw', TINY_PDF);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      title: 'A PDF Book',
      type: 'grammar',
      status: 'pending',
      byteSize: TINY_PDF.length,
      rawBlobRef,
    });

    await expect(runBookIngestTick(getLogger())).resolves.toBe('done');

    const row = await uploadRow(uploadId);
    expect(row.status).toBe('ready');
    expect(row.page_count).toBe(1);

    const pages = await bookPageRows(uploadId);
    expect(pages.length).toBe(1);
    expect(pages[0]!.blob_ref.endsWith('.jpg')).toBe(true);
    const onDisk = await readFile(
      path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, pages[0]!.blob_ref),
    );
    // A real JPEG starts with the FF D8 FF magic bytes (pdftoppm's -jpeg output).
    expect(onDisk[0]).toBe(0xff);
    expect(onDisk[1]).toBe(0xd8);
    expect(onDisk[2]).toBe(0xff);

    expect(await rawFileExists(rawBlobRef)).toBe(false);
  });

  it('corrupt file (valid zip magic bytes, garbage body) → failed with a bounded error, raw file still deleted, no pages', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    // Passes the magic-byte sniff (PK\x03\x04) but is not a real zip archive —
    // exercises the runner's OWN failure path (the route's own sniff would
    // normally have caught this before enqueue; the runner defends anyway).
    const corrupt = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage')]);
    const rawBlobRef = await writeRawFixture(userId, 'c.raw', corrupt);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      title: 'Corrupt Book',
      status: 'pending',
      byteSize: corrupt.length,
      rawBlobRef,
    });

    await expect(runBookIngestTick(getLogger())).resolves.toBe('failed');

    const row = await uploadRow(uploadId);
    expect(row.status).toBe('failed');
    expect(row.error).not.toBeNull();
    expect(row.error!.length).toBeLessThanOrEqual(2000);
    expect(row.raw_blob_ref).toBeNull();
    expect(row.finished_at).not.toBeNull();

    expect(await bookPageRows(uploadId)).toHaveLength(0);
    expect(await rawFileExists(rawBlobRef)).toBe(false);
  });

  it('rejects a zip with zero usable pages → failed, no pages, raw file deleted', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const zip = buildStoredZip([{ name: 'readme.txt', data: Buffer.from('no images here') }]);
    const rawBlobRef = await writeRawFixture(userId, 'd.raw', zip);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      title: 'Empty Book',
      status: 'pending',
      byteSize: zip.length,
      rawBlobRef,
    });

    await expect(runBookIngestTick(getLogger())).resolves.toBe('failed');

    const row = await uploadRow(uploadId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/no usable image pages/);
    expect(await bookPageRows(uploadId)).toHaveLength(0);
    expect(await rawFileExists(rawBlobRef)).toBe(false);
  });

  it('IDEMPOTENCY: a pending row with LEFTOVER book_pages from a prior attempt is re-decoded WITHOUT duplicating rows, and the leftover pages\' BLOB FILES are deleted too (Bug 1 fix — not just the rows)', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const pageA = markedPng('A');
    const zip = buildStoredZip([{ name: '001.png', data: pageA }]);
    const rawBlobRef = await writeRawFixture(userId, 'e.raw', zip);
    const uploadId = await seedBookUpload(pg.pool, userId, {
      title: 'Replayed Book',
      status: 'pending',
      byteSize: zip.length,
      rawBlobRef,
    });
    // Simulate a crashed prior run (or a same-title replace) that left OLD
    // pages behind, under DIFFERENT page numbers than the fresh decode will
    // produce — if the runner didn't clear these first, the fresh INSERT
    // would either duplicate rows or collide on UNIQUE(upload_id, page_number).
    // These are REAL files on disk (not just fake blob_ref strings) so this
    // test actually proves `clearPagesAndBlobs` unlinks the FILES, not only
    // the DB rows — seeding a nonexistent path would let a leftover-file-leak
    // regression pass silently.
    const leftoverPath1 = 'stale/leftover-1.jpg';
    const leftoverPath2 = 'stale/leftover-2.jpg';
    const leftoverAbs1 = path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, leftoverPath1);
    const leftoverAbs2 = path.join(process.env.BOOK_UPLOAD_STORAGE_DIR!, leftoverPath2);
    await mkdir(path.dirname(leftoverAbs1), { recursive: true });
    await writeFile(leftoverAbs1, Buffer.from('leftover-1'));
    await writeFile(leftoverAbs2, Buffer.from('leftover-2'));
    await seedBookPage(pg.pool, uploadId, 1, { blobRef: leftoverPath1 });
    await seedBookPage(pg.pool, uploadId, 2, { blobRef: leftoverPath2 });
    expect(await bookPageRows(uploadId)).toHaveLength(2);

    await expect(runBookIngestTick(getLogger())).resolves.toBe('done');

    const pages = await bookPageRows(uploadId);
    // Only the FRESH decode's one page survives — the leftovers are gone.
    expect(pages.length).toBe(1);
    expect(pages[0]!.blob_ref).not.toBe(leftoverPath1);
    expect(pages[0]!.blob_ref).not.toBe(leftoverPath2);
    const row = await uploadRow(uploadId);
    expect(row.status).toBe('ready');
    expect(row.page_count).toBe(1);

    // BUG 1 FIX: the leftover pages' blob FILES were deleted too, not just
    // their book_pages rows.
    await expect(readFile(leftoverAbs1)).rejects.toThrow();
    await expect(readFile(leftoverAbs2)).rejects.toThrow();
  });

  it('reaps a stale processing row as failed + clears its partial pages AND its raw upload file (additional fix found in review — the reaper used to leave raw_blob_ref set and the raw file on disk, unlike every other path to \'failed\'); a fresh pending row is untouched by the reap and gets claimed normally', async () => {
    const { userId } = await registerUser(t.app, pg.pool);

    // A crashed run: 'processing', started long ago, with partial pages it
    // never finished cleaning up.
    const staleRawBlobRef = await writeRawFixture(userId, 'f.raw', Buffer.from('unused'));
    const staleId = await seedBookUpload(pg.pool, userId, {
      title: 'Crashed Book',
      status: 'processing',
      byteSize: 10,
      rawBlobRef: staleRawBlobRef,
      startedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago ≫ default 20min threshold
    });
    await seedBookPage(pg.pool, staleId, 1, { blobRef: 'stale/partial.jpg' });

    // A FRESH pending upload — old table-wide state must not affect it;
    // 'pending' is never reaped (the healthy backlog), and the SAME tick
    // claims + processes it after reaping the stale row.
    const pageA = markedPng('A');
    const freshZip = buildStoredZip([{ name: '001.png', data: pageA }]);
    const freshRawBlobRef = await writeRawFixture(userId, 'g.raw', freshZip);
    const freshId = await seedBookUpload(pg.pool, userId, {
      title: 'Fresh Book',
      status: 'pending',
      byteSize: freshZip.length,
      rawBlobRef: freshRawBlobRef,
    });

    await expect(runBookIngestTick(getLogger())).resolves.toBe('done');

    const stale = await uploadRow(staleId);
    expect(stale.status).toBe('failed');
    expect(stale.error).toContain('interrupted');
    expect(await bookPageRows(staleId)).toHaveLength(0); // partial page cleared
    // Reap-path raw-file cleanup fix: the reaper must delete the crashed
    // run's raw file and null raw_blob_ref, exactly like settleFailed does
    // for every other path to 'failed' — otherwise the file is never
    // reachable again (jobRetention.ts's sweepFailedBookUploads doesn't do
    // filesystem cleanup, trusting raw_blob_ref is already NULL by the time
    // a row is 'failed').
    expect(stale.raw_blob_ref).toBeNull();
    expect(await rawFileExists(staleRawBlobRef)).toBe(false);

    const fresh = await uploadRow(freshId);
    expect(fresh.status).toBe('ready');
    expect(fresh.page_count).toBe(1);
  });

  it('a YOUNG processing row is neither reaped nor re-claimed', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const rawBlobRef = await writeRawFixture(userId, 'h.raw', Buffer.from('unused'));
    const youngId = await seedBookUpload(pg.pool, userId, {
      title: 'In Flight',
      status: 'processing',
      byteSize: 10,
      rawBlobRef,
      startedAt: new Date(), // just started
    });

    await expect(runBookIngestTick(getLogger())).resolves.toBe('idle');

    const row = await uploadRow(youngId);
    expect(row.status).toBe('processing'); // untouched
  });

  it('Phase 1.3: the idle color reaps stale rows but never claims pending ones', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const staleRawBlobRef = await writeRawFixture(userId, 'i.raw', Buffer.from('unused'));
    const staleId = await seedBookUpload(pg.pool, userId, {
      title: 'Crashed',
      status: 'processing',
      byteSize: 10,
      rawBlobRef: staleRawBlobRef,
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const zip = buildStoredZip([{ name: '001.png', data: TINY_PNG }]);
    const pendingRawBlobRef = await writeRawFixture(userId, 'j.raw', zip);
    const pendingId = await seedBookUpload(pg.pool, userId, {
      title: 'Should Not Be Claimed',
      status: 'pending',
      byteSize: zip.length,
      rawBlobRef: pendingRawBlobRef,
    });

    const otherColorFile = path.join(
      process.env.BOOK_UPLOAD_STORAGE_DIR!,
      'active-color-test',
      'active-color',
    );
    await mkdir(path.dirname(otherColorFile), { recursive: true });
    await writeFile(otherColorFile, 'green\n');
    const prevCfg = loadConfig();
    _setConfigForTesting({ ...prevCfg, DEPLOY_COLOR: 'blue', ACTIVE_COLOR_FILE: otherColorFile });
    try {
      // 'idle', not 'done' — claim+process never ran, even though a pending
      // upload was available.
      await expect(runBookIngestTick(getLogger())).resolves.toBe('idle');
    } finally {
      _setConfigForTesting(prevCfg);
    }

    // Reap still ran despite the gate.
    expect((await uploadRow(staleId)).status).toBe('failed');
    // Claim never ran: the pending upload (and its raw file) is untouched.
    expect((await uploadRow(pendingId)).status).toBe('pending');
    expect(await rawFileExists(pendingRawBlobRef)).toBe(true);
  });

  it('BOOK_INGEST_RUNNERS_ENABLED=false disables claim (manual kill switch), reap still runs', async () => {
    const { userId } = await registerUser(t.app, pg.pool);
    const staleRawBlobRef = await writeRawFixture(userId, 'k.raw', Buffer.from('unused'));
    const staleId = await seedBookUpload(pg.pool, userId, {
      title: 'Crashed',
      status: 'processing',
      byteSize: 10,
      rawBlobRef: staleRawBlobRef,
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const zip = buildStoredZip([{ name: '001.png', data: TINY_PNG }]);
    const pendingRawBlobRef = await writeRawFixture(userId, 'l.raw', zip);
    const pendingId = await seedBookUpload(pg.pool, userId, {
      title: 'Should Not Be Claimed Either',
      status: 'pending',
      byteSize: zip.length,
      rawBlobRef: pendingRawBlobRef,
    });

    const prevCfg = loadConfig();
    _setConfigForTesting({ ...prevCfg, BOOK_INGEST_RUNNERS_ENABLED: false });
    try {
      await expect(runBookIngestTick(getLogger())).resolves.toBe('idle');
    } finally {
      _setConfigForTesting(prevCfg);
    }

    expect((await uploadRow(staleId)).status).toBe('failed');
    expect((await uploadRow(pendingId)).status).toBe('pending');
  });
});
