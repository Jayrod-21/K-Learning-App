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
  /**
   * Insert / refresh a cache entry.
   *
   * `ttlSeconds` semantics (SWEEP_server_services #2 — these used to be
   * inverted, which permanently cached the four "uncached" routes):
   *   - `> 0` (finite)        → cache for that many seconds.
   *   - `0` (or any other
   *     non-positive value)   → DO NOT cache: `put` is a no-op, so `get`
   *                             always misses. This matches the intent of the
   *                             ttl-0 routes in config.ts (diagnostic_item,
   *                             image_ocr, generate_grammar_drill,
   *                             score_grammar_drill).
   *   - `CACHE_TTL_FOREVER`   → explicit opt-in sentinel for "no practical
   *                             expiry". No route uses it today.
   */
  put(key: CacheKey, response: unknown, ttlSeconds: number): Promise<void>;
  /**
   * Background eviction — delete rows past their expiry, plus legacy
   * NULL-expiry rows written by the pre-fix inverted ttl-0 semantics.
   */
  evictExpired(): Promise<number>;
}

/**
 * Explicit opt-in sentinel for "cache with no practical expiry".
 *
 * The pre-fix code overloaded `ttlSeconds = 0` to mean "no expiry", which
 * collided with the routes that pass 0 meaning "do not cache" (see #2 above).
 * A route that genuinely wants forever-caching must now say so explicitly
 * with this sentinel; it maps to a far-future `expires_at`, NOT to NULL —
 * NULL-expiry rows are treated as invalid legacy data and swept.
 */
export const CACHE_TTL_FOREVER = Number.POSITIVE_INFINITY;

/** Far-future expiry backing CACHE_TTL_FOREVER (well inside pg timestamptz range). */
const FOREVER_EXPIRES_AT = new Date('9999-12-31T00:00:00.000Z');

/**
 * Map a ttl to a concrete `expires_at`, or `null` meaning "do not cache".
 * Shared by both store implementations so their semantics cannot drift.
 */
function expiryFor(ttlSeconds: number): Date | null {
  if (ttlSeconds === CACHE_TTL_FOREVER) return FOREVER_EXPIRES_AT;
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    return new Date(Date.now() + ttlSeconds * 1000);
  }
  // 0 / negative / NaN → no caching.
  return null;
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

// NOTE on `expires_at IS NOT NULL`: rows with a NULL expiry are LEGACY POISON
// from the inverted ttl-0 bug (SWEEP_server_services #2) — e.g. permanently
// cached image_ocr rows whose weak key (media_type + base64 length) can serve
// the WRONG image's OCR. They must never be served; evictExpired sweeps them.
// "Forever" rows written via CACHE_TTL_FOREVER carry a far-future timestamp,
// so they still satisfy `expires_at > now()`.
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
  WHERE expires_at IS NOT NULL AND expires_at > now()
`;

// RETURNING hit_count so `get` can report the POST-increment count (the
// pre-fix code returned the pre-increment read — off-by-one; SWEEP #7).
const HIT_INCREMENT_SQL = `
  UPDATE claude_cache
     SET hit_count = hit_count + 1,
         last_hit_at = now()
   WHERE prompt_hash = $1
     AND model = $2::claude_model
  RETURNING hit_count
`;

// On conflict we refresh the payload/expiry ONLY. A re-write of the same key
// is not a cache hit; bumping hit_count/last_hit_at here inflated the
// hit-rate accounting (SWEEP #7).
const UPSERT_SQL = `
  INSERT INTO claude_cache
    (prompt_hash, model, route, response, expires_at)
  VALUES
    ($1, $2::claude_model, $3::claude_route, $4::jsonb, $5)
  ON CONFLICT ON CONSTRAINT uq_claude_cache_hash_model
  DO UPDATE SET
    response   = EXCLUDED.response,
    expires_at = EXCLUDED.expires_at
`;

// Also sweeps legacy NULL-expiry rows (see SELECT_SQL note) so the poisoned
// rows written before the ttl-0 fix self-heal out of the table.
const EVICT_SQL = `
  DELETE FROM claude_cache
   WHERE expires_at IS NULL
      OR expires_at < now()
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
      //
      // The UPDATE RETURNs the post-increment hit_count so this read
      // reflects itself in the count (pre-fix we returned the stale
      // pre-increment value — SWEEP #7). If the UPDATE hit 0 rows or
      // failed, fall back to the pre-read value: cosmetic accounting only.
      let hitCount = Number(row.hit_count);
      try {
        const upd = await client.query<{ hit_count: string | number }>(
          HIT_INCREMENT_SQL,
          [hash, key.model],
        );
        if (upd.rows.length > 0) {
          hitCount = Number(upd.rows[0]!.hit_count);
        }
      } catch (e) {
        this.logger.warn(
          { errMsg: errMessage(e), promptHash: hash },
          'claude cache hit-counter update failed',
        );
      }

      return {
        response: row.response,
        hitCount,
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
    const expiresAt = expiryFor(ttlSeconds);
    if (expiresAt === null) {
      // ttl 0 = DO NOT CACHE (SWEEP #2). Skip the write entirely — the
      // pre-fix code stored these rows with expires_at NULL, i.e. FOREVER,
      // which permanently cached the four routes that pass 0 expecting no
      // caching (and let image_ocr's weak cache key collide across images).
      return;
    }
    const hash = hashCacheKey(key);
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
    { response: unknown; hitCount: number; cachedAt: Date; expiresAt: Date }
  >();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(key: CacheKey): Promise<CacheEntry | null> {
    const hash = `${hashCacheKey(key)}|${key.model}`;
    const row = this.rows.get(hash);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
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
    const expiresAt = expiryFor(ttlSeconds);
    // ttl 0 = DO NOT CACHE — mirror PostgresCacheStore (SWEEP #2).
    if (expiresAt === null) return;
    const hash = `${hashCacheKey(key)}|${key.model}`;
    const existing = this.rows.get(hash);
    this.rows.set(hash, {
      response,
      // A refresh write is NOT a hit — mirror the Postgres UPSERT (SWEEP #7).
      hitCount: existing ? existing.hitCount : 0,
      cachedAt: existing ? existing.cachedAt : new Date(),
      expiresAt,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async evictExpired(): Promise<number> {
    let n = 0;
    const now = Date.now();
    for (const [k, v] of this.rows.entries()) {
      if (v.expiresAt.getTime() <= now) {
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
