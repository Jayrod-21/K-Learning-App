/**
 * Centralized error handling.
 *
 * Domain errors are typed (AppError + subclasses); the handler maps them to
 * HTTP status codes and shapes the JSON response. Unhandled errors become a
 * generic 500 with the correlation ID so the client can ask us "what was
 * <correlation id>?" — we never leak stack traces to the wire.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;
  public constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  public constructor(message: string, details?: unknown) {
    super(400, 'validation_error', message, details);
    this.name = 'ValidationError';
  }
}

/**
 * A 400 whose cause is the shared prompt-injection guard (`sanitizeUserInput`)
 * rejecting otherwise well-formed content — distinct from `ValidationError`'s
 * generic "malformed/wrong-type input" 400 so a client-facing surface (e.g.
 * chat's document attach, `docAttach.ts`) can tell a user "this file's
 * content was flagged" instead of misleadingly implying the file's FORMAT
 * was the problem (which would send the user off re-encoding a `.txt` that
 * was never going to be accepted). Same status (400) as `ValidationError` —
 * only the wire `code` differs — so nothing else about error handling
 * changes; this is purely a disambiguation hook for copy selection.
 */
export class ContentRejectedError extends AppError {
  public constructor(message: string, details?: unknown) {
    super(400, 'content_rejected', message, details);
    this.name = 'ContentRejectedError';
  }
}

export class UnauthorizedError extends AppError {
  public constructor(message = 'authentication required') {
    super(401, 'unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  public constructor(message = 'forbidden') {
    super(403, 'forbidden', message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  public constructor(message = 'not found') {
    super(404, 'not_found', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  public constructor(message: string) {
    super(409, 'conflict', message);
    this.name = 'ConflictError';
  }
}

export class PayloadTooLargeError extends AppError {
  public constructor(message: string) {
    super(413, 'payload_too_large', message);
    this.name = 'PayloadTooLargeError';
  }
}

export class UpstreamError extends AppError {
  /**
   * Maps an upstream (Claude / Kiwi) failure to an HTTP response. Defaults to
   * 502 Bad Gateway, but callers can override the status when the upstream
   * surfaced a meaningful one (e.g. a 429 rate-limit or a 504 timeout from the
   * Claude proxy) so the client sees the real failure class rather than a
   * blanket 502. Pass `{ status }` in details to override; the code stays
   * `upstream_error` for a consistent wire shape. (Previously the status
   * argument was silently ignored — every upstream error became a 502.)
   */
  public constructor(message: string, details?: unknown) {
    const status =
      details &&
      typeof details === 'object' &&
      typeof (details as { status?: unknown }).status === 'number'
        ? (details as { status: number }).status
        : 502;
    super(status, 'upstream_error', message, details);
    this.name = 'UpstreamError';
  }
}

/**
 * Map an error thrown by the Claude proxy (it carries `httpStatus`/`code` —
 * see services/claude/errors.ts) to a wire-safe UpstreamError.
 *
 * Proxy-ORIGIN client-fault statuses pass through: a prompt-injection
 * rejection (`PromptInjectionRejectedError`, 400) or the proxy's own
 * per-route limiter (`ClaudeRateLimitError`, 429) is the CALLER's fault, not
 * an upstream outage — flattening them to 502 misclassifies attacker/typo
 * input as an outage (5xx alert noise) and tells the client "retry later"
 * when the correct signal is "fix your input" / "back off". These 4xx are
 * statuses WE minted; SECURITY.md §13.7's "never forward the upstream
 * status" is about the Anthropic response, which stays hidden — every
 * 5xx-class proxy error (unavailable, output-schema, auth/persistence
 * misconfig) still flattens to a blanket 502 with no provider detail.
 * Non-proxy errors (NotFound/Conflict/…) pass through unchanged.
 *
 * Shared by the generation routes (writing.ts / reading.ts). grammarDrill /
 * diagnostic / imageIngest / conversation still carry private flatten-to-502
 * copies — migrating them is a wire-contract change tracked as F-094 in
 * BUGS_AND_FEATURES.md.
 */
export function mapClaudeError(err: unknown): unknown {
  if (err && typeof err === 'object' && 'httpStatus' in err) {
    const status = (err as { httpStatus?: unknown }).httpStatus;
    const code = (err as { code?: string }).code ?? 'upstream_error';
    const message = (err as { message?: string }).message ?? 'claude error';
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return new UpstreamError(`${code}: ${message}`, { status });
    }
    return new UpstreamError(`${code}: ${message}`);
  }
  return err;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    req.log?.warn({ issues: err.issues }, 'zod validation failed');
    res.status(400).json({
      error: { code: 'validation_error', message: 'invalid input', issues: err.issues },
      correlationId: req.correlationId,
    });
    return;
  }
  if (err instanceof AppError) {
    req.log?.warn({ code: err.code, status: err.status, message: err.message }, 'app error');
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
      correlationId: req.correlationId,
    });
    return;
  }
  // Unknown error — log full stack, return opaque body. Bar §"Security": never
  // leak internal details.
  req.log?.error({ err: serialize(err) }, 'unhandled error');
  res.status(500).json({
    error: { code: 'internal_error', message: 'something went wrong' },
    correlationId: req.correlationId,
  });
}

function serialize(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
