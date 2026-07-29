/**
 * Integration tests for /audio routes (Track A, A-3 — the server-side audio
 * upload path: store an owned audio blob + enqueue a Whisper transcription
 * job for the A-2 km-worker).
 *
 * Routes:
 *   POST /audio
 *   GET  /audio
 *   GET  /audio/shared              (F-207 — curated shared sets, read-only)
 *   GET  /audio/tracks/:id          (A-4a — track detail + ordered segments)
 *   GET  /audio/tracks/:id/stream   (A-4a — user-scoped Range-capable bytes)
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in).
 * The blob store points at a throwaway temp dir (AUDIO_UPLOAD_STORAGE_DIR is
 * env-injected before buildTestApp) — never any real storage. The per-file
 * and per-day caps are shrunk via env (AUDIO_UPLOAD_MAX_BYTES /
 * AUDIO_TRANSCRIBE_DAILY_BYTES_CAP) so the cap tests move kilobytes, not
 * hundreds of megabytes.
 *
 * Coverage:
 *   - auth required on both routes (401 unauthenticated)
 *   - POST happy path (mp3, ID3-tagged): 201 + audio_sources (standalone,
 *     unlinked, processing) + audio_tracks (track 1, pending, byte_size) +
 *     audio_transcription_jobs (pending, charged_bytes = byte_size) all owned
 *     by the caller, blob on disk with the exact bytes at a server-generated
 *     `{userId}/{uuid}.mp3` path
 *   - POST happy path (m4a `M4A ` brand; also `isom`) → `.m4a` blob
 *   - POST happy path (bare MPEG frame-sync mp3, no ID3 tag)
 *   - magic-byte authority: a text payload named `.mp3` with an audio declared
 *     mime → 400, NO rows in any of the three tables, NO blob on disk
 *   - declared-mime early reject (text/plain) → 400
 *   - missing file → 400; extra body field → 400 (.strict() mass-assignment)
 *   - size cap: over AUDIO_UPLOAD_MAX_BYTES → 413, no rows
 *   - daily bytes cap: today's charged_bytes near the cap → next upload 429
 *     BEFORE any write (no new rows, no blob); a smaller upload that fits →
 *     201; exact-boundary (used + bytes == cap) → 201 (strict >); failed
 *     jobs count (cost stance)
 *   - daily upload-COUNT cap: cap-many tiny jobs today → 429 before any
 *     write; one slot left → 201; cross-user isolation
 *   - day boundary: a full-cap seed dated YESTERDAY (bytes + count) → 201
 *     (pins the created_at >= date_trunc('day', now()) predicate)
 *   - GET /audio user-scoping: user A never sees user B's sources (IDOR);
 *     newest-first ordering; bounded to the 50 most recent sources; no
 *     source-level `status` in the DTO (per-track transcript_status only)
 *   - tx atomicity: a blob-write failure mid-transaction → 500 with NO
 *     partial rows in any table and NO blob on disk; a row-INSERT failure
 *     AFTER the blob write → rollback + the orphan blob is unlinked
 *   - A-4a stream: 200 full body (exact bytes) with audio/mpeg + nosniff +
 *     Accept-Ranges + Content-Length; m4a → audio/mp4; Range → 206 + correct
 *     Content-Range + exact partial bytes (bounded, open-ended, suffix);
 *     unsatisfiable Range → 416 with total-size Content-Range; IDOR (user B
 *     can NEVER stream user A's track → uniform 404); blob file deleted
 *     under a live row → 404 (not 500); malformed :id → 400
 *   - A-4a detail: happy path (done track → ordered camelCase segments +
 *     streamUrl + transcriptStatus + durationMs); IDOR → 404; a
 *     not-yet-transcribed track → segments: [] (normal state, not an error);
 *     nonexistent id → 404
 *   - F-207 shared corpus (the access-control threat-model tests, plan §5):
 *     a non-owner can LIST /audio/shared and STREAM/READ a shared set's
 *     tracks (200 + exact bytes); a non-owner still 404s uniformly on the
 *     owner's PRIVATE tracks (per-source flag — sharing one set opens no
 *     sibling); NO mutation surface exists for audio rows and the upload
 *     path cannot set is_shared (.strict() mass-assignment → 400, share-flag
 *     hijack impossible); the owner's shared set leaves their "My Audio"
 *     list (decision #2) while private uploads remain; the /audio/shared DTO
 *     carries NO owner identity (exact-key assertions + response-text scan)
 */
import os from 'node:os';
import path from 'node:path';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedAudioSegment, seedAudioTranscriptionJob } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

// Wrap the REAL audioStore in pass-through vi.fn()s so the atomicity test can
// inject a single blob-write failure while every other test exercises real
// filesystem I/O (mirrors uploads.test.ts's module-mock approach).
vi.mock('../../src/services/audioStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/audioStore.js')>();
  return { ...actual, saveBlob: vi.fn(actual.saveBlob) };
});
// Same treatment for withTransaction, so the orphan-blob test can wrap ONE
// transaction's client to fail a specific INSERT *after* the blob write —
// everything else (query, pool lifecycle) stays real.
vi.mock('../../src/db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pool.js')>();
  return { ...actual, withTransaction: vi.fn(actual.withTransaction) };
});
import { saveBlob } from '../../src/services/audioStore.js';
import { withTransaction } from '../../src/db/pool.js';

// The unmocked implementations, for restoring pass-through behavior in
// beforeEach and for the orphan-blob test's real-transaction wrapper.
// Loaded in beforeAll (no top-level await under this tsconfig's module mode).
let actualAudioStore: typeof import('../../src/services/audioStore.js');
let actualDbPool: typeof import('../../src/db/pool.js');

let pg: PgHandle;
let t: TestApp;

