/**
 * Chat — Pass 3 wiring tests.
 *
 * Covers:
 *   - Loading skeleton.
 *   - Happy load via `listConversations` → seeded opener renders.
 *   - Send dispatches `streamMessage(convId, { content, expected_version },
 *     { onDelta, onDone, onError, requestId, signal })`.
 *   - `onDelta` callbacks grow a partial tutor bubble in the DOM.
 *   - `onDone` finalises that bubble.
 *   - `onError` keeps the user turn and surfaces an inline error chip.
 *   - Send button is disabled / aria-busy while a stream is in-flight.
 *   - Unmounting mid-stream aborts the controller passed into the service.
 *
 * Test boundary: we mock `services/conversation` and capture the latest
 * stream call's options, so each test can fire `onDelta`/`onDone`/`onError`
 * at will and inspect the screen's reaction. No real SSE.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AppendMessageBody,
  ConversationsList,
} from '../types/domain';
import { ApiError } from '../services/api';

// ── Hoisted shared state — mocks read fresh values per test ─────────────
const hoisted = vi.hoisted(() => {
  interface CapturedStreamCall {
    conversationId: number;
    body: AppendMessageBody;
    signal: AbortSignal;
    requestId: string | undefined;
    onDelta: (chunk: string) => void;
    onDone: (() => void) | undefined;
    onError: ((err: Error) => void) | undefined;
    /** Promise we control — caller `await`s it. */
    promise: Promise<void>;
    /** Resolve the promise from the test. */
    resolve: () => void;
    /** Reject the promise from the test. */
    reject: (err: Error) => void;
  }
  interface EndpointState {
    kind: 'loading' | 'data' | 'mock';
    data: ConversationsList | null;
  }
  return {
    ref: {
      endpoint: { kind: 'loading' } as EndpointState,
      streamCalls: [] as CapturedStreamCall[],
      startCalls: [] as Array<{ mode: string }>,
      startResult: { conversation: { id: 9001 } } as { conversation: { id: number } },
    },
  };
});

// ── useEndpointOrMock mock ──────────────────────────────────────────────
vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: () => {
    const s = hoisted.ref.endpoint;
    if (s.kind === 'loading') {
      return {
        data: null,
        loading: true,
        error: null,
        isMock: false,
        refetch: () => undefined,
      };
    }
    return {
      data: s.data,
      loading: false,
      error: null,
      isMock: s.kind === 'mock',
      refetch: () => undefined,
    };
  },
}));

// ── useSettings mock — empty name, defaults elsewhere ───────────────────
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      name: '',
      email: '',
      phone: '',
      notif: {
        channel: { email: false, sms: false },
        reviewsDue: false,
        daily: false,
        weekly: false,
      },
      palette: {
        paper: 'hanji',
        accent: 'vermilion',
        correct: 'moss',
        wrong: 'vermilion',
      },
    },
    updateSettings: () => undefined,
    resetSettings: () => undefined,
  }),
}));

// ── services/conversation mock — capture every call ─────────────────────
vi.mock('../services/conversation', () => ({
  listConversations: vi.fn(),
  startConversation: vi.fn(async (body: { mode: string }) => {
    hoisted.ref.startCalls.push(body);
    return hoisted.ref.startResult;
  }),
  appendMessage: vi.fn(),
  streamMessage: vi.fn(
    (
      conversationId: number,
      body: AppendMessageBody,
      opts: {
        signal: AbortSignal;
        onDelta: (chunk: string) => void;
        onDone?: () => void;
        onError?: (err: Error) => void;
        requestId?: string;
      },
    ): Promise<void> => {
      let resolveFn: () => void = () => undefined;
      let rejectFn: (err: Error) => void = () => undefined;
      const promise = new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      hoisted.ref.streamCalls.push({
        conversationId,
        body,
        signal: opts.signal,
        requestId: opts.requestId,
        onDelta: opts.onDelta,
        onDone: opts.onDone,
        onError: opts.onError,
        promise,
        resolve: resolveFn,
        reject: rejectFn,
      });
      return promise;
    },
  ),
}));

import { Chat } from './Chat';

/** Reset shared state between tests so each starts from a clean slate. */
function resetState(): void {
  hoisted.ref.endpoint = { kind: 'loading', data: null };
  hoisted.ref.streamCalls = [];
  hoisted.ref.startCalls = [];
  hoisted.ref.startResult = { conversation: { id: 9001 } };
}

const LIST: ConversationsList = {
  conversations: [
    {
      id: 42,
      mode: 'casual',
      target_register: null,
      version: 3,
      updated_at: '2026-05-29T12:00:00Z',
      message_count: 0,
    },
    {
      id: 11,
      mode: 'casual',
      target_register: null,
      version: 1,
      updated_at: '2026-05-20T12:00:00Z',
      message_count: 4,
    },
  ],
};

