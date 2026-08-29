/**
 * Cross-user isolation — generated stories, reading chapters/positions, and
 * book uploads (Phase 2.10).
 *
 * F-207/F-217 carve-out: `book_uploads`/`reading_chapters` READS
 * intentionally widen to owned-OR-shared when `is_shared = true` — that is
 * NOT an isolation bug (see RECON_server.md §3 and the route comments in
 * uploads.ts/reading.ts). This suite asserts the DEFAULT (private, unshared)
 * case is denied, and separately asserts the shared-read widening is real
 * (not accidentally over-permissive) while owner-only MUTATIONS on a shared
 * book stay denied to a non-owner.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  seedGeneratedStory,
  seedBookUpload,
  seedReadingChapter,
  seedStoryAudio,
  seedStoryImages,
} from '../helpers/seed.js';
import { twoUsers, expectDenied, type TwoUsers } from '../helpers/twoUsers.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { saveBlob } from '../../src/services/audioStore.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    `TRUNCATE TABLE reading_attempts, reading_positions, reading_passages,
                     reading_chapters, generated_stories, book_uploads,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  resetLimiters();
});

describe('cross-user isolation — generated stories', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("B cannot GET A's story by id (404)", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: "A's private story",
    });

    const res = await users.b.agent.get(`/reading/generated/${String(storyId)}`);
    expectDenied(res);
  });

  it("B's story library excludes A's story", async () => {
    const aStoryId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: "A's story",
    });
    const bStoryId = await seedGeneratedStory(pg.pool, users.b.userId, {
      title: "B's story",
    });

    const res = await users.b.agent.get('/reading/generated');
    expect(res.status).toBe(200);
    const ids = (res.body.stories as Array<{ id: number }>).map((s) => s.id);
    expect(ids).toContain(bStoryId);
    expect(ids).not.toContain(aStoryId);
  });

  it("B cannot enqueue audio (owner-gated, cost-bearing mutation) for A's story", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId);

    const res = await users.b.agent.post(`/reading/generated/${String(storyId)}/audio`);
    expectDenied(res);
  });
});

/**
 * #45 (migration 109) — the public reuse library. Unlike F-207/F-217's
 * is_shared (operator-set-only, no route ever writes it), generated_stories.
 * is_shared is the app's FIRST user-settable shared flag — flipped by the
 * caller's OWN POST /reading/generated/:id/publish|unpublish, never by
 * another account. This suite asserts: (1) the DEFAULT (unpublished) case
 * stays IDOR-404 to a non-owner for BOTH the story and its images; (2) a
 * PUBLISHED story's text AND images are genuinely readable by a non-owner
 * (not just a 200 — the actual content matches); (3) every mutation on a
 * published story — publish/unpublish themselves included — stays denied to
 * a non-owner; (4) a non-owner CAN clone a published story into their OWN
 * library with source_story_id provenance; (5) that clone touches NEITHER
 * story_audio_jobs NOR story_image_jobs (the $0-spend guarantee) while its
 * cloned audio/images are genuinely present (proving blob-reference reuse
 * worked, not just that nothing happened); (6) the public browse listing
 * carries no owner-identifying field.
 */
