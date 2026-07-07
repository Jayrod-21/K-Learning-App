/**
 * Cache layer tests — InMemoryCacheStore covers the contract, and we
 * separately verify the SHA-256 hash function is collision-stable.
 *
 * The PostgresCacheStore `get` pool-release order is verified by
 * `cache.pool-release.test.ts` (sibling file) — it asserts the hit-counter
 * UPDATE finishes BEFORE `client.release()` returns the client to the pool.
 * That defends against the B4 BLOCKER (fire-and-forget UPDATE + sync release
 * = pool corruption under load). See REVIEW_B4 §B-1 / FIX_REPORT_B.md.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import pino from 'pino';
import type { Pool, PoolClient } from 'pg';
import {
  CACHE_TTL_FOREVER,
  InMemoryCacheStore,
  PostgresCacheStore,
  hashCacheKey,
  type CacheKey,
} from '../../../src/services/claude/cache';

function keyFor(over: Partial<CacheKey> = {}): CacheKey {
  return {
    route: 'enrich',
    model: 'claude-haiku-4-5',
    systemText: 'sys',
    userText: 'user',
    ...over,
  };
}

describe('hashCacheKey', () => {
  it('produces a 64-hex SHA-256 digest', () => {
    const h = hashCacheKey(keyFor());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash for whitespace-equivalent prompts', () => {
    const a = hashCacheKey(keyFor({ userText: '  먹다  \n\t (Verb)  ' }));
    const b = hashCacheKey(keyFor({ userText: '먹다 (Verb)' }));
    expect(a).toBe(b);
  });

  it('produces the same hash for NFC-equivalent code-point sequences', () => {
    // '가' as a single composed code point vs decomposed (NFD) — should
    // collide after NFC normalization.
    const composed = '가';
    const decomposed = '가'; // 한글 자모 ㄱ + ㅏ
    expect(composed).not.toBe(decomposed);
    const a = hashCacheKey(keyFor({ userText: composed }));
    const b = hashCacheKey(keyFor({ userText: decomposed }));
    expect(a).toBe(b);
  });

  it('produces different hashes for different routes / models', () => {
    const a = hashCacheKey(keyFor({ route: 'enrich' }));
    const b = hashCacheKey(keyFor({ route: 'recognize_grammar' }));
    const c = hashCacheKey(keyFor({ model: 'claude-sonnet-4-6' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('InMemoryCacheStore', () => {
  let store: InMemoryCacheStore;
  beforeEach(() => {
    store = new InMemoryCacheStore();
  });

  it('returns null on miss', async () => {
    const r = await store.get(keyFor());
    expect(r).toBeNull();
  });

  it('round-trips a write and read', async () => {
    await store.put(keyFor(), { foo: 'bar' }, 60);
    const r = await store.get(keyFor());
    expect(r?.response).toEqual({ foo: 'bar' });
  });

  it('increments hit count on each get', async () => {
    await store.put(keyFor(), { x: 1 }, 60);
    const r1 = await store.get(keyFor());
    const r2 = await store.get(keyFor());
    expect(r1?.hitCount).toBe(1);
    expect(r2?.hitCount).toBe(2);
  });

  it('treats an expired row as a miss', async () => {
    // Insert with a 0-ms TTL — guaranteed expired by next event-loop tick.
    await store.put(keyFor(), { x: 1 }, 0.0001); // ~0 seconds
    await new Promise((r) => setTimeout(r, 5));
    const r = await store.get(keyFor());
    expect(r).toBeNull();
  });

  it('upserts on duplicate key (no UNIQUE failure)', async () => {
    await store.put(keyFor(), { a: 1 }, 60);
    await store.put(keyFor(), { a: 2 }, 60);
    const r = await store.get(keyFor());
    expect(r?.response).toEqual({ a: 2 });
  });

  it('evictExpired removes expired rows and returns the count', async () => {
    await store.put(keyFor({ userText: 'a' }), { x: 1 }, 0.0001);
    await store.put(keyFor({ userText: 'b' }), { x: 2 }, 60);
    await new Promise((r) => setTimeout(r, 5));
    const n = await store.evictExpired();
    expect(n).toBe(1);
    expect(await store.get(keyFor({ userText: 'a' }))).toBeNull();
    expect(await store.get(keyFor({ userText: 'b' }))).not.toBeNull();
  });

  // ---- Regressions for SWEEP_server_services #2 (inverted ttl-0) ----------

  it('ttlSeconds = 0 means DO NOT cache: nothing stored, get misses', async () => {
    // Pre-fix this stored the row with NO expiry (cached forever) — the exact
    // inversion that permanently cached the four "uncached" routes.
    await store.put(keyFor(), { poisoned: true }, 0);
    expect(store.size()).toBe(0);
    expect(await store.get(keyFor())).toBeNull();
  });

  it('a positive ttl is stored and later expires', async () => {
    await store.put(keyFor(), { ok: true }, 60);
    expect(store.size()).toBe(1);
    expect((await store.get(keyFor()))?.response).toEqual({ ok: true });
    // And a short-ttl sibling row genuinely expires.
    await store.put(keyFor({ userText: 'short' }), { x: 1 }, 0.001);
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.get(keyFor({ userText: 'short' }))).toBeNull();
  });

  it('CACHE_TTL_FOREVER is an explicit opt-in: stored and never evicted', async () => {
    await store.put(keyFor(), { forever: true }, CACHE_TTL_FOREVER);
    expect((await store.get(keyFor()))?.response).toEqual({ forever: true });
    expect(await store.evictExpired()).toBe(0);
    expect(await store.get(keyFor())).not.toBeNull();
  });

  // ---- Regression for SWEEP_server_services #7 (hit-count accounting) -----

  it('a refresh write (re-put) does NOT count as a hit', async () => {
    await store.put(keyFor(), { v: 1 }, 60);
    expect((await store.get(keyFor()))?.hitCount).toBe(1);
    // Pre-fix the re-put bumped hitCount, so the next get reported 3.
    await store.put(keyFor(), { v: 2 }, 60);
    const r = await store.get(keyFor());
    expect(r?.response).toEqual({ v: 2 });
    expect(r?.hitCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PostgresCacheStore — ttl-0 / forever / hit-count semantics via a stub pool.
// (The pool-release ORDERING contract lives in cache.pool-release.test.ts.)
// ---------------------------------------------------------------------------

interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function makeRecordingPool(opts: {
  selectRows?: unknown[];
  updateRows?: unknown[];
}): { pool: Pool; queries: RecordedQuery[]; connects: () => number } {
  const queries: RecordedQuery[] = [];
  let connects = 0;
  const client: Partial<PoolClient> = {
    query: ((sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/SELECT response/i.test(sql)) {
        const rows = opts.selectRows ?? [];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (/UPDATE claude_cache/i.test(sql)) {
        const rows = opts.updateRows ?? [];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }) as PoolClient['query'],
    release: () => undefined,
  };
  const pool: Partial<Pool> = {
    connect: (() => {
      connects += 1;
      return Promise.resolve(client as PoolClient);
    }) as Pool['connect'],
  };
  return { pool: pool as Pool, queries, connects: () => connects };
}

const silentLogger = pino({ level: 'silent' });

describe('PostgresCacheStore — ttl semantics (SWEEP #2)', () => {
  it('put with ttlSeconds = 0 is a no-op: no connection, no write', async () => {
    const { pool, queries, connects } = makeRecordingPool({});
    const store = new PostgresCacheStore(pool, silentLogger);
    await store.put(keyFor(), { poisoned: true }, 0);
    expect(connects()).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it('put with a positive ttl writes a row with a real future expires_at', async () => {
    const { pool, queries } = makeRecordingPool({});
    const store = new PostgresCacheStore(pool, silentLogger);
    const before = Date.now();
    await store.put(keyFor(), { ok: true }, 60);
    expect(queries).toHaveLength(1);
    const expiresAt = queries[0]!.params[4];
    expect(expiresAt).toBeInstanceOf(Date);
    const t = (expiresAt as Date).getTime();
    expect(t).toBeGreaterThanOrEqual(before + 59_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it('put with CACHE_TTL_FOREVER writes a far-future expires_at, never NULL', async () => {
    const { pool, queries } = makeRecordingPool({});
    const store = new PostgresCacheStore(pool, silentLogger);
    await store.put(keyFor(), { forever: true }, CACHE_TTL_FOREVER);
    expect(queries).toHaveLength(1);
    const expiresAt = queries[0]!.params[4];
    expect(expiresAt).toBeInstanceOf(Date);
    expect((expiresAt as Date).getUTCFullYear()).toBe(9999);
  });

  it('get treats legacy NULL-expiry rows as invalid (SQL requires a non-NULL expiry)', async () => {
    // The poisoned rows written by the pre-fix ttl-0 bug have expires_at NULL.
    // The lookup must exclude them: assert the predicate the query ships with.
    const { pool, queries } = makeRecordingPool({ selectRows: [] });
    const store = new PostgresCacheStore(pool, silentLogger);
    await store.get(keyFor());
    const select = queries.find((q) => /SELECT response/i.test(q.sql));
    expect(select).toBeDefined();
    expect(select!.sql).toContain('expires_at IS NOT NULL AND expires_at > now()');
    expect(select!.sql).not.toContain('expires_at IS NULL OR');
  });

  it('evictExpired also sweeps legacy NULL-expiry rows', async () => {
    const { pool, queries } = makeRecordingPool({});
    const store = new PostgresCacheStore(pool, silentLogger);
    await store.evictExpired();
    const evict = queries.find((q) => /DELETE FROM claude_cache/i.test(q.sql));
    expect(evict).toBeDefined();
    expect(evict!.sql).toMatch(/expires_at IS NULL\s+OR expires_at < now\(\)/);
  });
});

describe('PostgresCacheStore — hit-count accounting (SWEEP #7)', () => {
  it('get returns the POST-increment hit count from the UPDATE', async () => {
    const { pool } = makeRecordingPool({
      selectRows: [{ response: { ok: true }, hit_count: 4, cached_at: new Date() }],
      updateRows: [{ hit_count: 5 }],
    });
    const store = new PostgresCacheStore(pool, silentLogger);
    const r = await store.get(keyFor());
    // Pre-fix this reported the stale pre-increment value (4).
    expect(r?.hitCount).toBe(5);
  });

  it('falls back to the pre-read count when the increment returns no row', async () => {
    const { pool } = makeRecordingPool({
      selectRows: [{ response: { ok: true }, hit_count: 4, cached_at: new Date() }],
      updateRows: [],
    });
    const store = new PostgresCacheStore(pool, silentLogger);
    const r = await store.get(keyFor());
    expect(r?.hitCount).toBe(4);
  });

  it('the upsert does not bump hit_count on conflict (a rewrite is not a hit)', async () => {
    const { pool, queries } = makeRecordingPool({});
    const store = new PostgresCacheStore(pool, silentLogger);
    await store.put(keyFor(), { ok: true }, 60);
    const upsert = queries.find((q) => /INSERT INTO claude_cache/i.test(q.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.sql).not.toContain('hit_count');
    expect(upsert!.sql).not.toContain('last_hit_at');
  });
});
