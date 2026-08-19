/**
 * notificationDelivery — claim/settle primitives (F-092), real Postgres.
 *
 * Bar §"Testing": real Postgres via testcontainers, no SQLite/mock-pool
 * stand-in for anything that exercises a UNIQUE constraint — the whole point
 * of `claimDelivery` is that the DATABASE (not application code) arbiters a
 * race, so only a real engine proves it.
 *
 * Coverage:
 *   - claimDelivery: a fresh (scheduleId, windowStart) pair is claimed
 *     (row returned); a second claim of the SAME pair loses (no row);
 *     a DIFFERENT windowStart for the same schedule claims independently.
 *   - THE headline test: N concurrent claimDelivery calls for the identical
 *     (scheduleId, windowStart) racing via Promise.all — exactly one winner,
 *     enforced by the UNIQUE (schedule_id, window_start) constraint (063),
 *     not by application-level locking.
 *   - settleDelivery: transitions a pending claim to sent/failed/skipped;
 *     a second settle of the SAME delivery is a no-op (settled: false) —
 *     the "UPDATE ... WHERE unclaimed" half of the pattern.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { setPoolForTesting } from '../../src/db/pool.js';
import { claimDelivery, settleDelivery } from '../../src/services/notificationDelivery.js';

let pg: PgHandle;

const FAKE_HASH = `$argon2id$${'x'.repeat(70)}`;

beforeAll(async () => {
  pg = await startPostgres();
  setPoolForTesting(pg.pool);
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE notification_deliveries, notification_schedules, users RESTART IDENTITY CASCADE',
  );
});

async function seedUser(email: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

/**
 * `notification_schedules.id` is BIGINT (052) → the F-203 int8 parser hands
 * safe-integer bigints back as NUMBERS; `claimDelivery(scheduleId)` accepts
 * `number | string`, so this raw id feeds it directly (the OUTPUT-side
 * `deliveryId` stays a pinned STRING — see the assertions below).
 */