describe('cross-user isolation — public story library (#45)', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("an UNPUBLISHED story's images stay IDOR-404 to a non-owner (text already covered above)", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: "A's private story",
    });
    await seedStoryImages(pg.pool, users.a.userId, storyId, { count: 2 });

    const listRes = await users.b.agent.get(`/reading/generated/${String(storyId)}/images`);
    expectDenied(listRes);
    const blobRes = await users.b.agent.get(
      `/reading/generated/${String(storyId)}/image/1/blob`,
    );
    expectDenied(blobRes);
  });

  it("A's PUBLISHED story's text AND images are genuinely readable by B (content matches, not just 200)", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: 'Published Story',
      bodyKo: '이 이야기는 공개되었습니다.',
    });
    const blobRefs = await seedStoryImages(pg.pool, users.a.userId, storyId, { count: 2 });
    // Real bytes at the seeded blob_refs are unnecessary here — the blob
    // route's 404-on-missing-file path is exercised elsewhere; this test
    // proves the ROW-level widening, not the filesystem read.
    await pg.pool.query(`UPDATE generated_stories SET is_shared = true WHERE id = $1`, [
      storyId,
    ]);

    const storyRes = await users.b.agent.get(`/reading/generated/${String(storyId)}`);
    expect(storyRes.status).toBe(200);
    expect(storyRes.body.story.title).toBe('Published Story');
    expect(storyRes.body.story.bodyKo).toBe('이 이야기는 공개되었습니다.');
    expect(storyRes.body.story.isShared).toBe(true);
    expect(storyRes.body.story.isOwn).toBe(false);

    const imagesRes = await users.b.agent.get(`/reading/generated/${String(storyId)}/images`);
    expect(imagesRes.status).toBe(200);
    expect(imagesRes.body.images.status).toBe('done');
    expect(imagesRes.body.images.images).toHaveLength(blobRefs.length);
  });

  it("B cannot publish, unpublish, or mutate A's PUBLISHED story", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId);
    await pg.pool.query(`UPDATE generated_stories SET is_shared = true WHERE id = $1`, [
      storyId,
    ]);

    expectDenied(
      await users.b.agent.post(`/reading/generated/${String(storyId)}/publish`).send({}),
    );
    expectDenied(
      await users.b.agent.post(`/reading/generated/${String(storyId)}/unpublish`).send({}),
    );
    expectDenied(await users.b.agent.post(`/reading/generated/${String(storyId)}/audio`));
    expectDenied(await users.b.agent.post(`/reading/generated/${String(storyId)}/images`));

    // The flag itself never moved — B's denied unpublish attempt did not
    // silently succeed against the DB underneath the 404.
    const { rows } = await pg.pool.query<{ is_shared: boolean }>(
      `SELECT is_shared FROM generated_stories WHERE id = $1`,
      [storyId],
    );
    expect(rows[0]?.is_shared).toBe(true);
  });

  it("A's own publish/unpublish route actually flips is_shared (owner-gated write works, not just denied for B)", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId);

    const pubRes = await users.a.agent
      .post(`/reading/generated/${String(storyId)}/publish`)
      .send({});
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.story.isShared).toBe(true);

    // B can now read it — the widening is live off A's own write, not a
    // fixture shortcut.
    expect((await users.b.agent.get(`/reading/generated/${String(storyId)}`)).status).toBe(200);

    const unpubRes = await users.a.agent
      .post(`/reading/generated/${String(storyId)}/unpublish`)
      .send({});
    expect(unpubRes.status).toBe(200);
    expect(unpubRes.body.story.isShared).toBe(false);
    expectDenied(await users.b.agent.get(`/reading/generated/${String(storyId)}`));
  });

  it("B CAN clone A's PUBLISHED story — owned by B, source_story_id set, at ZERO incremental spend, media genuinely reused", async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: 'Original',
      bodyKo: '원본 이야기 내용입니다.',
    });
    await seedStoryAudio(pg.pool, users.a.userId, storyId, { segmentCount: 2 });
    await seedStoryImages(pg.pool, users.a.userId, storyId, { count: 2 });
    await pg.pool.query(`UPDATE generated_stories SET is_shared = true WHERE id = $1`, [
      storyId,
    ]);

    const cloneRes = await users.b.agent
      .post(`/reading/generated/${String(storyId)}/clone`)
      .send({});
    expect(cloneRes.status).toBe(201);
    const clone = cloneRes.body.story as {
      id: number;
      title: string;
      bodyKo: string;
      isOwn: boolean;
      isShared: boolean;
    };
    expect(clone.title).toBe('Original');
    expect(clone.bodyKo).toBe('원본 이야기 내용입니다.');
    expect(clone.isOwn).toBe(true);
    // A clone starts PRIVATE regardless of the source's publish state.
    expect(clone.isShared).toBe(false);

    // Owned by B — provenance points back at A's story — verified directly
    // against the DB (the wire DTO deliberately never carries source_story_id
    // as a raw cross-user id; the ownership + provenance facts are asserted
    // at the row level here).
    const { rows } = await pg.pool.query<{
      user_id: number;
      source_story_id: number;
    }>(`SELECT user_id, source_story_id FROM generated_stories WHERE id = $1`, [clone.id]);
    expect(rows[0]?.user_id).toBe(users.b.userId);
    expect(rows[0]?.source_story_id).toBe(storyId);

    // B's own library now lists the clone.
    const listRes = await users.b.agent.get('/reading/generated');
    const ids = (listRes.body.stories as Array<{ id: number }>).map((s) => s.id);
    expect(ids).toContain(clone.id);

    // ZERO incremental metered spend: neither job ledger gained a row for
    // this clone.
    const audioJobs = await pg.pool.query(
      `SELECT 1 FROM story_audio_jobs WHERE generated_story_id = $1`,
      [clone.id],
    );
    expect(audioJobs.rowCount).toBe(0);
    const imageJobs = await pg.pool.query(
      `SELECT 1 FROM story_image_jobs WHERE generated_story_id = $1`,
      [clone.id],
    );
    expect(imageJobs.rowCount).toBe(0);

    // The media was genuinely REFERENCED, not silently dropped: B's clone
    // reports done audio + 2 done images through B's OWN owner-scoped
    // GET routes (no widening involved on this side — B owns the clone).
    const audioRes = await users.b.agent.get(`/reading/generated/${String(clone.id)}/audio`);
    expect(audioRes.body.audio.status).toBe('done');
    const imagesRes = await users.b.agent.get(`/reading/generated/${String(clone.id)}/images`);
    expect(imagesRes.body.images.status).toBe('done');
    expect(imagesRes.body.images.images).toHaveLength(2);
  });

  it('B cannot clone a PRIVATE (unpublished) story of A', async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId);

    const res = await users.b.agent.post(`/reading/generated/${String(storyId)}/clone`).send({});
    expectDenied(res);
  });

  it('the public browse listing carries no owner-identifying field for either account', async () => {
    const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
      title: 'Browsable Story',
    });
    await pg.pool.query(`UPDATE generated_stories SET is_shared = true WHERE id = $1`, [
      storyId,
    ]);

    const res = await users.b.agent.get('/reading/generated/shared');
    expect(res.status).toBe(200);
    const row = (res.body.stories as Array<Record<string, unknown>>).find(
      (s) => s.title === 'Browsable Story',
    );
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('userId');
    expect(row).not.toHaveProperty('user_id');
    expect(row).not.toHaveProperty('isOwn');
    // Structural JSON scan: neither account's email or numeric id string
    // rides the payload anywhere, not just on the matched row's own keys.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(users.a.email);
    expect(serialized).not.toContain(users.b.email);
  });

  /**
   * SECURITY REGRESSION GUARD (fix-pass, server review SF-1): the listen-via-
   * clone boundary (`GET /generated/:id/audio`'s doc comment above) holds
   * TODAY because publish/unpublish never touch `audio_sources.is_shared`
   * and `routes/audio.ts`'s stream route widens ONLY on that column — but
   * nothing before this test would have FAILED if a future change
   * "helpfully" started setting `audio_sources.is_shared = true` off a
   * published `generated_stories` row (e.g. to make "listen before clone"
   * easier) and thereby leaked every published story's narration straight
   * through the existing shared-corpus stream route. This test seeds REAL
   * bytes on disk (via the real `saveBlob`, not a fabricated blob_ref — a
   * missing file would 404 for an unrelated reason and mask a regression
   * here) and hits the REAL `/audio/tracks/:id/stream` route directly, not a
   * mock or a unit test of the query alone.
   */
  it(
    "B cannot stream A's published story's audio track directly " +
      '(listen-via-clone boundary), but CAN stream it after cloning',
    async () => {
      const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
        title: 'Voiced & Published',
      });

      // Real bytes on disk at a real blob path (the same shape a live TTS
      // run would produce), owned by A.
      const bytes = Buffer.from('fake mp3 bytes for the isolation stream test', 'utf8');
      const blobRef = await saveBlob(users.a.userId, randomUUID(), 'mp3', bytes);
      const srcSourceRes = await pg.pool.query<{ id: string }>(
        `INSERT INTO audio_sources
           (user_id, slug, title, kind, source_upload_id, generated_story_id, status)
         VALUES ($1, $2, $3, 'generated_story', NULL, $4, 'ready')
         RETURNING id`,
        [users.a.userId, `generated-story-${String(storyId)}`, 'Voiced & Published', storyId],
      );
      const srcTrackRes = await pg.pool.query<{ id: string }>(
        `INSERT INTO audio_tracks
           (source_id, user_id, track_number, title, blob_ref, byte_size, duration_ms,
            transcript_status)
         VALUES ($1, $2, 1, $3, $4, $5, 1000, 'done')
         RETURNING id`,
        [
          Number(srcSourceRes.rows[0]!.id),
          users.a.userId,
          'Voiced & Published',
          blobRef,
          bytes.length,
        ],
      );
      const srcTrackId = Number(srcTrackRes.rows[0]!.id);

      await pg.pool.query(`UPDATE generated_stories SET is_shared = true WHERE id = $1`, [
        storyId,
      ]);

      // The story itself IS readable by B (the point of publishing)…
      expect((await users.b.agent.get(`/reading/generated/${String(storyId)}`)).status).toBe(200);
      // …but B streaming A's track directly stays a uniform 404 — the
      // audio-stream boundary is NOT widened by the story's is_shared.
      const directRes = await users.b.agent.get(`/audio/tracks/${String(srcTrackId)}/stream`);
      expect(directRes.status).toBe(404);

      // The intended listen path: clone first, then stream B's OWN new
      // track through the existing, unmodified owner-only audio route.
      const cloneRes = await users.b.agent
        .post(`/reading/generated/${String(storyId)}/clone`)
        .send({});
      expect(cloneRes.status).toBe(201);
      const cloneId = cloneRes.body.story.id as number;

      const audioRes = await users.b.agent.get(`/reading/generated/${String(cloneId)}/audio`);
      expect(audioRes.body.audio.status).toBe('done');
      const cloneStreamUrl = audioRes.body.audio.track.streamUrl as string;
      expect(cloneStreamUrl).not.toBe(`/audio/tracks/${String(srcTrackId)}/stream`);

      const cloneStreamRes = await users.b.agent.get(cloneStreamUrl);
      expect(cloneStreamRes.status).toBe(200);
    },
  );

  /**
   * TOCTOU hardening (fix-pass, server review SF-2): the clone route's
   * readability re-check now takes `SELECT ... FOR SHARE` on the source row
   * (reading.ts's clone route) instead of a plain SELECT, so a clone
   * transaction genuinely BLOCKS behind a concurrent owner unpublish rather
   * than racing it. This test holds the row lock a real in-flight unpublish
   * would hold (via a raw client, exactly `tickets.test.ts`'s B-033
   * regression-test pattern: hold the lock, fire the REAL route
   * concurrently, prove it's still pending before releasing), then commits
   * the unpublish FIRST — the clone's now-unblocked re-check must see the
   * post-commit (unpublished) row and deny the clone, never the stale
   * published snapshot a non-blocking plain SELECT could have raced to.
   */
  it(
    "a clone genuinely BLOCKS behind a concurrent unpublish and is denied once the " +
      'unpublish commits first (not a race that could go either way)',
    async () => {
      const storyId = await seedGeneratedStory(pg.pool, users.a.userId, {
        title: 'Race Story',
      });
      await pg.pool.query(`UPDATE generated_stories SET is_shared = true WHERE id = $1`, [
        storyId,
      ]);

      const lockTx = await pg.pool.connect();
      try {
        await lockTx.query('BEGIN');
        // The exact statement A's real unpublish route runs, held open on a
        // raw connection so we control exactly when it commits.
        await lockTx.query(
          `UPDATE generated_stories SET is_shared = false WHERE id = $1 AND user_id = $2`,
          [storyId, users.a.userId],
        );

        let cloneSettled = false;
        const clonePromise = users.b.agent
          .post(`/reading/generated/${String(storyId)}/clone`)
          .send({})
          .then((r) => {
            cloneSettled = true;
            return r;
          });

        // The clone route's SELECT ... FOR SHARE must genuinely block on
        // the held row lock — prove it's still pending before we commit.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(cloneSettled).toBe(false);

        // The unpublish COMMITS first — the clone, now unblocked, must
        // re-read the row as it stands NOW (unpublished) and deny it.
        await lockTx.query('COMMIT');

        const res = await clonePromise;
        expectDenied(res);
      } finally {
        lockTx.release();
      }
    },
  );
});