describe('Chat', () => {
  it('renders the skeleton while loading', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'loading', data: null };
    render(<Chat />);
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the personalised opener once listConversations resolves', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    render(<Chat />);
    expect(screen.getByText('대화 · Chat')).toBeInTheDocument();
    // The fallback opener (formal greeting) is shown until the first real
    // tutor reply lands.
    expect(
      screen.getByText(/오늘은 재택근무의 장단점에 대해/),
    ).toBeInTheDocument();
  });

  it(
    'sends a message — calls streamMessage with the most recent ' +
      'conversation id, expected_version, and a request id',
    async () => {
      resetState();
      hoisted.ref.endpoint = { kind: 'data', data: LIST };
      const user = userEvent.setup();
      render(<Chat />);

      const input = screen.getByLabelText('Reply input');
      await user.type(input, '감사합니다');
      const send = screen.getByRole('button', { name: 'Send' });
      await user.click(send);

      expect(hoisted.ref.streamCalls.length).toBe(1);
      const call = hoisted.ref.streamCalls[0];
      if (!call) throw new Error('no captured stream call');
      expect(call.conversationId).toBe(42); // most-recent updated_at row
      expect(call.body.content).toBe('감사합니다');
      expect(call.body.expected_version).toBe(3);
      expect(typeof call.requestId).toBe('string');
      expect((call.requestId ?? '').length).toBeGreaterThan(10);
      // Optimistic user bubble visible.
      expect(screen.getByText('감사합니다')).toBeInTheDocument();
    },
  );

  it('streams deltas into a partial tutor bubble and finalises on done', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    render(<Chat />);
    const input = screen.getByLabelText('Reply input');
    await user.type(input, '안녕');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const call = hoisted.ref.streamCalls[0];
    if (!call) throw new Error('no captured stream call');

    act(() => {
      call.onDelta('네, ');
    });
    expect(screen.getByText('네,')).toBeInTheDocument();
    act(() => {
      call.onDelta('반갑습니다.');
    });
    // The partial bubble now contains the concatenated text.
    expect(screen.getByText('네, 반갑습니다.')).toBeInTheDocument();

    // Resolve the stream promise; onDone fires in the service path. We
    // simulate the helper's onDone callback firing right before EOF.
    await act(async () => {
      call.onDone?.();
      call.resolve();
      await call.promise;
    });

    // After done, Send is no longer in-flight. (`disabled` may remain true
    // because the composer is empty post-submit — the UX correctly blocks
    // a second empty send. We assert the stream-state attribute instead.)
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-busy')).toBe('false');
  });

  it('disables Send (aria-busy=true) while a stream is in flight', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    render(<Chat />);
    const input = screen.getByLabelText('Reply input');
    await user.type(input, '테스트');
    const send = screen.getByRole('button', { name: 'Send' });
    await user.click(send);

    // The stream promise is still pending — button is disabled + busy.
    expect(send).toBeDisabled();
    expect(send.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps the user turn and shows an error chip on stream error', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    render(<Chat />);
    const input = screen.getByLabelText('Reply input');
    await user.type(input, '실패');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const call = hoisted.ref.streamCalls[0];
    if (!call) throw new Error('no captured stream call');

    await act(async () => {
      const apiErr = new ApiError('upstream down', {
        status: 502,
        code: 'http_error',
      });
      call.onError?.(apiErr);
      call.reject(apiErr);
      await call.promise.catch(() => undefined);
    });

    // User turn is preserved.
    expect(screen.getByText('실패')).toBeInTheDocument();
    // Inline error chip is present.
    expect(screen.getByRole('alert')).toHaveTextContent('upstream down');
    // Retry control is rendered on the failed row.
    expect(
      screen.getByRole('button', { name: 'Retry sending message' }),
    ).toBeInTheDocument();
  });

  it('Retry reuses the SAME requestId so the server can short-circuit (C-SF-6)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    render(<Chat />);

    // First send: capture the minted requestId off the failing call.
    const input = screen.getByLabelText('Reply input');
    await user.type(input, '실패');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const firstCall = hoisted.ref.streamCalls[0];
    if (!firstCall) throw new Error('no captured stream call');
    const firstRequestId = firstCall.requestId;
    expect(typeof firstRequestId).toBe('string');
    expect((firstRequestId ?? '').length).toBeGreaterThan(10);

    // Stream fails. The user turn stays + a Retry chip appears.
    await act(async () => {
      const apiErr = new ApiError('upstream down', {
        status: 502,
        code: 'http_error',
      });
      firstCall.onError?.(apiErr);
      firstCall.reject(apiErr);
      await firstCall.promise.catch(() => undefined);
    });

    // Click Retry.
    await user.click(
      screen.getByRole('button', { name: 'Retry sending message' }),
    );

    // A second stream call is captured — same requestId as the first so
    // the server-side idempotency-by-request-id table short-circuits to
    // the already-persisted assistant reply (the whole reason this id
    // exists). A fresh id here would defeat that contract.
    await waitFor(() => {
      expect(hoisted.ref.streamCalls.length).toBe(2);
    });
    const retryCall = hoisted.ref.streamCalls[1];
    if (!retryCall) throw new Error('no retry stream call');
    expect(retryCall.requestId).toBe(firstRequestId);
    // And the body the user typed is preserved.
    expect(retryCall.body.content).toBe('실패');
  });

  it('aborts the in-flight stream when the screen unmounts', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    const { unmount } = render(<Chat />);
    const input = screen.getByLabelText('Reply input');
    await user.type(input, '중간');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const call = hoisted.ref.streamCalls[0];
    if (!call) throw new Error('no captured stream call');
    expect(call.signal.aborted).toBe(false);

    unmount();
    expect(call.signal.aborted).toBe(true);
  });
});
