/**
 * sseStream — parser + transport behaviour.
 *
 * The parser tests cover:
 *   - single event
 *   - multi-event payload split across one chunk
 *   - multi-event payload split across many small chunks (line boundaries
 *     and event boundaries crossed mid-chunk)
 *   - comments / heartbeats ignored
 *   - multi-line `data:` joined with '\n'
 *   - missing trailing blank line flushes the tail
 *
 * The transport tests cover:
 *   - HTTP 4xx → ApiError(status: <code>, code: <server code>)
 *   - HTTP 5xx with no JSON body → ApiError(http_error)
 *   - AbortSignal cancellation during read → ApiError(canceled)
 *   - Buffer overflow → ApiError(stream_parse)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSseBlock, streamSse } from './sseStream';
import { ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSseBlock', () => {
  it('returns null for a heartbeat-only block', () => {
    expect(parseSseBlock(': hb')).toBeNull();
  });

  it('parses a single data line as event=message', () => {
    expect(parseSseBlock('data: hello')).toEqual({
      event: 'message',
      data: 'hello',
    });
  });

  it('respects a named event', () => {
    expect(parseSseBlock('event: delta\ndata: chunk-1')).toEqual({
      event: 'delta',
      data: 'chunk-1',
    });
  });

  it('joins multiple data lines with \\n', () => {
    expect(parseSseBlock('data: line-1\ndata: line-2')).toEqual({
      event: 'message',
      data: 'line-1\nline-2',
    });
  });

  it('drops unknown fields silently', () => {
    expect(parseSseBlock('id: 42\nretry: 5\ndata: payload')).toEqual({
      event: 'message',
      data: 'payload',
    });
  });

  it('consumes the optional single space after the colon only once', () => {
    expect(parseSseBlock('data:  two-spaces')).toEqual({
      event: 'message',
      data: ' two-spaces',
    });
  });
});

// ── Transport tests ──────────────────────────────────────────────

/** Build a ReadableStream that emits each of `chunks` as a Uint8Array. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function mockFetchResponse(
  status: number,
  body: ReadableStream<Uint8Array> | string,
  ok = status >= 200 && status < 300,
  contentType = 'text/event-stream',
): void {
  // Content-Type defaults to `text/event-stream` because that's what the
  // streamSse contract expects. Tests that want to assert the misroute
  // defence pass an alternate value (e.g. `text/html`).
  const responseInit: ResponseInit = {
    status,
    headers: { 'content-type': contentType },
  };
  const response = new Response(body, responseInit);
  // `Response.ok` is derived from status, but jsdom/happy-dom may need a hint.
  if (response.ok !== ok) {
    Object.defineProperty(response, 'ok', { value: ok });
  }
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
}

describe('streamSse — happy path', () => {
  it('parses a multi-event payload split across chunks', async () => {
    mockFetchResponse(
      200,
      streamOf(['event: delta\ndata: a\n\nevent: delta\nda', 'ta: b\n\n']),
    );

    const events: { event: string; data: string }[] = [];
    const ctrl = new AbortController();

    await streamSse(
      'http://example.test/stream',
      { onEvent: (ev) => events.push(ev) },
      { signal: ctrl.signal },
    );

    expect(events).toEqual([
      { event: 'delta', data: 'a' },
      { event: 'delta', data: 'b' },
    ]);
  });

  it('flushes a tail event without trailing blank line', async () => {
    mockFetchResponse(200, streamOf(['event: done\ndata: bye']));

    const events: { event: string; data: string }[] = [];
    const ctrl = new AbortController();

    let doneCalled = false;
    await streamSse(
      'http://example.test/stream',
      { onEvent: (ev) => events.push(ev), onDone: () => (doneCalled = true) },
      { signal: ctrl.signal },
    );

    expect(events).toEqual([{ event: 'done', data: 'bye' }]);
    expect(doneCalled).toBe(true);
  });

  it('ignores comment / heartbeat lines', async () => {
    mockFetchResponse(
      200,
      streamOf([': keep-alive\n\nevent: delta\ndata: x\n\n']),
    );

    const events: { event: string; data: string }[] = [];
    const ctrl = new AbortController();

    await streamSse(
      'http://example.test/stream',
      { onEvent: (ev) => events.push(ev) },
      { signal: ctrl.signal },
    );

    expect(events).toEqual([{ event: 'delta', data: 'x' }]);
  });
});

describe('streamSse — error paths', () => {
  it('rejects with ApiError mapped from the server error envelope', async () => {
    mockFetchResponse(
      429,
      JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }),
    );

    const onError = vi.fn();
    const ctrl = new AbortController();

    await expect(
      streamSse(
        'http://example.test/stream',
        { onEvent: () => undefined, onError },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    expect(onError).toHaveBeenCalledWith(expect.any(ApiError));
  });

  it('preserves a structured retry_after from a 429 body (expensive-bucket contract)', async () => {
    // The streaming chat route sits behind the expensive limiter, so a 429
    // with `retry_after` is the LIKELIEST error body this path sees. The old
    // parser extracted only code/message and dropped it — the UI could never
    // render "wait N s" (the pattern Writing.tsx relies on), breaking the
    // documented ApiError contract on the route most likely to 429.
    mockFetchResponse(
      429,
      JSON.stringify({
        error: { code: 'rate_limited', message: 'slow down', retry_after: 42 },
      }),
    );

    const onError = vi.fn();
    const ctrl = new AbortController();

    await expect(
      streamSse(
        'http://example.test/stream',
        { onEvent: () => undefined, onError },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfter: 42,
    });
    const surfaced = onError.mock.calls[0]?.[0] as ApiError;
    expect(surfaced.retryAfter).toBe(42);
  });

  it('drops a malformed retry_after (same finite-positive guard as the axios path)', async () => {
    mockFetchResponse(
      429,
      JSON.stringify({
        error: { code: 'rate_limited', message: 'slow down', retry_after: -5 },
      }),
    );

    const ctrl = new AbortController();
    await expect(
      streamSse(
        'http://example.test/stream',
        { onEvent: () => undefined },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ retryAfter: undefined });
  });

  it('rejects with ApiError(stream_parse) on buffer overflow', async () => {
    // Emit a single giant chunk with NO blank-line boundary.
    const giant = 'a'.repeat(2_000_001);
    mockFetchResponse(200, streamOf([giant]));

    const ctrl = new AbortController();
    await expect(
      streamSse(
        'http://example.test/stream',
        { onEvent: () => undefined },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ code: 'stream_parse' });
  });

  it('rejects with ApiError(canceled) when aborted mid-stream', async () => {
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('event: delta\ndata: 1\n\n'));
        // Never close — wait for abort.
      },
    });
    mockFetchResponse(200, slow);

    const ctrl = new AbortController();

    const promise = streamSse(
      'http://example.test/stream',
      { onEvent: () => ctrl.abort() },
      { signal: ctrl.signal },
    );

    await expect(promise).rejects.toMatchObject({ code: 'canceled' });
  });

  it('rejects when fetch itself rejects (transport / DNS / TLS)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('getaddrinfo ENOTFOUND'),
    );

    const ctrl = new AbortController();
    await expect(
      streamSse(
        'http://example.test/stream',
        { onEvent: () => undefined },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
