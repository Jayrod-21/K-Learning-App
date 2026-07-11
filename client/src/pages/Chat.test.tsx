/**
 * Chat — Pass 3 wiring + chat rework Slice 2 tests.
 *
 * Covers:
 *   - Loading skeleton.
 *   - Happy load via `listConversations` → active history loads via
 *     `getConversation` → opener (empty history) renders.
 *   - Sidebar: lists conversations newest-first (derived titles + fallback
 *     mode/date titles), click-to-switch loads + renders that
 *     conversation's history, current-row highlight, collapse toggle
 *     (persisted in localStorage, narrow-viewport default), "New chat"
 *     (fresh conversation, prior rows remain, composer focused), 30-day
 *     retention note.
 *   - History fetch abort on switch/unmount + late-result no-op + failure
 *     fixed-copy + retry.
 *   - Fast A→B→A bounce (B pending) refetches A — the `loaded` cache is
 *     invalidated on switch, so a bounced-to thread is never blank.
 *   - Switch mid-stream aborts the stream; late tokens never paint.
 *   - Lazy-start hardening: unmount during a pending start never opens an
 *     SSE; two rapid sends share ONE started conversation (latch).
 *   - Send dispatches `streamMessage(convId, { content, expected_version },
 *     { onDelta, onDone, onError, requestId, signal })` against the ACTIVE
 *     conversation with the version its history load reported.
 *   - `onDelta` grows a partial tutor bubble; `onDone` finalises it.
 *   - `onError` keeps the user turn and surfaces an inline error chip.
 *   - Send button is disabled / aria-busy while a stream is in-flight.
 *   - Unmounting mid-stream aborts the controller passed into the service.
 *   - F-020 seeding + F-016 dictionary flows (unchanged contracts).
 *
 * Test boundary: we mock `services/conversation` and capture every call's
 * options, so each test can fire `onDelta`/`onDone`/`onError` or resolve a
 * history fetch at will and inspect the screen's reaction. No real SSE.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import type {
  AppendFileTurnResult,
  AppendImageTurnResult,
  AppendMessageBody,
  ConversationDetailResult,
  ConversationsList,
  NameConversationResult,
  StoredConversationTurn,
} from '../types/domain';
import type { ChatSeedState } from '../lib/askSeed';
import { buildChatOpenState, type ChatContext } from '../lib/chatContext';
import { ApiError } from '../services/api';
import { ToastProvider } from '../components/ToastProvider';

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
  interface CapturedGetCall {
    id: number;
    signal: AbortSignal | undefined;
    /** Resolve the history fetch from the test (manual mode). */
    resolve: (result: ConversationDetailResult) => void;
    /** Reject the history fetch from the test (manual mode). */
    reject: (err: Error) => void;
  }
  interface CapturedUploadCall {
    conversationId: number;
    file: File;
    expectedVersion: number;
    signal: AbortSignal | undefined;
    /** Resolve the upload from the test. */
    resolve: (result: AppendImageTurnResult) => void;
    /** Reject the upload from the test. */
    reject: (err: Error) => void;
  }
  interface CapturedFileUploadCall {
    conversationId: number;
    file: File;
    expectedVersion: number;
    signal: AbortSignal | undefined;
    resolve: (result: AppendFileTurnResult) => void;
    reject: (err: Error) => void;
  }
  interface CapturedNameCall {
    conversationId: number;
    resolve: (result: NameConversationResult) => void;
    reject: (err: Error) => void;
  }
  interface EndpointState {
    kind: 'loading' | 'data' | 'mock';
    data: ConversationsList | null;
  }
  /** Build a `GET /conversation/:id` envelope for tests. */
  const makeDetail = (
    id: number,
    messages: StoredConversationTurn[],
    version: number,
    title: string | null = null,
  ): ConversationDetailResult => ({
    conversation: {
      id,
      title,
      mode: 'casual',
      target_register: null,
      version,
      messages,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-29T12:00:00Z',
    },
  });
  return {
    makeDetail,
    ref: {
      endpoint: { kind: 'loading' } as EndpointState,
      streamCalls: [] as CapturedStreamCall[],
      startCalls: [] as Array<{ mode: string }>,
      startResult: { conversation: { id: 9001 } } as {
        conversation: { id: number };
      },
      /** true → startConversation resolves immediately with startResult;
       *  false → tests settle each pending start via startGates. */
      autoStart: true,
      startGates: [] as Array<{
        resolve: (result: { conversation: { id: number } }) => void;
        reject: (err: Error) => void;
      }>,
      getCalls: [] as CapturedGetCall[],
      /** true → getConversation auto-resolves from detailVersions/-Messages;
       *  false → tests settle each captured call by hand. */
      autoDetail: true,
      detailVersions: {} as Record<number, number>,
      detailMessages: {} as Record<number, StoredConversationTurn[]>,
      uploadCalls: [] as CapturedUploadCall[],
      fileUploadCalls: [] as CapturedFileUploadCall[],
      nameCalls: [] as CapturedNameCall[],
      /** true → nameConversation auto-resolves with a fixed title (most
       *  tests don't care about naming); false → tests settle by hand. */
      autoName: true,
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
  startConversation: vi.fn(
    (body: { mode: string }): Promise<{ conversation: { id: number } }> => {
      hoisted.ref.startCalls.push(body);
      if (hoisted.ref.autoStart) {
        return Promise.resolve(hoisted.ref.startResult);
      }
      // Manual mode — the test controls when (and whether) the start
      // settles, so lazy-start races (unmount / double-send) are testable.
      return new Promise((resolve, reject) => {
        hoisted.ref.startGates.push({ resolve, reject });
      });
    },
  ),
  appendMessage: vi.fn(),
  getConversation: vi.fn(
    (id: number, signal?: AbortSignal): Promise<ConversationDetailResult> => {
      if (hoisted.ref.autoDetail) {
        hoisted.ref.getCalls.push({
          id,
          signal,
          resolve: () => undefined,
          reject: () => undefined,
        });
        return Promise.resolve(
          hoisted.makeDetail(
            id,
            hoisted.ref.detailMessages[id] ?? [],
            hoisted.ref.detailVersions[id] ?? 1,
          ),
        );
      }
      let resolveFn: (result: ConversationDetailResult) => void = () =>
        undefined;
      let rejectFn: (err: Error) => void = () => undefined;
      const promise = new Promise<ConversationDetailResult>(
        (resolve, reject) => {
          resolveFn = resolve;
          rejectFn = reject;
        },
      );
      hoisted.ref.getCalls.push({
        id,
        signal,
        resolve: resolveFn,
        reject: rejectFn,
      });
      return promise;
    },
  ),
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
  uploadConversationImage: vi.fn(
    (
      conversationId: number,
      file: File,
      expectedVersion: number,
      signal?: AbortSignal,
    ): Promise<AppendImageTurnResult> => {
      let resolveFn: (result: AppendImageTurnResult) => void = () =>
        undefined;
      let rejectFn: (err: Error) => void = () => undefined;
      const promise = new Promise<AppendImageTurnResult>(
        (resolve, reject) => {
          resolveFn = resolve;
          rejectFn = reject;
        },
      );
      hoisted.ref.uploadCalls.push({
        conversationId,
        file,
        expectedVersion,
        signal,
        resolve: resolveFn,
        reject: rejectFn,
      });
      return promise;
    },
  ),
  uploadConversationFile: vi.fn(
    (
      conversationId: number,
      file: File,
      expectedVersion: number,
      signal?: AbortSignal,
    ): Promise<AppendFileTurnResult> => {
      let resolveFn: (result: AppendFileTurnResult) => void = () => undefined;
      let rejectFn: (err: Error) => void = () => undefined;
      const promise = new Promise<AppendFileTurnResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      hoisted.ref.fileUploadCalls.push({
        conversationId,
        file,
        expectedVersion,
        signal,
        resolve: resolveFn,
        reject: rejectFn,
      });
      return promise;
    },
  ),
  nameConversation: vi.fn(
    (conversationId: number): Promise<NameConversationResult> => {
      let resolveFn: (result: NameConversationResult) => void = () =>
        undefined;
      let rejectFn: (err: Error) => void = () => undefined;
      const promise = new Promise<NameConversationResult>(
        (resolve, reject) => {
          resolveFn = resolve;
          rejectFn = reject;
        },
      );
      hoisted.ref.nameCalls.push({
        conversationId,
        resolve: resolveFn,
        reject: rejectFn,
      });
      // Auto-resolve by default — most tests don't care about naming and
      // shouldn't have to manually settle a call they never asserted on.
      if (hoisted.ref.autoName) {
        resolveFn({ title: '자동 생성된 제목', generated: true });
      }
      return promise;
    },
  ),
}));

