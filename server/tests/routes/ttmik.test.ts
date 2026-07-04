/**
 * Per-route tests for src/routes/ttmik.ts (F-012 — TTMIK/Iyagi audio).
 *
 * Routes:
 *   GET /ttmik/lessons
 *   GET /ttmik/lessons/:level/:number
 *   GET /ttmik/lessons/:level/:number/audio
 *   GET /iyagi/episodes
 *   GET /iyagi/episodes/:number
 *   GET /iyagi/episodes/:number/audio
 *
 * The audio tests run against a throwaway corpus root in a tmp dir
 * (CORPUS_AUDIO_DIR is env-injected before the app is built) — never the
 * real corpus. Bytes are a fixed 16-byte marker so Range slices are exact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedIyagiEpisode, seedTtmikLesson } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { parseRangeHeader } from '../../src/routes/ttmik.js';

let pg: PgHandle;
let t: TestApp;
let audioRoot: string;

/** 16 known bytes so Range assertions are exact byte-for-byte. */
const AUDIO_BYTES = Buffer.from('0123456789ABCDEF');
const LESSON_REL = 'TTMIK/Lessons/Lesson 1/01 TTMIK Level 1 Lesson 1.mp3';
const IYAGI_REL = 'TTMIK/이야기들/이야기/3 TTMIK Iyagi 3.mp3';