describe('cross-user isolation — reading chapters & positions', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("a chapter of A's PRIVATE book is not reachable by B (404)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
    });
    const chapterId = await seedReadingChapter(pg.pool, users.a.userId, uploadId, {
      title: 'Chapter 1',
    });

    const res = await users.b.agent.get(`/reading/chapters/${String(chapterId)}`);
    expectDenied(res);
  });

  it("B cannot PUT a reading position against A's book (owner-strict, DB-FK-enforced)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
    });

    const res = await users.b.agent
      .put(`/reading/position/${String(uploadId)}`)
      .send({ page_number: 3 });
    expectDenied(res);

    const { rowCount } = await pg.pool.query(
      `SELECT 1 FROM reading_positions WHERE source_upload_id = $1 AND user_id = $2`,
      [uploadId, users.b.userId],
    );
    expect(rowCount).toBe(0);
  });

  it("a chapter of A's SHARED book IS readable by B (intentional F-207 widening, not a bug)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
    });
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);
    const chapterId = await seedReadingChapter(pg.pool, users.a.userId, uploadId, {
      title: 'Shared Chapter',
    });

    const res = await users.b.agent.get(`/reading/chapters/${String(chapterId)}`);
    expect(res.status).toBe(200);
    expect(res.body.chapter.title).toBe('Shared Chapter');

    // But the position write stays owner-strict even for a shared book (the
    // migration-051 composite FK makes a non-owner position row structurally
    // impossible — see RECON_server.md finding #3).
    const posRes = await users.b.agent
      .put(`/reading/position/${String(uploadId)}`)
      .send({ page_number: 1 });
    expectDenied(posRes);
  });
});