/** Shrunken caps for the suite (env-injected before buildTestApp). */
const MAX_FILE_BYTES = 64 * 1024; // 64 KiB per file
const DAILY_CAP_BYTES = 128 * 1024; // 128 KiB per user per day
const DAILY_COUNT_CAP = 3; // uploads per user per day (small, but > the 2-upload tests)

/** A deterministic fake mp3 of exactly `totalBytes`: a real ID3v2 header
 *  (the magic-byte sniff's authority) + 0x55 padding. */
function fakeMp3(totalBytes = 2048): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // "ID3"…
  return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length), 0x55)]);
}

/** A tagless mp3 opening directly on an MPEG frame header (0xFF 0xFB =
 *  sync + MPEG-1 Layer III) — the other valid mp3 shape. */
function fakeFrameSyncMp3(totalBytes = 2048): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length), 0x33)]);
}

/** A deterministic fake m4a: 4-byte box size + `ftyp` + a major brand. */
function fakeM4a(brand = 'M4A ', totalBytes = 2048): Buffer {
  const header = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand, 'latin1'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
  ]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length), 0x44)]);
}

beforeAll(async () => {
  actualAudioStore = await vi.importActual<typeof import('../../src/services/audioStore.js')>(
    '../../src/services/audioStore.js',
  );
  actualDbPool = await vi.importActual<typeof import('../../src/db/pool.js')>(
    '../../src/db/pool.js',
  );
  pg = await startPostgres();
  // Throwaway blob root + shrunken caps, set BEFORE buildTestApp so the
  // config parse picks them up (each has a default otherwise).
  process.env.AUDIO_UPLOAD_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-audio-test-${process.pid}-${Date.now()}`,
  );
  process.env.AUDIO_UPLOAD_MAX_BYTES = String(MAX_FILE_BYTES);
  process.env.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP = String(DAILY_CAP_BYTES);
  process.env.AUDIO_UPLOAD_DAILY_COUNT_CAP = String(DAILY_COUNT_CAP);
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  delete process.env.AUDIO_UPLOAD_STORAGE_DIR;
  delete process.env.AUDIO_UPLOAD_MAX_BYTES;
  delete process.env.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP;
  delete process.env.AUDIO_UPLOAD_DAILY_COUNT_CAP;
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  // users CASCADE clears audio_sources (user FK) → audio_tracks (source FK)
  // and audio_transcription_jobs (user FK). RESTART IDENTITY keeps ids small.
  await pg.pool.query(
    'TRUNCATE TABLE audio_transcription_jobs, audio_sources, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
  // Mock hygiene: mockReset() (NOT mockClear()) — only mockReset discards a
  // queued mockRejectedValueOnce/mockImplementationOnce left behind by a test
  // that bailed before consuming it (mockClear only clears call state, so a
  // leaked Once would poison the NEXT test's first upload with a baffling
  // 500). Then explicitly restore the real pass-through implementations so no
  // vitest-version nuance about what mockReset restores can bite.
  vi.mocked(saveBlob).mockReset();
  vi.mocked(saveBlob).mockImplementation(actualAudioStore.saveBlob);
  vi.mocked(withTransaction).mockReset();
  vi.mocked(withTransaction).mockImplementation(actualDbPool.withTransaction);
});

/** Count of regular files anywhere under the suite's blob root (0 if the
 *  root doesn't exist yet — nothing has been written). */
async function blobFileCount(): Promise<number> {
  try {
    const entries = await readdir(process.env.AUDIO_UPLOAD_STORAGE_DIR!, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.filter((e) => e.isFile()).length;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 0;
    throw err;
  }
}

async function rowCount(table: 'audio_sources' | 'audio_tracks' | 'audio_transcription_jobs') {
  const { rows } = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

describe('audio — auth required', () => {
  it.each([
    ['GET', '/audio'],
    ['POST', '/audio'],
    ['GET', '/audio/shared'],
    ['GET', '/audio/tracks/1'],
    ['GET', '/audio/tracks/1/stream'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const res = method === 'GET' ? await request(t.app).get(p) : await request(t.app).post(p);
    expect(res.status).toBe(401);
  });
});

describe('POST /audio — happy paths', () => {
  it('uploads an ID3-tagged mp3: 201 + source/track/job rows + the blob on disk (exact bytes)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(4096);

    const res = await agent
      .post('/audio')
      .field('title', 'Folktale 01')
      .attach('file', bytes, { filename: 'folktale-01.mp3', contentType: 'audio/mpeg' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sourceId: expect.any(Number),
      trackId: expect.any(Number),
      jobId: expect.any(Number),
      transcriptStatus: 'pending',
    });

    // audio_sources: a standalone, unlinked set owned by the caller.
    const src = await pg.pool.query<{
      user_id: string;
      slug: string;
      title: string;
      kind: string;
      source_upload_id: string | null;
      status: string;
    }>(
      `SELECT user_id, slug, title, kind, source_upload_id, status
         FROM audio_sources WHERE id = $1`,
      [res.body.sourceId],
    );
    expect(src.rows[0]).toMatchObject({
      user_id: String(userId),
      title: 'Folktale 01',
      kind: 'standalone_listening',
      source_upload_id: null,
      status: 'processing',
    });
    expect(src.rows[0]!.slug).toMatch(/^upload-[0-9a-f-]{36}$/);

    // audio_tracks: track 1, pending, byte-accurate, server-generated blob_ref.
    const trk = await pg.pool.query<{
      source_id: string;
      user_id: string;
      track_number: number;
      blob_ref: string;
      byte_size: string;
      transcript_status: string;
    }>(
      `SELECT source_id, user_id, track_number, blob_ref, byte_size, transcript_status
         FROM audio_tracks WHERE id = $1`,
      [res.body.trackId],
    );
    expect(trk.rows[0]).toMatchObject({
      source_id: String(res.body.sourceId),
      user_id: String(userId),
      track_number: 1,
      byte_size: String(bytes.length),
      transcript_status: 'pending',
    });
    expect(trk.rows[0]!.blob_ref).toMatch(new RegExp(`^${userId}/[0-9a-f-]{36}\\.mp3$`));

    // audio_transcription_jobs: the worker's pending claim, charged at enqueue.
    const job = await pg.pool.query<{
      track_id: string;
      user_id: string;
      status: string;
      charged_bytes: string;
    }>(
      `SELECT track_id, user_id, status, charged_bytes
         FROM audio_transcription_jobs WHERE id = $1`,
      [res.body.jobId],
    );
    expect(job.rows[0]).toEqual({
      track_id: String(res.body.trackId),
      user_id: String(userId),
      status: 'pending',
      charged_bytes: String(bytes.length),
    });

    // The blob is on disk with the exact uploaded bytes.
    const onDisk = await readFile(
      path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, trk.rows[0]!.blob_ref),
    );
    expect(Buffer.compare(onDisk, bytes)).toBe(0);
  });

  it('uploads an m4a (M4A brand) → 201 with a .m4a blob', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const bytes = fakeM4a('M4A ');
    const res = await agent
      .post('/audio')
      .field('title', 'Folktale m4a')
      .attach('file', bytes, { filename: 'folktale.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    const trk = await pg.pool.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM audio_tracks WHERE id = $1`,
      [res.body.trackId],
    );
    expect(trk.rows[0]!.blob_ref).toMatch(new RegExp(`^${userId}/[0-9a-f-]{36}\\.m4a$`));
  });

  it('accepts the generic isom major brand as m4a', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/audio')
      .attach('file', fakeM4a('isom'), { filename: 'a.m4a', contentType: 'audio/x-m4a' });
    expect(res.status).toBe(201);
  });

  it('accepts a tagless mp3 that opens on a bare MPEG frame header', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/audio')
      .attach('file', fakeFrameSyncMp3(), { filename: 'raw.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
  });

  it('defaults the title when the optional field is omitted', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/audio')
      .attach('file', fakeMp3(), { filename: 'untitled.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
    const src = await pg.pool.query<{ title: string }>(
      `SELECT title FROM audio_sources WHERE id = $1`,
      [res.body.sourceId],
    );
    // Server-side fallback — never the client filename.
    expect(src.rows[0]!.title).toMatch(/^Audio upload \d{4}-\d{2}-\d{2}$/);
  });
});

