/**
 * Postgres-backed cache for Claude responses.
 *
 * Lookup is by (prompt_hash, model) UNIQUE — see migration 004.
 * Write path uses ON CONFLICT DO UPDATE so concurrent identical writes
 * collapse to a single row with hit_count incremented (rather than
 * silently bloating the table).
 *
 * Why behind an interface (`CacheStore`): we want unit tests to plug in
 * an in-memory implementation without standing up a real Postgres, but
 * the integration tests still hit the real one (vitest + testcontainers).
 *
 * Thread / concurrency model: each call gets a connection from a shared
 * pool. We deliberately do NOT hold a transaction across the API call
 * (per SENIOR_ENGINEER_BAR.md §1: "No external I/O inside an open
 * transaction"). Lookup and write are separate one-statement
 * transactions; the cost is a possible duplicate API call when two
 * requests race on the same key, which we mitigate by ON CONFLICT DO
 * UPDATE so the write doesn't fail.
 */

import { createHash } from 'node:crypto';
import { type Pool, type PoolClient } from 'pg';
import type { Logger } from 'pino';

import type { ClaudeModelId, RouteName } from './config';
import { ClaudePersistenceError } from './errors';

// ---- Public interface ------------------------------------------------------

export interface CacheKey {
  readonly route: RouteName;
  readonly model: ClaudeModelId;
  readonly systemText: string;
  readonly userText: string;
}

export interface CacheEntry {
  readonly response: unknown;
  readonly hitCount: number;
  readonly cachedAt: Date;
}

export interface CacheStore {
  /** Look up a cache entry. Returns null on miss OR expired row. */
  get(key: CacheKey): Promise<CacheEntry | null>;
  /** Insert / refresh a cache entry. ttlSeconds = 0 means no expiry. */
  put(key: CacheKey, response: unknown, ttlSeconds: number): Promise<void>;
  /** Background eviction — delete rows past their expiry. */
  evictExpired(): Promise<number>;
}

// ---- Hashing ---------------------------------------------------------------

const UNIT_SEPARATOR = '\x1f';

/**
 * Compute the canonical cache key hash. Exported so tests can verify
 * that semantically equivalent prompts collide.
 */
