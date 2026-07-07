/**
 * Kiwi (Korean morphological analyzer) proxy.
 *
 * B1 owns the Kiwi HTTP service; the URL comes in via KIWI_URL. This module
 * just forwards calls. Request shape is intentionally narrow: we don't want
 * clients reaching arbitrary endpoints on the upstream.
 *
 * Resilience: 5s timeout, single retry on connect-error (NOT on 4xx), JSON
 * body validation via Zod before returning to the caller.
 */
import { request } from 'undici';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
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
        throw new ValidationError('kiwi rejected input', safeParseJson(text));
      }
      if (res.statusCode >= 500) {
        lastErr = new UpstreamError(`kiwi ${res.statusCode}`, safeParseJson(text));
        continue;
      }
      if (res.statusCode >= 300) {
        throw new UpstreamError(`kiwi ${res.statusCode}`, safeParseJson(text));
      }
      const parsed = KiwiResponseSchema.safeParse(safeParseJson(text));
      if (!parsed.success) {
        throw new UpstreamError('kiwi returned malformed payload', parsed.error.issues);
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
  throw new UpstreamError('kiwi unreachable', serializeErr(lastErr));
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code);
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