import { Chat } from './Chat';

/**
 * Chat reads `useLocation`/`useNavigate` (F-020 seeding + the Slice-3 FAB
 * open request), so every render needs a router. `routeState`, when given,
 * rides in as the `/chat` entry's router state — exactly how
 * `AskAboutThisButton` (a `ChatSeedState`) and `ChatFab` (a `ChatOpenState`)
 * deliver theirs. Chat also calls `useToast` (F-016 add-to-bank failure
 * toast), so every render needs a `ToastProvider` too.
 */
function renderChat(
  routeState?: ChatSeedState | ReturnType<typeof buildChatOpenState>,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter
      initialEntries={
        routeState !== undefined
          ? [{ pathname: '/chat', state: routeState }]
          : ['/chat']
      }
    >
      <ToastProvider>
        <Chat />
        <LocationStateProbe />
      </ToastProvider>
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
  hoisted.ref.getCalls = [];
  hoisted.ref.autoDetail = true;
  hoisted.ref.autoStart = true;
  hoisted.ref.startGates = [];
  // Versions deliberately DIFFER from the LIST fixture rows (42→3, 11→1)
  // so send tests PROVE the expected_version came from the HISTORY fetch
  // (the authoritative source) — an implementation that read `row.version`
  // off the list envelope would send 3/1 and fail.
  hoisted.ref.detailVersions = { 42: 5, 11: 2 };
  hoisted.ref.detailMessages = {};
  hoisted.ref.uploadCalls = [];
  hoisted.ref.fileUploadCalls = [];
  hoisted.ref.nameCalls = [];
  hoisted.ref.autoName = true;
  window.localStorage.clear();
}

const LIST: ConversationsList = {
  conversations: [
    {
      id: 42,
      title: null,
      mode: 'casual',
      target_register: null,
      version: 3,
      updated_at: '2026-05-29T12:00:00Z',
      message_count: 0,
    },
    {
      id: 11,
      title: null,
      mode: 'casual',
      target_register: null,
      version: 1,
      updated_at: '2026-05-20T12:00:00Z',
      message_count: 4,
    },
  ],
};

/** One stored user/assistant turn for detailMessages fixtures. */
function turn(
  role: 'user' | 'assistant',
  content: string,
): StoredConversationTurn {
  return { role, content, sent_at: '2026-05-20T12:00:00Z' };
}

/** The empty-thread opener line (settings.name is '' in these tests). */
const OPENER_RE = /오늘은 재택근무의 장단점에 대해/;

/**
 * The thread pane. Message text can ALSO appear in the sidebar as a derived
 * conversation title (first user message snippet), so bubble assertions must
 * scope to the log or `getByText` finds two matches.
 */
function thread(): HTMLElement {
  return screen.getByRole('log', { name: 'Conversation' });
}

describe('Chat', () => {
  it('renders the skeleton while loading', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'loading', data: null };
    renderChat();
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the opener once the active conversation loads with no history', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();
    expect(
      screen.getByRole('heading', { level: 1, name: '대화 · Chat' }),
    ).toBeInTheDocument();
    // The newest conversation (42) is auto-active; its (empty) history
    // resolves and the opener greeting renders above the composer.
    expect(await screen.findByText(OPENER_RE)).toBeInTheDocument();
    expect(hoisted.ref.getCalls[0]?.id).toBe(42);
  });

  it('P3b: chrome eyebrows render Korean in both-mode', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();
    // Topbar eyebrow — the nav manifest pair (Tutor conversation · 튜터 대화).
    expect(screen.getByText('튜터 대화')).toBeInTheDocument();
    expect(screen.getByText('Tutor conversation')).toBeInTheDocument();
    // Composer label: bilingual "Reply · 답장" with the 합쇼체 register cue
    // kept OUTSIDE the pair (it names the target register, not a translation).
    expect(screen.getByText('답장')).toBeInTheDocument();
    expect(screen.getByText('Reply')).toBeInTheDocument();
    expect(screen.getByText(/합쇼체/)).toBeInTheDocument();
    // Bubble role labels are bilingual too (opener bubble, post history load).
    expect((await screen.findAllByText('튜터')).length).toBeGreaterThan(0);
  });

  it(
    'sends a message — calls streamMessage with the active conversation ' +
      'id, the history-loaded expected_version, and a request id',
    async () => {
      resetState();
      hoisted.ref.endpoint = { kind: 'data', data: LIST };
      const user = userEvent.setup();
      renderChat();
      await screen.findByText(OPENER_RE); // history for 42 settled

      const input = screen.getByLabelText('Reply input');
      await user.type(input, '감사합니다');
      const send = screen.getByRole('button', { name: 'Send' });
      await user.click(send);

      expect(hoisted.ref.streamCalls.length).toBe(1);
      const call = hoisted.ref.streamCalls[0];
      if (!call) throw new Error('no captured stream call');
      expect(call.conversationId).toBe(42); // most-recent updated_at row
      expect(call.body.content).toBe('감사합니다');
      // 5 comes from the HISTORY fetch (detailVersions); the list row says
      // 3 — proving the send rebinds to the authoritative detail version.
      expect(call.body.expected_version).toBe(5);
      expect(typeof call.requestId).toBe('string');
      expect((call.requestId ?? '').length).toBeGreaterThan(10);
      // Optimistic user bubble visible (scoped: the text is also the row title).
      expect(within(thread()).getByText('감사합니다')).toBeInTheDocument();
    },
  );

  it('streams deltas into a partial tutor bubble and finalises on done', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);
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
    await screen.findByText(OPENER_RE);
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
    await screen.findByText(OPENER_RE);
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

    // User turn is preserved (scoped: the text is also the row title).
    expect(within(thread()).getByText('실패')).toBeInTheDocument();
    // Inline error chip shows FIXED copy (F-UP-018) — never the server
    // prose riding on ApiError.message.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Stream failed. Please retry.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('upstream down');
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
    await screen.findByText(OPENER_RE);

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
    await screen.findByText(OPENER_RE);
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

