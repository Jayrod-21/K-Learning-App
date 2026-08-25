/**
 * Natural-key non-collision suite (Phase 2.10, deliverable 3).
 *
 * Proves the "2nd-user-not-blocked" property: every per-user natural key in
 * this codebase is scoped `(user_id, X)`, never a bare global `(X)` — so two
 * distinct users independently doing the "same" thing must BOTH succeed,
 * never have the second collide with (or silently inherit/clobber) the
 * first's row. Each case below asserts the SECOND write succeeds AND that
 * the two resulting rows are independent (both queryable, each showing its
 * own owner's data).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { seedHanjaCharacter } from '../helpers/seed.js';
import { twoUsers, type TwoUsers } from '../helpers/twoUsers.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

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
    `TRUNCATE TABLE vocab_list_entries, vocab_lists,
                     vocab_cards, card_reviews,
                     user_gloss_overrides,
                     book_uploads,
                     hanja_progress,
                     notification_schedules,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  await pg.pool.query(`DELETE FROM vocab_entries`);
  await pg.pool.query(`TRUNCATE TABLE hanja_characters RESTART IDENTITY CASCADE`);
  resetLimiters();
});

describe('natural-key non-collision — two users never block each other', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it('vocab_entries + vocab_cards (user_mined): both A and B mine the SAME lemma — both succeed, each gets their OWN card', async () => {
    const LEMMA = '고양이';

    const aRes = await users.a.agent
      .post('/vocab/mine')
      .send({ lemma: LEMMA, english: 'cat' });
    expect(aRes.status).toBe(201);

    const bRes = await users.b.agent
      .post('/vocab/mine')
      .send({ lemma: LEMMA, english: 'cat (b)' });
    expect(bRes.status).toBe(201);

    // The underlying vocab_entries row is intentionally SHARED (keyed by
    // corpus/source_id = lemma-<lemma>), so both resolve to the same entry —
    // but the CARD (the per-user save artifact) must be two distinct rows.
    expect(bRes.body.entryId).toBe(aRes.body.entryId);
    expect(bRes.body.card.id).not.toBe(aRes.body.card.id);

    const cards = await pg.pool.query<{ user_id: string }>(
      `SELECT user_id FROM vocab_cards WHERE id = ANY($1::bigint[]) ORDER BY user_id`,
      [[aRes.body.card.id, bRes.body.card.id]],
    );
    expect(cards.rows.map((r) => Number(r.user_id)).sort((x, y) => x - y)).toEqual(
      [users.a.userId, users.b.userId].sort((x, y) => x - y),
    );
  });

  it('user_gloss_overrides UNIQUE(user_id, lemma): both A and B override the SAME lemma — two independent rows', async () => {
    const LEMMA = '강아지';

    const aRes = await users.a.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: "A's gloss" });
    expect(aRes.status).toBe(200);

    const bRes = await users.b.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: "B's gloss" });
    expect(bRes.status).toBe(200);

    const rows = await pg.pool.query<{ user_id: string; gloss: string }>(
      `SELECT user_id, gloss FROM user_gloss_overrides WHERE lemma = $1`,
      [LEMMA],
    );
    expect(rows.rows).toHaveLength(2);
    const byUser = new Map(rows.rows.map((r) => [Number(r.user_id), r.gloss]));
    expect(byUser.get(users.a.userId)).toBe("A's gloss");
    expect(byUser.get(users.b.userId)).toBe("B's gloss");
  });

  it('vocab_lists: A and B create a list with the SAME name — both succeed (list names are per-user, not global)', async () => {
    const NAME = '내가 좋아하는 단어';

    const aRes = await users.a.agent.post('/vocab/lists').send({ name_kr: NAME });
    expect(aRes.status).toBe(201);

    const bRes = await users.b.agent.post('/vocab/lists').send({ name_kr: NAME });
    expect(bRes.status).toBe(201);

    expect(bRes.body.list.id).not.toBe(aRes.body.list.id);

    const rows = await pg.pool.query<{ user_id: string }>(
      `SELECT user_id FROM vocab_lists WHERE name_kr = $1`,
      [NAME],
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('book_uploads UNIQUE(user_id, title): A and B upload with the SAME title — both succeed independently', async () => {
    const TITLE = 'shared-title-across-users';

    const aIns = await pg.pool.query<{ id: string }>(
      `INSERT INTO book_uploads (user_id, title, type, status, byte_size)
       VALUES ($1, $2, 'vocab'::book_upload_type, 'processing'::book_upload_status, 1024)
       RETURNING id`,
      [users.a.userId, TITLE],
    );
    expect(aIns.rows).toHaveLength(1);

    const bIns = await pg.pool.query<{ id: string }>(
      `INSERT INTO book_uploads (user_id, title, type, status, byte_size)
       VALUES ($1, $2, 'vocab'::book_upload_type, 'processing'::book_upload_status, 1024)
       RETURNING id`,
      [users.b.userId, TITLE],
    );
    expect(bIns.rows).toHaveLength(1);
    expect(bIns.rows[0]!.id).not.toBe(aIns.rows[0]!.id);

    // Each user's own GET /uploads carries exactly their own row under the
    // shared title.
    const aList = await users.a.agent.get('/uploads');
    expect((aList.body.uploads as Array<{ id: number }>)).toHaveLength(1);
    const bList = await users.b.agent.get('/uploads');
    expect((bList.body.uploads as Array<{ id: number }>)).toHaveLength(1);
  });

  it('hanja_progress UNIQUE(user_id, char): A and B set state for the SAME character — independent states', async () => {
    const CHAR = '學';
    await seedHanjaCharacter(pg.pool, { char: CHAR });

    const aRes = await users.a.agent
      .post(`/hanja/${encodeURIComponent(CHAR)}/state`)
      .send({ state: 'banked' });
    expect(aRes.status).toBe(200);

    const bRes = await users.b.agent
      .post(`/hanja/${encodeURIComponent(CHAR)}/state`)
      .send({ state: 'practicing' });
    expect(bRes.status).toBe(200);

    const rows = await pg.pool.query<{ user_id: string; state: string }>(
      `SELECT user_id, state FROM hanja_progress WHERE char = $1`,
      [CHAR],
    );
    expect(rows.rows).toHaveLength(2);
    const byUser = new Map(rows.rows.map((r) => [Number(r.user_id), r.state]));
    expect(byUser.get(users.a.userId)).toBe('banked');
    expect(byUser.get(users.b.userId)).toBe('practicing');
  });

  it('notification_schedules UNIQUE(user_id, kind, channel): A and B schedule the SAME (kind, channel) — independent rows', async () => {
    const schedule = {
      kind: 'daily_reminder' as const,
      channel: 'push' as const,
      timeOfDay: '08:00',
      tz: 'America/Denver',
      enabled: true,
    };

    const aRes = await users.a.agent
      .put('/notifications/schedules')
      .send({ schedules: [schedule] });
    expect(aRes.status).toBe(200);

    const bRes = await users.b.agent
      .put('/notifications/schedules')
      .send({ schedules: [{ ...schedule, timeOfDay: '20:00' }] });
    expect(bRes.status).toBe(200);

    // Each user reads back ONLY their own schedule (proves both the write
    // and the read stay scoped, not just that the write didn't error).
    expect(aRes.body.schedules).toHaveLength(1);
    expect(aRes.body.schedules[0].timeOfDay).toBe('08:00');
    expect(bRes.body.schedules).toHaveLength(1);
    expect(bRes.body.schedules[0].timeOfDay).toBe('20:00');

    const rows = await pg.pool.query(
      `SELECT user_id FROM notification_schedules WHERE kind = 'daily_reminder' AND channel = 'push'`,
    );
    expect(rows.rowCount).toBe(2);
  });
});
