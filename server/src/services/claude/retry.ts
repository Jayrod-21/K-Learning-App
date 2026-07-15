/**
 * Exponential-backoff-with-jitter wrapper for Anthropic SDK calls.
 *
 * Why a hand-rolled wrapper instead of the SDK's `maxRetries`:
 *   - The SDK retries silently; we want WARN-log + cost row even on
 *     retried-and-eventually-succeeded so dashboards reflect reality.
 *   - We need to distinguish "transient — retry" from "model gave us a
 *     bad shape — don't retry" (Zod failures are intentionally
 *     non-retryable because the model isn't suddenly going to fix itself
 *     on the next call with the same prompt).
 *   - We want to redact the `request` field on the thrown error so the
 *     API key never reaches the logger even if a future SDK regression
 *     starts attaching the auth header to the error object.
 *
 * The retryable error classification is in `isRetryable()` and is
 * deliberately conservative: when in doubt, don't retry (retries cost
 * money and they amplify outages).
 */

import { type Logger } from 'pino';
import {
  ClaudeAuthError,
  ClaudeUnavailableError,
} from './errors';

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseMs: number;
  readonly maxDelayMs: number;
  readonly logger: Logger;
  /** Identifier for logs ("enrich", "recognize_grammar", ...). */
  readonly route: string;
  /** Optional injectable sleep — tests stub this to make retries instant. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional injectable random for predictable jitter in tests. */
  readonly random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `fn`, retry on retryable errors with exponential backoff + jitter,
 * up to `maxAttempts`. After the last retry fails, throws
 * `ClaudeUnavailableError` (or `ClaudeAuthError` if the cause was auth).
 *
 * Non-retryable errors are rethrown immediately, in their original type.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let lastError: unknown = undefined;

  // attempt 0 is the first try; we retry up to maxAttempts times total
  for (let attempt = 0; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      const result = await fn();
      if (attempt > 0) {
        opts.logger.warn(
          { route: opts.route, attempt, status: 'recovered' },
          'claude call recovered after retry',
        );
      }
      return result;
    } catch (err) {
      lastError = err;
      const retryable = isRetryable(err);
      const isAuth = isAuthError(err);

      if (isAuth) {
        opts.logger.error(
          { route: opts.route, attempt, errCode: classify(err) },
          'claude call auth failure (not retryable)',
        );
        throw new ClaudeAuthError(
          'Anthropic API rejected the credentials',
          redactCause(err),
        );
      }

      if (!retryable || attempt === opts.maxAttempts) {
        // Either non-retryable or out of attempts.
        if (retryable) {
          opts.logger.error(
            { route: opts.route, attempt, errCode: classify(err) },
            'claude call retries exhausted',
          );
          throw new ClaudeUnavailableError(
            `Anthropic call failed after ${opts.maxAttempts + 1} attempts`,
            redactCause(err),
          );
        }
        // Non-retryable: rethrow as-is so the caller can distinguish.
        throw err;
      }

      const delay = computeDelay(attempt, opts.baseMs, opts.maxDelayMs, random);
      opts.logger.warn(
        {
          route: opts.route,
          attempt,
          delayMs: delay,
          errCode: classify(err),
        },
        'claude call failed, retrying',
      );
      await sleep(delay);
    }
  }
  // Unreachable: the loop either returns or throws.
  /* istanbul ignore next */
  throw new ClaudeUnavailableError(
    'retry loop fell through unexpectedly',
    redactCause(lastError),
  );
}

/** Pure helper, exported for tests. */
export function computeDelay(
  attempt: number,
  baseMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  // Full jitter (AWS architecture blog "Exponential Backoff And Jitter"):
  //   delay = random(0, min(maxDelayMs, baseMs * 2^attempt))
  // Avoids retry-thundering-herd and is well-behaved on the lower bound.
  const exp = Math.min(maxDelayMs, baseMs * 2 ** attempt);
  return Math.floor(random() * exp);
}

/**
 * OS-level connection error codes that mean "the transport failed, not the
 * request" — always safe to retry.
 */
const CONN_ERROR_CODE_RE =
  /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)$/;

/**
 * Message-level fallback for the same failure class, for errors that don't
 * carry a structured `.code` (e.g. a message-only rethrow, or the SDK's own
 * generic "Connection error." / "Request timed out." text on
 * APIConnectionError / APIConnectionTimeoutError — see below).
 */
const CONN_ERROR_MESSAGE_RE =
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|connection error|connection terminated|request timed out|timeout|socket hang up/i;

/** Narrow an unknown value to a plain object for duck-typing, else undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v != null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/** True if `e` (or its `.cause`) duck-types as a transient connection failure. */
function isConnectionErrorShape(e: Record<string, unknown> | undefined): boolean {
  if (!e) return false;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return CONN_ERROR_CODE_RE.test(code) || CONN_ERROR_MESSAGE_RE.test(message);
}

/** Exported for tests. */
export function isRetryable(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  // Anthropic SDK: HTTP-mapped errors carry a numeric `status`.
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
  }

  // No HTTP status: either the SDK's APIConnectionError / APIConnectionTimeoutError
  // (network-level; the SDK constructs these with `status: undefined` by design —
  // see @anthropic-ai/sdk's core/error.ts) or a raw transport error passed through
  // directly.
  //
  // B-032: this used to gate on `err.name === 'APIConnectionError'`. That check is
  // DEAD — neither APIConnectionError nor APIConnectionTimeoutError override
  // `Error.prototype.name` in their constructors, so a real instance's `.name` is
  // always the literal string "Error", never "APIConnectionError". A transient
  // connection drop to Claude was therefore never retried. Duck-type on the
  // actual shape instead: the SDK attaches the underlying transport error (with
  // its OS `code`, e.g. ECONNREFUSED/ECONNRESET) as `.cause`, and/or the error's
  // own message is one of the SDK's fixed connection-failure strings. We check
  // both the error itself AND its `.cause` so this works whether or not the SDK
  // wrapped the raw transport error.
  if (isConnectionErrorShape(e) || isConnectionErrorShape(asRecord(e.cause))) {
    return true;
  }
  return false;
}

function isAuthError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  return status === 401 || status === 403;
}

function classify(err: unknown): string {
  if (err == null || typeof err !== 'object') return 'unknown';
  const e = err as { name?: unknown; status?: unknown; code?: unknown };
  if (typeof e.status === 'number') return `http_${e.status}`;
  if (typeof e.name === 'string' && e.name.length > 0) return e.name;
  if (typeof e.code === 'string' && e.code.length > 0) return e.code;
  return 'unknown';
}

/**
 * Strip request / headers / API-key-bearing fields off a SDK error before
 * we propagate it as a `cause`. Defense in depth — never trust the SDK
 * to keep secrets out of error objects across versions.
 */
function redactCause(err: unknown): unknown {
  if (err == null || typeof err !== 'object') return err;
  const e = err as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const k of ['name', 'message', 'status', 'code', 'type']) {
    if (k in e) safe[k] = e[k];
  }
  return safe;
}
