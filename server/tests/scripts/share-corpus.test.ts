/**
 * Integration tests for the F-207 phase-2 cutover CLI
 * (src/scripts/share-corpus.ts).
 *
 * Real Postgres via testcontainers (full migration chain incl. 079's
 * is_shared columns), driving the exported seams (`runShareCorpus`,
 * `parseEnv`, `exitCodeFor`) directly — no child process, no CLI spawn.
 * NO real database is ever touched.
 *
 * Coverage:
 *   - DRY RUN writes NOTHING: owner A's 2 sets + 1 book and bystander B's
 *     set all stay is_shared = false; the summary still enumerates exactly
 *     A's 2 sets + 1 book (slug/title/id) with flipped counts of 0
 *   - APPLY flips ONLY the owner's rows: A's 2 sets + 1 book become true,
 *     B's set stays false (owner scoping proven), rowcounts 2/1
 *   - IDEMPOTENT: a second apply flips 0, reports 2 sets + 1 book already
 *     shared, and resolves cleanly (the CLI's exit-0 path)
 *   - mixed prior state: a pre-shared set is excluded from the candidate
 *     list and counted as already-shared instead
 *   - unknown email → ShareCorpusInputError (bad input), DB untouched, and
 *     exitCodeFor maps it to 2 (vs 1 for any other failure)
 *   - email is trimmed + lowercased before resolution
 *   - parseEnv: owner default (the seed-admin email), apply only on 'true'
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { _setConfigForTesting } from '../../src/config/index.js';
import { closePool } from '../../src/db/pool.js';
import {
  DEFAULT_OWNER_EMAIL,
  ShareCorpusInputError,
  exitCodeFor,
  parseEnv,
  runShareCorpus,
} from '../../src/scripts/share-corpus.js';

let pg: PgHandle;
let ownerId: number;
let bystanderId: number;

const OWNER_EMAIL = 'owner@example.com';
const BYSTANDER_EMAIL = 'bystander@example.com';

/** Valid-shaped Argon2id PHC string satisfying ck_users_password_hash_argon2id
 *  (prefix + length 80..255). Never verified — the CLI never authenticates. */
const FAKE_ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=4$' + 'A'.repeat(60);

async function insertUser(email: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_ARGON2_HASH],
  );
  return Number(rows[0]!.id);
}

async function insertAudioSet(userId: number, slug: string, title: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO audio_sources (user_id, slug, title, kind, status)
     VALUES ($1, $2, $3, 'standalone_listening', 'ready') RETURNING id`,
    [userId, slug, title],
  );
  return Number(rows[0]!.id);
}

async function insertBook(userId: number, title: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO book_uploads (user_id, title, type, status, byte_size)
     VALUES ($1, $2, 'literature', 'ready', 1) RETURNING id`,
    [userId, title],
  );
  return Number(rows[0]!.id);
}

/** Every (id, is_shared) pair across BOTH tables — the writes-nothing and
 *  owner-scoping assertions read the whole database state, not a slice. */
async function sharedFlags(): Promise<{
  audio: Array<{ id: number; user_id: number; is_shared: boolean }>;
  books: Array<{ id: number; user_id: number; is_shared: boolean }>;
}> {
  const audio = await pg.pool.query<{ id: string; user_id: string; is_shared: boolean }>(
    'SELECT id, user_id, is_shared FROM audio_sources ORDER BY id',
  );
  const books = await pg.pool.query<{ id: string; user_id: string; is_shared: boolean }>(
    'SELECT id, user_id, is_shared FROM book_uploads ORDER BY id',
  );
  const norm = (r: { id: string; user_id: string; is_shared: boolean }) => ({
    id: Number(r.id),
    user_id: Number(r.user_id),
    is_shared: r.is_shared,
  });
  return { audio: audio.rows.map(norm), books: books.rows.map(norm) };
}

beforeAll(async () => {
  pg = await startPostgres();
  // Module-global pool config — mirrors tests/scripts/bulk-ingest-books.test.ts:
  // getPool() lazily builds against the testcontainer from DATABASE_URL.
  process.env.NODE_ENV = 'test';
  process.env.PORT = '4000';
  process.env.DATABASE_URL = pg.connectionString;
  process.env.KIWI_URL = 'http://kiwi.invalid/';
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  process.env.LOG_LEVEL = 'silent';
  _setConfigForTesting({});
});

afterAll(async () => {
  await closePool();
  await stopPostgres(pg);
});

beforeEach(async () => {
  // users CASCADE clears audio_sources + book_uploads (user_id FKs).
  await pg.pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  ownerId = await insertUser(OWNER_EMAIL);
  bystanderId = await insertUser(BYSTANDER_EMAIL);
  // Owner A: 2 audio sets + 1 book, all is_shared = false (the 079 default).
  await insertAudioSet(ownerId, 'korean-folktales', 'Korean Folktales');
  await insertAudioSet(ownerId, 'news-in-korean', 'News in Korean');
  await insertBook(ownerId, 'Korean Folktales (Book)');
  // Bystander B: 1 audio set that must NEVER flip.
  await insertAudioSet(bystanderId, 'b-private-set', 'B Private Set');
});

