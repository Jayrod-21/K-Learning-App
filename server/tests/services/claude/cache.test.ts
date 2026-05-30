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
import {
  InMemoryCacheStore,
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
});
