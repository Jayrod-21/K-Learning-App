/**
 * Integration tests for /admin routes (Phase 2.2 admin-role foundation).
 *
 * Real Postgres via testcontainers per Bar §"Testing". The load-bearing
 * assertions here are the AuthZ chain itself (401 with no session, 403 for a
 * non-admin session, 200 only for role='admin') and the secret-exclusion
 * contract on GET /admin/users — the response must NEVER carry
 * password_hash, asserted structurally over the whole JSON payload, not just
 * spot-checked fields (mirrors tickets.test.ts's assertAnonymized pattern).
 *
 * Admin users are minted by promoting a fully-registered agent's row directly
 * (`UPDATE users SET role = 'admin'`) rather than driving a role-seeding UI —
 * there is none yet; the production path is server/src/scripts/seed-user.ts
 * SEED_USER_ROLE=admin, covered separately in seed-user.test.ts. `role` is
 * read fresh per request by getActiveSession (auth/sessions.ts), so a
 * promotion after the agent's session already exists still takes effect on
 * the next request — no re-login needed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { _setConfigForTesting } from '../../src/config/index.js';

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
    `TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE`,
  );
  resetLimiters();
});

async function promoteToAdmin(userId: number): Promise<void> {
  await pg.pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);
}

// ---- Phase 2.6 spend-ceiling seed helpers ----------------------------------

async function seedStory(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO generated_stories (user_id, title, body_ko, level)
     VALUES ($1, 'T', '본문', 'basic') RETURNING id`,
    [userId],
  );
  return rows[0]!.id;
}

async function seedClaudeUsage(cost: number): Promise<void> {
  await pg.pool.query(
    `INSERT INTO claude_usage (request_id, route, model, cost_estimate_usd, latency_ms)
     VALUES ($1, 'enrich'::claude_route, 'claude-haiku-4-5'::claude_model, $2, 5)`,
    [randomUUID(), cost],
  );
}

async function seedDoneAudioJob(userId: number, storyId: number, cost: number): Promise<void> {
  await pg.pool.query(
    `INSERT INTO story_audio_jobs
        (generated_story_id, user_id, status, char_count, cost_estimate_usd, finished_at)
     VALUES ($1, $2, 'done', 100, $3, now())`,
    [storyId, userId, cost],
  );
}

async function seedDoneImageJob(userId: number, storyId: number, cost: number): Promise<void> {
  await pg.pool.query(
    `INSERT INTO story_image_jobs
        (generated_story_id, user_id, status, image_count, cost_estimate_usd, finished_at)
     VALUES ($1, $2, 'done', 3, $3, now())`,
    [storyId, userId, cost],
  );
}

describe('GET /admin/users — auth required', () => {
  it('no session -> 401', async () => {
    const res = await request(t.app).get('/admin/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('GET /admin/users — admin required', () => {
  it('a non-admin (ordinary user) session -> 403', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/admin/users');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('an admin session -> 200 with safe fields, password_hash NEVER present', async () => {
    const { agent, userId, email } = await registerUser(t.app, pg.pool);
    await promoteToAdmin(userId);

    const res = await agent.get('/admin/users');
    expect(res.status).toBe(200);

    // Structural secret-exclusion check over the WHOLE payload — not just a
    // spot-checked field — so a future column added to the SELECT can never
    // silently leak the hash even if a reviewer misses it in a field-by-field
    // diff.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('password_hash');
    expect(json).not.toContain('$argon2id$');

    const users = res.body.users as Array<Record<string, unknown>>;
    expect(Array.isArray(users)).toBe(true);
    const self = users.find((u) => u.email === email);
    expect(self).toBeDefined();
    expect(self).toMatchObject({
      id: userId,
      email,
      role: 'admin',
      email_verified: expect.any(Boolean),
    });
    expect(self).toHaveProperty('created_at');
    // Exactly the allow-listed field set — nothing extra rode along.
    expect(Object.keys(self!).sort()).toEqual(
      ['created_at', 'email', 'email_verified', 'id', 'role'].sort(),
    );
  });

  it('lists both admin and non-admin users with their correct roles', async () => {
    const admin = await registerUser(t.app, pg.pool);
    await promoteToAdmin(admin.userId);
    const plain = await registerUser(t.app, pg.pool);

    const res = await admin.agent.get('/admin/users');
    expect(res.status).toBe(200);
    const users = res.body.users as Array<{ email: string; role: string }>;
    const byEmail = new Map(users.map((u) => [u.email, u.role]));
    expect(byEmail.get(admin.email)).toBe('admin');
    expect(byEmail.get(plain.email)).toBe('user');
  });

  it('a demoted-back-to-user session loses admin access on the next request', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await promoteToAdmin(userId);
    const first = await agent.get('/admin/users');
    expect(first.status).toBe(200);

    await pg.pool.query(`UPDATE users SET role = 'user' WHERE id = $1`, [userId]);
    const second = await agent.get('/admin/users');
    expect(second.status).toBe(403);
  });
});

describe('GET /admin/spend — auth required', () => {
  it('no session -> 401', async () => {
    const res = await request(t.app).get('/admin/spend');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('GET /admin/spend — admin required', () => {
  it('a non-admin (ordinary user) session -> 403', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/admin/spend');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('an admin session sees the correct spend math over seeded rows, with no secret fields', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await promoteToAdmin(userId);
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 10 });

    const storyId = await seedStory(userId);
    await seedClaudeUsage(3);
    await seedDoneAudioJob(userId, storyId, 2);
    await seedDoneImageJob(userId, storyId, 1);

    const res = await agent.get('/admin/spend');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      ceiling_usd: 10,
      window: 'utc_day',
      spent_usd: { total: 6, claude: 3, tts: 2, images: 1 },
      remaining_usd: 4,
    });

    // No secrets ride along — structural check over the whole payload
    // (admin.test.ts's own convention for GET /admin/users, above).
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('password_hash');
    expect(json).not.toContain('$argon2id$');
  });

  it('reports enabled=false when the ceiling is unset (default 0), regardless of seeded spend', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await promoteToAdmin(userId);
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 0 });
    await seedClaudeUsage(50);

    const res = await agent.get('/admin/spend');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, ceiling_usd: 0, remaining_usd: 0 });
    expect(res.body.spent_usd.claude).toBe(50);
  });
});