// ── Conversation sidebar (chat rework Slice 2) ───────────────────────────
describe('Chat sidebar (Slice 2)', () => {
  it('lists conversations newest-first with fallback titles, highlights the current one, and shows the retention note', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();

    const nav = await screen.findByRole('navigation', {
      name: 'Conversations',
    });
    const items = within(nav).getAllByRole('listitem');
    expect(items.length).toBe(2);

    // Newest (42, updated 5/29) first — fallback title is mode + date
    // because the list endpoint carries no message bodies.
    const first = within(items[0] as HTMLElement).getByRole('button');
    expect(first).toHaveAccessibleName(/^일상 대화 · 5\/29/);
    expect(first).toHaveAttribute('aria-current', 'true');
    const second = within(items[1] as HTMLElement).getByRole('button');
    expect(second).toHaveAccessibleName(/^일상 대화 · 5\/20/);
    expect(second).not.toHaveAttribute('aria-current');

    // 30-day retention note (bilingual chrome).
    expect(
      within(nav).getByText(/kept 30 days, then cleared/),
    ).toBeInTheDocument();
    expect(within(nav).getByText(/30일 뒤 삭제/)).toBeInTheDocument();
  });

  it('clicking a row loads + renders its history, derives its title, and sends target it', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.detailMessages[11] = [
      turn('user', '문법 질문이 있어요'),
      turn('assistant', '네, 말씀해 보세요'),
    ];
    const user = userEvent.setup();
    renderChat();

    const nav = await screen.findByRole('navigation', {
      name: 'Conversations',
    });
    await user.click(
      within(nav).getByRole('button', { name: /일상 대화 · 5\/20/ }),
    );

    // Full history renders — the previously-missing capability. (Scoped to
    // the thread: the first user message doubles as the sidebar title.)
    expect(
      await within(thread()).findByText('문법 질문이 있어요'),
    ).toBeInTheDocument();
    expect(within(thread()).getByText('네, 말씀해 보세요')).toBeInTheDocument();
    expect(hoisted.ref.getCalls.map((c) => c.id)).toContain(11);
    // The opener does NOT render over real history.
    expect(screen.queryByText(OPENER_RE)).not.toBeInTheDocument();

    // Its sidebar title is now the first user message's snippet, and the
    // highlight moved.
    const row11 = within(nav).getByRole('button', {
      name: /문법 질문이 있어요/,
    });
    expect(row11).toHaveAttribute('aria-current', 'true');

    // A send now targets conversation 11 with the version ITS history
    // fetch reported (2) — not the list row's 1, and not the previous
    // conversation's 5.
    await user.type(screen.getByLabelText('Reply input'), '알겠습니다');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(hoisted.ref.streamCalls.length).toBe(1);
    expect(hoisted.ref.streamCalls[0]?.conversationId).toBe(11);
    expect(hoisted.ref.streamCalls[0]?.body.expected_version).toBe(2);
  });

  it('collapse toggles the rail, persists to localStorage, and survives a remount', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    const first = renderChat();

    const toggle = await screen.findByRole('button', {
      name: 'Collapse conversation list',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Expanded: the New chat label text is visible.
    expect(screen.getByText('New chat')).toBeInTheDocument();

    await user.click(toggle);

    // Collapsed: labels hidden, accessible names intact, preference stored.
    const expand = screen.getByRole('button', {
      name: 'Expand conversation list',
    });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('New chat')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New chat' }),
    ).toBeInTheDocument();
    // Rows stay keyboard-operable with their full accessible names.
    expect(
      screen.getByRole('button', { name: /일상 대화 · 5\/29/ }),
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem('km.chat.sidebar-collapsed'),
    ).toBe('1');

    // A fresh mount reads the persisted preference.
    first.unmount();
    renderChat();
    expect(
      await screen.findByRole('button', {
        name: 'Expand conversation list',
      }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('defaults to collapsed on a narrow viewport (no stored preference)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    try {
      renderChat();
      expect(
        await screen.findByRole('button', {
          name: 'Expand conversation list',
        }),
      ).toHaveAttribute('aria-expanded', 'false');
    } finally {
      spy.mockRestore();
    }
  });

  it('New chat starts a fresh conversation, keeps prior rows, focuses the composer, and sends use it', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.detailMessages[42] = [
      turn('user', '이전 대화 내용'),
      turn('assistant', '이전 답변'),
    ];
    const user = userEvent.setup();
    renderChat();
    // The active conversation's real history is on screen first.
    await within(thread()).findByText('이전 대화 내용');

    await user.click(screen.getByRole('button', { name: 'New chat' }));

    await waitFor(() => {
      expect(hoisted.ref.startCalls.length).toBe(1);
    });
    expect(hoisted.ref.startCalls[0]?.mode).toBe('casual');

    // Fresh thread: opener renders, the old history is gone (the sidebar
    // still shows conversation 42's derived title — only the THREAD resets).
    expect(await screen.findByText(OPENER_RE)).toBeInTheDocument();
    expect(
      within(thread()).queryByText('이전 대화 내용'),
    ).not.toBeInTheDocument();

    // Prior conversations remain listed; the new one is current + newest.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const items = within(nav).getAllByRole('listitem');
    expect(items.length).toBe(3);
    const newRow = within(items[0] as HTMLElement).getByRole('button');
    expect(newRow).toHaveAttribute('aria-current', 'true');
    // Conversation 42 kept its derived title (its history loaded, so its
    // first user message replaced the mode/date fallback); 11 never loaded
    // and keeps the fallback.
    expect(
      within(nav).getByRole('button', { name: /이전 대화 내용/ }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole('button', { name: /일상 대화 · 5\/20/ }),
    ).toBeInTheDocument();

    // Composer focused, ready to type.
    expect(screen.getByLabelText('Reply input')).toHaveFocus();

    // A send targets the NEW conversation at version 1 — no history fetch
    // needed (a just-started conversation is known-empty).
    await user.type(screen.getByLabelText('Reply input'), '새 대화 시작');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(hoisted.ref.streamCalls[0]?.conversationId).toBe(9001);
    expect(hoisted.ref.streamCalls[0]?.body.expected_version).toBe(1);
    expect(hoisted.ref.getCalls.every((c) => c.id !== 9001)).toBe(true);
  });

  it('switching aborts the in-flight history fetch and a late result never paints (abort discipline)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.autoDetail = false;
    const user = userEvent.setup();
    renderChat();

    // Mount kicks off the newest conversation's history fetch.
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(1);
    });
    const firstCall = hoisted.ref.getCalls[0];
    if (!firstCall) throw new Error('no captured history call');
    expect(firstCall.id).toBe(42);
    expect(firstCall.signal?.aborted).toBe(false);

    // Switch to the other conversation while the first fetch is pending.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    await user.click(
      within(nav).getByRole('button', { name: /일상 대화 · 5\/20/ }),
    );
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(2);
    });
    expect(firstCall.signal?.aborted).toBe(true);

    // The aborted fetch resolving LATE must be a total no-op.
    await act(async () => {
      firstCall.resolve(hoisted.makeDetail(42, [turn('user', '늦은 응답')], 3));
    });
    expect(screen.queryByText('늦은 응답')).not.toBeInTheDocument();

    // The current fetch resolves and paints ITS history.
    const secondCall = hoisted.ref.getCalls[1];
    if (!secondCall) throw new Error('no second history call');
    expect(secondCall.id).toBe(11);
    await act(async () => {
      secondCall.resolve(
        hoisted.makeDetail(11, [turn('user', '두 번째 대화')], 1),
      );
    });
    expect(
      await within(thread()).findByText('두 번째 대화'),
    ).toBeInTheDocument();
  });

  it('fast A→B→A bounce refetches A and renders its history (loaded-cache invalidation, B1)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.autoDetail = false;
    const user = userEvent.setup();
    renderChat();

    // A (42) is auto-active; its history loads fully.
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(1);
    });
    expect(hoisted.ref.getCalls[0]?.id).toBe(42);
    await act(async () => {
      hoisted.ref.getCalls[0]?.resolve(
        hoisted.makeDetail(42, [turn('user', '원래 대화 내용')], 5),
      );
    });
    expect(
      await within(thread()).findByText('원래 대화 내용'),
    ).toBeInTheDocument();

    // Switch to B (11); its fetch stays PENDING.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    await user.click(
      within(nav).getByRole('button', { name: /일상 대화 · 5\/20/ }),
    );
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(2);
    });
    expect(hoisted.ref.getCalls[1]?.id).toBe(11);

    // Bounce straight back to A BEFORE B's fetch resolves. (A's row now
    // carries its derived first-user-message title.)
    await user.click(
      within(nav).getByRole('button', { name: /원래 대화 내용/ }),
    );

    // The bounce must (re)drive A's history fetch. Without invalidating the
    // `loaded` cache on switch, the history effect early-returns on the
    // stale `loaded.key === 42`, no third fetch fires, and the thread stays
    // permanently blank — re-clicking the row is a no-op.
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(3);
    });
    expect(hoisted.ref.getCalls[2]?.id).toBe(42);
    // B's pending fetch was aborted by the bounce.
    expect(hoisted.ref.getCalls[1]?.signal?.aborted).toBe(true);
    // A visible loading state shows while A refetches (scoped to the
    // thread — the announce live region carries similar text).
    expect(
      within(thread()).getByText(/대화 불러오는 중/),
    ).toBeInTheDocument();

    // The refetch resolves and A's history renders again.
    await act(async () => {
      hoisted.ref.getCalls[2]?.resolve(
        hoisted.makeDetail(42, [turn('user', '원래 대화 내용')], 5),
      );
    });
    expect(
      await within(thread()).findByText('원래 대화 내용'),
    ).toBeInTheDocument();
  });

  it('switching conversations aborts the in-flight stream and its late tokens never paint', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.detailMessages[11] = [turn('assistant', '다른 대화 답변')];
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE); // history for 42 settled

    // Start a stream in conversation 42 and let a first token paint.
    await user.type(screen.getByLabelText('Reply input'), '스트림 질문');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const call = hoisted.ref.streamCalls[0];
    if (!call) throw new Error('no captured stream call');
    expect(call.conversationId).toBe(42);
    expect(call.signal.aborted).toBe(false);
    act(() => {
      call.onDelta('첫 토큰');
    });
    expect(within(thread()).getByText('첫 토큰')).toBeInTheDocument();

    // Switch mid-stream — the prior stream's controller must be aborted
    // (the threat-model claim previously only tested for unmount).
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    await user.click(
      within(nav).getByRole('button', { name: /일상 대화 · 5\/20/ }),
    );
    expect(call.signal.aborted).toBe(true);

    // Conversation 11's own history renders.
    expect(
      await within(thread()).findByText('다른 대화 답변'),
    ).toBeInTheDocument();

    // A late token from the aborted stream must not render into the new
    // thread (defense-in-depth: the streaming-row tail guard).
    act(() => {
      call.onDelta('늦은 토큰');
    });
    expect(screen.queryByText(/늦은 토큰/)).not.toBeInTheDocument();

    // The aborted stream settling is swallowed — no error chip on the way
    // out of a deliberate switch.
    await act(async () => {
      call.reject(new ApiError('canceled', { status: 0, code: 'canceled' }));
      await call.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('unmounting aborts the in-flight history fetch', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.autoDetail = false;
    const { unmount } = renderChat();

    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(1);
    });
    const call = hoisted.ref.getCalls[0];
    if (!call) throw new Error('no captured history call');
    expect(call.signal?.aborted).toBe(false);

    unmount();
    expect(call.signal?.aborted).toBe(true);
  });

  it('a failed history load shows fixed copy (never server prose) and Retry refetches', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.autoDetail = false;
    const user = userEvent.setup();
    renderChat();

    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(1);
    });
    await act(async () => {
      hoisted.ref.getCalls[0]?.reject(
        new ApiError('relation "conversations" does not exist', {
          status: 500,
          code: 'server_error',
        }),
      );
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This conversation could not be loaded.');
    expect(alert).not.toHaveTextContent('relation');
    // Sends are blocked while the thread has no trustworthy version — even
    // with text in the composer (non-vacuous: typing usually enables Send).
    await user.type(screen.getByLabelText('Reply input'), '테스트');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(hoisted.ref.streamCalls.length).toBe(0);

    // Retry re-arms the effect — a second fetch fires and paints.
    await user.click(within(alert).getByRole('button', { name: /Retry/ }));
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(2);
    });
    await act(async () => {
      hoisted.ref.getCalls[1]?.resolve(
        hoisted.makeDetail(42, [turn('user', '다시 시도 성공')], 3),
      );
    });
    expect(
      await within(thread()).findByText('다시 시도 성공'),
    ).toBeInTheDocument();
  });
});