describe('cross-user isolation — book uploads', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("B cannot GET A's PRIVATE upload by id (404)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId);

    const res = await users.b.agent.get(`/uploads/${String(uploadId)}`);
    expectDenied(res);
  });

  it("A's SHARED upload IS readable by B via GET /uploads/:id (intentional F-217 widening)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      title: 'shared corpus book',
      status: 'ready',
    });
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);

    const res = await users.b.agent.get(`/uploads/${String(uploadId)}`);
    expect(res.status).toBe(200);
    expect(res.body.upload.title).toBe('shared corpus book');
  });

  it("B's GET /uploads (own uploads) excludes A's upload — even A's SHARED one", async () => {
    const aUploadId = await seedBookUpload(pg.pool, users.a.userId, {
      title: 'a upload',
    });
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      aUploadId,
    ]);
    const bUploadId = await seedBookUpload(pg.pool, users.b.userId, {
      title: 'b upload',
    });

    const res = await users.b.agent.get('/uploads');
    expect(res.status).toBe(200);
    // Wire contract: upload ids are emitted as STRINGS (uploads.ts's toDTO,
    // pre-int8-parser behavior) — compare as strings, not numbers.
    const ids = (res.body.uploads as Array<{ id: string }>).map((u) => u.id);
    expect(ids).toContain(String(bUploadId));
    expect(ids).not.toContain(String(aUploadId));
  });

  it("B cannot DELETE A's upload — even a SHARED one (owner-only mutation)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId);
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);

    const res = await users.b.agent.delete(`/uploads/${String(uploadId)}`);
    expectDenied(res);

    const { rowCount } = await pg.pool.query(`SELECT 1 FROM book_uploads WHERE id = $1`, [
      uploadId,
    ]);
    expect(rowCount).toBe(1);
  });

  it("B cannot POST /uploads/:id/extract against A's upload (owner-only, cost-bearing)", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, {
      status: 'ready',
      pageCount: 1,
    });

    const res = await users.b.agent.post(`/uploads/${String(uploadId)}/extract`).send({});
    expectDenied(res);
  });

  it("B cannot reorder pages of A's upload", async () => {
    const uploadId = await seedBookUpload(pg.pool, users.a.userId, { status: 'ready' });

    const res = await users.b.agent
      .patch(`/uploads/${String(uploadId)}/pages/order`)
      .send({ page_ids: [1] });
    expectDenied(res);
  });
});
