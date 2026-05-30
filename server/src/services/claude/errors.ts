/**
 * Typed error hierarchy for the Claude proxy.
 *
 * Why a hierarchy: callers (the Express route handlers and the retry
 * wrapper) need to distinguish "this is a transient infra failure, retry"
 * from "this is a user-input problem, return 400" from "this is a model
 * regression, return 502 and page somebody". Bare `Error` doesn't carry
 * that signal.
 *
 * Naming convention: every class ends in `Error`, every class has a
 * `code` field that's the same as its class name (cheaper than `name`
 * for switch-on-string).
 */

export abstract class ClaudeProxyError extends Error {
  /** Stable machine-readable code. Pick on this in switch statements. */
  public abstract readonly code: string;
  /** Hint to the retry wrapper. */
  public abstract readonly retryable: boolean;
  /** HTTP status the route handler should return when this surfaces. */
  public abstract readonly httpStatus: number;

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** User-supplied input failed validation BEFORE reaching the model. */
export class ClaudeInputValidationError extends ClaudeProxyError {
  public readonly code = 'ClaudeInputValidationError';
  public readonly retryable = false;
  public readonly httpStatus = 400;
}

/** Input contained prompt-injection markers we refuse to forward. */
export class PromptInjectionRejectedError extends ClaudeProxyError {
  public readonly code = 'PromptInjectionRejectedError';
  public readonly retryable = false;
  public readonly httpStatus = 400;
}

/** Per-route rate limit exhausted in this module (NOT the SDK 429). */
export class ClaudeRateLimitError extends ClaudeProxyError {
  public readonly code = 'ClaudeRateLimitError';
  public readonly retryable = false;
  public readonly httpStatus = 429;
}

/** Anthropic returned 429 or 5xx and retries are exhausted. */
export class ClaudeUnavailableError extends ClaudeProxyError {
  public readonly code = 'ClaudeUnavailableError';
  public readonly retryable = false; // already retried inside the wrapper
  public readonly httpStatus = 502;
}

/** Model returned content that failed Zod validation. */
export class ClaudeOutputSchemaError extends ClaudeProxyError {
  public readonly code = 'ClaudeOutputSchemaError';
  public readonly retryable = false;
  public readonly httpStatus = 502;
}

/** Anthropic API key missing / bad. Surfaces only at boot or on first call. */
export class ClaudeAuthError extends ClaudeProxyError {
  public readonly code = 'ClaudeAuthError';
  public readonly retryable = false;
  public readonly httpStatus = 500; // server-side misconfig, NOT a 401 to client
}

/** Cache / cost-tracking persistence failure. The call may have succeeded
 *  at Anthropic but we couldn't record it. The route should still return
 *  the answer; the error is logged at WARN. */
export class ClaudePersistenceError extends ClaudeProxyError {
  public readonly code = 'ClaudePersistenceError';
  public readonly retryable = true;
  public readonly httpStatus = 500;
}