// ── Lazy-start hardening (Slice 2 fix-pass) ──────────────────────────────
describe('Chat lazy-start (Slice 2 hardening)', () => {
  it('unmounting during a pending lazy-start never opens the SSE stream', async () => {
    resetState();
    // No existing conversations — sending must lazy-start one.
    hoisted.ref.endpoint = { kind: 'data', data: { conversations: [] } };
    hoisted.ref.autoStart = false;
    const user = userEvent.setup();
    const { unmount } = renderChat();

    await user.type(screen.getByLabelText('Reply input'), '안녕하세요');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(hoisted.ref.startCalls.length).toBe(1);
    });
    // The start RTT is still pending — no stream yet.
    expect(hoisted.ref.streamCalls.length).toBe(0);

    unmount();

    // startConversation resolves AFTER unmount. The continuation must not
    // open an SSE stream against the dead tree — the unmount cleanup has
    // already run, so nothing would ever abort it (a held connection and
    // real Claude spend, invisible to the user).
    await act(async () => {
      hoisted.ref.startGates[0]?.resolve({ conversation: { id: 9001 } });
    });
    expect(hoisted.ref.streamCalls.length).toBe(0);
  });

  it('two rapid sends on a fresh thread share ONE lazy-started conversation', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: { conversations: [] } };
    hoisted.ref.autoStart = false;
    const user = userEvent.setup();
    renderChat();

    // Two sends land before startConversation resolves — during that RTT
    // `streaming` is still false, so the Send button is not the guard.
    const input = screen.getByLabelText('Reply input');
    await user.type(input, '첫 번째 질문');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.type(input, '두 번째 질문');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // Exactly ONE conversation was started — the second send latched onto
    // the first's in-flight start instead of creating its own.
    expect(hoisted.ref.startCalls.length).toBe(1);

    await act(async () => {
      hoisted.ref.startGates[0]?.resolve({ conversation: { id: 9001 } });
    });

    // Both sends stream into the SAME conversation.
    await waitFor(() => {
      expect(hoisted.ref.streamCalls.length).toBe(2);
    });
    expect(hoisted.ref.streamCalls[0]?.conversationId).toBe(9001);
    expect(hoisted.ref.streamCalls[1]?.conversationId).toBe(9001);
    expect(hoisted.ref.streamCalls[0]?.body.content).toBe('첫 번째 질문');
    expect(hoisted.ref.streamCalls[1]?.body.content).toBe('두 번째 질문');
    // Both optimistic bubbles are in the one thread…
    expect(within(thread()).getByText('첫 번째 질문')).toBeInTheDocument();
    expect(within(thread()).getByText('두 번째 질문')).toBeInTheDocument();
    // …and exactly one sidebar row was adopted.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(within(nav).getAllByRole('listitem').length).toBe(1);
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
        <ToastProvider>
          <Chat />
          <LocationStateProbe />
        </ToastProvider>
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
    await waitFor(() => {
      expect(hoisted.ref.streamCalls.length).toBe(1);
    });
    expect(hoisted.ref.streamCalls[0]?.body.content).toBe(SEED.seedText);
    // The lazily-started conversation joins the sidebar list.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(within(nav).getAllByRole('listitem').length).toBe(1);
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
        <ToastProvider>
          <Chat />
        </ToastProvider>
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


