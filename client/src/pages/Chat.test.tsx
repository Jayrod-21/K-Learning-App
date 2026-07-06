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
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import type {
  AppendMessageBody,
  ConversationsList,
} from '../types/domain';
import type { ChatSeedState } from '../lib/askSeed';
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

/**
 * Chat now reads `useLocation`/`useNavigate` (F-020 seeding), so every render
 * needs a router. `seedState`, when given, rides in as the `/chat` entry's
 * router state — exactly how `AskAboutThisButton` delivers it.
 */
function renderChat(seedState?: ChatSeedState): ReturnType<typeof render> {
  return render(
    <MemoryRouter
      initialEntries={
        seedState !== undefined
          ? [{ pathname: '/chat', state: seedState }]
          : ['/chat']
      }
    >
      <Chat />
      <LocationStateProbe />
    </MemoryRouter>,
  );
}

/**
 * Exposes whether the current history entry still carries router state —
 * lets the seed tests assert Chat cleared the consumed seed — plus the full
 * URL, so they can assert the clearing replace-navigation preserved
 * search + hash (it must drop ONLY the state).
 */
function LocationStateProbe(): JSX.Element {
  const location = useLocation();
  return (
    <>
      <div data-testid="location-state">
        {location.state === null || location.state === undefined
          ? 'empty'
          : 'present'}
      </div>
      <div data-testid="location-url">
        {`${location.pathname}${location.search}${location.hash}`}
      </div>
    </>
  );
}

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
    renderChat();
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the personalised opener once listConversations resolves', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();
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
      renderChat();

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
    renderChat();
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
    renderChat();
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
    renderChat();
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
    renderChat();

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
    const { unmount } = renderChat();
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

// ── "Ask about this" seeding (F-020) ─────────────────────────────────────
describe('Chat seed (F-020)', () => {
  const SEED: ChatSeedState = {
    seedText: 'About this TOPIK question:\n\n알맞은 것을 고르십시오.',
    mode: 'topik_prep',
  };

  it('pre-fills the composer from location.state and does NOT auto-send', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat(SEED);

    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    expect(input.value).toBe(SEED.seedText);
    // Pre-fill only — no stream was dispatched and no user bubble appended.
    expect(hoisted.ref.streamCalls.length).toBe(0);
    // The user can review + send: the button is enabled (composer non-empty).
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('clears the router state after consuming the seed (no re-seed on re-render)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat(SEED);

    // The clearing replace-navigation lands after mount.
    await waitFor(() => {
      expect(screen.getByTestId('location-state')).toHaveTextContent('empty');
    });
    // The pre-filled text survives the state-clearing re-render.
    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    expect(input.value).toBe(SEED.seedText);
  });

  it('preserves search + hash when clearing the seed state (only the state drops)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/chat',
            search: '?conversation=7',
            hash: '#latest',
            state: SEED,
          },
        ]}
      >
        <Chat />
        <LocationStateProbe />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('location-state')).toHaveTextContent('empty');
    });
    // The replace-navigation rebuilt the FULL URL — a future deep-link param
    // must survive a seeded arrival.
    expect(screen.getByTestId('location-url')).toHaveTextContent(
      '/chat?conversation=7#latest',
    );
    // And the seed still landed in the composer.
    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    expect(input.value).toBe(SEED.seedText);
  });

  it('keeps user edits — the seed never re-applies over typed text', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat(SEED);

    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    await user.type(input, ' 감사합니다');
    expect(input.value).toBe(`${SEED.seedText} 감사합니다`);
  });

  it('prefers the seed mode when lazily starting the conversation', async () => {
    resetState();
    // No existing conversations — sending must lazy-start one.
    hoisted.ref.endpoint = { kind: 'data', data: { conversations: [] } };
    const user = userEvent.setup();
    renderChat(SEED);

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(hoisted.ref.startCalls.length).toBe(1);
    });
    expect(hoisted.ref.startCalls[0]?.mode).toBe('topik_prep');
    // And the seed text is what went out.
    expect(hoisted.ref.streamCalls[0]?.body.content).toBe(SEED.seedText);
  });

  it('ignores malformed router state (untrusted history state)', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/chat', state: { seedText: 42, mode: 'topik_prep' } },
        ]}
      >
        <Chat />
      </MemoryRouter>,
    );
    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    expect(input.value).toBe('');
  });

  it('renders with an empty composer when no seed state is present', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();
    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
