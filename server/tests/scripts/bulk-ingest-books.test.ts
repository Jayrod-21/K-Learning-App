/**
 * Integration tests for the operator bulk book-ingest CLI
 * (src/scripts/bulk-ingest-books.ts + src/scripts/corpus-books.manifest.ts).
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in),
 * driving the exported seams directly (`ingestOne`, `loadAndNormalize`,
 * `runBulkIngest`, `parseCliArgs`) — no child process, no CLI spawn. The blob
 * store and the "corpus" directory are throwaway temp dirs; NO real corpus
 * files or real database are ever touched. The zip path uses REAL, hand-built
 * archives (tests/helpers/zip.ts) through the REAL yauzl parser — same
 * posture as tests/routes/uploads.test.ts.
 *
 * Coverage:
 *   - happy path: a real 3-image zip → book_uploads row (manifest title +
 *     type, status 'ready', correct page_count) + book_pages numbered 1..N in
 *     NATURAL filename order, each page's blob on disk with the exact bytes
 *   - idempotent re-run: same title again → still ONE row (UPSERT), pages
 *     REPLACED (new count/rows/blobs; old blobs unlinked), never duplicated
 *   - re-tag: a changed manifest `type` updates the existing row on re-run
 *   - a manifest type NOT in BOOK_UPLOAD_TYPES throws BEFORE any write
 *     (no rows, no blob files)
 *   - MID-TRANSACTION failure (a book_pages INSERT throws after BEGIN):
 *     the tx is rolled back — no book_uploads row / no book_pages for a new
 *     book, prior row + pages + blobs fully intact for a replace — and the
 *     connection is demonstrably usable afterwards (ROLLBACK really ran)
 *   - failed-ROLLBACK path: ingestOne reports the ORIGINAL error through
 *     onRollbackFailure so a pool-owning caller can destroy the client
 *   - the batch runner on a mid-tx failure: reports it as a FAILURE
 *     (non-zero-exit semantics), rolls back cleanly, and RETURNS the client
 *     to the pool (no leak); when ROLLBACK also fails it DESTROYS the client
 *     instead of re-pooling it (release(err) semantics)
 *   - --dry-run: normalizes + reports page counts but writes NOTHING
 *   - missing file: warned + skipped, the rest of the batch still ingests
 *   - failure isolation: one bad archive fails ONLY that book; the batch
 *     continues and the failure is reported in the summary
 *   - CORPUS_MANIFEST sanity: 17 entries, valid per assertValidManifest,
 *     unique file basenames
 *   - parseCliArgs: happy path, missing --dir, bad --user
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildStoredZip } from '../helpers/zip.js';
import { _setConfigForTesting } from '../../src/config/index.js';
import { closePool, getPoolForTesting, setPoolForTesting } from '../../src/db/pool.js';
import type { BookUploadType } from '../../src/services/bookUploadIngest.js';
import {
  assertValidManifest,
  ingestOne,
  parseCliArgs,
  runBulkIngest,
} from '../../src/scripts/bulk-ingest-books.js';
import {
  CORPUS_MANIFEST,
  type CorpusBookEntry,
} from '../../src/scripts/corpus-books.manifest.js';

let pg: PgHandle;
let tmpRoot: string;
let storageDir: string;
let corpusDir: string;
let userId: number;

/** A minimal but VALID (decodable) 1x1 PNG — same fixture as
 *  tests/routes/uploads.test.ts's TINY_PNG. The page-image sniff only checks
 *  the leading magic bytes, so appending a marker (see `markedPng`) keeps
 *  every "page" byte-for-byte distinct for order assertions. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function markedPng(marker: string): Buffer {
  return Buffer.concat([TINY_PNG, Buffer.from(`-${marker}`, 'utf8')]);
}

/** Valid-shaped Argon2id PHC string satisfying ck_users_password_hash_argon2id
 *  (prefix + length 80..255). Never verified — the CLI never authenticates. */
const FAKE_ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=4$' + 'A'.repeat(60);

/** The 3-page fixture book: filenames deliberately NON-zero-padded-sorted so
 *  natural filename order (001, 002, 010) — not append order — must seed
 *  page_number. */
