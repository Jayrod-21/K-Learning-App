/**
 * jobRetention — best-effort retention sweeps for the ephemeral job-ledger
 * tables, against real Postgres (audit §1.4).
 *
 * Bar §"Testing": a DELETE with an age + status predicate and user scoping is
 * exactly the kind of thing a mock pool cannot prove — the interval math and
 * the terminal-status filter are the engine's, so we run them on a real
 * engine via testcontainers.
 *
 * Coverage per table (audio_transcription_jobs, story_audio_jobs,
 * story_image_jobs):
 *   - an OLD terminal row (finished_at past the window) is deleted;
 *   - a RECENT terminal row (finished_at inside the window) is kept;
 *   - a non-terminal row (pending/running, finished_at NULL) is kept even when
 *     its created_at is ancient — it could still be driven by a worker;
 *   - the sweep is strictly user-scoped: another user's old terminal row is
 *     untouched when sweeping the first user;
 *   - the returned count matches the rows actually deleted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { setPoolForTesting } from '../../src/db/pool.js';
import {
  JOB_RETENTION_DAYS,
  sweepAudioTranscriptionJobs,
  sweepFailedBookUploads,
  sweepStoryAudioJobs,
  sweepStoryImageJobs,
} from '../../src/services/jobRetention.js';

let pg: PgHandle;

const FAKE_HASH = `$argon2id$${'x'.repeat(70)}`;

/** A silent logger — the sweeps only ever info/warn, and we assert on the
 *  returned count and the DB state, not on log output. */
const nullLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as Logger;

/** Comfortably past / inside the retention window, expressed in days. */
const OLD_DAYS = JOB_RETENTION_DAYS + 10;
const RECENT_DAYS = 5;

beforeAll(async () => {
  pg = await startPostgres();
  setPoolForTesting(pg.pool);
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    `TRUNCATE TABLE audio_transcription_jobs, story_audio_jobs, story_image_jobs,
                    book_uploads, generated_stories, users RESTART IDENTITY CASCADE`,
  );
});