// ── FAB entry: force-new + "Discuss the page you were on?" (Slice 3) ─────
describe('Chat FAB open (Slice 3)', () => {
  const PAGE_CTX: ChatContext = {
    pageLabel: 'Today · 오늘',
    summary: '3 review cards due · Listening: 재택근무',
  };

  /** The generic FAB-entry opener (mockup copy). */
  const ASK_OPENER_RE = /무엇에 대해 이야기하고 싶으세요/;

  it('shows the popup with the page context; Yes seeds the composer and targets a NEW conversation', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat(buildChatOpenState(PAGE_CTX));

    // The popup is up, carrying the page's label + summary; the opener
    // stays hidden underneath it (mockup behavior) and NO conversation was
    // started or fetched — the FAB entry is the pending-'new' thread.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Today · 오늘');
    expect(dialog).toHaveTextContent('3 review cards due');
    expect(screen.queryByText(ASK_OPENER_RE)).not.toBeInTheDocument();
    expect(hoisted.ref.startCalls.length).toBe(0);
    expect(hoisted.ref.getCalls.length).toBe(0);

    await user.click(
      within(dialog).getByRole('button', { name: /Yes, use it/ }),
    );

    // Popup gone; composer pre-filled with the generic context seed —
    // pre-fill ONLY, nothing auto-sent.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    expect(input.value).toContain('Today · 오늘');
    expect(input.value).toContain('3 review cards due');
    expect(hoisted.ref.streamCalls.length).toBe(0);
    // The ask-opener now renders (empty pending thread).
    expect(screen.getByText(ASK_OPENER_RE)).toBeInTheDocument();
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    // Sending lazy-starts a NEW conversation (not 42, the newest existing
    // row) and the prior conversations stay listed in the sidebar.
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(hoisted.ref.streamCalls.length).toBe(1);
    });
    expect(hoisted.ref.startCalls.length).toBe(1);
    expect(hoisted.ref.streamCalls[0]?.conversationId).toBe(9001);
    expect(hoisted.ref.streamCalls[0]?.body.expected_version).toBe(1);
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(within(nav).getAllByRole('listitem').length).toBe(3);
    expect(
      within(nav).getByRole('button', { name: /일상 대화 · 5\/29/ }),
    ).toBeInTheDocument();
  });

  it('No dismisses the popup, keeps the composer empty, and shows the generic opener', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat(buildChatOpenState(PAGE_CTX));

    await user.click(
      screen.getByRole('button', { name: /No, start fresh/ }),
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Reply input').value,
    ).toBe('');
    expect(screen.getByText(ASK_OPENER_RE)).toBeInTheDocument();
    // The default remote-work greeting does NOT render on a FAB entry.
    expect(screen.queryByText(OPENER_RE)).not.toBeInTheDocument();
  });

  it('Escape closes the popup as No (useModalA11y contract)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat(buildChatOpenState(PAGE_CTX));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Reply input').value,
    ).toBe('');
    expect(screen.getByText(ASK_OPENER_RE)).toBeInTheDocument();
  });

  it('arms the focus trap + initial focus only when the popup actually mounts — async list load (B-1)', async () => {
    resetState();
    // PROD SHAPE: the conversation-list fetch is ASYNC, so the FIRST render
    // of every FAB entry is the loading skeleton — the popup is NOT in the
    // DOM yet. A synchronous `kind: 'data'` mock hides exactly this (the
    // hook's container-reading effects would arm in the same commit the
    // popup mounts), so this test drives loading → data explicitly.
    hoisted.ref.endpoint = { kind: 'loading', data: null };
    // Fresh element per render pass — reusing the SAME element object would
    // let React bail out on reference equality and never re-read the
    // endpoint mock.
    const makeUi = (): JSX.Element => (
      <MemoryRouter
        initialEntries={[
          { pathname: '/chat', state: buildChatOpenState(PAGE_CTX) },
        ]}
      >
        <ToastProvider>
          <Chat />
        </ToastProvider>
      </MemoryRouter>
    );
    const { rerender } = render(makeUi());

    // During the load: no dialog, and — the B-1 leak — NO body scroll lock
    // (the old unconditional hook locked scroll under the skeleton with no
    // dialog anywhere to release it).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');

    // The list resolves → the loaded layout mounts WITH the popup, and the
    // modal a11y arms NOW (the `open` flag flips, re-running the effects
    // against the mounted container).
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    rerender(makeUi());
    const dialog = screen.getByRole('dialog');
    expect(document.body.style.overflow).toBe('hidden');

    // Initial focus landed INSIDE the dialog (first focusable = Yes).
    const yes = within(dialog).getByRole('button', { name: /Yes, use it/ });
    const no = within(dialog).getByRole('button', { name: /No, start fresh/ });
    await waitFor(() => {
      expect(yes).toHaveFocus();
    });

    // The Tab trap armed too: Tab from the last focusable wraps to the
    // first, Shift+Tab from the first wraps back — focus cannot escape.
    no.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(yes).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(no).toHaveFocus();

    // Dismissing releases the scroll lock.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('never locks body scroll on the list-error screen — the popup cannot mount there (B-1)', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'loading', data: null };
    // Fresh element per render pass (see the async-load test above).
    const makeUi = (): JSX.Element => (
      <MemoryRouter
        initialEntries={[
          { pathname: '/chat', state: buildChatOpenState(PAGE_CTX) },
        ]}
      >
        <ToastProvider>
          <Chat />
        </ToastProvider>
      </MemoryRouter>
    );
    const { rerender } = render(makeUi());
    expect(document.body.style.overflow).not.toBe('hidden');

    // The list load FAILS (no data, no mock fallback) → the error branch.
    // The popup never mounts, so the scroll lock must never engage — the
    // old unconditional hook locked it indefinitely here (only Esc or a
    // full unmount could release it).
    hoisted.ref.endpoint = { kind: 'data', data: null };
    rerender(makeUi());

    expect(
      screen.getByText("The conversation couldn't be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('renders a backdrop behind the popup — clicking it answers No (background not interactive)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat(buildChatOpenState(PAGE_CTX));

    // The dialog claims aria-modal="true"; a viewport-covering scrim backs
    // that claim for pointer users — the sidebar/thread behind it is not
    // clickable while the offer is up.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const backdrop = screen.getByTestId('chat-askpop-backdrop');
    expect(backdrop).toBeInTheDocument();

    // Scrim click = No: popup + scrim unmount, the composer stays empty,
    // the generic opener renders, and nothing was started or sent.
    await user.click(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('chat-askpop-backdrop'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Reply input').value,
    ).toBe('');
    expect(screen.getByText(ASK_OPENER_RE)).toBeInTheDocument();
    expect(hoisted.ref.startCalls.length).toBe(0);
    expect(hoisted.ref.streamCalls.length).toBe(0);
  });

  it('Yes never clobbers text already in the composer (seed fills an empty composer only)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat(buildChatOpenState(PAGE_CTX));

    // Pre-existing composer text. Driven via a direct change event — the
    // backdrop blocks the pointer path in prod, but the Yes-branch guard
    // (`prev.trim() === '' ? seed : prev`) must hold regardless of how the
    // text got there.
    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    fireEvent.change(input, { target: { value: '미리 쓴 답장' } });

    await user.click(screen.getByRole('button', { name: /Yes, use it/ }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(input.value).toBe('미리 쓴 답장');
    expect(input.value).not.toContain('Today · 오늘');
    // Still pre-fill-only semantics: nothing auto-sent either way.
    expect(hoisted.ref.streamCalls.length).toBe(0);
  });

  it('skips the popup entirely when the FAB carried no context', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat(buildChatOpenState(null));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Straight to the generic opener on the pending-'new' thread; the
    // existing conversations were neither resumed nor fetched.
    expect(screen.getByText(ASK_OPENER_RE)).toBeInTheDocument();
    expect(hoisted.ref.getCalls.length).toBe(0);
    // Prior conversations remain listed.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(within(nav).getAllByRole('listitem').length).toBe(2);
  });

  it('a malformed context in forged history state degrades to the no-popup flow', () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/chat',
            state: { kmChatOpen: true, context: { pageLabel: 42 } },
          },
        ]}
      >
        <ToastProvider>
          <Chat />
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(ASK_OPENER_RE)).toBeInTheDocument();
  });

  it('clears the open request from history state after consuming it', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat(buildChatOpenState(PAGE_CTX));

    await waitFor(() => {
      expect(screen.getByTestId('location-state')).toHaveTextContent('empty');
    });
    // The popup survived the state-clearing re-render (captured at mount).
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a plain navigation (no open request) keeps resuming the latest conversation', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();

    // Unchanged Slice-2 behavior: newest row auto-active, history fetched,
    // default greeting on its empty thread — and no popup.
    expect(await screen.findByText(OPENER_RE)).toBeInTheDocument();
    expect(hoisted.ref.getCalls[0]?.id).toBe(42);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(ASK_OPENER_RE)).not.toBeInTheDocument();
  });
});