const PAGE_1 = markedPng('page-one'); // 001.png
const PAGE_2 = markedPng('page-two'); // 002.png
const PAGE_3 = markedPng('page-ten'); // 010.png

const ENTRY_A: CorpusBookEntry = { file: 'book-a.zip', title: 'Test Book A', type: 'vocab' };

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg.pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

interface FailingClientOpts {
  /** Reject any query whose SQL matches this predicate with an injected error. */
  failWhen: (sql: string) => boolean;
  /** Also reject ROLLBACK — simulates a dead connection mid-transaction. */
  failRollback?: boolean;
}

const INJECTED_FAILURE = 'injected mid-transaction failure';
const INJECTED_ROLLBACK_FAILURE = 'injected ROLLBACK failure';

/**
 * Wrap a REAL testcontainer client so its Nth-matching query rejects while
 * every other query (BEGIN, SELECT ... FOR UPDATE, the upsert, ROLLBACK
 * unless failRollback) still hits the real Postgres. Everything except the
 * injected rejection is real — this is a fault injector, not a mock DB.
 */
function wrapFailingClient(real: PoolClient, opts: FailingClientOpts): PoolClient {
  const interceptedQuery = (...args: unknown[]): Promise<unknown> => {
    const first = args[0];
    const sql =
      typeof first === 'string'
        ? first
        : String((first as { text?: unknown } | undefined)?.text ?? '');
    if (opts.failRollback === true && /^\s*ROLLBACK/i.test(sql)) {
      return Promise.reject(new Error(INJECTED_ROLLBACK_FAILURE));
    }
    if (opts.failWhen(sql)) {
      return Promise.reject(new Error(INJECTED_FAILURE));
    }
    return (real.query as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'query') return interceptedQuery;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * Install a real pg Pool (against the testcontainer) as the module-global
 * pool, with promise-style `connect()` — the call runBulkIngest makes —
 * returning fault-injected clients. Callback-style connect (used internally
 * by pool.query, e.g. the --user pre-flight) stays unwrapped so only the
 * per-book transaction path sees the injected failure. Restores the previous
 * module-global pool afterwards.
 */
async function withInjectedFailingPool(
  opts: FailingClientOpts,
  fn: (injected: Pool) => Promise<void>,
): Promise<void> {
  const prev = getPoolForTesting();
  const injected = new Pool({ connectionString: pg.connectionString, max: 2 });
  const origConnect = injected.connect.bind(injected);
  (injected as { connect: unknown }).connect = (cb?: (...cbArgs: unknown[]) => void) =>
    cb !== undefined
      ? (origConnect as (...a: unknown[]) => unknown)(cb)
      : origConnect().then((client) => wrapFailingClient(client, opts));
  setPoolForTesting(injected);
  try {
    await fn(injected);
  } finally {
    await closePool(); // ends `injected` and clears the module global
    if (prev !== null) setPoolForTesting(prev);
  }
}

async function uploadRows() {
  const { rows } = await pg.pool.query<{
    id: string;
    user_id: string;
    title: string;
    type: BookUploadType;
    status: string;
    page_count: number | null;
  }>(
    `SELECT id, user_id, title, type, status, page_count
       FROM book_uploads ORDER BY id`,
  );
  return rows;
}

async function pageRows(uploadId: string) {
  const { rows } = await pg.pool.query<{ id: string; page_number: number; blob_ref: string }>(
    `SELECT id, page_number, blob_ref FROM book_pages
      WHERE upload_id = $1 ORDER BY page_number`,
    [uploadId],
  );
  return rows;
}

beforeAll(async () => {
  pg = await startPostgres();

  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'km-bulk-ingest-test-'));
  storageDir = path.join(tmpRoot, 'blobs');
  corpusDir = path.join(tmpRoot, 'corpus');
  await mkdir(corpusDir, { recursive: true });

  // Config for everything the ingest path touches (uploadStore's storage dir,
  // getPool's DATABASE_URL for the runBulkIngest tests, pino's LOG_LEVEL) —
  // mirrors tests/helpers/app.ts's env-then-_setConfigForTesting pattern
  // without building the express app (the CLI never touches the app).
  process.env.NODE_ENV = 'test';
  process.env.PORT = '4000';
  process.env.DATABASE_URL = pg.connectionString;
  process.env.KIWI_URL = 'http://kiwi.invalid/';
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  process.env.LOG_LEVEL = 'silent';
  process.env.BOOK_UPLOAD_STORAGE_DIR = storageDir;
  _setConfigForTesting({});

  // On-disk fixtures for the throwaway "corpus" dir: two REAL (hand-built,
  // yauzl-parseable) zips + one file that is not a zip at all.
  await writeFile(
    path.join(corpusDir, 'book-a.zip'),
    // Append order deliberately scrambled: natural sort must reorder.
    buildStoredZip([
      { name: '010.png', data: PAGE_3 },
      { name: '001.png', data: PAGE_1 },
      { name: '002.png', data: PAGE_2 },
    ]),
  );
  await writeFile(
    path.join(corpusDir, 'book-a-v2.zip'),
    buildStoredZip([
      { name: 'p1.png', data: markedPng('v2-one') },
      { name: 'p2.png', data: markedPng('v2-two') },
    ]),
  );
  await writeFile(path.join(corpusDir, 'garbage.zip'), Buffer.from('not a zip at all', 'utf8'));
});

