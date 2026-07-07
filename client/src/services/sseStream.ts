/**
 * sseStream — fetch + ReadableStream + SSE-line parser.
 *
 * Why not `EventSource`? It's GET-only. Our streaming routes are POST
 * (conversation turn body + cookie auth on the same request), so we need
 * fetch-driven SSE. This helper wraps the lowest-common-denominator pattern
 * once so every streaming service (`conversation.streamMessage`, future
 * `enrich.stream`, etc.) shares the same parser, abort plumbing, and error
 * normalisation. Keeps the surface area small.
 *
 * SSE primer (only the subset we use — RFC 7613 / WHATWG eventsource):
 *   - Each event is a block of lines, terminated by a BLANK LINE (\n\n).
 *   - Within a block, recognised fields are `event:`, `data:`, `id:`,
 *     `retry:`. We honour `event` + `data` only.
 *   - Multiple `data:` lines in one block are joined with '\n'.
 *   - Lines starting with `:` are comments (heartbeats) — discarded.
 *
 * Threat model:
 *   - Cookie session rides via `credentials: 'include'`. Server is
 *     same-origin in prod (see `services/api.ts` header) — the cookie is
 *     `SameSite=Strict`, so this only works against same-origin.
 *   - Backpressure: we read one chunk at a time and process synchronously;
 *     a fast server can't out-write us. Memory bound is the partial-buffer
 *     between blank-line boundaries — capped at MAX_BUFFER_BYTES to refuse
 *     a server that never flushes a blank line (defence against a buggy or
 *     malicious upstream that would otherwise grow the buffer until OOM).
 *   - Abort: caller's `AbortSignal` is forwarded to fetch AND checked on
 *     every read hop; the reader's `cancel()` then releases the underlying
 *     TCP stream. No dangling sockets.
 *   - Error info leakage: parse failures throw `ApiError` with code
 *     `stream_parse` and a generic message; the raw offending bytes are
 *     dropped, not echoed back into the message. Avoids reflecting any
 *     upstream noise into the UI.
 *   - Server 4xx/5xx with a JSON body are normalised through `ApiError`
 *     (same shape as `apiRequest`) so call sites have one error type.
 */
import { ApiError } from './api';

/** One parsed SSE event. `event` defaults to `'message'` per the spec. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Callbacks the consumer wires into the stream loop. */
export interface SseHandlers {
  /** Fired for every successfully parsed event. */
  onEvent: (event: SseEvent) => void;
  /** Optional — fired when the server closes the stream cleanly (EOF). */
  onDone?: () => void;
  /** Optional — fired on any error. After this, the promise also rejects. */
  onError?: (err: ApiError) => void;
}

/** Options for `streamSse`. */
export interface SseStreamOptions {
  /** Required — abort to release the connection. */
  signal: AbortSignal;
  /** POST body, JSON-stringified. */
  body?: unknown;
  /** Extra request headers. `Content-Type` defaults to `application/json`. */
  headers?: Record<string, string>;
  /** HTTP method. Defaults to `POST` (SSE-over-POST is the whole reason
   *  this helper exists; if you want GET, pass it explicitly). */
  method?: 'GET' | 'POST';
}

/**
 * Cap on the partial-event buffer before we give up on a server that never
 * emits a blank-line boundary. Real SSE events from B4 are well under 64 KB;
 * 1 MB is comfortably above that and well below a memory pressure threshold.
 */
const MAX_BUFFER_BYTES = 1_000_000;

/**
 * Parse a completed SSE event block (one or more lines, no trailing blank).
 * Returns `null` if the block was a heartbeat / only had unrecognised fields.
 */
export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    if (raw === '' || raw.startsWith(':')) continue;
    const colon = raw.indexOf(':');
    const field = colon === -1 ? raw : raw.slice(0, colon);
    // Per spec, exactly one optional space after `:` is consumed.
    const valueRaw = colon === -1 ? '' : raw.slice(colon + 1);
    const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // `id` / `retry` deliberately ignored — we don't reconnect.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Open an SSE connection, parse events, dispatch to handlers. Resolves when
 * the server cleanly closes the stream. Rejects on transport, HTTP, or parse
 * errors. Honours `signal` end-to-end.
 *
 * Side effects:
 *   - one `fetch` call to `url`
 *   - reader cancellation on abort
 */
