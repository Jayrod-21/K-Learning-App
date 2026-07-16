/**
 * Kiwi (Korean morphological analyzer) proxy.
 *
 * B1 owns the Kiwi HTTP service; the URL comes in via KIWI_URL. This module
 * just forwards calls. Request shape is intentionally narrow: we don't want
 * clients reaching arbitrary endpoints on the upstream.
 *
 * Resilience: 5s timeout, single retry on connect-error (NOT on 4xx), JSON
 * body validation via Zod before returning to the caller.
 *
 * F-195 (error hygiene): every error thrown here carries NO `details` payload.
 * The generic errorHandler forwards `AppError.details` verbatim to the client,
 * so attaching the upstream response body (or a serialized `{name, message}`
 * of a network error) leaked raw upstream/internal text to the wire — the same
 * class of leak F-124 closed for the Claude proxy. The raw detail (status,
 * truncated body, network-error cause) is logged server-side via
 * `logUpstreamDetail` below, mirroring `mapClaudeError`'s whitelist posture:
 * the wire only ever sees the fixed, server-minted message strings in this
 * file. Dropping `details` also closes a latent status-override hole — an
 * upstream body carrying a numeric `status` key would previously have
 * overridden OUR response status via UpstreamError's `{ status }` detail hook.
 */
import { request } from 'undici';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../logging.js';
import { UpstreamError, ValidationError } from '../middleware/errors.js';

const TIMEOUT_MS = 5_000;

export const LemmatizeRequestSchema = z.object({
  text: z.string().min(1).max(2_000),
});
export type LemmatizeRequest = z.infer<typeof LemmatizeRequestSchema>;

const KiwiTokenSchema = z.object({
  form: z.string(),
  lemma: z.string(),
  tag: z.string(),
  start: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
});

const KiwiResponseSchema = z.object({
  tokens: z.array(KiwiTokenSchema),
});

export type KiwiResponse = z.infer<typeof KiwiResponseSchema>;

export async function lemmatize(
  body: LemmatizeRequest,
  correlationId: string,
): Promise<KiwiResponse> {
  const cfg = loadConfig();
  const url = `${cfg.KIWI_URL.replace(/\/$/, '')}/lemmatize`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify(body),
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS,
      });
      const text = await res.body.text();
      if (res.statusCode === 400) {
        // Upstream judged the INPUT bad → our 400. The upstream body may echo
        // the input or expose analyzer internals — log it, never forward it.
        logUpstreamDetail(correlationId, res.statusCode, text);
        throw new ValidationError('kiwi rejected input');
      }
      if (res.statusCode >= 500) {
        logUpstreamDetail(correlationId, res.statusCode, text);
        lastErr = new UpstreamError(`kiwi ${res.statusCode}`);
        continue;
      }
      if (res.statusCode >= 300) {
        logUpstreamDetail(correlationId, res.statusCode, text);
        throw new UpstreamError(`kiwi ${res.statusCode}`);
      }
      const parsed = KiwiResponseSchema.safeParse(safeParseJson(text));
      if (!parsed.success) {
        // Zod issues describe the UPSTREAM payload — server-side only (F-195).
        getLogger().warn(
          { correlationId, issues: parsed.error.issues },
          'kiwi returned malformed payload (raw detail server-side only)',
        );
        throw new UpstreamError('kiwi returned malformed payload');
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      lastErr = err;
      // Retry only on connect/timeout errors, not on 4xx.
      if (!isTransient(err)) throw err;
    }
  }
  // Retries exhausted. If the upstream was REACHABLE but kept 5xx-ing, the
  // recorded UpstreamError ('kiwi 500', payload) is the accurate story —
  // rethrow it as-is. Labeling it 'unreachable' would misdirect debugging
  // toward the network when the service is up and failing.
  if (lastErr instanceof UpstreamError) throw lastErr;
  // Network-level failure: the cause's {name, message} (e.g. an undici connect
  // error naming host/port) is logged here, never forwarded (F-195).
  getLogger().warn(
    { correlationId, cause: serializeErr(lastErr) },
    'kiwi unreachable (raw detail server-side only)',
  );
  throw new UpstreamError('kiwi unreachable');
}

/**
 * Server-side-only record of an upstream error response (F-195). Body is
 * truncated to bound log volume; the wire never sees any of this.
 */
function logUpstreamDetail(correlationId: string, statusCode: number, body: string): void {
  getLogger().warn(
    { correlationId, kiwiStatus: statusCode, kiwiBody: body.slice(0, 500) },
    'kiwi upstream error (raw detail server-side only)',
  );
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  // UND_ERR_BODY_TIMEOUT: the body stalled after headers arrived (thrown by
  // `res.body.text()`) — the same transient class as a headers timeout. Retry,
  // then surface the fixed 'kiwi unreachable' 502 instead of an opaque 500.
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ].includes(code);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function serializeErr(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { value: String(err) };
}