afterAll(async () => {
  delete process.env.BOOK_UPLOAD_STORAGE_DIR;
  // runBulkIngest's non-dry tests lazily built the module-global pool from
  // DATABASE_URL — close it before the container goes away.
  await closePool();
  await stopPostgres(pg);
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // users CASCADE clears book_uploads (user_id FK) → book_pages (upload_id
  // FK). RESTART IDENTITY keeps ids predictable across tests.
  await pg.pool.query('TRUNCATE TABLE book_uploads, users RESTART IDENTITY CASCADE');
  // Wipe the blob store too: RESTART IDENTITY reuses user id 1 every test, so
  // a prior test's page blobs under `<storageDir>/1/` would otherwise pollute
  // this test's "no blob files were written" assertions. saveBlob mkdir -p's
  // the tree back on demand.
  await rm(storageDir, { recursive: true, force: true });
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('operator@example.com', $1) RETURNING id`,
    [FAKE_ARGON2_HASH],
  );
  userId = Number(rows[0]!.id);
});

describe('ingestOne — happy path', () => {
  it('ingests a real zip: book_uploads row (title/type/ready/page_count) + pages 1..N in natural order with exact blob bytes', async () => {
    const result = await withClient((client) => ingestOne(client, corpusDir, ENTRY_A, userId));

    expect(result.wasNew).toBe(true);
    expect(result.pageCount).toBe(3);
    expect(result.priorBlobRefs).toEqual([]);
    expect(result.priorBlobUnlinkFailures).toBe(0);

    const uploads = await uploadRows();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      title: 'Test Book A',
      type: 'vocab',
      status: 'ready',
      page_count: 3,
    });
    expect(Number(uploads[0]!.user_id)).toBe(userId);
    expect(uploads[0]!.id).toBe(result.uploadId);

    const pages = await pageRows(result.uploadId);
    expect(pages.map((p) => p.page_number)).toEqual([1, 2, 3]);

    // Natural filename order seeded page_number: 001 → page 1, 002 → page 2,
    // 010 → page 3 (NOT the scrambled append order in the archive).
    const expectedBytes = [PAGE_1, PAGE_2, PAGE_3];
    for (let i = 0; i < pages.length; i += 1) {
      const blobBytes = await readFile(path.join(storageDir, pages[i]!.blob_ref));
      expect(blobBytes.equals(expectedBytes[i]!)).toBe(true);
    }
  });
});

describe('ingestOne — idempotent re-run', () => {
  it('re-running the same title REPLACES pages (one row, new pages, old blobs unlinked) — never duplicates', async () => {
    const first = await withClient((client) => ingestOne(client, corpusDir, ENTRY_A, userId));
    const firstPages = await pageRows(first.uploadId);
    expect(firstPages).toHaveLength(3);
    const oldBlobPaths = firstPages.map((p) => path.join(storageDir, p.blob_ref));
    for (const p of oldBlobPaths) expect(existsSync(p)).toBe(true);

    // Same TITLE (the idempotency key), different archive (2 pages).
    const v2: CorpusBookEntry = { ...ENTRY_A, file: 'book-a-v2.zip' };
    const second = await withClient((client) => ingestOne(client, corpusDir, v2, userId));

    expect(second.wasNew).toBe(false);
    expect(second.uploadId).toBe(first.uploadId);
    expect(second.pageCount).toBe(2);
    expect(second.priorBlobRefs).toHaveLength(3);
    expect(second.priorBlobUnlinkFailures).toBe(0);

    const uploads = await uploadRows();
    expect(uploads).toHaveLength(1); // UPSERT — still ONE row
    expect(uploads[0]!.page_count).toBe(2);

    const secondPages = await pageRows(first.uploadId);
    expect(secondPages.map((p) => p.page_number)).toEqual([1, 2]);
    // Old page rows were replaced, not kept alongside.
    const oldIds = new Set(firstPages.map((p) => p.id));
    for (const p of secondPages) expect(oldIds.has(p.id)).toBe(false);
    // Replaced blobs were unlinked post-commit; new ones exist.
    for (const p of oldBlobPaths) expect(existsSync(p)).toBe(false);
    for (const p of secondPages) {
      expect(existsSync(path.join(storageDir, p.blob_ref))).toBe(true);
    }
  });

  it('a changed manifest type re-tags the existing row on re-run', async () => {
    await withClient((client) => ingestOne(client, corpusDir, ENTRY_A, userId));
    const retagged: CorpusBookEntry = { ...ENTRY_A, type: 'literature' };
    const result = await withClient((client) => ingestOne(client, corpusDir, retagged, userId));

    expect(result.wasNew).toBe(false);
    const uploads = await uploadRows();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.type).toBe('literature');
  });
});

describe('ingestOne — invalid manifest type', () => {
  it('throws BEFORE any write (no rows, no blob files)', async () => {
    const badEntry = { ...ENTRY_A, type: 'poetry' as BookUploadType };
    await expect(
      withClient((client) => ingestOne(client, corpusDir, badEntry, userId)),
    ).rejects.toThrow(/invalid type "poetry"/);

    expect(await uploadRows()).toHaveLength(0);
    // No blob was written for this user (the type check fires before the
    // file is even read, let alone persisted).
    expect(existsSync(path.join(storageDir, String(userId)))).toBe(false);
  });
});

describe('ingestOne — mid-transaction rollback', () => {
  it('a persist failure after BEGIN rolls the tx back: no row, no pages, connection still usable', async () => {
    const real = await pg.pool.connect();
    try {
      // Everything up to the first book_pages INSERT (BEGIN, the FOR UPDATE
      // probe, the book_uploads upsert, the first saveBlob) runs for real;
      // the page-row INSERT then rejects mid-transaction.
      const failing = wrapFailingClient(real, {
        failWhen: (sql) => sql.includes('INSERT INTO book_pages'),
      });
      await expect(ingestOne(failing, corpusDir, ENTRY_A, userId)).rejects.toThrow(
        INJECTED_FAILURE,
      );

      // The book is FULLY absent — rollback took the upsert with it.
      expect(await uploadRows()).toHaveLength(0);
      const { rows } = await pg.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM book_pages',
      );
      expect(rows[0]!.n).toBe(0);

      // ROLLBACK really ran on THIS connection: were the tx still open and
      // aborted, any query here would fail with "current transaction is
      // aborted" — and a count through the same connection would otherwise
      // still see its own uncommitted upsert.
      const probe = await real.query<{ n: number }>('SELECT count(*)::int AS n FROM book_uploads');
      expect(probe.rows[0]!.n).toBe(0);
    } finally {
      real.release();
    }
    // NOTE: blobs saved before the failure remain as orphan FILES by design
    // (see the module header's orphan-blob note) — only DB state is asserted.
  });

  it('a failed re-ingest (replace) leaves the prior book fully intact — row, pages, and blobs', async () => {
    const first = await withClient((client) => ingestOne(client, corpusDir, ENTRY_A, userId));
    const priorPages = await pageRows(first.uploadId);
    expect(priorPages).toHaveLength(3);

    const real = await pg.pool.connect();
    try {
      const failing = wrapFailingClient(real, {
        failWhen: (sql) => sql.includes('INSERT INTO book_pages'),
      });
      const v2: CorpusBookEntry = { ...ENTRY_A, file: 'book-a-v2.zip' };
      await expect(ingestOne(failing, corpusDir, v2, userId)).rejects.toThrow(INJECTED_FAILURE);
    } finally {
      real.release();
    }

    // Rollback restored the prior state outright: same row, same page rows
    // (the replace's DELETE was rolled back), prior blobs untouched on disk.
    const uploads = await uploadRows();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.id).toBe(first.uploadId);
    expect(uploads[0]!.page_count).toBe(3);
    const after = await pageRows(first.uploadId);
    expect(after.map((p) => p.id)).toEqual(priorPages.map((p) => p.id));
    for (const p of priorPages) {
      expect(existsSync(path.join(storageDir, p.blob_ref))).toBe(true);
    }
  });

  it('when ROLLBACK also fails, onRollbackFailure receives the ORIGINAL error (for release(err))', async () => {
    const real = await pg.pool.connect();
    let poisonedBy: Error | undefined;
    try {
      const failing = wrapFailingClient(real, {
        failWhen: (sql) => sql.includes('INSERT INTO book_pages'),
        failRollback: true,
      });
      await expect(
        ingestOne(failing, corpusDir, ENTRY_A, userId, {
          onRollbackFailure: (originalErr) => {
            poisonedBy = originalErr;
          },
        }),
      ).rejects.toThrow(INJECTED_FAILURE);

      // The hook fired with the ORIGINAL ingest error (withTransaction passes
      // the original error to release(err) — same contract), NOT the rollback
      // error, and the rethrown error was not masked either.
      expect(poisonedBy).toBeInstanceOf(Error);
      expect(poisonedBy!.message).toBe(INJECTED_FAILURE);
    } finally {
      // The REAL connection never rolled back (the wrapper swallowed it) —
      // clean it up directly before returning it to the test pool.
      await real.query('ROLLBACK').catch(() => undefined);
      real.release();
    }
  });
});

describe('runBulkIngest — mid-transaction failure through the batch runner', () => {
  it('reports the book as a FAILURE, leaves no half-written book, and returns the client to the pool', async () => {
    await withInjectedFailingPool(
      { failWhen: (sql) => sql.includes('INSERT INTO book_pages') },
      async (injected) => {
        const summary = await runBulkIngest({
          dir: corpusDir,
          userId,
          dryRun: false,
          manifest: [ENTRY_A],
        });

        // Non-zero-exit semantics: the failure is RECORDED (main() throws on
        // any failure), not swallowed as a skip or a success.
        expect(summary.failures).toHaveLength(1);
        expect(summary.failures[0]!.title).toBe('Test Book A');
        expect(summary.failures[0]!.error).toContain(INJECTED_FAILURE);
        expect(summary.ingested).toBe(0);

        // Rolled back: nothing half-written.
        expect(await uploadRows()).toHaveLength(0);

        // ROLLBACK succeeded → the client went BACK to the pool (plain
        // release): every physical client is idle, none leaked or destroyed.
        expect(injected.totalCount).toBeGreaterThan(0);
        expect(injected.idleCount).toBe(injected.totalCount);
      },
    );
  });

  it('when ROLLBACK also fails, the poisoned client is DESTROYED (release(err)), not re-pooled', async () => {
    await withInjectedFailingPool(
      {
        failWhen: (sql) => sql.includes('INSERT INTO book_pages'),
        failRollback: true,
      },
      async (injected) => {
        const summary = await runBulkIngest({
          dir: corpusDir,
          userId,
          dryRun: false,
          manifest: [ENTRY_A],
        });

        expect(summary.failures).toHaveLength(1);
        expect(summary.failures[0]!.error).toContain(INJECTED_FAILURE);
        expect(await uploadRows()).toHaveLength(0);

        // release(err) DESTROYS the connection: the pre-flight's client (from
        // the unwrapped callback path) may idle, but the per-book client must
        // be GONE from the pool — an aborted-tx client re-pooled here would
        // poison the next checkout ("current transaction is aborted").
        expect(injected.totalCount).toBe(injected.idleCount);
        expect(injected.totalCount).toBeLessThanOrEqual(1);
      },
    );
  });
});

describe('runBulkIngest — --dry-run', () => {
  it('normalizes + reports page counts but writes NOTHING', async () => {
    const summary = await runBulkIngest({
      dir: corpusDir,
      userId,
      dryRun: true,
      manifest: [ENTRY_A],
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.ingested).toBe(1);
    expect(summary.totalPages).toBe(3);
    expect(summary.failures).toEqual([]);
    expect(summary.skippedMissing).toEqual([]);

    expect(await uploadRows()).toHaveLength(0);
    expect(existsSync(path.join(storageDir, String(userId)))).toBe(false);
  });
});

describe('runBulkIngest — batch behavior', () => {
  it('warns + skips a missing file without aborting; the rest of the batch still ingests', async () => {
    const missing: CorpusBookEntry = { file: 'nope.zip', title: 'Missing Book', type: 'both' };
    const summary = await runBulkIngest({
      dir: corpusDir,
      userId,
      dryRun: false,
      manifest: [missing, ENTRY_A],
    });

    expect(summary.skippedMissing).toEqual(['nope.zip']);
    expect(summary.failures).toEqual([]);
    expect(summary.ingested).toBe(1);
    expect(summary.created).toBe(1);

    const uploads = await uploadRows();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.title).toBe('Test Book A');
  });

  it('one bad archive fails ONLY that book; the batch continues and reports the failure', async () => {
    const bad: CorpusBookEntry = { file: 'garbage.zip', title: 'Garbage Book', type: 'vocab' };
    const summary = await runBulkIngest({
      dir: corpusDir,
      userId,
      dryRun: false,
      manifest: [bad, ENTRY_A],
    });

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]!.title).toBe('Garbage Book');
    expect(summary.ingested).toBe(1);

    const uploads = await uploadRows();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.title).toBe('Test Book A');
  });

  it('--only filters to matching titles (case-insensitive substring)', async () => {
    const other: CorpusBookEntry = { file: 'book-a-v2.zip', title: 'Other Book', type: 'dialogue' };
    const summary = await runBulkIngest({
      dir: corpusDir,
      userId,
      dryRun: false,
      only: 'test book',
      manifest: [ENTRY_A, other],
    });

    expect(summary.ingested).toBe(1);
    const uploads = await uploadRows();
    expect(uploads.map((u) => u.title)).toEqual(['Test Book A']);
  });

  it('rejects a manifest with an invalid type before processing ANY entry', async () => {
    const bad = { ...ENTRY_A, title: 'Bad Type Book', type: 'poetry' as BookUploadType };
    await expect(
      runBulkIngest({ dir: corpusDir, userId, dryRun: false, manifest: [ENTRY_A, bad] }),
    ).rejects.toThrow(/invalid type "poetry"/);
    // Fail-fast: even the VALID first entry was not processed.
    expect(await uploadRows()).toHaveLength(0);
  });
});

describe('corpus manifest + arg parsing (no DB)', () => {
  it('CORPUS_MANIFEST has the 17 corpus books, valid + unique file basenames', () => {
    expect(CORPUS_MANIFEST).toHaveLength(17);
    expect(() => assertValidManifest(CORPUS_MANIFEST)).not.toThrow();
    const files = new Set(CORPUS_MANIFEST.map((e) => e.file));
    expect(files.size).toBe(17);
  });

  it('assertValidManifest rejects duplicate titles', () => {
    expect(() => assertValidManifest([ENTRY_A, { ...ENTRY_A, file: 'other.zip' }])).toThrow(
      /duplicate title/,
    );
  });

  it('parseCliArgs parses flags and applies defaults', () => {
    expect(parseCliArgs(['--dir', '/tmp/x'])).toEqual({
      dir: '/tmp/x',
      userId: 1,
      dryRun: false,
    });
    expect(
      parseCliArgs(['--dir', '/tmp/x', '--user', '2', '--dry-run', '--only', '삼국사기']),
    ).toEqual({ dir: '/tmp/x', userId: 2, dryRun: true, only: '삼국사기' });
  });

  it('parseCliArgs rejects a missing --dir and a non-positive --user', () => {
    expect(() => parseCliArgs([])).toThrow(/--dir is required/);
    expect(() => parseCliArgs(['--dir', '/tmp/x', '--user', '0'])).toThrow(/--user/);
    expect(() => parseCliArgs(['--dir', '/tmp/x', '--user', 'abc'])).toThrow(/--user/);
  });
});