describe('POST /audio — rejects (content authority, caps, validation)', () => {
  it('rejects a non-audio payload named .mp3 with an audio declared mime (400) — magic bytes, not extension — writing NOTHING', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // The blob root is shared across this file's tests (earlier happy-path
    // uploads leave files behind), so "wrote nothing" is asserted as an
    // unchanged COUNT, not an empty dir.
    const blobsBefore = await blobFileCount();
    const res = await agent
      .post('/audio')
      .attach('file', Buffer.from('definitely not audio, just text pretending'), {
        filename: 'sneaky.mp3',
        contentType: 'audio/mpeg',
      });
    expect(res.status).toBe(400);
    expect(await rowCount('audio_sources')).toBe(0);
    expect(await rowCount('audio_tracks')).toBe(0);
    expect(await rowCount('audio_transcription_jobs')).toBe(0);
    expect(await blobFileCount()).toBe(blobsBefore);
  });

  it('rejects a PNG payload regardless of name/mime (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await agent
      .post('/audio')
      .attach('file', png, { filename: 'image.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(400);
    expect(await rowCount('audio_sources')).toBe(0);
  });

  it('rejects a disallowed declared mime at the fileFilter (400) and names the real reason', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/audio')
      .attach('file', fakeMp3(), { filename: 'a.mp3', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    // The 400 says WHY (the declared mime was rejected), not the misleading
    // "file is required" — the fileFilter stamps the dropped mime on the req.
    expect(res.body.error.message).toContain('text/plain');
    expect(res.body.error.message).toContain('not an accepted audio type');
    expect(await rowCount('audio_sources')).toBe(0);
  });

  it('rejects a missing file (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/audio').field('title', 'no file here');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown extra body field (400, .strict() mass-assignment defense)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/audio')
      .field('title', 'ok')
      .field('status', 'ready') // smuggle attempt
      .attach('file', fakeMp3(), { filename: 'a.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(400);
    expect(await rowCount('audio_sources')).toBe(0);
  });

  it('rejects a file over AUDIO_UPLOAD_MAX_BYTES (413), writing nothing', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const blobsBefore = await blobFileCount();
    const res = await agent
      .post('/audio')
      .attach('file', fakeMp3(MAX_FILE_BYTES + 1), {
        filename: 'big.mp3',
        contentType: 'audio/mpeg',
      });
    expect(res.status).toBe(413);
    expect(await rowCount('audio_sources')).toBe(0);
    expect(await rowCount('audio_tracks')).toBe(0);
    expect(await rowCount('audio_transcription_jobs')).toBe(0);
    expect(await blobFileCount()).toBe(blobsBefore);
  });
});

