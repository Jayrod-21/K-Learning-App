/**
 * conversation service — non-streaming endpoints + stream URL construction.
 *
 * We mock `sseStream.streamSse` to verify URL composition + handler wiring
 * without going near the network. The SSE parser itself has its own
 * coverage in `sseStream.test.ts`.
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

  it('uses the dedicated /stream suffix by default', async () => {
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
  });

  it('uses the ?stream=1 query when streamPath="query"', async () => {
    let capturedUrl = '';
    vi.spyOn(sse, 'streamSse').mockImplementation(async (url) => {
      capturedUrl = url;
    });

    const ctrl = new AbortController();
    await streamMessage(
      7,
      { content: 'hi', expected_version: 1 },
      {
        signal: ctrl.signal,
        onDelta: () => undefined,
        streamPath: 'query',
      },
    );

    expect(capturedUrl).toContain('/conversation/7/messages?stream=1');
  });

  it('forwards `delta` events to onDelta and `error` events to onError', async () => {
    const onDelta = vi.fn();
    const onError = vi.fn();
    vi.spyOn(sse, 'streamSse').mockImplementation(async (_url, handlers) => {
      handlers.onEvent({ event: 'delta', data: 'hello' });
      handlers.onEvent({ event: 'error', data: 'oops' });
      handlers.onDone?.();
    });

    const ctrl = new AbortController();
    await streamMessage(
      1,
      { content: 'x', expected_version: 1 },
      { signal: ctrl.signal, onDelta, onError },
    );

    expect(onDelta).toHaveBeenCalledWith('hello');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
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