// ── "+" attach menu — Camera / Upload image / Upload document (F-035) ───
describe('Chat attach menu (F-035)', () => {
  it('opens on click, closes on Escape, and returns focus to the trigger', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    const trigger = screen.getByRole('button', { name: 'Attach' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Attach' })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /Camera/ }),
    ).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes when clicking outside the menu (no item picked)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await user.click(screen.getByRole('button', { name: 'Attach' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('lists Camera, Upload image, and Upload document as menu items', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await user.click(screen.getByRole('button', { name: 'Attach' }));
    const menu = screen.getByRole('menu', { name: 'Attach' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.length).toBe(3);
    expect(within(menu).getByRole('menuitem', { name: /Camera/ })).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: /Upload image/ }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: /Upload document/ }),
    ).toBeInTheDocument();
  });
});

// ── Image-in-chat (Slice 3, now behind the "+" menu — F-035) ─────────────
describe('Chat image upload (Slice 3 + F-035 menu)', () => {
  function makeImageFile(
    name = 'menu.jpg',
    type = 'image/jpeg',
    size?: number,
  ): File {
    const file = new File(['x'], name, { type });
    if (size !== undefined) {
      Object.defineProperty(file, 'size', { value: size });
    }
    return file;
  }

  /** Open the "+" menu, click "Upload image", then fire the picked file
   *  straight into the hidden input the item proxies. */
  async function pickImageViaMenu(
    user: ReturnType<typeof userEvent.setup>,
    file: File,
  ): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Attach' }));
    await user.click(screen.getByRole('menuitem', { name: /Upload image/ }));
    const input = screen.getByTestId<HTMLInputElement>('chat-image-input');
    fireEvent.change(input, { target: { files: [file] } });
  }

  /** Same, via the Camera menu item / hidden input — proves camera and
   *  image share the same upload flow (uploadImageFile). */
  async function pickImageViaCamera(
    user: ReturnType<typeof userEvent.setup>,
    file: File,
  ): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Attach' }));
    await user.click(screen.getByRole('menuitem', { name: /Camera/ }));
    const input = screen.getByTestId<HTMLInputElement>('chat-camera-input');
    fireEvent.change(input, { target: { files: [file] } });
  }

  /** Oversize/unsupported pre-check rejections fire before any menu
   *  interaction matters — go straight at the hidden input like before. */
  function pickFileDirect(file: File): void {
    const input = screen.getByTestId<HTMLInputElement>('chat-image-input');
    fireEvent.change(input, { target: { files: [file] } });
  }

  const IMAGE_TURN: StoredConversationTurn = {
    role: 'user',
    content: '아메리카노 4,500원',
    sent_at: '2026-07-07T12:00:00Z',
    image: {
      capture_id: 7,
      blob_url: '/images/7/blob',
      caption_kr: '아메리카노 4,500원',
      caption_en: 'Americano 4,500 won',
    },
  };

  it('uploads onto the active conversation and renders the OCR turn (image + Korean + caption)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE); // conversation 42 loaded, version 5

    await pickImageViaMenu(user, makeImageFile());

    // The service got the ACTIVE conversation + the history-loaded version.
    await waitFor(() => {
      expect(hoisted.ref.uploadCalls.length).toBe(1);
    });
    const call = hoisted.ref.uploadCalls[0];
    if (!call) throw new Error('no captured upload call');
    expect(call.conversationId).toBe(42);
    expect(call.expectedVersion).toBe(5);
    expect(call.file.name).toBe('menu.jpg');

    // In-flight affordances: busy trigger + status line.
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
    expect(screen.getByText(/Uploading/)).toBeInTheDocument();

    await act(async () => {
      call.resolve({ version: 6, messages: [], turn: IMAGE_TURN });
    });

    // The OCR'd turn renders: photo + Korean text; the English caption
    // follows the English toggle (on by default here). The image is
    // decorative for AT (its OCR'd text below is the content) — tests key
    // off the testid.
    const img = within(thread()).getByTestId('chat-bubble-image');
    expect(img).toHaveAttribute('src', '/images/7/blob');
    expect(
      within(thread()).getByText('아메리카노 4,500원'),
    ).toBeInTheDocument();
    expect(
      within(thread()).getByText('Americano 4,500 won'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach' })).not.toBeDisabled();

    // The version advanced to the server's post-append value: the next
    // send must ride version 6, not the stale 5.
    await user.type(screen.getByLabelText('Reply input'), '이게 무슨 뜻이에요?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(hoisted.ref.streamCalls[0]?.body.expected_version).toBe(6);
  });

  it('the Camera menu item drives the SAME upload flow via its own hidden input', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await pickImageViaCamera(user, makeImageFile('capture.jpg'));

    await waitFor(() => {
      expect(hoisted.ref.uploadCalls.length).toBe(1);
    });
    expect(hoisted.ref.uploadCalls[0]?.file.name).toBe('capture.jpg');
    expect(hoisted.ref.uploadCalls[0]?.conversationId).toBe(42);
  });

  it('renders image turns from a loaded history (persistence round-trip)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.detailMessages[42] = [
      IMAGE_TURN,
      turn('assistant', '메뉴판이네요!'),
    ];
    renderChat();

    const img = await within(thread()).findByTestId('chat-bubble-image');
    expect(img).toHaveAttribute('src', '/images/7/blob');
    expect(
      within(thread()).getByText('메뉴판이네요!'),
    ).toBeInTheDocument();
  });

  it('shows the FIXED daily-cap copy on a 429 — never the server prose', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await pickImageViaMenu(user, makeImageFile());
    await waitFor(() => {
      expect(hoisted.ref.uploadCalls.length).toBe(1);
    });

    await act(async () => {
      hoisted.ref.uploadCalls[0]?.reject(
        new ApiError('vision_daily_cap_exceeded: user 3 spent $1.02', {
          status: 429,
          code: 'daily_cap_exceeded',
        }),
      );
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      "You've hit today's image limit. Try again tomorrow.",
    );
    expect(alert).not.toHaveTextContent('vision_daily_cap_exceeded');
    // The failed upload appended nothing.
    expect(
      within(thread()).queryByTestId('chat-bubble-image'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach' })).not.toBeDisabled();
  });

  it('rejects an oversize file client-side with the shared fixed copy (no request)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();
    await screen.findByText(OPENER_RE);

    pickFileDirect(makeImageFile('big.jpg', 'image/jpeg', 9 * 1024 * 1024));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That image is too large. Pick one under 8 MB.',
    );
    expect(hoisted.ref.uploadCalls.length).toBe(0);
  });

  it('rejects a non-image file client-side with the shared fixed copy (no request)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();
    await screen.findByText(OPENER_RE);

    pickFileDirect(makeImageFile('doc.pdf', 'application/pdf'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That file isn’t a supported image. Use a JPEG, PNG, or WebP.',
    );
    expect(hoisted.ref.uploadCalls.length).toBe(0);
  });

  it('aborts the in-flight upload on unmount and a late resolve never paints', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const { unmount } = renderChat();
    await screen.findByText(OPENER_RE);

    pickFileDirect(makeImageFile());
    await waitFor(() => {
      expect(hoisted.ref.uploadCalls.length).toBe(1);
    });
    const call = hoisted.ref.uploadCalls[0];
    if (!call) throw new Error('no captured upload call');
    expect(call.signal?.aborted).toBe(false);

    unmount();
    expect(call.signal?.aborted).toBe(true);

    // A late settle against the dead tree is a total no-op.
    await act(async () => {
      call.resolve({ version: 6, messages: [], turn: IMAGE_TURN });
    });
  });

  it('aborts the in-flight upload when switching conversations — the OCR turn never lands in the other thread', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.detailMessages[11] = [turn('assistant', '다른 대화')];
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    pickFileDirect(makeImageFile());
    await waitFor(() => {
      expect(hoisted.ref.uploadCalls.length).toBe(1);
    });
    const call = hoisted.ref.uploadCalls[0];
    if (!call) throw new Error('no captured upload call');

    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    await user.click(
      within(nav).getByRole('button', { name: /일상 대화 · 5\/20/ }),
    );
    expect(call.signal?.aborted).toBe(true);

    await within(thread()).findByText('다른 대화');
    await act(async () => {
      call.resolve({ version: 6, messages: [], turn: IMAGE_TURN });
    });
    expect(
      within(thread()).queryByTestId('chat-bubble-image'),
    ).not.toBeInTheDocument();
    expect(
      within(thread()).queryByText('아메리카노 4,500원'),
    ).not.toBeInTheDocument();
  });

  it('a 409 (stale version) shows fixed copy and refetches the thread for the fresh version', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);
    expect(hoisted.ref.getCalls.length).toBe(1);

    pickFileDirect(makeImageFile());
    await waitFor(() => {
      expect(hoisted.ref.uploadCalls.length).toBe(1);
    });
    // The server has since moved the row to version 7 — the refetch the
    // 409 triggers must observe it (set BEFORE rejecting: the auto-detail
    // mock resolves synchronously at call time).
    hoisted.ref.detailVersions[42] = 7;
    await act(async () => {
      hoisted.ref.uploadCalls[0]?.reject(
        new ApiError('version conflict: expected 5, row at 7', {
          status: 409,
          code: 'version_conflict',
        }),
      );
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This conversation changed — reloading it. Try again.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'version conflict',
    );
    // The loaded-thread cache was invalidated → a fresh history fetch for
    // the SAME conversation refreshes the version before the user retries.
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(2);
    });
    expect(hoisted.ref.getCalls[1]?.id).toBe(42);
    // A follow-up send rides the refetched version.
    await screen.findByText(OPENER_RE);
    await user.type(screen.getByLabelText('Reply input'), '다시');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(hoisted.ref.streamCalls[0]?.body.expected_version).toBe(7);
  });

  it('Send is disabled and Enter no-ops while an upload is in flight (SF-1)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE); // conversation 42 loaded, version 5

    const input = screen.getByLabelText<HTMLTextAreaElement>('Reply input');
    await user.type(input, '업로드 중에 보내기');
    pickFileDirect(makeImageFile());
    await waitFor(() => {
      expect(hoisted.ref.uploadCalls.length).toBe(1);
    });
    const call = hoisted.ref.uploadCalls[0];
    if (!call) throw new Error('no captured upload call');

    // Symmetric with the camera button's `streaming` gate: a text send now
    // would carry the SAME expected_version (5) as the in-flight upload,
    // guaranteeing a server 409 on one side. The button is disabled…
    const sendBtn = screen.getByRole('button', { name: 'Send' });
    expect(sendBtn).toBeDisabled();
    // …and the Enter-to-send path (which bypasses the button) no-ops too,
    // keeping the typed text intact.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(hoisted.ref.streamCalls.length).toBe(0);
    expect(input.value).toBe('업로드 중에 보내기');

    // Once the upload settles, Send re-enables and the message rides the
    // POST-append version (6) — no conflict, nothing lost.
    await act(async () => {
      call.resolve({ version: 6, messages: [], turn: IMAGE_TURN });
    });
    expect(sendBtn).not.toBeDisabled();
    await user.click(sendBtn);
    await waitFor(() => {
      expect(hoisted.ref.streamCalls.length).toBe(1);
    });
    expect(hoisted.ref.streamCalls[0]?.body.expected_version).toBe(6);
  });
});