describe('POST /audio — per-user daily transcription-bytes cap', () => {
  it('429s BEFORE any write once today’s charged bytes + this file exceed the cap; a smaller file that fits still succeeds', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Seed today's spend to (cap - 500) — the ledger sums charged_bytes by
    // user_id alone (a NULL-track row is a legal deleted-track ledger entry,
    // migration 076). Seeded as status='failed' ON PURPOSE: the cap is a COST
    // control and a failed run spent CPU too, so failed jobs must count.
    await seedAudioTranscriptionJob(pg.pool, userId, {
      chargedBytes: DAILY_CAP_BYTES - 500,
      status: 'failed',
    });
    const blobsBefore = await blobFileCount();

    // 1000 bytes would exceed the cap → 429, nothing written.
    const over = await agent
      .post('/audio')
      .attach('file', fakeMp3(1000), { filename: 'over.mp3', contentType: 'audio/mpeg' });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('rate_limited');
    expect(await rowCount('audio_sources')).toBe(0);
    expect(await rowCount('audio_tracks')).toBe(0);
    expect(await rowCount('audio_transcription_jobs')).toBe(1); // only the seed
    expect(await blobFileCount()).toBe(blobsBefore);

    // 400 bytes fits under the remaining 500 → 201.
    const fits = await agent
      .post('/audio')
      .attach('file', fakeMp3(400), { filename: 'fits.mp3', contentType: 'audio/mpeg' });
    expect(fits.status).toBe(201);
    expect(await rowCount('audio_transcription_jobs')).toBe(2);
  });

  it("one user's spend never caps another user", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await seedAudioTranscriptionJob(pg.pool, a.userId, { chargedBytes: DAILY_CAP_BYTES });
    const res = await b.agent
      .post('/audio')
      .attach('file', fakeMp3(1000), { filename: 'b.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
  });

  it('a file that lands EXACTLY on the bytes cap is accepted (the check is strict >)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // used + fileBytes == cap must pass: the route rejects only when the
    // total EXCEEDS the cap.
    await seedAudioTranscriptionJob(pg.pool, userId, { chargedBytes: DAILY_CAP_BYTES - 1000 });
    const res = await agent
      .post('/audio')
      .attach('file', fakeMp3(1000), { filename: 'exact.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
  });

  it("yesterday's spend does not count: a full-cap seed dated yesterday still 201s (day-boundary predicate)", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Saturate BOTH caps with YESTERDAY's rows — full bytes budget AND the
    // full upload count. If the `created_at >= date_trunc('day', now())`
    // predicate were dropped (turning the daily caps into all-time caps),
    // this upload would 429; a 201 proves the ledger window is TODAY only.
    for (let i = 0; i < DAILY_COUNT_CAP; i += 1) {
      await seedAudioTranscriptionJob(pg.pool, userId, {
        chargedBytes: Math.ceil(DAILY_CAP_BYTES / DAILY_COUNT_CAP),
        createdAt: yesterday,
      });
    }
    const res = await agent
      .post('/audio')
      .attach('file', fakeMp3(1000), { filename: 'fresh.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
  });
});

describe('POST /audio — per-user daily upload-COUNT cap', () => {
  it('429s BEFORE any write once today already holds cap-many jobs, however few bytes they spent', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Tiny-file flood shape: cap-many jobs that together barely dent the
    // BYTES budget — only the COUNT cap can refuse the next one. One seed is
    // 'failed' on purpose (failed runs spent worker effort; they count).
    await seedAudioTranscriptionJob(pg.pool, userId, { chargedBytes: 100, status: 'failed' });
    for (let i = 1; i < DAILY_COUNT_CAP; i += 1) {
      await seedAudioTranscriptionJob(pg.pool, userId, { chargedBytes: 100 });
    }
    const blobsBefore = await blobFileCount();

    const res = await agent
      .post('/audio')
      .attach('file', fakeMp3(1000), { filename: 'one-too-many.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.body.error.message).toContain('upload limit');
    expect(await rowCount('audio_sources')).toBe(0);
    expect(await rowCount('audio_tracks')).toBe(0);
    expect(await rowCount('audio_transcription_jobs')).toBe(DAILY_COUNT_CAP); // only the seeds
    expect(await blobFileCount()).toBe(blobsBefore);
  });

  it('one job under the count cap still uploads (and cross-user counts stay isolated)', async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    for (let i = 0; i < DAILY_COUNT_CAP - 1; i += 1) {
      await seedAudioTranscriptionJob(pg.pool, a.userId, { chargedBytes: 100 });
    }
    // A has one slot left → 201; B is untouched by A's count → 201.
    const aRes = await a.agent
      .post('/audio')
      .attach('file', fakeMp3(1000), { filename: 'last-slot.mp3', contentType: 'audio/mpeg' });
    expect(aRes.status).toBe(201);
    const bRes = await b.agent
      .post('/audio')
      .attach('file', fakeMp3(1000), { filename: 'b.mp3', contentType: 'audio/mpeg' });
    expect(bRes.status).toBe(201);
  });
});

describe('GET /audio — user-scoped listing', () => {
  it('returns an empty list for a fresh user (200)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/audio');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sources: [] });
  });

  it("lists only the caller's sources with per-track transcript status (IDOR: A never sees B)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);

    const aUp = await a.agent
      .post('/audio')
      .field('title', 'A audio')
      .attach('file', fakeMp3(1200), { filename: 'a.mp3', contentType: 'audio/mpeg' });
    expect(aUp.status).toBe(201);
    const bUp = await b.agent
      .post('/audio')
      .field('title', 'B audio')
      .attach('file', fakeM4a(), { filename: 'b.m4a', contentType: 'audio/mp4' });
    expect(bUp.status).toBe(201);

    const aList = await a.agent.get('/audio');
    expect(aList.status).toBe(200);
    expect(aList.body.sources).toHaveLength(1);
    const aSrc = aList.body.sources[0];
    expect(aSrc).toMatchObject({
      id: aUp.body.sourceId,
      title: 'A audio',
      kind: 'standalone_listening',
    });
    // No source-level `status` in the DTO: the raw column pins to
    // 'processing' for uploads (nothing settles it after enqueue), so the API
    // deliberately exposes only per-track transcript_status — the truth.
    expect(aSrc).not.toHaveProperty('status');
    expect(aSrc.tracks).toEqual([
      {
        id: aUp.body.trackId,
        track_number: 1,
        title: 'A audio',
        byte_size: 1200,
        duration_ms: null,
        transcript_status: 'pending',
      },
    ]);

    const bList = await b.agent.get('/audio');
    expect(bList.body.sources).toHaveLength(1);
    expect(bList.body.sources[0].id).toBe(bUp.body.sourceId);
    expect(bList.body.sources[0].title).toBe('B audio');
  });

  it('lists sources newest first', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const first = await agent
      .post('/audio')
      .field('title', 'older')
      .attach('file', fakeMp3(), { filename: '1.mp3', contentType: 'audio/mpeg' });
    const second = await agent
      .post('/audio')
      .field('title', 'newer')
      .attach('file', fakeMp3(), { filename: '2.mp3', contentType: 'audio/mpeg' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const list = await agent.get('/audio');
    expect(list.status).toBe(200);
    expect(list.body.sources.map((s: { id: number }) => s.id)).toEqual([
      second.body.sourceId,
      first.body.sourceId,
    ]);
  });

  it('bounds the listing to the 50 most recent sources', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Seed 55 sources directly (no uploads — the LIMIT is about lifetime row
    // growth, not the upload path). Same-timestamp rows are fine: the ORDER
    // BY tiebreaks on id DESC.
    await pg.pool.query(
      `INSERT INTO audio_sources (user_id, slug, title, kind, source_upload_id, status)
       SELECT $1, 'bulk-' || g, 'Bulk ' || g, 'standalone_listening', NULL, 'processing'
         FROM generate_series(1, 55) AS g`,
      [userId],
    );
    const list = await agent.get('/audio');
    expect(list.status).toBe(200);
    expect(list.body.sources).toHaveLength(50);
    // Newest-first: the highest ids (the most recently inserted) survive the
    // bound, in descending order.
    const ids = list.body.sources.map((s: { id: number }) => s.id);
    expect(ids[0]).toBeGreaterThan(ids[49]!);
    expect([...ids].sort((x: number, y: number) => y - x)).toEqual(ids);
  });
});

