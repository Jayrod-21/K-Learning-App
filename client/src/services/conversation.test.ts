/**
 * conversation service — non-streaming endpoints + stream URL construction
 * + streaming protocol dispatch.
 *
 * Two boundaries are exercised:
 *   - `sseStream.streamSse` mocked: URL composition + handler wiring.
 *   - `fetch` mocked with the server's byte-for-byte SSE output: the
 *     B-010 regression suite drives the REAL parser + dispatch so the
 *     client/server wire contract (data-only frames, inner `.event`
 *     discriminator) stays pinned. Generic parser edge cases live in
 *     `sseStream.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendMessage,
  listConversations,
  startConversation,
  streamMessage,
} from './conversation';
import { api, ApiError } from './api';
import * as sse from './sseStream';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startConversation', () => {
  it('POSTs /conversation with the body', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ conversation: { id: 7 } });

    const out = await startConversation({ mode: 'casual' });

    expect(spy).toHaveBeenCalledWith('/conversation', { mode: 'casual' });
    expect(out.conversation.id).toBe(7);
  });
});

describe('appendMessage', () => {
  it('POSTs to the nested route with expected_version', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ version: 2, messages: [] });

    await appendMessage(7, { content: 'hi', expected_version: 1 });

    expect(spy).toHaveBeenCalledWith('/conversation/7/messages', {
      content: 'hi',
      expected_version: 1,
    });
  });

  it('surfaces 409 stale version', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('stale', { status: 409, code: 'conflict' }),
    );
    await expect(
      appendMessage(1, { content: 'x', expected_version: 0 }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('listConversations', () => {
  it('GETs /conversation', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ conversations: [] });
    await listConversations();
    expect(spy).toHaveBeenCalledWith('/conversation');
  });
});

describe('streamMessage', () => {
  beforeEach(() => {
    // Make `import.meta.env.VITE_API_URL` empty per same-origin posture.
    // The build-time injected default is '' in dev tests; we rely on that.
  });

  it('always targets the dedicated /stream suffix — the only endpoint that streams', async () => {
    // Regression guard for the removed `streamPath: 'query'` option: the
    // `?stream=1` handler is the plain-JSON append route (it ignores unknown
    // query params). A caller steered there would pay for a full Claude turn
    // the server persists (version bump included), then throw `stream_parse`
    // at the content-type gate and 409 on every retry. The option is gone;
    // the URL must be the /stream suffix, with no query string.
    let capturedUrl = '';
    const spy = vi
      .spyOn(sse, 'streamSse')
      .mockImplementation(async (url) => {
        capturedUrl = url;
      });

    const ctrl = new AbortController();
    await streamMessage(
      7,
      { content: 'hi', expected_version: 1 },
      { signal: ctrl.signal, onDelta: () => undefined },
    );

    expect(spy).toHaveBeenCalled();
    expect(capturedUrl).toContain('/conversation/7/messages/stream');
    expect(capturedUrl).not.toContain('stream=1');
    expect(capturedUrl).not.toContain('?');
  });

  it('dispatches on the INNER `.event` of data-only frames (B-010)', async () => {
    // The server never writes SSE-level `event:` lines — every frame
    // arrives as SSE event 'message' with the discriminator inside the
    // JSON payload. Dispatching on the SSE-level name was bug B-010.
    const onDelta = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();
    vi.spyOn(sse, 'streamSse').mockImplementation(async (_url, handlers) => {
      handlers.onEvent({
        event: 'message',
        data: JSON.stringify({ event: 'delta', text: 'hello' }),
      });
      handlers.onDone?.();
    });

    const ctrl = new AbortController();
    await streamMessage(
      1,
      { content: 'x', expected_version: 1 },
      { signal: ctrl.signal, onDelta, onError, onDone },
    );

    expect(onDelta).toHaveBeenCalledExactlyOnceWith('hello');
    expect(onDone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats an in-band error frame as terminal: onError once + rejection', async () => {
    const onDelta = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();
    vi.spyOn(sse, 'streamSse').mockImplementation(async (_url, handlers) => {
      handlers.onEvent({
        event: 'message',
        data: JSON.stringify({ event: 'error', code: 'upstream_error', message: 'oops' }),
      });
      // Even if the underlying stream then "resolves cleanly" (EOF
      // tail-flush path), the failure must still surface.
      handlers.onDone?.();
    });

    const ctrl = new AbortController();
    await expect(
      streamMessage(
        1,
        { content: 'x', expected_version: 1 },
        { signal: ctrl.signal, onDelta, onError, onDone },
      ),
    ).rejects.toMatchObject({ code: 'upstream_error', message: 'oops' });

    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(ApiError));
    // A terminal error is not a clean close — onDone must be suppressed.
    expect(onDone).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('rejects when sse throws an ApiError', async () => {
    vi.spyOn(sse, 'streamSse').mockRejectedValueOnce(
      new ApiError('boom', { status: 502, code: 'upstream' }),
    );

    const ctrl = new AbortController();
    await expect(
      streamMessage(
        1,
        { content: 'x', expected_version: 1 },
        { signal: ctrl.signal, onDelta: () => undefined },
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('forwards X-Request-Id when requestId is set (C-SF-5)', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.spyOn(sse, 'streamSse').mockImplementation(
      async (_url, _handlers, opts) => {
        capturedHeaders = opts?.headers;
      },
    );

    const ctrl = new AbortController();
    await streamMessage(
      7,
      { content: 'hi', expected_version: 1 },
      {
        signal: ctrl.signal,
        onDelta: () => undefined,
        requestId: 'abc-123',
      },
    );

    expect(capturedHeaders).toEqual({ 'X-Request-Id': 'abc-123' });
  });

  it('does NOT set X-Request-Id when requestId is omitted', async () => {
    // Inverse of the above — defends against an accidental hardcoded header.
    let capturedHeaders: Record<string, string> | undefined;
    vi.spyOn(sse, 'streamSse').mockImplementation(
      async (_url, _handlers, opts) => {
        capturedHeaders = opts?.headers;
      },
    );

    const ctrl = new AbortController();
    await streamMessage(
      7,
      { content: 'hi', expected_version: 1 },
      { signal: ctrl.signal, onDelta: () => undefined },
    );

    expect(capturedHeaders).toBeUndefined();
  });
});

// ── B-010 regression: real wire shape end-to-end through streamSse ──────
//
// These tests do NOT mock streamSse. They mock `fetch` to return the
// server's byte-for-byte SSE output (`server/src/routes/conversation.ts`
// `writeSseFrame`): data-only frames with the discriminator INSIDE the
// JSON payload and no SSE-level `event:` lines. The old client dispatched
// on the SSE-level event name (always 'message'), so onDelta never fired
// and the tutor bubble stayed empty — every test here fails on that code.

/** Encode raw SSE text as the streaming body of a 200 response. */
function sseResponse(raw: string): void {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
  );
}

