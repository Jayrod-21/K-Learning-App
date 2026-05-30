/**
 * PostgresCacheStore — pool-release ordering test (B4 BLOCKER).
 *
 * The previous implementation fire-and-forgot the hit-counter UPDATE and
 * then synchronously called ``client.release()`` in the ``finally`` block.
 * Under load this returned an in-flight client to the pool; the next caller
 * could receive a connection mid-statement (corruption).
 *
 * This test stubs ``pg.Pool`` and asserts that:
 *   1. The hit-counter UPDATE is awaited (so its promise has settled by
 *      the time the `get()` call resolves).
 *   2. ``client.release()`` is called AFTER the UPDATE settles.
 *   3. Concurrent ``get()`` calls do not interleave their UPDATE→release
 *      on the same logical client (they each get their own).
 *
 * See REVIEW_B4 §B-1 and FIX_REPORT_B.md §B4-BLOCKER.
 */

import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Pool, PoolClient } from 'pg';
import { PostgresCacheStore } from '../../../src/services/claude/cache';

interface RecordedCall {
  readonly clientId: number;
  readonly sql: string;
  resolved: boolean;
  resolvedAt: number | null;
}

/**
 * Stub PoolClient that records what SQL is executed and when it resolves,
 * and a release() call timestamp. ``updateDelayMs`` lets us slow the
 * hit-counter update to expose ordering bugs.
 */
function makeStubPool(opts: { updateDelayMs: number; rowsForSelect: unknown[] }): {
  pool: Pool;
  events: RecordedCall[];
  releases: { clientId: number; calledAt: number }[];
} {
  const events: RecordedCall[] = [];
  const releases: { clientId: number; calledAt: number }[] = [];
  let nextClientId = 0;

  const makeClient = (): PoolClient => {
    const clientId = ++nextClientId;
    let releaseCalled = false;

    const client: Partial<PoolClient> = {
      query: ((sql: string) => {
        // Identify by SQL fragment.
        const isSelect = /SELECT response/i.test(sql);
        const isUpdate = /UPDATE claude_cache/i.test(sql);
        const rec: RecordedCall = {
          clientId,
          sql: isSelect ? 'SELECT' : isUpdate ? 'UPDATE' : 'OTHER',
          resolved: false,
          resolvedAt: null,
        };
        events.push(rec);
        const delay = isUpdate ? opts.updateDelayMs : 0;
        return new Promise((resolve) => {
          setTimeout(() => {
            rec.resolved = true;
            rec.resolvedAt = Date.now();
            if (isSelect) {
              resolve({ rows: opts.rowsForSelect, rowCount: opts.rowsForSelect.length });
            } else {
              resolve({ rows: [], rowCount: 1 });
            }
          }, delay);
        });
      }) as PoolClient['query'],
      release: (() => {
        if (releaseCalled) {
          throw new Error(`client ${clientId} released twice`);
        }
        releaseCalled = true;
        releases.push({ clientId, calledAt: Date.now() });
      }) as PoolClient['release'],
    };
    return client as PoolClient;
  };

  const pool: Partial<Pool> = {
    connect: (() => Promise.resolve(makeClient())) as Pool['connect'],
  };
  return { pool: pool as Pool, events, releases };
}

const silentLogger = pino({ level: 'silent' });

describe('PostgresCacheStore.get — pool release ordering (B4 BLOCKER)', () => {
  it('awaits the hit-counter UPDATE before releasing the client', async () => {
    const HIT_DELAY = 30; // ms — large enough to be observable
    const { pool, events, releases } = makeStubPool({
      updateDelayMs: HIT_DELAY,
      rowsForSelect: [
        {
          response: { ok: true },
          hit_count: 1,
          cached_at: new Date(),
        },
      ],
    });
    const store = new PostgresCacheStore(pool, silentLogger);

    const result = await store.get({
      route: 'enrich',
      model: 'claude-haiku-4-5',
      systemText: 'sys',
      userText: 'u',
    });
    expect(result).not.toBeNull();

    // We expect SELECT + UPDATE on the same client, both resolved.
    expect(events.length).toBe(2);
    const select = events.find((e) => e.sql === 'SELECT');
    const update = events.find((e) => e.sql === 'UPDATE');
    expect(select?.resolved).toBe(true);
    expect(update?.resolved).toBe(true);
    expect(select?.clientId).toBe(update?.clientId);

    // Exactly one release on that client, and its timestamp is >= the
    // UPDATE's resolved timestamp. This is the BLOCKER fix: the release
    // happens AFTER the in-flight query settles.
    expect(releases.length).toBe(1);
    expect(releases[0]!.clientId).toBe(update!.clientId);
    expect(releases[0]!.calledAt).toBeGreaterThanOrEqual(update!.resolvedAt!);
  });

  it('still releases the client when the hit-counter UPDATE fails', async () => {
    // Force the UPDATE to reject by overriding query for that statement.
    const events: { sql: string; resolved: boolean }[] = [];
    let releaseCalled = false;

    const client: Partial<PoolClient> = {
      query: ((sql: string) => {
        const isSelect = /SELECT response/i.test(sql);
        events.push({ sql: isSelect ? 'SELECT' : 'UPDATE', resolved: false });
        if (isSelect) {
          events[events.length - 1]!.resolved = true;
          return Promise.resolve({
            rows: [{ response: { ok: true }, hit_count: 1, cached_at: new Date() }],
            rowCount: 1,
          });
        }
        // Hit-counter UPDATE rejects.
        return Promise.reject(new Error('simulated update failure'));
      }) as PoolClient['query'],
      release: (() => {
        releaseCalled = true;
      }) as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: (() => Promise.resolve(client as PoolClient)) as Pool['connect'],
    };

    const store = new PostgresCacheStore(pool as Pool, silentLogger);
    // Read still succeeds — UPDATE failure is swallowed and logged.
    const result = await store.get({
      route: 'enrich',
      model: 'claude-haiku-4-5',
      systemText: 'sys',
      userText: 'u',
    });
    expect(result).not.toBeNull();
    expect(releaseCalled).toBe(true);
  });

  it('handles concurrent gets without sharing the same client', async () => {
    // Each concurrent call must acquire its OWN client and release it.
    // The previous (broken) pattern could leak pool slots; our fix shouldn't.
    const HIT_DELAY = 20;
    const { pool, events, releases } = makeStubPool({
      updateDelayMs: HIT_DELAY,
      rowsForSelect: [
        {
          response: { ok: true },
          hit_count: 1,
          cached_at: new Date(),
        },
      ],
    });
    const store = new PostgresCacheStore(pool, silentLogger);

    const key = {
      route: 'enrich' as const,
      model: 'claude-haiku-4-5' as const,
      systemText: 'sys',
      userText: 'u',
    };

    await Promise.all([store.get(key), store.get(key), store.get(key)]);

    // Three calls × (SELECT + UPDATE) = 6 events; three releases.
    expect(events.length).toBe(6);
    expect(releases.length).toBe(3);
    // Each client id appears exactly twice in events (SELECT + UPDATE).
    const perClient = new Map<number, number>();
    for (const e of events) {
      perClient.set(e.clientId, (perClient.get(e.clientId) ?? 0) + 1);
    }
    for (const [, n] of perClient) {
      expect(n).toBe(2);
    }
    // And exactly once in releases.
    const releaseIds = new Set(releases.map((r) => r.clientId));
    expect(releaseIds.size).toBe(3);
  });
});