export async function streamSse(
  url: string,
  handlers: SseHandlers,
  opts: SseStreamOptions,
): Promise<void> {
  const { signal, body, headers, method = 'POST' } = opts;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'text/event-stream',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    // fetch only throws on transport-level failures (DNS / TLS / abort).
    if (signal.aborted) {
      const aborted = new ApiError('request canceled', {
        status: 0,
        code: 'canceled',
      });
      handlers.onError?.(aborted);
      throw aborted;
    }
    const apiErr = new ApiError(
      err instanceof Error ? err.message : 'network unreachable',
      { status: 0, code: 'network' },
    );
    handlers.onError?.(apiErr);
    throw apiErr;
  }

  if (!response.ok || !response.body) {
    // Try to surface the server's `{ error: { code, message, retry_after } }`
    // envelope. `retry_after` matters here: the streaming chat route sits
    // behind the expensive limiter, so a 429 with a structured retry window
    // is the LIKELIEST error body this path sees — dropping it (the old
    // behaviour) broke the documented `ApiError.retryAfter` contract on
    // exactly the route most likely to 429 (the axios path preserves it, see
    // services/api.ts `normaliseError`).
    let code = 'http_error';
    let message = `stream failed: ${String(response.status)}`;
    let retryAfter: number | undefined;
    try {
      const text = await response.text();
      const parsed: unknown = text ? JSON.parse(text) : null;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error?: unknown }).error === 'object' &&
        (parsed as { error?: unknown }).error !== null
      ) {
        const e = (
          parsed as {
            error: { code?: unknown; message?: unknown; retry_after?: unknown };
          }
        ).error;
        if (typeof e.code === 'string') code = e.code;
        if (typeof e.message === 'string') message = e.message;
        // Same finite-positive guard as the axios path — a structured
        // numeric field, never echoed server prose.
        if (
          typeof e.retry_after === 'number' &&
          Number.isFinite(e.retry_after) &&
          e.retry_after > 0
        ) {
          retryAfter = e.retry_after;
        }
      }
    } catch {
      // Body wasn't JSON — keep the generic message.
    }
    const apiErr = new ApiError(message, {
      status: response.status,
      code,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
    handlers.onError?.(apiErr);
    throw apiErr;
  }

  // Content-Type sanity check. A 200 OK with `text/html` (reverse-proxy
  // intercept page, SSO redirect, a misrouted JSON endpoint) would silently
  // produce zero events and resolve onDone — the UI would render a
  // "successful empty turn" instead of an actionable error. Refuse loudly
  // here so the wire-shape mismatch becomes visible.
  const contentType = response.headers.get('content-type') ?? '';
  const ctNormalised = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (ctNormalised !== 'text/event-stream') {
    const apiErr = new ApiError(
      `unexpected content-type: ${contentType || '(none)'}`,
      { status: 0, code: 'stream_parse' },
    );
    handlers.onError?.(apiErr);
    throw apiErr;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      // A consumer-side `signal.abort()` cancels the reader, which then
      // resolves `read()` with `{ done: true, value: undefined }` rather
      // than rejecting. Catch that here so an `onEvent` handler that
      // aborts mid-stream produces a canonical canceled rejection
      // instead of a silent normal resolution.
      if (signal.aborted) {
        const aborted = new ApiError('request canceled', {
          status: 0,
          code: 'canceled',
        });
        handlers.onError?.(aborted);
        throw aborted;
      }
      if (done) {
        // Flush any trailing event (server might omit the final blank line).
        const tail = buffer.trim();
        if (tail.length > 0) {
          const event = parseSseBlock(tail);
          if (event) handlers.onEvent(event);
        }
        handlers.onDone?.();
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      if (buffer.length > MAX_BUFFER_BYTES) {
        const apiErr = new ApiError('sse buffer overflow', {
          status: 0,
          code: 'stream_parse',
        });
        handlers.onError?.(apiErr);
        throw apiErr;
      }

      // Drain complete event blocks. Accept \n\n and \r\n\r\n boundaries.
      for (;;) {
        const boundary = findEventBoundary(buffer);
        if (boundary === -1) break;
        const block = buffer.slice(0, boundary);
        // Advance past the consumed delimiter (\n\n is 2 chars, \r\n\r\n is 4).
        buffer = buffer.slice(boundary + delimiterLength(buffer, boundary));
        const event = parseSseBlock(block);
        if (event) handlers.onEvent(event);
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal.aborted) {
      const aborted = new ApiError('request canceled', {
        status: 0,
        code: 'canceled',
      });
      handlers.onError?.(aborted);
      throw aborted;
    }
    const apiErr = new ApiError(
      err instanceof Error ? err.message : 'stream read failed',
      { status: 0, code: 'stream_parse' },
    );
    handlers.onError?.(apiErr);
    throw apiErr;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Locate the start index of the next event-boundary delimiter (\n\n or
 * \r\n\r\n) inside `buffer`. Returns -1 when none is present. The caller
 * is expected to consult `delimiterLength` to skip past the delimiter.
 */
function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Length of the boundary delimiter starting at `at` in `buffer`. */
function delimiterLength(buffer: string, at: number): number {
  return buffer.startsWith('\r\n\r\n', at) ? 4 : 2;
}