export function hashCacheKey(key: CacheKey): string {
  const canonical = [
    key.route,
    key.model,
    normalize(key.systemText),
    normalize(key.userText),
  ].join(UNIT_SEPARATOR);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function normalize(text: string): string {
  // NFC normalize so equivalent code-point sequences hash identically;
  // collapse whitespace so cosmetic edits don't bust the cache.
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// ---- Postgres implementation ----------------------------------------------

const SELECT_SQL = `
  SELECT response, hit_count, cached_at
  FROM (
    SELECT
      response,
      hit_count,
      created_at AS cached_at,
      expires_at
    FROM claude_cache
    WHERE prompt_hash = $1
      AND model = $2::claude_model
    LIMIT 1
  ) AS row
  WHERE expires_at IS NULL OR expires_at > now()
`;

const HIT_INCREMENT_SQL = `
  UPDATE claude_cache
     SET hit_count = hit_count + 1,
         last_hit_at = now()
   WHERE prompt_hash = $1
     AND model = $2::claude_model
`;

const UPSERT_SQL = `
  INSERT INTO claude_cache
    (prompt_hash, model, route, response, expires_at)
  VALUES
    ($1, $2::claude_model, $3::claude_route, $4::jsonb, $5)
  ON CONFLICT ON CONSTRAINT uq_claude_cache_hash_model
  DO UPDATE SET
    response   = EXCLUDED.response,
    expires_at = EXCLUDED.expires_at,
    -- Re-writing the same key counts as a hit-like event for accounting.
    hit_count  = claude_cache.hit_count + 1,
    last_hit_at = now()
`;

const EVICT_SQL = `
  DELETE FROM claude_cache
   WHERE expires_at IS NOT NULL
     AND expires_at < now()
`;

export class PostgresCacheStore implements CacheStore {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async get(key: CacheKey): Promise<CacheEntry | null> {
    const hash = hashCacheKey(key);
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const res = await client.query<{
        response: unknown;
        hit_count: string | number;
        cached_at: Date;
      }>(SELECT_SQL, [hash, key.model]);

      if (res.rows.length === 0) return null;
      const row = res.rows[0]!;

      // Hit-counter update is awaited on the SAME pooled client BEFORE
      // releasing it in `finally`. A previous version fire-and-forgot the
      // UPDATE while synchronously calling `client.release()` — that
      // returned an in-flight client to the pool and risked the next
      // caller getting connection state mid-statement (corruption).
      // Cache hits are already cheap; the extra round-trip (~1ms on a
      // local Postgres) is well worth the correctness. If the UPDATE
      // itself fails (e.g. row was just evicted by a sweep), we swallow
      // the error — we already have the read answer.
      try {
        await client.query(HIT_INCREMENT_SQL, [hash, key.model]);
      } catch (e) {
        this.logger.warn(
          { errMsg: errMessage(e), promptHash: hash },
          'claude cache hit-counter update failed',
        );
      }

      return {
        response: row.response,
        hitCount: Number(row.hit_count),
        cachedAt: row.cached_at,
      };
    } catch (e) {
      // Cache READ failures must NOT fail the request — they should
      // demote to a fresh API call. Log and return null.
      this.logger.warn(
        { errMsg: errMessage(e), promptHash: hash },
        'claude cache lookup failed; treating as miss',
      );
      return null;
    } finally {
      if (client) client.release();
    }
  }

  async put(
    key: CacheKey,
    response: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    const hash = hashCacheKey(key);
    const expiresAt =
      ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query(UPSERT_SQL, [
        hash,
        key.model,
        key.route,
        JSON.stringify(response),
        expiresAt,
      ]);
    } catch (e) {
      // Cache WRITE failure is a soft error: the caller already got the
      // model response. Log loudly so it's visible, but throw a typed
      // error so callers can opt to bubble it as a 500 if they prefer.
      this.logger.warn(
        { errMsg: errMessage(e), promptHash: hash },
        'claude cache write failed',
      );
      throw new ClaudePersistenceError('failed to write claude_cache row', e);
    } finally {
      if (client) client.release();
    }
  }

  async evictExpired(): Promise<number> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const res = await client.query(EVICT_SQL);
      return res.rowCount ?? 0;
    } catch (e) {
      this.logger.warn(
        { errMsg: errMessage(e) },
        'claude cache eviction sweep failed',
      );
      return 0;
    } finally {
      if (client) client.release();
    }
  }
}

// ---- In-memory implementation (for unit tests) -----------------------------

export class InMemoryCacheStore implements CacheStore {
  private readonly rows = new Map<
    string,
    { response: unknown; hitCount: number; cachedAt: Date; expiresAt: Date | null }
  >();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(key: CacheKey): Promise<CacheEntry | null> {
    const hash = `${hashCacheKey(key)}|${key.model}`;
    const row = this.rows.get(hash);
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      this.rows.delete(hash);
      return null;
    }
    row.hitCount += 1;
    return { response: row.response, hitCount: row.hitCount, cachedAt: row.cachedAt };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async put(
    key: CacheKey,
    response: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    const hash = `${hashCacheKey(key)}|${key.model}`;
    const expiresAt =
      ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;
    const existing = this.rows.get(hash);
    this.rows.set(hash, {
      response,
      hitCount: existing ? existing.hitCount + 1 : 0,
      cachedAt: existing ? existing.cachedAt : new Date(),
      expiresAt,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async evictExpired(): Promise<number> {
    let n = 0;
    const now = Date.now();
    for (const [k, v] of this.rows.entries()) {
      if (v.expiresAt !== null && v.expiresAt.getTime() <= now) {
        this.rows.delete(k);
        n += 1;
      }
    }
    return n;
  }

  size(): number {
    return this.rows.size;
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
