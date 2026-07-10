/**
 * Global test setup (vitest `setupFiles`).
 *
 * The suite runs files sequentially in per-file isolated forks
 * (vitest.config.ts: `fileParallelism: false`, `isolate: true`), so tests in
 * the SAME file share one Node process — and therefore the rate-limiter
 * modules' in-memory hit stores. Reset them before each test so a prior test's
 * failed-auth attempts can't push a later test over the per-IP `authLimiter`
 * ceiling and turn an expected 200/400 into a spurious 429. Individual suites
 * may still call resetLimiters() in their own beforeEach; this is the safety
 * net that covers every suite uniformly.
 */
import { beforeEach } from 'vitest';
import { resetLimiters } from '../src/middleware/rateLimits.js';

beforeEach(() => {
  resetLimiters();
});
