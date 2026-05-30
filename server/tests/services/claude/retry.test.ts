/**
 * Retry / backoff tests.
 */

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  withRetry,
  computeDelay,
  isRetryable,
} from '../../../src/services/claude/retry';
import {
  ClaudeAuthError,
  ClaudeUnavailableError,
} from '../../../src/services/claude/errors';
import { sdkError } from './setup';

const silentLog = pino({ level: 'silent' });

describe('isRetryable', () => {
  it.each([429, 500, 502, 503, 504, 408, 425])(
    'retries HTTP %i',
    (status) => {
      expect(isRetryable(sdkError(status))).toBe(true);
    },
  );

  it.each([400, 404, 422])('does NOT retry HTTP %i', (status) => {
    expect(isRetryable(sdkError(status))).toBe(false);
  });

  it('does NOT retry auth (401/403) [handled separately by withRetry]', () => {
    // isRetryable says false; withRetry handles 401/403 by throwing ClaudeAuthError.
    expect(isRetryable(sdkError(401))).toBe(false);
    expect(isRetryable(sdkError(403))).toBe(false);
  });

  it('retries network-level errors by message', () => {
    expect(isRetryable(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
  });

  it('retries APIConnectionError by name', () => {
    const e = new Error('failed to connect');
    e.name = 'APIConnectionError';
    expect(isRetryable(e)).toBe(true);
  });

  it('does not retry non-error values', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable('boom')).toBe(false);
  });
});

describe('computeDelay', () => {
  it('returns 0..base on attempt 0', () => {
    const d = computeDelay(0, 100, 8000, () => 0.5);
    expect(d).toBe(50); // floor(0.5 * 100)
  });

  it('grows exponentially up to the cap', () => {
    const d0 = computeDelay(0, 100, 8000, () => 1);
    const d3 = computeDelay(3, 100, 8000, () => 1);
    const d20 = computeDelay(20, 100, 8000, () => 1);
    expect(d0).toBe(100);
    expect(d3).toBe(800);
    expect(d20).toBe(8000); // capped
  });

  it('never returns negative', () => {
    const d = computeDelay(5, 100, 8000, () => 0);
    expect(d).toBeGreaterThanOrEqual(0);
  });
});

describe('withRetry', () => {
  const sleep = vi.fn(async () => undefined);
  const opts = {
    maxAttempts: 3,
    baseMs: 1,
    maxDelayMs: 2,
    logger: silentLog,
    route: 'enrich',
    sleep,
    random: () => 0,
  };

  it('returns the value on first-try success', async () => {
    const fn = vi.fn(async () => 'ok');
    const r = await withRetry(fn, opts);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on 5xx then succeeds', async () => {
    sleep.mockClear();
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw sdkError(503);
      return 'ok';
    });
    const r = await withRetry(fn, opts);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws ClaudeUnavailableError after exhausting attempts', async () => {
    const fn = vi.fn(async () => {
      throw sdkError(503);
    });
    await expect(withRetry(fn, opts)).rejects.toBeInstanceOf(ClaudeUnavailableError);
    expect(fn).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it('does not retry on 400; rethrows the original', async () => {
    const err = sdkError(400, 'bad request');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, opts)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws ClaudeAuthError on 401, no retries', async () => {
    const fn = vi.fn(async () => {
      throw sdkError(401);
    });
    await expect(withRetry(fn, opts)).rejects.toBeInstanceOf(ClaudeAuthError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws ClaudeAuthError on 403', async () => {
    const fn = vi.fn(async () => {
      throw sdkError(403);
    });
    await expect(withRetry(fn, opts)).rejects.toBeInstanceOf(ClaudeAuthError);
  });

  it('retries on 429 (rate limit) up to limit', async () => {
    const fn = vi.fn(async () => {
      throw sdkError(429);
    });
    await expect(withRetry(fn, opts)).rejects.toBeInstanceOf(ClaudeUnavailableError);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
