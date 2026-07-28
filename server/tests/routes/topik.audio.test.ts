/**
 * Per-route tests for GET /topik/audio/:testNumber/:level (F-119 Phase 4 —
 * official TOPIK mock listening audio), plus proof that the streamer
 * extracted to services/corpusAudio.ts keeps the exact ttmik-era semantics
 * on this new consumer (Range slices, header policy, uniform 404s,
 * traversal/symlink containment).
 *
 * Split out of topik.test.ts on purpose: like ttmik.test.ts, the audio tests
 * need a throwaway corpus root (CORPUS_AUDIO_DIR env-injected BEFORE the app
 * is built) — never the real corpus — and topik.test.ts builds its app
 * without one. Bytes are a fixed 16-byte marker so Range slices are exact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { ensureCorpusSource, registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { resolveTopikAudioLevel } from '../../src/routes/topik.js';

let pg: PgHandle;
let t: TestApp;
let audioRoot: string;

/** 16 known bytes so Range assertions are exact byte-for-byte. */
const AUDIO_BYTES = Buffer.from('0123456789ABCDEF');
/** Distinct bytes for the TOPIK I sitting of the SAME test_number (D-1). */
const AUDIO_BYTES_I = Buffer.from('FEDCBA9876543210');

// Real corpus-relative key shapes (migration 078's contract) — spaces and all.
const TOPIK_II_REL = 'TOPIK TEST/60 - 60th TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Audio.mp3';
const TOPIK_I_REL = 'TOPIK TEST/60 - 60th TOPIK/TOPIK-I/60th-TOPIK-I-Listening-Audio.mp3';

/**
 * The ONE `error` object every 404 on this surface must serialize to — the
 * route's boundary 404 (malformed testNumber/level) and corpusAudio.ts's
 * streamer 404s (unknown paper, NULL/hostile/missing audio_path) share this
 * message byte-for-byte, so the wire body never says WHY a URL missed.
 * (correlationId varies per request, so assertions compare `body.error`.)
 */
const UNIFORM_404_ERROR = { code: 'not_found', message: 'no audio for this unit' };

beforeAll(async () => {
  audioRoot = await mkdtemp(join(tmpdir(), 'km-topik-audio-'));
  await mkdir(join(audioRoot, 'TOPIK TEST/60 - 60th TOPIK/TOPIK-II'), { recursive: true });
  await mkdir(join(audioRoot, 'TOPIK TEST/60 - 60th TOPIK/TOPIK-I'), { recursive: true });
  await writeFile(join(audioRoot, TOPIK_II_REL), AUDIO_BYTES);
  await writeFile(join(audioRoot, TOPIK_I_REL), AUDIO_BYTES_I);
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
  await pg.pool.query('TRUNCATE TABLE topik_items, topik_tests CASCADE');
  resetLimiters();
});

/**
 * Seed one topik_tests paper (no items needed — audio serving reads only the
 * test row) keyed by the migration-029 natural key, with an optional 078
 * audio_path. Raw SQL on purpose: the shared seedTopikItem helper hardcodes
 * 'TOPIK II' and always creates items this surface never touches.
 */