async function seedUser(email: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

async function seedStory(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO generated_stories (user_id, title, body_ko, level)
     VALUES ($1, 'T', '본문', 'basic')
     RETURNING id`,
    [userId],
  );
  return rows[0]!.id;
}

/** Insert one transcription job with an explicit status + finished-age. A
 *  NULL `finishedDaysAgo` leaves finished_at NULL (the in-flight shape). */
async function seedTranscriptionJob(
  userId: number,
  status: 'pending' | 'running' | 'done' | 'failed',
  finishedDaysAgo: number | null,
): Promise<void> {
  await pg.pool.query(
    `INSERT INTO audio_transcription_jobs (user_id, status, charged_bytes, finished_at)
     VALUES ($1, $2::audio_transcription_status, 1024,
             CASE WHEN $3::int IS NULL THEN NULL
                  ELSE now() - make_interval(days => $3::int) END)`,
    [userId, status, finishedDaysAgo],
  );
}

async function seedStoryAudioJob(
  userId: number,
  storyId: number,
  status: 'pending' | 'running' | 'done' | 'failed',
  finishedDaysAgo: number | null,
): Promise<void> {
  await pg.pool.query(
    `INSERT INTO story_audio_jobs (generated_story_id, user_id, status, char_count, finished_at)
     VALUES ($1, $2, $3, 100,
             CASE WHEN $4::int IS NULL THEN NULL
                  ELSE now() - make_interval(days => $4::int) END)`,
    [storyId, userId, status, finishedDaysAgo],
  );
}

async function seedStoryImageJob(
  userId: number,
  storyId: number,
  status: 'pending' | 'running' | 'done' | 'failed',
  finishedDaysAgo: number | null,
): Promise<void> {
  await pg.pool.query(
    `INSERT INTO story_image_jobs (generated_story_id, user_id, status, image_count, finished_at)
     VALUES ($1, $2, $3, 2,
             CASE WHEN $4::int IS NULL THEN NULL
                  ELSE now() - make_interval(days => $4::int) END)`,
    [storyId, userId, status, finishedDaysAgo],
  );
}

async function countTranscriptionJobs(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audio_transcription_jobs WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]!.n);
}

async function countStoryAudioJobs(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM story_audio_jobs WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]!.n);
}

async function countStoryImageJobs(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM story_image_jobs WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]!.n);
}

let bookUploadTitleCounter = 0;

/** Insert one book_uploads row with an explicit status + finished-age. A
 *  NULL `finishedDaysAgo` leaves finished_at NULL (pending/processing's
 *  in-flight shape — Phase 2.5). Title must be unique per (user, title); a
 *  counter keeps every seeded row distinct within one test. */
async function seedBookUploadRow(
  userId: number,
  status: 'pending' | 'processing' | 'ready' | 'failed',
  finishedDaysAgo: number | null,
): Promise<void> {
  bookUploadTitleCounter += 1;
  await pg.pool.query(
    `INSERT INTO book_uploads (user_id, title, type, status, byte_size, finished_at)
     VALUES ($1, $2, 'vocab', $3::book_upload_status, 1024,
             CASE WHEN $4::int IS NULL THEN NULL
                  ELSE now() - make_interval(days => $4::int) END)`,
    [userId, `retention-test-${bookUploadTitleCounter}`, status, finishedDaysAgo],
  );
}

async function countBookUploads(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM book_uploads WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]!.n);
}

describe('sweepAudioTranscriptionJobs', () => {
  it('deletes old terminal rows, keeps recent + in-flight, and is user-scoped', async () => {
    const userId = await seedUser('atj-owner@example.com');
    const other = await seedUser('atj-other@example.com');

    await seedTranscriptionJob(userId, 'done', OLD_DAYS); // deleted
    await seedTranscriptionJob(userId, 'failed', OLD_DAYS); // deleted
    await seedTranscriptionJob(userId, 'done', RECENT_DAYS); // kept — recent
    await seedTranscriptionJob(userId, 'pending', null); // kept — in-flight
    await seedTranscriptionJob(userId, 'running', null); // kept — in-flight
    await seedTranscriptionJob(other, 'done', OLD_DAYS); // kept — other user

    const deleted = await sweepAudioTranscriptionJobs(userId, nullLog);

    expect(deleted).toBe(2);
    expect(await countTranscriptionJobs(userId)).toBe(3);
    expect(await countTranscriptionJobs(other)).toBe(1);
  });

  it('is idempotent — a second sweep deletes nothing', async () => {
    const userId = await seedUser('atj-idem@example.com');
    await seedTranscriptionJob(userId, 'done', OLD_DAYS);

    expect(await sweepAudioTranscriptionJobs(userId, nullLog)).toBe(1);
    expect(await sweepAudioTranscriptionJobs(userId, nullLog)).toBe(0);
  });

  it('brackets the retention cutoff at JOB_RETENTION_DAYS (±1h): the nearer row is kept, the farther deleted', async () => {
    // Straddle the cutoff with two rows an hour on either side of
    // `now() - make_interval(days => JOB_RETENTION_DAYS)`: one finished 1h INSIDE
    // the window (expected kept) and one 1h OUTSIDE it (expected deleted). Both
    // ages are pinned by an explicit interval rather than the current instant, so
    // this avoids the seed/sweep timing race that seeding *exactly* on the line
    // would hit (the sweep's own `now()` runs just after the seed's, so an
    // exactly-on-line row always reads as marginally older and "kept" would
    // falsely fail). This brackets the cutoff tightly enough to catch a
    // wrong-magnitude or wrong-unit regression in the interval math (e.g. days↔
    // hours, or a changed window size); it deliberately does NOT try to
    // distinguish `<` from `<=` — neither row sits exactly on the line, and the
    // exact-boundary instant is not reproducible here without flaking.
    const userId = await seedUser('atj-boundary@example.com');

    await pg.pool.query(
      `INSERT INTO audio_transcription_jobs (user_id, status, charged_bytes, finished_at)
       VALUES ($1, 'done', 1024, now() - make_interval(days => $2::int) + interval '1 hour')`,
      [userId, JOB_RETENTION_DAYS], // finished 1h short of the window — kept
    );
    await pg.pool.query(
      `INSERT INTO audio_transcription_jobs (user_id, status, charged_bytes, finished_at)
       VALUES ($1, 'done', 1024, now() - make_interval(days => $2::int) - interval '1 hour')`,
      [userId, JOB_RETENTION_DAYS], // finished 1h past the window — deleted
    );

    const deleted = await sweepAudioTranscriptionJobs(userId, nullLog);

    expect(deleted).toBe(1);
    expect(await countTranscriptionJobs(userId)).toBe(1);
  });
});

describe('sweepStoryAudioJobs', () => {
  it('deletes old terminal rows, keeps recent + in-flight, and is user-scoped', async () => {
    const userId = await seedUser('saj-owner@example.com');
    const other = await seedUser('saj-other@example.com');
    const story = await seedStory(userId);
    const otherStory = await seedStory(other);

    await seedStoryAudioJob(userId, story, 'done', OLD_DAYS); // deleted
    await seedStoryAudioJob(userId, story, 'failed', OLD_DAYS); // deleted
    await seedStoryAudioJob(userId, story, 'done', RECENT_DAYS); // kept — recent
    await seedStoryAudioJob(userId, story, 'pending', null); // kept — in-flight
    await seedStoryAudioJob(other, otherStory, 'done', OLD_DAYS); // kept — other user

    const deleted = await sweepStoryAudioJobs(userId, nullLog);

    expect(deleted).toBe(2);
    expect(await countStoryAudioJobs(userId)).toBe(2);
    expect(await countStoryAudioJobs(other)).toBe(1);
  });
});

describe('sweepStoryImageJobs', () => {
  it('deletes old terminal rows, keeps recent + in-flight, and is user-scoped', async () => {
    const userId = await seedUser('sij-owner@example.com');
    const other = await seedUser('sij-other@example.com');
    const story = await seedStory(userId);
    const otherStory = await seedStory(other);

    await seedStoryImageJob(userId, story, 'done', OLD_DAYS); // deleted
    await seedStoryImageJob(userId, story, 'failed', OLD_DAYS); // deleted
    await seedStoryImageJob(userId, story, 'done', RECENT_DAYS); // kept — recent
    await seedStoryImageJob(userId, story, 'running', null); // kept — in-flight
    await seedStoryImageJob(other, otherStory, 'failed', OLD_DAYS); // kept — other user

    const deleted = await sweepStoryImageJobs(userId, nullLog);

    expect(deleted).toBe(2);
    expect(await countStoryImageJobs(userId)).toBe(2);
    expect(await countStoryImageJobs(other)).toBe(1);
  });
});

describe('sweepFailedBookUploads (Phase 2.5 — async book-ingest pipeline)', () => {
  it('deletes old FAILED rows, keeps recent-failed + ready + in-flight, and is user-scoped', async () => {
    const userId = await seedUser('bu-owner@example.com');
    const other = await seedUser('bu-other@example.com');

    await seedBookUploadRow(userId, 'failed', OLD_DAYS); // deleted
    await seedBookUploadRow(userId, 'failed', RECENT_DAYS); // kept — recent
    // A 'ready' upload is the user's actual content — NEVER swept by age,
    // unlike the job-ledger tables above (book_uploads IS the asset here,
    // not a row that merely records a job ran).
    await seedBookUploadRow(userId, 'ready', OLD_DAYS); // kept — ready, however old
    await seedBookUploadRow(userId, 'pending', null); // kept — in-flight
    await seedBookUploadRow(userId, 'processing', null); // kept — in-flight
    await seedBookUploadRow(other, 'failed', OLD_DAYS); // kept — other user

    const deleted = await sweepFailedBookUploads(userId, nullLog);

    expect(deleted).toBe(1);
    expect(await countBookUploads(userId)).toBe(4);
    expect(await countBookUploads(other)).toBe(1);
  });

  it('is idempotent — a second sweep deletes nothing', async () => {
    const userId = await seedUser('bu-idem@example.com');
    await seedBookUploadRow(userId, 'failed', OLD_DAYS);

    expect(await sweepFailedBookUploads(userId, nullLog)).toBe(1);
    expect(await sweepFailedBookUploads(userId, nullLog)).toBe(0);
  });
});

describe('runSweep best-effort failure isolation', () => {
  it('resolves 0 and does not throw when the underlying query rejects', async () => {
    // The module's core safety property: a sweep is housekeeping riding the
    // caller's read, so a failing DELETE (connection blip, statement
    // timeout, ...) must never surface as a thrown/rejected error — it must
    // be swallowed and reported as "0 swept". Prove it by installing a pool
    // whose query() always rejects, then restore the real testcontainer pool
    // in `finally` so later tests aren't affected by this substitution.
    const throwingPool = {
      query: async () => {
        throw new Error('simulated connection failure');
      },
      on: () => {},
    } as unknown as Pool;

    try {
      setPoolForTesting(throwingPool);

      const userId = 1; // never reached — the query rejects before WHERE user_id = $1 matters
      await expect(sweepAudioTranscriptionJobs(userId, nullLog)).resolves.toBe(0);
      await expect(sweepStoryAudioJobs(userId, nullLog)).resolves.toBe(0);
      await expect(sweepStoryImageJobs(userId, nullLog)).resolves.toBe(0);
    } finally {
      setPoolForTesting(pg.pool);
    }
  });
});
