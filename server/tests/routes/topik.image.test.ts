/**
 * Per-route tests for GET /topik/image/:testNumber/:level/:itemNumber (F-120
 * Phase 1 — TOPIK question exam figures), plus proof that the guard shared
 * through services/corpusAudio.ts's resolveCorpusFile keeps the exact
 * audio-surface semantics on this new consumer (header policy, uniform 404s,
 * traversal/symlink containment) and that the `imageUrl` DTO field is emitted
 * only for image-mapped rows AND SURVIVES the mock answer-strip.
 *
 * Split out of topik.test.ts on purpose (topik.audio.test.ts's reasoning):
 * these tests need a throwaway corpus root (CORPUS_IMAGE_DIR env-injected
 * BEFORE the app is built) — never the real corpus. Bytes are fixed markers
 * so responses are exact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedTopikItem } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { resolveImageContentType } from '../../src/services/corpusImage.js';

let pg: PgHandle;
let t: TestApp;
let imageRoot: string;

/** Known bytes so responses are exact byte-for-byte. */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a-fake-png-payload');
/** Distinct bytes for the TOPIK I sitting of the SAME test_number (D-1). */
const PNG_BYTES_I = Buffer.from('fake-png-payload-topik-one-sitting');
const WEBP_BYTES = Buffer.from('RIFF-fake-webp');

// Real corpus-relative key shapes (migration 085's contract) — spaces and all.
const II_REL = 'TOPIK IMAGES/60 - 60th TOPIK/TOPIK-II/listening/q01.png';
const I_REL = 'TOPIK IMAGES/60 - 60th TOPIK/TOPIK-I/listening/q01.png';
const WEBP_REL = 'TOPIK IMAGES/60 - 60th TOPIK/TOPIK-II/listening/q02.webp';

/**
 * The ONE `error` object every 404 on this surface must serialize to — the
 * route's boundary 404s (malformed testNumber/level/itemNumber) and
 * corpusImage.ts's misses (unknown item, NULL/hostile/missing image_ref,
 * unknown extension) share this message byte-for-byte, so the wire body
 * never says WHY a URL missed (the audio surface's exact posture).
 */
const UNIFORM_404_ERROR = { code: 'not_found', message: 'no image for this item' };

