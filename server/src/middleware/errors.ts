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
import { getLogger } from '../logging.js';

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

/**
 * A 409 whose cause is a writing-grade claim collision: a concurrent
 * duplicate `/diagnostic/:runId/answer` request for the same still-pending
 * writing item lost the atomic claim race (`claimWritingGrade`, see
 * diagnostic.ts fix-pass SF1 / fix-pass 2 FIX B). Distinct wire `code` from
 * `ConflictError`'s generic `'conflict'` — same status, same disambiguation
 * pattern as `ContentRejectedError` above — so the client can tell this
 * apart from the pre-existing "answer already recorded" 409. That
 * distinction matters: for THIS case the item is very likely NOT yet
 * recorded (the winning request may still be mid-call, or may go on to
 * fail entirely), so the correct client behavior is a short retry in place,
 * not the "already recorded — continuing" toast + exit-the-run resync that
 * the generic 409 handler uses everywhere else.
 */
export class WritingGradeInProgressError extends AppError {
  public constructor(message = 'writing item is already being graded — retry shortly') {
    super(409, 'writing_grade_in_progress', message);
    this.name = 'WritingGradeInProgressError';
  }
}

/**
 * The global daily spend ceiling (Phase 2.6 — server/src/services/
 * spendCeiling.ts) has been reached: combined Claude + ElevenLabs TTS +
 * OpenAI image spend for the current UTC day is at or over the operator-
 * configured SPEND_CEILING_DAILY_USD. 503, not 429/403: this is a
 * service-wide temporary condition (the WHOLE app is out of budget for the
 * day, not this caller specifically) — 429 would misleadingly suggest a
 * per-caller pace problem the caller could fix by slowing down, and 403
 * would misleadingly suggest a permissions problem. The errorHandler's
 * generic AppError branch maps this to {status, code, message} with no
 * internal detail (no spend figures, no ceiling value) — those are
 * operator-only, surfaced via GET /admin/spend, never on an error response.
 */
export class SpendCeilingExceededError extends AppError {
  public constructor(message = 'daily generation budget reached — please try again later') {
    super(503, 'spend_ceiling_reached', message);
    this.name = 'SpendCeilingExceededError';
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
 * Client-safe message per Claude-proxy error `code` (services/claude/errors.ts
 * — every ClaudeProxyError's `code` is its class name). Deliberately generic:
 * no upstream/provider text, no request internals. Anything not listed here
 * (every 5xx-class proxy error: ClaudeUnavailableError, ClaudeOutputSchemaError,
 * ClaudeAuthError, ClaudePersistenceError, and any future/unknown code) falls
 * back to `DEFAULT_UPSTREAM_MESSAGE` below.
 */
const CLAUDE_CLIENT_MESSAGES: Readonly<Record<string, string>> = {
  ClaudeInputValidationError: 'your request could not be processed',
  PromptInjectionRejectedError: 'your message could not be processed',
  ClaudeRateLimitError: 'too many requests — please slow down and try again shortly',
};

const DEFAULT_UPSTREAM_MESSAGE =
  'the AI assistant is temporarily unavailable — please try again';

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
 * F-124: the wire message is now a fixed, whitelisted string picked by `code`
 * (`CLAUDE_CLIENT_MESSAGES` / `DEFAULT_UPSTREAM_MESSAGE`) — NEVER the raw
 * `${code}: ${message}` template this used to forward. That was safe only by
 * accident (every proxy message today happens to be a fixed generic string);
 * a future non-generic upstream message (or a code we don't explicitly
 * whitelist) would otherwise leak straight to the client. The raw code/message
 * are still captured, but only in the server-side log line below — never on
 * the response body.
 *
 * F-094: the SINGLE shared mapper for every Claude-touching route
 * (writing.ts / reading.ts / grammar.ts (/identify — F-193) / grammarDrill.ts /
 * diagnostic.ts / conversation.ts / imageIngest.ts / enrich.ts /
 * gradeWriting.ts). Those routes used to carry
 * private flatten-always-to-502 copies (several of them forwarding the raw
 * `${code}: ${message}` straight to the client — the exact leak F-124 exists
 * to close) that predated the 4xx passthrough above — all migrated onto this
 * helper so an injection rejection or the proxy's own limiter reads as
 * 400/429 everywhere, not just on the generation routes, and no route can
 * forward raw upstream/provider text. `diagnostic.ts`'s own pre-wrap
 * (`buildGeneratedItem`) calls this helper too, rather than embedding
 * `err.message` directly, for the same reason.
 */
export function mapClaudeError(err: unknown): unknown {
  if (err && typeof err === 'object' && 'httpStatus' in err) {
    const status = (err as { httpStatus?: unknown }).httpStatus;
    const code = (err as { code?: string }).code ?? 'upstream_error';
    const rawMessage = (err as { message?: string }).message ?? 'claude error';
    // Server-side-only detail — never forwarded to the client (see doc comment).
    getLogger().warn(
      { claudeCode: code, claudeMessage: rawMessage, claudeHttpStatus: status },
      'claude proxy error mapped to client response',
    );
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const clientMessage = CLAUDE_CLIENT_MESSAGES[code] ?? 'your request could not be processed';
      return new UpstreamError(clientMessage, { status });
    }
    return new UpstreamError(DEFAULT_UPSTREAM_MESSAGE);
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
