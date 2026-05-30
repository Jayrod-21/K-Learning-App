/**
 * In-process token-bucket rate limiter.
 *
 * Defense in depth: B3's express edge also applies rate limits, but a
 * mis-mounted route there could bypass them. This bucket runs INSIDE the
 * claude module so every call goes through it.
 *
 * One bucket per (route, bucketKey). bucketKey is `userId` when present,
 * else `'anon'`. Capacity = rateLimitPerMinute; refill is continuous at
 * capacity/60 tokens/second. Burst tolerance = full capacity.
 *
 * In-memory state: fine for the single-process server. If/when we scale
 * to multiple workers, swap to a Redis-backed implementation behind the
 * same interface.
 */

import type { RouteName } from './config';
import { ClaudeRateLimitError } from './errors';

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiter {
  /** Consume 1 token. Throws ClaudeRateLimitError if none available. */
  consume(route: RouteName, bucketKey: string): void;
}

export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: Readonly<Record<RouteName, number>>,
    /** Injectable for tests. */
    private readonly now: () => number = Date.now,
  ) {}

  consume(route: RouteName, bucketKey: string): void {
    const capacity = this.perMinute[route];
    const refillPerMs = capacity / 60_000;

    const key = `${route}:${bucketKey}`;
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: t };
      this.buckets.set(key, bucket);
    }
    // Refill in proportion to elapsed time.
    const elapsed = Math.max(0, t - bucket.lastRefillMs);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = t;

    if (bucket.tokens < 1) {
      throw new ClaudeRateLimitError(
        `claude proxy rate limit exceeded for route=${route} key=${bucketKey} ` +
          `(limit=${capacity}/min)`,
      );
    }
    bucket.tokens -= 1;
  }

  /** Test-only: clear buckets between tests. */
  reset(): void {
    this.buckets.clear();
  }
}