describe('POST /audio — transaction atomicity', () => {
  it('a blob-write failure mid-transaction leaves NO partial rows and NO blob (500)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const blobsBefore = await blobFileCount();
    vi.mocked(saveBlob).mockRejectedValueOnce(new Error('simulated disk failure'));

    const res = await agent
      .post('/audio')
      .field('title', 'doomed')
      .attach('file', fakeMp3(), { filename: 'doomed.mp3', contentType: 'audio/mpeg' });

    expect(res.status).toBe(500);
    // The audio_sources INSERT ran BEFORE the blob write inside the same
    // transaction — the rollback must have erased it along with everything else.
    expect(await rowCount('audio_sources')).toBe(0);
    expect(await rowCount('audio_tracks')).toBe(0);
    expect(await rowCount('audio_transcription_jobs')).toBe(0);
    expect(await blobFileCount()).toBe(blobsBefore);

    // And the failure is transient state, not poison: the next upload works.
    const retry = await agent
      .post('/audio')
      .field('title', 'recovered')
      .attach('file', fakeMp3(), { filename: 'ok.mp3', contentType: 'audio/mpeg' });
    expect(retry.status).toBe(201);
  });

  it('a row-INSERT failure AFTER the blob hit disk rolls back the rows AND unlinks the orphan blob (500)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const blobsBefore = await blobFileCount();

    // Run ONE real transaction whose client fails the audio_tracks INSERT —
    // i.e. AFTER saveBlob wrote real bytes to disk. The route only uses
    // client.query inside the closure, so a thin wrapper suffices; BEGIN/
    // COMMIT/ROLLBACK still run on the real client inside the real
    // withTransaction.
    vi.mocked(withTransaction).mockImplementationOnce(async (fn) =>
      actualDbPool.withTransaction(async (client) => {
        const failingClient = {
          query: (...args: unknown[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            if (sql.includes('INSERT INTO audio_tracks')) {
              return Promise.reject(new Error('simulated audio_tracks INSERT failure'));
            }
            return (client.query as (...qArgs: unknown[]) => Promise<unknown>)(...args);
          },
        } as unknown as typeof client;
        return fn(failingClient);
      }),
    );

    const res = await agent
      .post('/audio')
      .field('title', 'doomed after blob')
      .attach('file', fakeMp3(), { filename: 'doomed2.mp3', contentType: 'audio/mpeg' });

    expect(res.status).toBe(500);
    // The blob WAS written (saveBlob ran) …
    expect(vi.mocked(saveBlob)).toHaveBeenCalledTimes(1);
    // … but the rollback erased every row, and the catch-block cleanup
    // unlinked the now-orphaned file — disk is back at baseline. A
    // regression here silently accumulates orphan blobs.
    expect(await rowCount('audio_sources')).toBe(0);
    expect(await rowCount('audio_tracks')).toBe(0);
    expect(await rowCount('audio_transcription_jobs')).toBe(0);
    expect(await blobFileCount()).toBe(blobsBefore);

    // Transient, not poison: the next upload works end-to-end.
    const retry = await agent
      .post('/audio')
      .field('title', 'recovered again')
      .attach('file', fakeMp3(), { filename: 'ok2.mp3', contentType: 'audio/mpeg' });
    expect(retry.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// A-4a — GET /audio/tracks/:id/stream (user-scoped, Range-capable)
// ---------------------------------------------------------------------------

/** Upload `bytes` via the real route and return the new track id (the blob
 *  lands on disk at the server-written path, exactly as production). */
async function uploadTrack(
  agent: ReturnType<typeof request.agent>,
  bytes: Buffer,
  opts: { filename?: string; contentType?: string } = {},
): Promise<number> {
  const res = await agent.post('/audio').attach('file', bytes, {
    filename: opts.filename ?? 'track.mp3',
    contentType: opts.contentType ?? 'audio/mpeg',
  });
  expect(res.status).toBe(201);
  return res.body.trackId as number;
}

/** GET an audio URL with the body captured as a raw Buffer (supertest does
 *  not buffer audio/* bodies by default — ttmik.test.ts's exact helper). */
function getAudio(agent: ReturnType<typeof request.agent>, url: string, range?: string) {
  const req = agent
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return range === undefined ? req : req.set('Range', range);
}

describe('GET /audio/tracks/:id/stream — bytes, headers, Range', () => {
  it('no Range header → 200 with the full exact bytes + the streaming headers', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(4096);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    // REQUIRED: the browser must never content-sniff these bytes (A-3's m4a
    // sniff admits generic MP4 brands).
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    // EXACT contract — `private` alone would also pass for no-store/max-age=0.
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it('an m4a track streams as audio/mp4 (Content-Type from the server-written extension)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeM4a('M4A ');
    const trackId = await uploadTrack(agent, bytes, {
      filename: 'track.m4a',
      contentType: 'audio/mp4',
    });

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mp4');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it('Range: bytes=0-99 → 206 with correct Content-Range and the exact slice', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(4096);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=0-99');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-99/${bytes.length}`);
    expect(res.headers['content-length']).toBe('100');
    expect(Buffer.compare(res.body as Buffer, bytes.subarray(0, 100))).toBe(0);
  });

  it('open-ended Range: bytes=4000- → 206 to EOF', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(4096);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=4000-');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4000-4095/4096`);
    expect(Buffer.compare(res.body as Buffer, bytes.subarray(4000))).toBe(0);
  });

  it('suffix Range: bytes=-16 → 206 with the last 16 bytes', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(4096);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=-16');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4080-4095/4096`);
    expect(Buffer.compare(res.body as Buffer, bytes.subarray(4080))).toBe(0);
  });

  it('unsatisfiable Range (start past EOF) → 416 with total-size Content-Range', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(4096);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=999999-');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${bytes.length}`);
    // No partial bytes may leak on a 416.
    expect((res.body as Buffer).length).toBe(0);
  });

  it('inverted Range: bytes=5-2 is an INVALID specifier → ignored, 200 full body (RFC 9110 §14.1.1)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(2048);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=5-2');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it('multi-range bytes=0-1,3-4 is unsupported → ignored, 200 full body', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(2048);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=0-1,3-4');
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it('zero-length suffix bytes=-0 → 416 with total-size Content-Range', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(2048);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=-0');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${bytes.length}`);
    expect((res.body as Buffer).length).toBe(0);
  });

  it('non-bytes range unit (chunks=0-3) → ignored, 200 full body', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(2048);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'chunks=0-3');
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it('malformed Range header is ignored → 200 full body (RFC 9110 §14.2)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(2048);
    const trackId = await uploadTrack(agent, bytes);

    const res = await getAudio(agent, `/audio/tracks/${trackId}/stream`, 'bytes=tuna-sandwich');
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it("IDOR: user B cannot stream user A's track — uniform 404, never confirming existence", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const trackId = await uploadTrack(a.agent, fakeMp3());

    const res = await b.agent.get(`/audio/tracks/${trackId}/stream`);
    expect(res.status).toBe(404);
    // Indistinguishable from a genuinely-missing id (the correlationId is
    // per-request noise; the error payload is what must be uniform).
    const ghost = await b.agent.get(`/audio/tracks/999999/stream`);
    expect(ghost.status).toBe(404);
    expect(res.body.error).toEqual(ghost.body.error);
  });

  it('a live row whose blob file is gone → 404, not 500', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const trackId = await uploadTrack(agent, fakeMp3());
    const { rows } = await pg.pool.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM audio_tracks WHERE id = $1`,
      [trackId],
    );
    await unlink(path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, rows[0]!.blob_ref));

    const res = await agent.get(`/audio/tracks/${trackId}/stream`);
    expect(res.status).toBe(404);
  });

  it.each(['abc', '0', '-1', '1.5'])('malformed :id %j → 400 before any query', async (bad) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/audio/tracks/${bad}/stream`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// A-4a — GET /audio/tracks/:id (track detail + ordered transcript segments)
// ---------------------------------------------------------------------------

describe('GET /audio/tracks/:id — detail + segments', () => {
  it('returns the track DTO + ordered camelCase segments once transcription is done', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/audio')
      .field('title', 'Folktale 01')
      .attach('file', fakeMp3(), { filename: 'f.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
    const trackId = res.body.trackId as number;

    // Simulate the worker settling the track (transcript_status + duration),
    // then its segment rows — seeded out of insertion order to pin the ORDER
    // BY segment_number (insertion order must never be what sorts them).
    await pg.pool.query(
      `UPDATE audio_tracks SET transcript_status = 'done', duration_ms = 6000 WHERE id = $1`,
      [trackId],
    );
    await seedAudioSegment(pg.pool, trackId, 3, { startMs: 4000, endMs: 6000, body: '셋' });
    await seedAudioSegment(pg.pool, trackId, 1, { startMs: 0, endMs: 2000, body: '하나' });
    await seedAudioSegment(pg.pool, trackId, 2, { startMs: 2000, endMs: 4000, body: '둘' });

    const detail = await agent.get(`/audio/tracks/${trackId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({
      track: {
        id: trackId,
        title: 'Folktale 01',
        transcriptStatus: 'done',
        durationMs: 6000,
        streamUrl: `/audio/tracks/${trackId}/stream`,
      },
      segments: [
        { segmentNumber: 1, startMs: 0, endMs: 2000, body: '하나' },
        { segmentNumber: 2, startMs: 2000, endMs: 4000, body: '둘' },
        { segmentNumber: 3, startMs: 4000, endMs: 6000, body: '셋' },
      ],
    });
  });

  it('a not-yet-transcribed track returns segments: [] — a normal state, not an error', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const trackId = await uploadTrack(agent, fakeMp3());

    const detail = await agent.get(`/audio/tracks/${trackId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.track).toMatchObject({
      id: trackId,
      transcriptStatus: 'pending',
      durationMs: null,
      streamUrl: `/audio/tracks/${trackId}/stream`,
    });
    expect(detail.body.segments).toEqual([]);
  });

  it("IDOR: user B cannot read user A's track detail — uniform 404", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const trackId = await uploadTrack(a.agent, fakeMp3());
    await seedAudioSegment(pg.pool, trackId, 1);

    const res = await b.agent.get(`/audio/tracks/${trackId}`);
    expect(res.status).toBe(404);
    const ghost = await b.agent.get(`/audio/tracks/999999`);
    expect(ghost.status).toBe(404);
    // correlationId is per-request noise; the error payload must be uniform.
    expect(res.body.error).toEqual(ghost.body.error);
  });

  it('a nonexistent id → 404; a malformed id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/audio/tracks/424242')).status).toBe(404);
    expect((await agent.get('/audio/tracks/not-a-number')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// F-207 phase 1 — shared curated corpus: the access-control threat-model
// tests (docs/LISTEN_SHARED_CORPUS_PLAN.md §5). The rule under test:
// shared = READABLE by every account, MUTABLE by no one but the owner.
// is_shared is operator-set only, so tests flip it the way the phase-2
// cutover script will: a direct keyed UPDATE, never a route.
// ---------------------------------------------------------------------------

/** Upload one set via the real route and return BOTH ids (uploadTrack above
 *  returns only the track id; these tests assert at the source level too). */
async function uploadSet(
  agent: ReturnType<typeof request.agent>,
  bytes: Buffer,
  title: string,
): Promise<{ sourceId: number; trackId: number }> {
  const res = await agent
    .post('/audio')
    .field('title', title)
    .attach('file', bytes, { filename: 'set.mp3', contentType: 'audio/mpeg' });
  expect(res.status).toBe(201);
  return { sourceId: res.body.sourceId as number, trackId: res.body.trackId as number };
}

/** Operator-style share flip — the phase-2 cutover script's exact shape.
 *  There is deliberately NO route that does this (share-flag-hijack threat). */
async function shareSource(sourceId: number): Promise<void> {
  await pg.pool.query(`UPDATE audio_sources SET is_shared = true WHERE id = $1`, [sourceId]);
}

describe('F-207 — GET /audio/shared (curated list, cross-account, no owner PII)', () => {
  it('a NON-owner lists the shared set — and ONLY the shared one; private sets of any owner never appear', async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const shared = await uploadSet(a.agent, fakeMp3(1500), 'Korean Folktales');
    await uploadSet(a.agent, fakeMp3(), 'A private set'); // stays private
    await uploadSet(b.agent, fakeMp3(), 'B private set'); // stays private
    await shareSource(shared.sourceId);

    const res = await b.agent.get('/audio/shared');
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      id: shared.sourceId,
      title: 'Korean Folktales',
      kind: 'standalone_listening',
    });
    expect(res.body.sources[0].tracks).toEqual([
      {
        id: shared.trackId,
        track_number: 1,
        title: 'Korean Folktales',
        byte_size: 1500,
        duration_ms: null,
        transcript_status: 'pending',
      },
    ]);
  });

  it('the DTO carries NO owner identity: exact key sets + no user_id/email anywhere on the wire', async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const { sourceId } = await uploadSet(a.agent, fakeMp3(), 'Iyagi Episodes');
    await shareSource(sourceId);

    const res = await b.agent.get('/audio/shared');
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    // EXACT key sets — a future column added to the projection cannot slip
    // into this response unnoticed (these are the owner's rows served to
    // other accounts; the DTO is the privacy boundary).
    expect(Object.keys(res.body.sources[0]).sort()).toEqual([
      'created_at',
      'id',
      'kind',
      'slug',
      'title',
      'tracks',
    ]);
    expect(Object.keys(res.body.sources[0].tracks[0]).sort()).toEqual([
      'byte_size',
      'duration_ms',
      'id',
      'title',
      'track_number',
      'transcript_status',
    ]);
    // Belt-and-braces: nothing owner-identifying anywhere in the raw payload.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('user_id');
    expect(raw).not.toContain('userId');
    expect(raw).not.toContain('email');
    expect(raw).not.toContain(a.email);
  });

  it("the OWNER sees the same curated list (non-user-scoped includes the owner's own view)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const { sourceId } = await uploadSet(a.agent, fakeMp3(), 'TTMIK Grammar');
    await shareSource(sourceId);

    const res = await a.agent.get('/audio/shared');
    expect(res.status).toBe(200);
    expect(res.body.sources.map((s: { id: number }) => s.id)).toEqual([sourceId]);
  });

  it('empty curated corpus → 200 with an empty list (never an error)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/audio/shared');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sources: [] });
  });
});