async function seedSchedule(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO notification_schedules
            (user_id, kind, channel, time_of_day, tz, enabled)
     VALUES ($1, 'daily_reminder', 'email', '08:00', 'Asia/Seoul', true)
     RETURNING id`,
    [userId],
  );
  return rows[0]!.id;
}

describe('claimDelivery', () => {
  it('claims a fresh (scheduleId, windowStart) pair', async () => {
    const userId = await seedUser('claim-fresh@example.com');
    const scheduleId = await seedSchedule(userId);
    // Pin the F-203 int8-parser contract on the INPUT side: a raw schedule id
    // read from the DB is now a NUMBER (safe-integer BIGINT), and
    // `claimDelivery(scheduleId)` accepts `number | string` to take it as-is.
    expect(typeof scheduleId).toBe('number');
    const windowStart = new Date('2026-07-15T08:00:00.000Z');

    const result = await claimDelivery(scheduleId, windowStart);
    expect(result.claimed).toBe(true);
    expect(result.deliveryId).not.toBeNull();
    // Pin the string wire contract (R2 NIT): post-F-203 the int8 parser hands
    // the service a NUMBER for `notification_deliveries.id`, and the service
    // String()-wraps it at the boundary (notificationDelivery.ts) so
    // `ClaimDeliveryResult.deliveryId` stays `string | null` — this assertion
    // is what forces that byte-identical external contract.
    expect(typeof result.deliveryId).toBe('string');

    const { rows } = await pg.pool.query<{ status: string }>(
      `SELECT status FROM notification_deliveries WHERE id = $1`,
      [result.deliveryId],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  it('a second claim of the SAME (scheduleId, windowStart) loses', async () => {
    const userId = await seedUser('claim-dupe@example.com');
    const scheduleId = await seedSchedule(userId);
    const windowStart = new Date('2026-07-15T08:00:00.000Z');

    const first = await claimDelivery(scheduleId, windowStart);
    const second = await claimDelivery(scheduleId, windowStart);

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.deliveryId).toBeNull();

    const { rows } = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_deliveries WHERE schedule_id = $1`,
      [scheduleId],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('a DIFFERENT windowStart for the same schedule claims independently', async () => {
    const userId = await seedUser('claim-diff-window@example.com');
    const scheduleId = await seedSchedule(userId);

    const first = await claimDelivery(scheduleId, new Date('2026-07-15T08:00:00.000Z'));
    const second = await claimDelivery(scheduleId, new Date('2026-07-16T08:00:00.000Z'));

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(true);
    expect(first.deliveryId).not.toBe(second.deliveryId);
  });

  // THE headline property: the claim key is enforced by the database under
  // real concurrency, not by an in-process mutex an actual multi-process
  // sender pool couldn't share.
  it('concurrent claims of the identical firing → exactly one winner', async () => {
    const userId = await seedUser('claim-concurrent@example.com');
    const scheduleId = await seedSchedule(userId);
    const windowStart = new Date('2026-07-15T08:00:00.000Z');

    const CONCURRENCY = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => claimDelivery(scheduleId, windowStart)),
    );

    const winners = results.filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(CONCURRENCY - 1);

    // Exactly one row landed — the race did not slip a duplicate past the
    // constraint (which a naive probe-then-insert implementation would).
    const { rows } = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_deliveries
        WHERE schedule_id = $1 AND window_start = $2`,
      [scheduleId, windowStart.toISOString()],
    );
    expect(rows[0]?.n).toBe('1');
  });
});

describe('settleDelivery', () => {
  it('transitions a pending claim to sent, recording sent_at + provider_ref', async () => {
    const userId = await seedUser('settle-sent@example.com');
    const scheduleId = await seedSchedule(userId);
    const { deliveryId } = await claimDelivery(
      scheduleId,
      new Date('2026-07-15T08:00:00.000Z'),
    );

    const sentAt = new Date('2026-07-15T08:00:05.000Z');
    const outcome = await settleDelivery(deliveryId!, {
      status: 'sent',
      sentAt,
      providerRef: 'ses-msg-0001',
    });
    expect(outcome.settled).toBe(true);

    const { rows } = await pg.pool.query<{
      status: string;
      sent_at: Date | null;
      provider_ref: string | null;
    }>(
      `SELECT status, sent_at, provider_ref FROM notification_deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.sent_at?.toISOString()).toBe(sentAt.toISOString());
    expect(rows[0]?.provider_ref).toBe('ses-msg-0001');
  });

  it('transitions a pending claim to failed with no sent_at', async () => {
    const userId = await seedUser('settle-failed@example.com');
    const scheduleId = await seedSchedule(userId);
    const { deliveryId } = await claimDelivery(
      scheduleId,
      new Date('2026-07-15T08:00:00.000Z'),
    );

    const outcome = await settleDelivery(deliveryId!, { status: 'failed' });
    expect(outcome.settled).toBe(true);

    const { rows } = await pg.pool.query<{ status: string; sent_at: Date | null }>(
      `SELECT status, sent_at FROM notification_deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.sent_at).toBeNull();
  });

  it('a second settle of the SAME delivery is a no-op (unclaimed guard)', async () => {
    const userId = await seedUser('settle-dupe@example.com');
    const scheduleId = await seedSchedule(userId);
    const { deliveryId } = await claimDelivery(
      scheduleId,
      new Date('2026-07-15T08:00:00.000Z'),
    );

    const first = await settleDelivery(deliveryId!, {
      status: 'sent',
      sentAt: new Date('2026-07-15T08:00:05.000Z'),
    });
    expect(first.settled).toBe(true);

    // A retried/duplicate settle call attempting to flip it to failed must
    // NOT clobber the already-recorded 'sent' outcome.
    const second = await settleDelivery(deliveryId!, { status: 'failed' });
    expect(second.settled).toBe(false);

    const { rows } = await pg.pool.query<{ status: string }>(
      `SELECT status FROM notification_deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(rows[0]?.status).toBe('sent');
  });

  it('settling a nonexistent delivery id is a no-op', async () => {
    // deliveryId is the BIGINT-as-string shape (see the pinned-type test
    // above) — passed as a string here to match `settleDelivery`'s signature.
    const outcome = await settleDelivery('999999999999', { status: 'skipped' });
    expect(outcome.settled).toBe(false);
  });
});