// ── Document attach (F-035 backend wiring) ────────────────────────────────
describe('Chat document attach (F-035)', () => {
  function makeDocFile(
    name = 'notes.txt',
    type = 'text/plain',
    size?: number,
  ): File {
    const file = new File(['하나 둘 셋'], name, { type });
    if (size !== undefined) {
      Object.defineProperty(file, 'size', { value: size });
    }
    return file;
  }

  const FILE_TURN: StoredConversationTurn = {
    role: 'user',
    content: '하나 둘 셋 넷 다섯',
    sent_at: '2026-07-07T12:00:00Z',
    file: {
      name: 'notes.txt',
      media_type: 'text/plain',
      size_bytes: 42,
      truncated: false,
    },
  };

  async function pickDocViaMenu(
    user: ReturnType<typeof userEvent.setup>,
    file: File,
  ): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Attach' }));
    await user.click(
      screen.getByRole('menuitem', { name: /Upload document/ }),
    );
    const input = screen.getByTestId<HTMLInputElement>('chat-file-input');
    fireEvent.change(input, { target: { files: [file] } });
  }

  it('uploads a document and renders its file chip + text in the thread', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE); // conversation 42 loaded, version 5

    await pickDocViaMenu(user, makeDocFile());
    await waitFor(() => {
      expect(hoisted.ref.fileUploadCalls.length).toBe(1);
    });
    const call = hoisted.ref.fileUploadCalls[0];
    if (!call) throw new Error('no captured file upload call');
    expect(call.conversationId).toBe(42);
    expect(call.expectedVersion).toBe(5);
    expect(call.file.name).toBe('notes.txt');

    await act(async () => {
      call.resolve({ version: 6, messages: [], turn: FILE_TURN });
    });

    expect(
      within(thread()).getByTestId('chat-bubble-file'),
    ).toHaveTextContent('notes.txt');
    expect(
      within(thread()).getByText('하나 둘 셋 넷 다섯'),
    ).toBeInTheDocument();

    // The version advanced — the next send rides it.
    await user.type(screen.getByLabelText('Reply input'), '이 문서 요약해줘');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(hoisted.ref.streamCalls[0]?.body.expected_version).toBe(6);
  });

  it('rejects an oversize document client-side with fixed copy (no request)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await pickDocViaMenu(user, makeDocFile('big.txt', 'text/plain', 300 * 1024));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That file is too large. Pick one under 256 KB.',
    );
    expect(hoisted.ref.fileUploadCalls.length).toBe(0);
  });

  it('rejects an unsupported declared mime client-side with fixed copy (no request)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await pickDocViaMenu(user, makeDocFile('sheet.csv', 'text/csv'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      "That file couldn't be attached. Use a plain text (.txt or .md) file under 256 KB.",
    );
    expect(hoisted.ref.fileUploadCalls.length).toBe(0);
  });

  it('a 409 (stale version) shows the shared attachment-conflict copy and refetches the thread', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);
    expect(hoisted.ref.getCalls.length).toBe(1);

    await pickDocViaMenu(user, makeDocFile());
    await waitFor(() => {
      expect(hoisted.ref.fileUploadCalls.length).toBe(1);
    });
    hoisted.ref.detailVersions[42] = 9;
    await act(async () => {
      hoisted.ref.fileUploadCalls[0]?.reject(
        new ApiError('version conflict: expected 5, row at 9', {
          status: 409,
          code: 'version_conflict',
        }),
      );
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This conversation changed — reloading it. Try again.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'version conflict',
    );
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(2);
    });
    expect(hoisted.ref.getCalls[1]?.id).toBe(42);
  });

  it('aborts the in-flight document upload on unmount', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    const { unmount } = renderChat();
    await screen.findByText(OPENER_RE);

    await pickDocViaMenu(user, makeDocFile());
    await waitFor(() => {
      expect(hoisted.ref.fileUploadCalls.length).toBe(1);
    });
    const call = hoisted.ref.fileUploadCalls[0];
    if (!call) throw new Error('no captured file upload call');
    expect(call.signal?.aborted).toBe(false);

    unmount();
    expect(call.signal?.aborted).toBe(true);
  });

  it('an image upload and a document upload share the `uploading` gate (mutually exclusive)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await pickDocViaMenu(user, makeDocFile());
    await waitFor(() => {
      expect(hoisted.ref.fileUploadCalls.length).toBe(1);
    });
    // The "+" trigger is disabled while ANY attachment upload is in flight —
    // a second attach attempt (image or document) cannot race the first.
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
  });
});