beforeAll(async () => {
  audioRoot = await mkdtemp(join(tmpdir(), 'km-corpus-audio-'));
  await mkdir(join(audioRoot, 'TTMIK/Lessons/Lesson 1'), { recursive: true });
  await mkdir(join(audioRoot, 'TTMIK/이야기들/이야기'), { recursive: true });
  await writeFile(join(audioRoot, LESSON_REL), AUDIO_BYTES);
  await writeFile(join(audioRoot, IYAGI_REL), AUDIO_BYTES);
  // MUST precede buildTestApp — the config re-parses process.env there.
  process.env.CORPUS_AUDIO_DIR = audioRoot;

  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  delete process.env.CORPUS_AUDIO_DIR;
  await teardownTestApp(t);
  await stopPostgres(pg);
  await rm(audioRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  // Fixed natural keys re-seed per test; the container is shared per-file.
  await pg.pool.query('TRUNCATE TABLE ttmik_lessons, iyagi_episodes CASCADE');
  resetLimiters();
});

/** Seed a lesson at (1,1) and point it at the on-disk fixture mp3. */
async function seedLessonWithAudio(): Promise<number> {
  const id = await seedTtmikLesson(pg.pool, { level: 1, number: 1, title: 'greetings' });
  await pg.pool.query(`UPDATE ttmik_lessons SET audio_path = $1 WHERE id = $2`, [
    LESSON_REL,
    id,
  ]);
  return id;
}

/** Seed episode 3 and point it at the on-disk fixture mp3. */
async function seedEpisodeWithAudio(): Promise<number> {
  const id = await seedIyagiEpisode(pg.pool, { number: 3 });
  await pg.pool.query(`UPDATE iyagi_episodes SET audio_path = $1 WHERE id = $2`, [
    IYAGI_REL,
    id,
  ]);
  return id;
}

/** Override a lesson's stored audio_path (hostile-row scenarios). */
async function setLessonAudioPath(id: number, path: string | null): Promise<void> {
  await pg.pool.query(`UPDATE ttmik_lessons SET audio_path = $1 WHERE id = $2`, [
    path,
    id,
  ]);
}

/** GET an audio URL with the body captured as a raw Buffer. */
function getAudio(agent: ReturnType<typeof request.agent>, url: string, range?: string) {
  const req = agent.get(url).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return range === undefined ? req : req.set('Range', range);
}

// ---------------------------------------------------------------------------
// Auth gate — every route on this surface
// ---------------------------------------------------------------------------

describe('ttmik/iyagi — auth required', () => {
  it.each([
    '/ttmik/lessons',
    '/ttmik/lessons/1/1',
    '/ttmik/lessons/1/1/audio',
    '/iyagi/episodes',
    '/iyagi/episodes/3',
    '/iyagi/episodes/3/audio',
  ])('GET %s unauthenticated → 401', async (path) => {
    const res = await request(t.app).get(path);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Catalog lists
// ---------------------------------------------------------------------------

describe('GET /ttmik/lessons', () => {
  it('lists lessons ordered with hasAudio flags', async () => {
    await seedLessonWithAudio();
    await seedTtmikLesson(pg.pool, { level: 1, number: 2, title: 'numbers' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons');
    expect(res.status).toBe(200);
    expect(res.body.lessons).toEqual([
      { level: 1, number: 1, title: 'greetings', hasAudio: true },
      { level: 1, number: 2, title: 'numbers', hasAudio: false },
    ]);
  });
});

describe('GET /iyagi/episodes', () => {
  it('lists episodes ordered with hasAudio flags', async () => {
    await seedEpisodeWithAudio();
    await seedIyagiEpisode(pg.pool, { number: 7 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/iyagi/episodes');
    expect(res.status).toBe(200);
    expect(res.body.episodes).toEqual([
      { number: 3, title: 'mock episode', hasAudio: true },
      { number: 7, title: 'mock episode', hasAudio: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Detail endpoints
// ---------------------------------------------------------------------------

describe('GET /ttmik/lessons/:level/:number', () => {
  it('returns meta + ordered transcript + audioUrl', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/1/1');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({
      level: 1,
      number: 1,
      title: 'greetings',
      hasAudio: true,
    });
    expect(res.body.audioUrl).toBe('/ttmik/lessons/1/1/audio');
    expect(res.body.sentences.map((s: { ordinal: number }) => s.ordinal)).toEqual([1, 2]);
    expect(res.body.sentences[0]).toMatchObject({ korean: '안녕하세요', english: 'hello' });
  });

  it('audioUrl is null when no audio is mapped', async () => {
    await seedTtmikLesson(pg.pool, { level: 2, number: 4 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/2/4');
    expect(res.status).toBe(200);
    expect(res.body.meta.hasAudio).toBe(false);
    expect(res.body.audioUrl).toBeNull();
  });

  it('unknown lesson → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/9/999');
    expect(res.status).toBe(404);
  });

  it('non-numeric params → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/one/two');
    expect(res.status).toBe(400);
  });
});

describe('GET /iyagi/episodes/:number', () => {
  it('returns meta + ordered transcript + audioUrl', async () => {
    await seedEpisodeWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/iyagi/episodes/3');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({
      number: 3,
      title: 'mock episode',
      hosts: [],
      hasAudio: true,
    });
    expect(res.body.audioUrl).toBe('/iyagi/episodes/3/audio');
    expect(res.body.sentences.map((s: { ordinal: number }) => s.ordinal)).toEqual([1, 2]);
  });

  it('unknown episode → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/iyagi/episodes/42424');
    expect(res.status).toBe(404);
  });

  it('episode number beyond the schema cap → 400 (validation, not a scan)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/iyagi/episodes/424242');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Audio streaming — full body + Range semantics
// ---------------------------------------------------------------------------

describe('GET /ttmik/lessons/:level/:number/audio', () => {
  it('no Range header → 200 with the full file', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/ttmik/lessons/1/1/audio');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(AUDIO_BYTES.length));
    expect(res.headers['content-range']).toBeUndefined();
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES)).toBe(0);
  });

  it('Range: bytes=0-3 → 206 with Content-Range and exact slice', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/ttmik/lessons/1/1/audio', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-3/${AUDIO_BYTES.length}`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('4');
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES.subarray(0, 4))).toBe(0);
  });

  it('open-ended Range: bytes=4- → 206 to EOF', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/ttmik/lessons/1/1/audio', 'bytes=4-');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4-15/${AUDIO_BYTES.length}`);
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES.subarray(4))).toBe(0);
  });

  it('suffix Range: bytes=-4 → 206 with the last 4 bytes', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/ttmik/lessons/1/1/audio', 'bytes=-4');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 12-15/${AUDIO_BYTES.length}`);
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES.subarray(12))).toBe(0);
  });

  it('end clamped to EOF when past the file size', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/ttmik/lessons/1/1/audio', 'bytes=8-9999');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 8-15/${AUDIO_BYTES.length}`);
  });

  it('unsatisfiable Range (start past EOF) → 416 with total-size Content-Range', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/ttmik/lessons/1/1/audio', 'bytes=999-');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${AUDIO_BYTES.length}`);
  });

  it('malformed Range header is ignored → 200 full body', async () => {
    await seedLessonWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/ttmik/lessons/1/1/audio', 'chickens=0-3');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(AUDIO_BYTES.length));
  });

  it('lesson exists but audio_path is NULL → 404', async () => {
    await seedTtmikLesson(pg.pool, { level: 1, number: 1 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/1/1/audio');
    expect(res.status).toBe(404);
  });

  it('no such lesson row → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/8/888/audio');
    expect(res.status).toBe(404);
  });

  it('audio_path set but file missing on disk → 404', async () => {
    const id = await seedLessonWithAudio();
    await setLessonAudioPath(id, 'TTMIK/Lessons/Lesson 1/does not exist.mp3');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/1/1/audio');
    expect(res.status).toBe(404);
  });

  it('dot-dot traversal in a stored audio_path → 404, nothing leaks', async () => {
    const id = await seedLessonWithAudio();
    await setLessonAudioPath(id, '../../../../etc/passwd');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/1/1/audio');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('absolute stored audio_path → 404', async () => {
    const id = await seedLessonWithAudio();
    await setLessonAudioPath(id, '/etc/passwd');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ttmik/lessons/1/1/audio');
    expect(res.status).toBe(404);
  });

  it('symlink inside the root pointing outside → 404', async () => {
    // Plant a real file OUTSIDE the corpus root and a symlink to it INSIDE.
    const outside = join(audioRoot, '..', `km-outside-${Date.now()}.mp3`);
    await writeFile(outside, AUDIO_BYTES);
    const linkRel = 'TTMIK/evil-link.mp3';
    await symlink(outside, join(audioRoot, linkRel));
    try {
      const id = await seedLessonWithAudio();
      await setLessonAudioPath(id, linkRel);
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get('/ttmik/lessons/1/1/audio');
      expect(res.status).toBe(404);
    } finally {
      await rm(outside, { force: true });
      await rm(join(audioRoot, linkRel), { force: true });
    }
  });
});