describe('F-207 — cross-account READ of a shared set (stream + detail)', () => {
  it("a NON-owner streams a shared set's track: 200 + the exact bytes + the streaming headers", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const bytes = fakeMp3(4096);
    const { sourceId, trackId } = await uploadSet(a.agent, bytes, 'Folktale 01');
    await shareSource(sourceId);

    const res = await getAudio(b.agent, `/audio/tracks/${trackId}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it("a NON-owner reads a shared track's detail + segments (the Listen transcript surface)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const { sourceId, trackId } = await uploadSet(a.agent, fakeMp3(), 'Folktale 02');
    await shareSource(sourceId);
    await pg.pool.query(
      `UPDATE audio_tracks SET transcript_status = 'done', duration_ms = 2000 WHERE id = $1`,
      [trackId],
    );
    await seedAudioSegment(pg.pool, trackId, 1, { startMs: 0, endMs: 2000, body: '옛날 옛적에' });

    const res = await b.agent.get(`/audio/tracks/${trackId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      track: {
        id: trackId,
        title: 'Folktale 02',
        transcriptStatus: 'done',
        durationMs: 2000,
        streamUrl: `/audio/tracks/${trackId}/stream`,
      },
      segments: [{ segmentNumber: 1, startMs: 0, endMs: 2000, body: '옛날 옛적에' }],
    });
  });

  it("IDOR holds per-source: sharing ONE of A's sets opens NO sibling — B still gets the uniform 404 on A's private track (stream + detail)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const shared = await uploadSet(a.agent, fakeMp3(), 'Shared set');
    const priv = await uploadSet(a.agent, fakeMp3(), 'Private set');
    await shareSource(shared.sourceId);

    // The shared one reads fine…
    expect((await b.agent.get(`/audio/tracks/${shared.trackId}`)).status).toBe(200);

    // …the private sibling is a uniform 404 on BOTH read routes —
    // byte-identical error payload to a genuinely-missing id (no existence
    // oracle survives the widening).
    const ghostStream = await b.agent.get('/audio/tracks/999999/stream');
    const privStream = await b.agent.get(`/audio/tracks/${priv.trackId}/stream`);
    expect(ghostStream.status).toBe(404);
    expect(privStream.status).toBe(404);
    expect(privStream.body.error).toEqual(ghostStream.body.error);

    const ghostDetail = await b.agent.get('/audio/tracks/999999');
    const privDetail = await b.agent.get(`/audio/tracks/${priv.trackId}`);
    expect(ghostDetail.status).toBe(404);
    expect(privDetail.status).toBe(404);
    expect(privDetail.body.error).toEqual(ghostDetail.body.error);

    // And the OWNER's access to their private set is untouched.
    expect((await a.agent.get(`/audio/tracks/${priv.trackId}/stream`)).status).toBe(200);
  });
});

