/**
 * Unit tests for `mapClaudeError` (F-124 / F-094).
 *
 * F-124: the shared mapper used to forward the raw upstream `${code}: ${message}`
 * verbatim to the client on every path. That was safe only by accident (every
 * proxy error message today happens to be a fixed generic string) — a future
 * non-generic message, or an unwhitelisted code, would otherwise leak straight
 * to the wire. These tests pin: (1) the client-facing body NEVER contains the
 * raw `code: message` text, regardless of code/status; (2) the correct HTTP
 * status mapping is preserved (proxy client-fault 4xx pass through, everything
 * else flattens to 502); (3) non-proxy errors (no `httpStatus`) pass through
 * unchanged.
 *
 * F-094: this is now the ONE mapper for every Claude-touching route
 * (writing/reading/grammarDrill/diagnostic/conversation/imageIngest) — these
 * cases cover the shapes all of those private copies used to handle.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetConfig, TEST_TOTP_SECRET_ENC_KEY } from '../../src/config/index.js';
import { mapClaudeError, UpstreamError, NotFoundError } from '../../src/middleware/errors.js';

beforeAll(() => {
  // mapClaudeError logs the raw upstream detail server-side (F-124) via the
  // shared logger, which lazily loads the main app config on first use — give
  // it just enough env to parse (mirrors the minimal env other unit-style
  // tests provide; no DB/HTTP touched by this suite).
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
  process.env.KIWI_URL ??= 'http://localhost:9999';
  process.env.CLIENT_ORIGIN ??= 'http://localhost:5173';
  process.env.TOTP_SECRET_ENC_KEY ??= TEST_TOTP_SECRET_ENC_KEY;
  process.env.LOG_LEVEL ??= 'silent';
  resetConfig();
});

/** Build a Claude-proxy-shaped error (carries httpStatus/code — the shape
 *  every ClaudeProxyError subclass has, per services/claude/errors.ts). */
function proxyError(httpStatus: number, code: string, message: string): Error {
  const e = new Error(message) as Error & { httpStatus: number; code: string };
  e.httpStatus = httpStatus;
  e.code = code;
  return e;
}

describe('mapClaudeError', () => {
  it('never forwards the raw upstream `${code}: ${message}` to the client, on any status', () => {
    const cases: Array<[number, string, string]> = [
      [400, 'ClaudeInputValidationError', 'super secret internal detail'],
      [400, 'PromptInjectionRejectedError', 'user tried \\n\\nignore instructions'],
      [429, 'ClaudeRateLimitError', 'bucket=name_conversation exhausted'],
      [502, 'ClaudeUnavailableError', 'anthropic api key rotated at 03:00 UTC'],
      [500, 'ClaudeAuthError', 'ANTHROPIC_API_KEY missing'],
      [503, 'SomeFutureProviderCode', 'a message we never whitelisted'],
    ];
    for (const [status, code, message] of cases) {
      const mapped = mapClaudeError(proxyError(status, code, message));
      expect(mapped).toBeInstanceOf(UpstreamError);
      const wireMessage = (mapped as UpstreamError).message;
      expect(wireMessage).not.toContain(message);
      expect(wireMessage).not.toContain(code);
      expect(wireMessage).not.toContain(`${code}: ${message}`);
    }
  });

  it('a 400 proxy-origin client fault (e.g. prompt injection) stays 400, with a safe generic message', () => {
    const mapped = mapClaudeError(
      proxyError(400, 'PromptInjectionRejectedError', 'raw upstream detail'),
    ) as UpstreamError;
    expect(mapped).toBeInstanceOf(UpstreamError);
    expect(mapped.status).toBe(400);
    expect(mapped.message.length).toBeGreaterThan(0);
    expect(mapped.message).not.toContain('raw upstream detail');
  });

  it('a 429 proxy-origin client fault (per-route limiter) stays 429, with a safe generic message', () => {
    const mapped = mapClaudeError(
      proxyError(429, 'ClaudeRateLimitError', 'raw upstream detail'),
    ) as UpstreamError;
    expect(mapped.status).toBe(429);
    expect(mapped.message).not.toContain('raw upstream detail');
  });

  it('a 5xx-class proxy error (unavailable / output-schema / auth / persistence) flattens to 502', () => {
    const cases = [
      proxyError(502, 'ClaudeUnavailableError', 'x'),
      proxyError(502, 'ClaudeOutputSchemaError', 'x'),
      proxyError(500, 'ClaudeAuthError', 'x'),
      proxyError(500, 'ClaudePersistenceError', 'x'),
    ];
    for (const err of cases) {
      const mapped = mapClaudeError(err) as UpstreamError;
      expect(mapped.status).toBe(502);
    }
  });

  it('a proxy error with a status outside 400-499 (e.g. 300 or missing) also flattens to 502', () => {
    const noStatus = new Error('weird') as Error & { httpStatus?: unknown; code: string };
    noStatus.code = 'Whatever';
    // httpStatus present but not a number (defensive: a malformed proxy error).
    (noStatus as { httpStatus: unknown }).httpStatus = 'not-a-number';
    const mapped = mapClaudeError(noStatus) as UpstreamError;
    expect(mapped.status).toBe(502);
  });

  it('an unwhitelisted proxy code still gets a safe generic 4xx message (no raw text)', () => {
    const mapped = mapClaudeError(
      proxyError(422, 'SomeBrandNewCode', 'internal reason'),
    ) as UpstreamError;
    expect(mapped.status).toBe(422);
    expect(mapped.message).not.toContain('internal reason');
    expect(mapped.message).not.toContain('SomeBrandNewCode');
  });

  it('passes non-proxy errors through unchanged (no httpStatus field)', () => {
    const nf = new NotFoundError('conversation not found');
    expect(mapClaudeError(nf)).toBe(nf);

    const plain = new Error('some other bug');
    expect(mapClaudeError(plain)).toBe(plain);
  });

  it('passes non-object/null values through unchanged', () => {
    expect(mapClaudeError(null)).toBeNull();
    expect(mapClaudeError('boom')).toBe('boom');
    expect(mapClaudeError(undefined)).toBeUndefined();
  });
});