describe('GET /iyagi/episodes/:number/audio', () => {
  it('serves a Range slice from the episode file', async () => {
    await seedEpisodeWithAudio();
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/iyagi/episodes/3/audio', 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 2-5/${AUDIO_BYTES.length}`);
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES.subarray(2, 6))).toBe(0);
  });

  it('episode without audio → 404', async () => {
    await seedIyagiEpisode(pg.pool, { number: 9 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/iyagi/episodes/9/audio');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// parseRangeHeader — pure unit coverage of the RFC edge cases
// ---------------------------------------------------------------------------

describe('parseRangeHeader', () => {
  const SIZE = 100;
  it.each<[string | undefined, ReturnType<typeof parseRangeHeader>]>([
    [undefined, null],
    ['bytes=0-49', { start: 0, end: 49 }],
    ['bytes=50-', { start: 50, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=-1000', { start: 0, end: 99 }], // suffix larger than file → whole file
    ['bytes=0-9999', { start: 0, end: 99 }], // end clamped
    ['bytes=100-', 'unsatisfiable'], // start == size
    ['bytes=7-3', 'unsatisfiable'], // inverted
    ['bytes=-0', 'unsatisfiable'], // zero-length suffix
    ['bytes=-', null], // both empty → malformed → ignore
    ['bytes=0-3,5-9', null], // multi-range unsupported → ignore
    ['chunks=0-3', null], // unknown unit → ignore
    ['garbage', null],
  ])('parseRangeHeader(%j, 100) → %j', (header, expected) => {
    expect(parseRangeHeader(header, SIZE)).toEqual(expected);
  });
});