beforeAll(async () => {
  imageRoot = await mkdtemp(join(tmpdir(), 'km-topik-image-'));
  await mkdir(join(imageRoot, 'TOPIK IMAGES/60 - 60th TOPIK/TOPIK-II/listening'), {
    recursive: true,
  });
  await mkdir(join(imageRoot, 'TOPIK IMAGES/60 - 60th TOPIK/TOPIK-I/listening'), {
    recursive: true,
  });
  await writeFile(join(imageRoot, II_REL), PNG_BYTES);
  await writeFile(join(imageRoot, I_REL), PNG_BYTES_I);
  await writeFile(join(imageRoot, WEBP_REL), WEBP_BYTES);
  // MUST precede buildTestApp — the config re-parses process.env there.
  process.env.CORPUS_IMAGE_DIR = imageRoot;

  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  delete process.env.CORPUS_IMAGE_DIR;
  await teardownTestApp(t);
  await stopPostgres(pg);
  await rm(imageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  await pg.pool.query('TRUNCATE TABLE topik_items, topik_tests CASCADE');
  resetLimiters();
});

/** Overwrite an item's stored image_ref (hostile-row scenarios). */
async function setItemImageRef(id: number, ref: string | null): Promise<void> {
  await pg.pool.query(`UPDATE topik_items SET image_ref = $1 WHERE id = $2`, [ref, id]);
}

/** GET an image URL with the body captured as a raw Buffer. */
function getImage(agent: ReturnType<typeof request.agent>, url: string) {
  return agent
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('GET /topik/image — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/topik/image/60/2/1');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Happy path — bytes + header policy
// ---------------------------------------------------------------------------

describe('GET /topik/image/:testNumber/:level/:itemNumber — serving', () => {
  it('mapped item → 200 with the file bytes and the corpus-image header policy', async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
      imageRef: II_REL,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getImage(agent, '/topik/image/60/2/1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['content-length']).toBe(String(PNG_BYTES.length));
    // No Range support BY DESIGN (small single-request crops).
    expect(res.headers['accept-ranges']).toBeUndefined();
    expect(Buffer.compare(res.body as Buffer, PNG_BYTES)).toBe(0);
  });

  it('Content-Type comes from the STORED extension (webp)', async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 2,
      imageRef: WEBP_REL,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await getImage(agent, '/topik/image/60/2/2');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(Buffer.compare(res.body as Buffer, WEBP_BYTES)).toBe(0);
  });

  it('D-1: TOPIK I and II share test_number — :level selects the right item', async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
      topikLevel: 'TOPIK II',
      imageRef: II_REL,
    });
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
      topikLevel: 'TOPIK I',
      imageRef: I_REL,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const resII = await getImage(agent, '/topik/image/60/2/1');
    expect(resII.status).toBe(200);
    expect(Buffer.compare(resII.body as Buffer, PNG_BYTES)).toBe(0);
    const resI = await getImage(agent, '/topik/image/60/1/1');
    expect(resI.status).toBe(200);
    expect(Buffer.compare(resI.body as Buffer, PNG_BYTES_I)).toBe(0);
  });

  it('resolveImageContentType — closed extension set, prototype keys never resolve', () => {
    expect(resolveImageContentType('a/q1.png')).toBe('image/png');
    expect(resolveImageContentType('a/q1.PNG')).toBe('image/png'); // case-folded
    expect(resolveImageContentType('a/q1.webp')).toBe('image/webp');
    expect(resolveImageContentType('a/q1.jpg')).toBe('image/jpeg');
    expect(resolveImageContentType('a/q1.jpeg')).toBe('image/jpeg');
    expect(resolveImageContentType('a/q1.svg')).toBeUndefined(); // scriptable — never
    expect(resolveImageContentType('a/q1.mp3')).toBeUndefined();
    expect(resolveImageContentType('a/q1')).toBeUndefined(); // extension-less
    // Prototype-chain keys must not index the allow-map (Object.hasOwn guard).
    expect(resolveImageContentType('a/q1.constructor')).toBeUndefined();
    expect(resolveImageContentType('a/q1.__proto__')).toBeUndefined();
    expect(resolveImageContentType('a/q1.toString')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Uniform 404 semantics — nothing on this surface distinguishes its misses
// ---------------------------------------------------------------------------

describe('GET /topik/image/:testNumber/:level/:itemNumber — uniform 404s', () => {
  it('item exists but image_ref is NULL (ships-empty state) → 404', async () => {
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 60, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/image/60/2/1');
    expect(res.status).toBe(404);
    expect((res.body as { error: unknown }).error).toEqual(UNIFORM_404_ERROR);
  });

  it('unknown test_number / unknown item_number → 404', async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
      imageRef: II_REL,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/topik/image/999/2/1')).status).toBe(404);
    expect((await agent.get('/topik/image/60/2/99')).status).toBe(404);
  });

  it.each(['3', 'x', '0', 'II', 'constructor', '__proto__', 'toString'])(
    'bad level %j → 404, never a 500, uniform body',
    async (level) => {
      await seedTopikItem(pg.pool, {
        section: 'listening',
        testNumber: 60,
        itemNumber: 1,
        imageRef: II_REL,
      });
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get(`/topik/image/60/${level}/1`);
      expect(res.status).toBe(404);
      expect((res.body as { error: unknown }).error).toEqual(UNIFORM_404_ERROR);
    },
  );

  it.each(['abc', '-1', '0', '2147483648'])(
    'bad testNumber %j → 404, never a 500 (int4 overflow dies at the boundary)',
    async (testNumber) => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get(`/topik/image/${testNumber}/2/1`);
      expect(res.status).toBe(404);
    },
  );

  it.each(['abc', '-1', '0', '2147483648'])(
    'bad itemNumber %j → 404, never a 500',
    async (itemNumber) => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get(`/topik/image/60/2/${itemNumber}`);
      expect(res.status).toBe(404);
    },
  );

  it('every 404 class serializes to the SAME JSON body — no oracle on the wire', async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
    });
    const traversal = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 61,
      itemNumber: 1,
      imageRef: II_REL,
    });
    await setItemImageRef(traversal, '../../../../etc/passwd');
    const badExt = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 62,
      itemNumber: 1,
      imageRef: II_REL,
    });
    await setItemImageRef(badExt, 'TOPIK IMAGES/evil.svg');
    const { agent } = await registerUser(t.app, pg.pool);

    // Baseline = a route-boundary 404 (bad level); the rest must serialize
    // identically to it.
    const first = await agent.get('/topik/image/60/9/1');
    expect(first.status).toBe(404);
    const baseline = (first.body as { error: unknown }).error;
    const urls = [
      '/topik/image/abc/2/1', // non-numeric testNumber → route boundary 404
      '/topik/image/2147483648/2/1', // int4 overflow → route boundary 404
      '/topik/image/60/2/abc', // non-numeric itemNumber → route boundary 404
      '/topik/image/999/2/1', // no such item → serving 404
      '/topik/image/60/2/1', // item exists, image_ref NULL → serving 404
      '/topik/image/61/2/1', // hostile traversal image_ref → serving 404
      '/topik/image/62/2/1', // unmapped extension → serving 404
    ];
    for (const url of urls) {
      const res = await agent.get(url);
      expect(res.status).toBe(404);
      expect((res.body as { error: unknown }).error).toEqual(baseline);
    }
  });
});