/** Serialize frames exactly like the server's `writeSseFrame`. */
function serverFrames(...payloads: unknown[]): string {
  return payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('');
}

describe('streamMessage — server-shaped SSE frames (B-010 regression)', () => {
  it('fires onDelta for each data-only delta frame and onDone at EOF', async () => {
    sseResponse(
      serverFrames(
        { event: 'start', register: '해요체' },
        { event: 'delta', text: '안녕' },
        { event: 'delta', text: '하세요!' },
        {
          event: 'done',
          version: 2,
          messages: [],
          register: '해요체',
          english_note: null,
        },
      ),
    );

    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const ctrl = new AbortController();

    await streamMessage(
      7,
      { content: '안녕하세요', expected_version: 1 },
      { signal: ctrl.signal, onDelta, onDone, onError },
    );

    // The tutor bubble is built by concatenating onDelta chunks — this is
    // the exact dispatch that never fired under B-010.
    expect(onDelta.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      '안녕',
      '하세요!',
    ]);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces a persist-fail frame with FIXED copy + the recovered text preserved', async () => {
    // The persistence_error frame's `message` is server-side error detail
    // (potentially raw pg prose) — the client must substitute fixed copy,
    // never echo it. The frame's `recovered_text` is the full assistant
    // reply the user just watched stream in; dropping it (the old behaviour)
    // threw away a whole Claude turn.
    sseResponse(
      serverFrames(
        { event: 'delta', text: '부분 답' },
        {
          event: 'error',
          code: 'persistence_error',
          message: 'duplicate key value violates unique constraint "x"',
          recovered_text: '부분 답',
        },
      ),
    );

    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const ctrl = new AbortController();

    await expect(
      streamMessage(
        7,
        { content: 'x', expected_version: 1 },
        { signal: ctrl.signal, onDelta, onDone, onError },
      ),
    ).rejects.toMatchObject({
      code: 'persistence_error',
      // Fixed copy — the raw server prose must NOT ride into the UI chip.
      message: 'The reply streamed but could not be saved. Retry to send it again.',
      // The streamed assistant text is preserved for recovery.
      recoveredText: '부분 답',
    });

    // Deltas before the error still streamed; the error fired exactly once
    // (no double-fire from the internal abort) and the close was not clean.
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('부분 답');
    expect(onError).toHaveBeenCalledTimes(1);
    const surfaced = onError.mock.calls[0]?.[0] as ApiError;
    expect(surfaced).toBeInstanceOf(ApiError);
    expect(surfaced.message).not.toContain('duplicate key');
    expect(surfaced.recoveredText).toBe('부분 답');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('an error frame with no code/message falls back to stream_error', async () => {
    // The route's headers-sent catch emits `{event:'error', message}` with
    // no `code` — the fallback keeps the rejection actionable.
    sseResponse(serverFrames({ event: 'error', message: 'stream failed' }));

    const ctrl = new AbortController();
    await expect(
      streamMessage(
        7,
        { content: 'x', expected_version: 1 },
        { signal: ctrl.signal, onDelta: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'stream_error', message: 'stream failed' });
  });

  it('fails loudly (stream_parse) on a non-JSON frame instead of ignoring it', async () => {
    sseResponse('data: not-json\n\n');

    const onDelta = vi.fn();
    const onError = vi.fn();
    const ctrl = new AbortController();

    await expect(
      streamMessage(
        7,
        { content: 'x', expected_version: 1 },
        { signal: ctrl.signal, onDelta, onError },
      ),
    ).rejects.toMatchObject({ code: 'stream_parse' });

    expect(onDelta).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown inner event types (forward compatibility)', async () => {
    sseResponse(
      serverFrames(
        { event: 'telemetry', ms: 12 },
        { event: 'delta', text: 'ok' },
        { event: 'done', version: 2, messages: [] },
      ),
    );

    const onDelta = vi.fn();
    const onError = vi.fn();
    const ctrl = new AbortController();

    await streamMessage(
      7,
      { content: 'x', expected_version: 1 },
      { signal: ctrl.signal, onDelta, onError },
    );

    expect(onDelta).toHaveBeenCalledExactlyOnceWith('ok');
    expect(onError).not.toHaveBeenCalled();
  });
});