describe('F-207 — mutation stays owner-only; the share flag cannot be hijacked', () => {
  it('sharing is READ-only: no mutation route exists for audio rows at all — every write verb on a shared id is 404 (no such surface)', async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const { sourceId, trackId } = await uploadSet(a.agent, fakeMp3(), 'Shared set');
    await shareSource(sourceId);

    // The audio router mounts exactly POST /audio (create-own) + the GET
    // reads. There is NO rename/delete/re-transcribe surface — for a
    // non-owner OR the owner — so "a non-owner cannot mutate a shared set"
    // holds structurally: 404 (no route), asserted against every plausible
    // mutation shape so a future mutation route cannot land without tripping
    // this test and adding its own owner-scope proof.
    // Deferred (thunked) so each request is built + awaited ONE AT A TIME.
    // Building all six supertest Tests eagerly in an array literal fires them
    // concurrently against the ephemeral test server, and a later request
    // reusing the agent's connection to an already-torn-down request server
    // races into ECONNREFUSED — a harness artifact, not a route behavior.
    const attempts: Array<() => Promise<{ status: number }>> = [
      () => b.agent.patch(`/audio/${sourceId}`).send({ title: 'hijacked' }),
      () => b.agent.put(`/audio/${sourceId}`).send({ title: 'hijacked' }),
      () => b.agent.delete(`/audio/${sourceId}`),
      () => b.agent.patch(`/audio/tracks/${trackId}`).send({ title: 'hijacked' }),
      () => b.agent.delete(`/audio/tracks/${trackId}`),
      () => b.agent.post(`/audio/tracks/${trackId}/transcribe`),
    ];
    for (const make of attempts) {
      expect((await make()).status).toBe(404);
    }

    // Nothing changed under A's rows.
    const src = await pg.pool.query<{ title: string; is_shared: boolean; user_id: string }>(
      `SELECT title, is_shared, user_id FROM audio_sources WHERE id = $1`,
      [sourceId],
    );
    expect(src.rows[0]).toEqual({
      title: 'Shared set',
      is_shared: true,
      user_id: String(a.userId),
    });
  });

  it('share-flag hijack via upload is impossible: an is_shared body field is REJECTED (.strict() → 400), and rows only ever land private', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Attempt the mass-assignment: .strict() must 400, writing nothing.
    const res = await agent
      .post('/audio')
      .field('title', 'Sneaky')
      .field('is_shared', 'true')
      .attach('file', fakeMp3(), { filename: 's.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(400);
    expect(await rowCount('audio_sources')).toBe(0);

    // A clean upload lands is_shared = false (079's default — private).
    const ok = await uploadSet(agent, fakeMp3(), 'Clean');
    const { rows } = await pg.pool.query<{ is_shared: boolean; user_id: string }>(
      `SELECT is_shared, user_id FROM audio_sources WHERE id = $1`,
      [ok.sourceId],
    );
    expect(rows[0]).toEqual({ is_shared: false, user_id: String(userId) });
  });
});

describe("F-207 — decision #2: a shared set leaves the owner's My Audio list", () => {
  it("A's shared set is absent from A's GET /audio while A's private upload remains; B's list is untouched", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const shared = await uploadSet(a.agent, fakeMp3(), 'Now curated');
    const priv = await uploadSet(a.agent, fakeMp3(), 'Still mine');
    const bOwn = await uploadSet(b.agent, fakeMp3(), 'B own');
    await shareSource(shared.sourceId);

    const aList = await a.agent.get('/audio');
    expect(aList.status).toBe(200);
    expect(aList.body.sources.map((s: { id: number }) => s.id)).toEqual([priv.sourceId]);

    const bList = await b.agent.get('/audio');
    expect(bList.body.sources.map((s: { id: number }) => s.id)).toEqual([bOwn.sourceId]);
  });
});