describe('runShareCorpus — dry run (the default)', () => {
  it('enumerates the owner rows that would flip but writes NOTHING', async () => {
    const summary = await runShareCorpus({ ownerEmail: OWNER_EMAIL, apply: false });

    expect(summary.apply).toBe(false);
    expect(summary.ownerId).toBe(ownerId);
    // Exactly A's 2 sets + 1 book, deterministic slug/title order.
    expect(summary.audioToShare.map((s) => s.slug)).toEqual([
      'korean-folktales',
      'news-in-korean',
    ]);
    expect(summary.audioToShare.map((s) => s.title)).toEqual([
      'Korean Folktales',
      'News in Korean',
    ]);
    expect(summary.booksToShare.map((b) => b.title)).toEqual(['Korean Folktales (Book)']);
    expect(summary.audioAlreadyShared).toBe(0);
    expect(summary.booksAlreadyShared).toBe(0);
    // No UPDATE was issued at all.
    expect(summary.audioFlipped).toBe(0);
    expect(summary.booksFlipped).toBe(0);

    // The whole database is untouched: every row (A's AND B's) still false.
    const flags = await sharedFlags();
    expect(flags.audio.every((r) => !r.is_shared)).toBe(true);
    expect(flags.books.every((r) => !r.is_shared)).toBe(true);
  });

  it('excludes a pre-shared set from the candidates and counts it as already shared', async () => {
    await pg.pool.query(
      `UPDATE audio_sources SET is_shared = true WHERE user_id = $1 AND slug = $2`,
      [ownerId, 'korean-folktales'],
    );

    const summary = await runShareCorpus({ ownerEmail: OWNER_EMAIL, apply: false });
    expect(summary.audioToShare.map((s) => s.slug)).toEqual(['news-in-korean']);
    expect(summary.audioAlreadyShared).toBe(1);
    expect(summary.booksToShare).toHaveLength(1);
  });
});

describe('runShareCorpus — apply', () => {
  it("flips ONLY the owner's rows; the bystander's row stays private", async () => {
    const summary = await runShareCorpus({ ownerEmail: OWNER_EMAIL, apply: true });

    expect(summary.apply).toBe(true);
    expect(summary.audioFlipped).toBe(2);
    expect(summary.booksFlipped).toBe(1);
    expect(summary.audioToShare).toHaveLength(2);
    expect(summary.booksToShare).toHaveLength(1);

    const flags = await sharedFlags();
    // A's rows: all true.
    expect(
      flags.audio.filter((r) => r.user_id === ownerId).every((r) => r.is_shared),
    ).toBe(true);
    expect(
      flags.books.filter((r) => r.user_id === ownerId).every((r) => r.is_shared),
    ).toBe(true);
    // B's row: STILL false — owner scoping proven.
    const bRows = flags.audio.filter((r) => r.user_id === bystanderId);
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.is_shared).toBe(false);
  });

  it('is idempotent: a second apply flips 0 and reports everything already shared', async () => {
    await runShareCorpus({ ownerEmail: OWNER_EMAIL, apply: true });

    // Resolves cleanly (the CLI's exit-0 path) — no throw, zero flips.
    const second = await runShareCorpus({ ownerEmail: OWNER_EMAIL, apply: true });
    expect(second.audioFlipped).toBe(0);
    expect(second.booksFlipped).toBe(0);
    expect(second.audioToShare).toEqual([]);
    expect(second.booksToShare).toEqual([]);
    expect(second.audioAlreadyShared).toBe(2);
    expect(second.booksAlreadyShared).toBe(1);

    // And B is still untouched after both runs.
    const flags = await sharedFlags();
    expect(flags.audio.find((r) => r.user_id === bystanderId)!.is_shared).toBe(false);
  });

  it('trims + lowercases the owner email before resolving', async () => {
    const summary = await runShareCorpus({
      ownerEmail: `  ${OWNER_EMAIL.toUpperCase()}  `,
      apply: false,
    });
    expect(summary.ownerId).toBe(ownerId);
    expect(summary.ownerEmail).toBe(OWNER_EMAIL);
  });
});

describe('runShareCorpus — bad input (exit 2)', () => {
  it('an unknown email rejects with ShareCorpusInputError and changes nothing', async () => {
    await expect(
      runShareCorpus({ ownerEmail: 'nobody@example.com', apply: true }),
    ).rejects.toThrow(ShareCorpusInputError);

    const flags = await sharedFlags();
    expect(flags.audio.every((r) => !r.is_shared)).toBe(true);
    expect(flags.books.every((r) => !r.is_shared)).toBe(true);
  });

  it('an empty email rejects with ShareCorpusInputError', async () => {
    await expect(runShareCorpus({ ownerEmail: '   ', apply: true })).rejects.toThrow(
      ShareCorpusInputError,
    );
  });

  it('exitCodeFor maps bad input to 2 and any other failure to 1', () => {
    expect(exitCodeFor(new ShareCorpusInputError('no such user'))).toBe(2);
    expect(exitCodeFor(new Error('connection refused'))).toBe(1);
    expect(exitCodeFor('not-even-an-error')).toBe(1);
  });
});

describe('parseEnv (no DB)', () => {
  it('defaults to the seed-admin owner email and DRY RUN', () => {
    expect(parseEnv({})).toEqual({ ownerEmail: DEFAULT_OWNER_EMAIL, apply: false });
  });

  it('normalizes the email and gates apply on exactly "true"', () => {
    expect(
      parseEnv({ SHARE_CORPUS_OWNER_EMAIL: '  Owner@Example.COM ', SHARE_CORPUS_APPLY: 'TRUE' }),
    ).toEqual({ ownerEmail: 'owner@example.com', apply: true });
    expect(parseEnv({ SHARE_CORPUS_APPLY: '1' }).apply).toBe(false);
    expect(parseEnv({ SHARE_CORPUS_APPLY: 'yes' }).apply).toBe(false);
    expect(parseEnv({ SHARE_CORPUS_APPLY: '' }).apply).toBe(false);
  });
});