// ---------------------------------------------------------------------------
// Containment — a hostile stored image_ref never escapes CORPUS_IMAGE_DIR
// ---------------------------------------------------------------------------

describe('GET /topik/image — hostile image_ref rows', () => {
  it('dot-dot traversal in a stored image_ref → 404, nothing leaks', async () => {
    const id = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
      imageRef: II_REL,
    });
    await setItemImageRef(id, '../../../../etc/passwd');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/image/60/2/1');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('absolute stored image_ref → 404', async () => {
    const id = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
      imageRef: II_REL,
    });
    // A .png suffix so the extension gate passes and the PATH guard is what
    // rejects it (the defense under test).
    await setItemImageRef(id, '/etc/passwd.png');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/image/60/2/1');
    expect(res.status).toBe(404);
  });

  it('symlink inside the root pointing outside → 404', async () => {
    const outside = join(imageRoot, '..', `km-topik-img-outside-${Date.now()}.png`);
    await writeFile(outside, PNG_BYTES);
    const linkRel = 'TOPIK IMAGES/evil-link.png';
    await symlink(outside, join(imageRoot, linkRel));
    try {
      const id = await seedTopikItem(pg.pool, {
        section: 'listening',
        testNumber: 60,
        itemNumber: 1,
        imageRef: II_REL,
      });
      await setItemImageRef(id, linkRel);
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get('/topik/image/60/2/1');
      expect(res.status).toBe(404);
    } finally {
      await rm(outside, { force: true });
      await rm(join(imageRoot, linkRel), { force: true });
    }
  });

  it('image_ref set but file missing on disk → 404', async () => {
    const id = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 60,
      itemNumber: 1,
      imageRef: II_REL,
    });
    await setItemImageRef(id, 'TOPIK IMAGES/60 - 60th TOPIK/does not exist.png');
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/image/60/2/1');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DTO emission — imageUrl only when image_ref is mapped, and it SURVIVES the
// mock answer-strip (unlike audioUrl).
// ---------------------------------------------------------------------------

describe('imageUrl DTO emission (F-120)', () => {
  it('study/browse DTO carries imageUrl ONLY for image-mapped rows, with the level-mapped URL', async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 870,
      itemNumber: 1,
      hasImage: true,
      imageRef: II_REL,
    });
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 870,
      itemNumber: 2,
      hasImage: true, // has_image without an asset — today's 145 rows
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/items').query({ source_test: 870 });
    expect(res.status).toBe(200);
    const [mapped, unmapped] = res.body.items;
    expect(mapped.imageUrl).toBe('/topik/image/870/2/1');
    // The raw stored key must never reach any wire.
    expect(JSON.stringify(res.body)).not.toContain(II_REL);
    expect(unmapped).not.toHaveProperty('imageUrl');
  });

  it("TOPIK I paper's imageUrl uses level segment 1 (the audio URLs' exact ternary)", async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 871,
      itemNumber: 7,
      topikLevel: 'TOPIK I',
      imageRef: I_REL,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/items').query({ source_test: 871 });
    expect(res.body.items[0].imageUrl).toBe('/topik/image/871/1/7');
  });

  it('imageUrl SURVIVES the mock answer-strip (unlike audioUrl) — and the strip still holds', async () => {
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 872,
      itemNumber: 1,
      hasImage: true,
      imageRef: II_REL,
      extra: { explanation: 'should NOT reach the wire' },
    });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 872, itemNumber: 2 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 872, section: 'reading' });
    expect(res.status).toBe(200);
    const items = res.body.items as Array<Record<string, unknown>>;
    const withImage = items[0]!;
    const without = items[1]!;
    // The figure URL rides the mock wire — the timed exam needs it to render
    // an image-dependent item answerably (question content, like hasImage).
    expect(withImage.imageUrl).toBe('/topik/image/872/2/1');
    expect(without).not.toHaveProperty('imageUrl');
    // The answer-strip is untouched: no explanation, no `correct` anywhere.
    for (const item of res.body.items as Array<{ options: Array<Record<string, unknown>> }>) {
      expect(item).not.toHaveProperty('explanation');
      expect(JSON.stringify(item)).not.toContain('"correct"');
      for (const opt of item.options) {
        expect(Object.keys(opt).sort()).toEqual(['en', 'id', 'kr']);
      }
    }
  });
});
