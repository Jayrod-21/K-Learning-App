/**
 * withTransaction — client release semantics (SWEEP_server_services #5).
 *
 * node-postgres: `client.release()` RETURNS the client to the pool;
 * `client.release(err)` DESTROYS it. The pre-fix code always released with no
 * argument, so a connection whose ROLLBACK failed (socket death
 * mid-transaction, backend restart during a blue/green flip) was returned to
 * the pool and handed — dead — to the next caller.
 *
 * These tests stub the pool via setPoolForTesting and assert:
 *   1. success       → COMMIT + plain release (re-pooled).
 *   2. fn throws,
 *      ROLLBACK ok   → plain release (connection proved healthy).
 *   3. fn throws,
 *      ROLLBACK fails → release(err) — the client is DESTROYED, exactly once.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Pool, PoolClient } from 'pg';
import {
  getPoolForTesting,
  setPoolForTesting,
  withTransaction,
} from '../../src/db/pool';
import { setLoggerForTesting } from '../../src/logging';

interface StubHarness {
  pool: Pool;
  queries: string[];
  /** Each entry is the argument list release() was invoked with. */
  releaseCalls: unknown[][];
}

function makeStubPool(opts: { rollbackFails?: boolean } = {}): StubHarness {
  const queries: string[] = [];
  const releaseCalls: unknown[][] = [];
  const client: Partial<PoolClient> = {
    query: ((sql: string) => {
      queries.push(sql);
      if (sql === 'ROLLBACK' && opts.rollbackFails) {
        return Promise.reject(
          new Error('terminating connection due to administrator command'),
        );
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as PoolClient['query'],
    release: ((...args: unknown[]) => {
      releaseCalls.push(args);
    }) as PoolClient['release'],
  };
  const pool = {
    connect: () => Promise.resolve(client as PoolClient),
    on: () => pool,
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return { pool, queries, releaseCalls };
}

// The pool module logs through getLogger(); install a silent logger so these
// tests need no app config env.
beforeAll(() => {
  setLoggerForTesting(pino({ level: 'silent' }));
});

// The suite runs single-fork: never leave the stub installed for later tests.
let previousPool: Pool | null = null;

function installStub(h: StubHarness): void {
  previousPool = getPoolForTesting();
  setPoolForTesting(h.pool);
}

afterEach(() => {
  if (previousPool) {
    setPoolForTesting(previousPool);
    previousPool = null;
  }
});

describe('withTransaction — release semantics (SWEEP #5)', () => {
  it('commits and re-pools the client on success', async () => {
    const h = makeStubPool();
    installStub(h);

    const out = await withTransaction((client) => {
      void client;
      return Promise.resolve('ok');
    });

    expect(out).toBe('ok');
    expect(h.queries).toEqual(['BEGIN', 'COMMIT']);
    expect(h.releaseCalls).toEqual([[]]); // exactly one plain release
  });

  it('rolls back and re-pools the client when fn throws but ROLLBACK succeeds', async () => {
    const h = makeStubPool();
    installStub(h);
    const boom = new Error('constraint violation');

    await expect(withTransaction(() => Promise.reject(boom))).rejects.toBe(boom);

    expect(h.queries).toEqual(['BEGIN', 'ROLLBACK']);
    // ROLLBACK worked → the connection is demonstrably healthy → plain
    // release (returned to the pool, NOT destroyed).
    expect(h.releaseCalls).toEqual([[]]);
  });

  it('DESTROYS the client (release(err)) when ROLLBACK fails', async () => {
    const h = makeStubPool({ rollbackFails: true });
    installStub(h);
    const boom = new Error('socket hang up');

    await expect(withTransaction(() => Promise.reject(boom))).rejects.toBe(boom);

    expect(h.queries).toEqual(['BEGIN', 'ROLLBACK']);
    // Exactly ONE release, and it carries the error → pg discards the
    // (possibly dead) connection instead of re-pooling it. Pre-fix this was
    // a plain release() and the assertion below failed.
    expect(h.releaseCalls).toHaveLength(1);
    expect(h.releaseCalls[0]).toHaveLength(1);
    expect(h.releaseCalls[0]![0]).toBe(boom);
  });

  it('wraps a non-Error throw before destroying so pg still discards the client', async () => {
    const h = makeStubPool({ rollbackFails: true });
    installStub(h);

    await expect(
      withTransaction(() => Promise.reject('string failure')),
    ).rejects.toBe('string failure');

    expect(h.releaseCalls).toHaveLength(1);
    expect(h.releaseCalls[0]![0]).toBeInstanceOf(Error);
  });
});