// ── Auto-naming (F-036) ───────────────────────────────────────────────────
describe('Chat auto-naming (F-036)', () => {
  /** Fire a send and settle its stream cleanly (onDone + resolve). */
  async function sendAndFinish(
    user: ReturnType<typeof userEvent.setup>,
    text: string,
    callIndex: number,
  ): Promise<void> {
    await user.type(screen.getByLabelText('Reply input'), text);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(hoisted.ref.streamCalls.length).toBe(callIndex + 1);
    });
    const call = hoisted.ref.streamCalls[callIndex];
    if (!call) throw new Error('no captured stream call');
    await act(async () => {
      call.onDone?.();
      call.resolve();
      await call.promise;
    });
  }

  it('triggers nameConversation once the first turn completes, and renders the resolved title in the sidebar', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.autoName = false;
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await sendAndFinish(user, '안녕하세요', 0);

    await waitFor(() => {
      expect(hoisted.ref.nameCalls.length).toBe(1);
    });
    expect(hoisted.ref.nameCalls[0]?.conversationId).toBe(42);

    await act(async () => {
      hoisted.ref.nameCalls[0]?.resolve({
        title: '재택근무 논의',
        generated: true,
      });
    });

    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(
      within(nav).getByRole('button', { name: /재택근무 논의/ }),
    ).toBeInTheDocument();
  });

  it('does not re-call nameConversation for the same conversation after this session already succeeded', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    await sendAndFinish(user, '첫 메시지', 0);
    await waitFor(() => {
      expect(hoisted.ref.nameCalls.length).toBe(1);
    });

    await sendAndFinish(user, '두 번째 메시지', 1);

    // A second turn in the SAME conversation must not re-trigger naming —
    // the per-session latch already has a confirmed title.
    expect(hoisted.ref.nameCalls.length).toBe(1);
  });

  it('a real title on the loaded history (`conversation.title`) wins over the derived snippet', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.autoDetail = false;
    renderChat();

    // Conversation 42 auto-loads first; settle it by hand with a NAMED
    // detail (title set) whose first message is DIFFERENT text — proving
    // the confirmed title wins over the snippet it would otherwise derive.
    await waitFor(() => {
      expect(hoisted.ref.getCalls.length).toBe(1);
    });
    expect(hoisted.ref.getCalls[0]?.id).toBe(42);
    await act(async () => {
      hoisted.ref.getCalls[0]?.resolve(
        hoisted.makeDetail(
          42,
          [turn('user', '문법 질문이 있어요')],
          5,
          '문법 도움',
        ),
      );
    });

    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(
      within(nav).getByRole('button', { name: /문법 도움/ }),
    ).toBeInTheDocument();
    expect(
      within(nav).queryByRole('button', { name: /^문법 질문이 있어요/ }),
    ).not.toBeInTheDocument();
  });
});

// ── English toggle — visible label (B-020) ────────────────────────────────
describe('Chat English toggle label (B-020)', () => {
  it('renders a visible bilingual label naming the switch’s purpose', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    renderChat();
    await screen.findByText(OPENER_RE);

    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('영어')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Show English translations' }),
    ).toBeInTheDocument();
  });

  it('toggling off hides the English translation lines', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    expect(screen.getByText(/Today we'll discuss/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('switch', { name: 'Show English translations' }),
    );
    expect(
      screen.queryByText(/Today we'll discuss/),
    ).not.toBeInTheDocument();
  });
});