async function seedPaper(opts: {
  testNumber: number;
  level: 'TOPIK I' | 'TOPIK II';
  section?: 'reading' | 'listening';
  audioPath?: string | null;
}): Promise<number> {
  const corpusSourceId = await ensureCorpusSource(pg.pool, 'topik', 'intermediate');
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO topik_tests (corpus_source_id, corpus, test_number, topik_level, section, audio_path)
     VALUES ($1, 'topik'::corpus, $2, $3, $4::topik_section, $5)
     RETURNING id`,
    [
      corpusSourceId,
      opts.testNumber,
      opts.level,
      opts.section ?? 'listening',
      opts.audioPath ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/** Overwrite a paper's stored audio_path (hostile-row scenarios). */
async function setPaperAudioPath(id: number, path: string | null): Promise<void> {
  await pg.pool.query(`UPDATE topik_tests SET audio_path = $1 WHERE id = $2`, [path, id]);
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
// Auth gate
// ---------------------------------------------------------------------------

describe('GET /topik/audio — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/topik/audio/60/2');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Happy path — full body + Range semantics + header policy
// ---------------------------------------------------------------------------

describe('GET /topik/audio/:testNumber/:level — streaming', () => {
  it('no Range header → 200 with the full file and the corpus header policy', async () => {
    await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/topik/audio/60/2');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe(String(AUDIO_BYTES.length));
    expect(res.headers['content-range']).toBeUndefined();
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES)).toBe(0);
  });

  it('Range: bytes=0-3 → 206 with Content-Range and exact slice', async () => {
    await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/topik/audio/60/2', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-3/${AUDIO_BYTES.length}`);
    expect(res.headers['content-length']).toBe('4');
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES.subarray(0, 4))).toBe(0);
  });

  it('suffix Range: bytes=-4 → 206 with the last 4 bytes', async () => {
    await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/topik/audio/60/2', 'bytes=-4');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 12-15/${AUDIO_BYTES.length}`);
    expect(Buffer.compare(res.body as Buffer, AUDIO_BYTES.subarray(12))).toBe(0);
  });

  it('unsatisfiable Range (start past EOF) → 416 with total-size Content-Range', async () => {
    await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getAudio(agent, '/topik/audio/60/2', 'bytes=999-');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${AUDIO_BYTES.length}`);
  });

  it('D-1: TOPIK I and II share test_number — :level selects the right paper', async () => {
    // Same test_number 60, both levels seeded with DIFFERENT bytes: any query
    // keyed on test_number alone would merge the sittings (migration 029).
    await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    await seedPaper({ testNumber: 60, level: 'TOPIK I', audioPath: TOPIK_I_REL });
    const { agent } = await registerUser(t.app, pg.pool);
    const resII = await getAudio(agent, '/topik/audio/60/2');
    expect(resII.status).toBe(200);
    expect(Buffer.compare(resII.body as Buffer, AUDIO_BYTES)).toBe(0);
    const resI = await getAudio(agent, '/topik/audio/60/1');
    expect(resI.status).toBe(200);
    expect(Buffer.compare(resI.body as Buffer, AUDIO_BYTES_I)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Uniform 404 semantics — nothing on this surface distinguishes its misses
// ---------------------------------------------------------------------------

describe('GET /topik/audio/:testNumber/:level — uniform 404s', () => {
  it('paper exists but audio_path is NULL → 404', async () => {
    await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: null });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/audio/60/2');
    expect(res.status).toBe(404);
  });

  it('unknown test_number → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/audio/999/2');
    expect(res.status).toBe(404);
  });

  it('only a non-listening section row exists → 404 (section is pinned)', async () => {
    // A reading row carrying an audio_path must never satisfy the audio route.
    await seedPaper({
      testNumber: 61,
      level: 'TOPIK II',
      section: 'reading',
      audioPath: TOPIK_II_REL,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/audio/61/2');
    expect(res.status).toBe(404);
  });

  // Unit-level pin for the Object.hasOwn hardening. Over HTTP the slip is NOT
  // observable today (without the guard, pg coerces the inherited
  // Function/object to text, the parameterized query matches zero rows, and
  // the streamer returns the same uniform 404) — so only a direct assertion
  // on the resolver can catch a regression to a bare index.
  describe('resolveTopikAudioLevel — prototype-chain keys never resolve', () => {
    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
      'resolveTopikAudioLevel(%j) → undefined, not an inherited value',
      (key) => {
        expect(resolveTopikAudioLevel(key)).toBeUndefined();
      },
    );

    it('resolves only the two real discriminators', () => {
      expect(resolveTopikAudioLevel('1')).toBe('TOPIK I');
      expect(resolveTopikAudioLevel('2')).toBe('TOPIK II');
      expect(resolveTopikAudioLevel(undefined)).toBeUndefined();
      expect(resolveTopikAudioLevel('')).toBeUndefined();
    });
  });

  // 'constructor'/'__proto__'/'toString' are prototype-chain keys: a bare
  // index into the TOPIK_AUDIO_LEVELS object literal returns an inherited
  // value for them, so without the Object.hasOwn guard they'd slip past the
  // === undefined check and reach the query. Each must 404 at the boundary
  // with the SAME uniform body as every other miss on this surface.
  it.each(['3', 'x', '0', 'II', 'constructor', '__proto__', 'toString'])(
    'bad level %j → 404, never a 500, uniform body',
    async (level) => {
      await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get(`/topik/audio/60/${level}`);
      expect(res.status).toBe(404);
      expect((res.body as { error: unknown }).error).toEqual(UNIFORM_404_ERROR);
    },
  );

  it.each(['abc', '-1', '0', '2147483648'])(
    'bad testNumber %j → 404, never a 500 (int4 overflow dies at the boundary)',
    async (testNumber) => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get(`/topik/audio/${testNumber}/2`);
      expect(res.status).toBe(404);
    },
  );

  it('every 404 class serializes to the SAME JSON body — no oracle on the wire', async () => {
    // One case per 404 origin: the route's own boundary rejections (bad
    // level, malformed/overflow testNumber) AND the streamer's misses
    // (unknown paper, NULL audio_path, section-pinned reading row, hostile
    // traversal path). If any of them ever carries a different message, a
    // caller could distinguish "your URL is malformed" from "that paper/file
    // doesn't exist" — this pins them byte-identical.
    await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: null });
    await seedPaper({
      testNumber: 61,
      level: 'TOPIK II',
      section: 'reading',
      audioPath: TOPIK_II_REL,
    });
    const traversalId = await seedPaper({
      testNumber: 62,
      level: 'TOPIK II',
      audioPath: TOPIK_II_REL,
    });
    await setPaperAudioPath(traversalId, '../../../../etc/passwd');
    const { agent } = await registerUser(t.app, pg.pool);

    // Baseline = a route-boundary 404 (bad level); the rest must serialize
    // identically to it.
    const first = await agent.get('/topik/audio/60/9');
    expect(first.status).toBe(404);
    const baseline = (first.body as { error: unknown }).error;
    const urls = [
      '/topik/audio/abc/2', // non-numeric testNumber → route boundary 404
      '/topik/audio/2147483648/2', // int4 overflow → route boundary 404
      '/topik/audio/999/2', // no such paper → streamer 404
      '/topik/audio/60/2', // paper exists, audio_path NULL → streamer 404
      '/topik/audio/61/2', // only a reading row (section pinned) → streamer 404
      '/topik/audio/62/2', // hostile traversal audio_path → streamer 404
    ];
    for (const url of urls) {
      const res = await agent.get(url);
      expect(res.status).toBe(404);
      // Deep-equal against the FIRST body — a divergent message anywhere on
      // this surface (e.g. reverting the route's message to a bespoke one)
      // fails here.
      expect((res.body as { error: unknown }).error).toEqual(baseline);
    }
  });
});

// ---------------------------------------------------------------------------
// Containment — a hostile stored audio_path never escapes CORPUS_AUDIO_DIR
// ---------------------------------------------------------------------------

describe('GET /topik/audio/:testNumber/:level — hostile audio_path rows', () => {
  it('dot-dot traversal in a stored audio_path → 404, nothing leaks', async () => {
    const id = await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    await setPaperAudioPath(id, '../../../../etc/passwd');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/audio/60/2');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('absolute stored audio_path → 404', async () => {
    const id = await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    await setPaperAudioPath(id, '/etc/passwd');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/audio/60/2');
    expect(res.status).toBe(404);
  });

  it('symlink inside the root pointing outside → 404', async () => {
    // Plant a real file OUTSIDE the corpus root and a symlink to it INSIDE.
    const outside = join(audioRoot, '..', `km-topik-outside-${Date.now()}.mp3`);
    await writeFile(outside, AUDIO_BYTES);
    const linkRel = 'TOPIK TEST/evil-link.mp3';
    await symlink(outside, join(audioRoot, linkRel));
    try {
      const id = await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
      await setPaperAudioPath(id, linkRel);
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get('/topik/audio/60/2');
      expect(res.status).toBe(404);
    } finally {
      await rm(outside, { force: true });
      await rm(join(audioRoot, linkRel), { force: true });
    }
  });

  it('audio_path set but file missing on disk → 404', async () => {
    const id = await seedPaper({ testNumber: 60, level: 'TOPIK II', audioPath: TOPIK_II_REL });
    await setPaperAudioPath(id, 'TOPIK TEST/60 - 60th TOPIK/TOPIK-II/does not exist.mp3');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/audio/60/2');
    expect(res.status).toBe(404);
  });
});
