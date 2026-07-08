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
  AppendMessageBody,
  ConversationDetailResult,
  ConversationsList,
  DefineResult,
  MineWordInput,
  MineWordResult,
  StoredConversationTurn,
} from '../types/domain';
import type { ChatSeedState } from '../lib/askSeed';
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
  interface CapturedDefineCall {
    word: string;
    signal: AbortSignal | undefined;
    /** Resolve the lookup from the test. */
    resolve: (result: DefineResult) => void;
    /** Reject the lookup from the test. */
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
  ): ConversationDetailResult => ({
    conversation: {
      id,
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
      defineCalls: [] as CapturedDefineCall[],
      mineCalls: [] as MineWordInput[],
      /** When set, the next (and every) mineWord call rejects with this. */
      mineRejectWith: null as Error | null,
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
}));

// ── services/define mock — controlled promise per lookup (F-016) ────────
vi.mock('../services/define', () => ({
  defineEntry: vi.fn(
    (word: string, signal?: AbortSignal): Promise<DefineResult> => {
      let resolveFn: (result: DefineResult) => void = () => undefined;
      let rejectFn: (err: Error) => void = () => undefined;
      const promise = new Promise<DefineResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      hoisted.ref.defineCalls.push({
        word,
        signal,
        resolve: resolveFn,
        reject: rejectFn,
      });
      return promise;
    },
  ),
}));

// ── services/vocab mock — Chat only imports mineWord (F-016 add-to-bank) ─
vi.mock('../services/vocab', () => ({
  mineWord: vi.fn(async (input: MineWordInput): Promise<MineWordResult> => {
    hoisted.ref.mineCalls.push(input);
    const rejection = hoisted.ref.mineRejectWith;
    if (rejection !== null) throw rejection;
    return { entryId: 1, card: { id: 1, version: 1 } };
  }),
}));

import { Chat } from './Chat';

/**
 * Chat reads `useLocation`/`useNavigate` (F-020 seeding), so every render
 * needs a router. `seedState`, when given, rides in as the `/chat` entry's
 * router state — exactly how `AskAboutThisButton` delivers it. Chat also
 * calls `useToast` (F-016 add-to-bank failure toast), so every render needs
 * a `ToastProvider` too.
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
  hoisted.ref.defineCalls = [];
  hoisted.ref.mineCalls = [];
  hoisted.ref.mineRejectWith = null;
  window.localStorage.clear();
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

// ── Dictionary lookup (F-016) ────────────────────────────────────────────
describe('Chat dictionary lookup (F-016)', () => {
  const ENTRY_RESULT: DefineResult = {
    word: '사전',
    entries: [
      {
        id: 77,
        headword: '사전',
        part_of_speech: 'noun',
        definition_korean: null,
        definition_english: 'dictionary',
        examples: [
          {
            korean: '사전을 찾아보세요.',
            english: 'Look it up in the dictionary.',
          },
        ],
      },
    ],
  };

  /** A second, distinguishable entry — lets races assert WHOSE result won. */
  const TREE_RESULT: DefineResult = {
    word: '나무',
    entries: [
      {
        id: 88,
        headword: '나무',
        part_of_speech: 'noun',
        definition_korean: null,
        definition_english: 'tree',
        examples: [],
      },
    ],
  };

  /**
   * Entry with NO English gloss — `buildWordPopover` fills the popover's
   * `en` with the app-wide `GLOSS_DICTIONARY_ENTRY` sentinel ('Dictionary
   * entry'). The bank payload must never persist that sentinel as the
   * word's English (B-002 SF-1 contract, Chat.tsx sentinel filter).
   */
  const SENTINEL_RESULT: DefineResult = {
    word: '사전',
    entries: [
      {
        id: 77,
        headword: '사전',
        part_of_speech: 'noun',
        definition_korean: null,
        definition_english: null,
        examples: [],
      },
    ],
  };

  /** Open the lookup field via the book toggle and type a word into it. */
  async function openDictAndType(
    user: ReturnType<typeof userEvent.setup>,
    word: string,
  ): Promise<void> {
    await user.click(
      screen.getByRole('button', { name: 'Dictionary lookup' }),
    );
    await user.type(screen.getByLabelText('Dictionary word'), word);
  }

  it('looks up a word — calls defineEntry and renders the popover with headword + gloss', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));

    // The service was called with the trimmed word…
    expect(hoisted.ref.defineCalls.length).toBe(1);
    expect(hoisted.ref.defineCalls[0]?.word).toBe('사전');
    // …and the popover opened immediately in its loading state.
    expect(screen.getByTestId('word-popover-loading')).toBeInTheDocument();

    await act(async () => {
      hoisted.ref.defineCalls[0]?.resolve(ENTRY_RESULT);
    });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('사전')).toBeInTheDocument();
    expect(within(dialog).getByText('dictionary')).toBeInTheDocument();
    expect(within(dialog).getByText('noun')).toBeInTheDocument();
    expect(within(dialog).getByText('사전을 찾아보세요.')).toBeInTheDocument();
    // Loading stub gone once resolved.
    expect(
      screen.queryByTestId('word-popover-loading'),
    ).not.toBeInTheDocument();
  });

  it('Enter in the lookup field submits the lookup', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.keyboard('{Enter}');

    expect(hoisted.ref.defineCalls.length).toBe(1);
    expect(hoisted.ref.defineCalls[0]?.word).toBe('사전');
  });

  it('Enter during an in-flight lookup is a no-op — matches the disabled button', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.keyboard('{Enter}');
    expect(hoisted.ref.defineCalls.length).toBe(1);

    // The lookup is still pending (dictLoading true — the search button is
    // disabled). Enter must obey the same gate: no abort-and-refire behind
    // a visibly disabled affordance. fireEvent targets the input directly
    // because the loading popover has moved focus to its Close button.
    fireEvent.keyDown(screen.getByLabelText('Dictionary word'), {
      key: 'Enter',
    });

    // No second lookup fired AND the first was not aborted-and-restarted.
    expect(hoisted.ref.defineCalls.length).toBe(1);
    expect(hoisted.ref.defineCalls[0]?.signal?.aborted).toBe(false);
  });

  it('shows the friendly no-entry notice when the lookup matches nothing', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '없는말');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[0]?.resolve({ word: '없는말', entries: [] });
    });

    // No dialog, no crash — a fixed friendly line under the field instead.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'No dictionary entry found for that word.',
    );
  });

  it('shows fixed error copy on krdict_unavailable — never the server prose', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[0]?.reject(
        new ApiError('KRDICT tables missing in this deploy', {
          status: 503,
          code: 'krdict_unavailable',
        }),
      );
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'The dictionary is unavailable right now. Try again later.',
    );
    expect(alert).not.toHaveTextContent('KRDICT tables missing');
  });

  it('shows the shared fixed network copy on a network failure', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[0]?.reject(
        new ApiError('connect ECONNREFUSED 127.0.0.1:3000', {
          status: 0,
          code: 'network',
        }),
      );
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Network unreachable. Check your connection and try again.',
    );
    expect(alert).not.toHaveTextContent('ECONNREFUSED');
  });

  it('empty / whitespace input is a no-op', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await user.click(
      screen.getByRole('button', { name: 'Dictionary lookup' }),
    );
    const lookupBtn = screen.getByRole('button', { name: 'Look up word' });
    expect(lookupBtn).toBeDisabled();

    await user.type(screen.getByLabelText('Dictionary word'), '   ');
    expect(lookupBtn).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(hoisted.ref.defineCalls.length).toBe(0);
  });

  it('aborts an in-flight lookup on unmount', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    const { unmount } = renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));

    const call = hoisted.ref.defineCalls[0];
    if (!call) throw new Error('no captured define call');
    expect(call.signal?.aborted).toBe(false);

    unmount();
    expect(call.signal?.aborted).toBe(true);
  });

  it('closing the popover aborts the pending lookup', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));

    // Loading stub is a dialog with a Close button.
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(hoisted.ref.defineCalls[0]?.signal?.aborted).toBe(true);
  });

  it('ignores a lookup result that lands AFTER the popover was closed (SF-1)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));

    // Close while the lookup is still pending — this aborts the controller.
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(hoisted.ref.defineCalls[0]?.signal?.aborted).toBe(true);

    // The mocked promise now resolves LATE, with a full entry. Without the
    // `ctrl.signal.aborted` guard on the success continuation this would
    // repaint the popover the user just dismissed.
    await act(async () => {
      hoisted.ref.defineCalls[0]?.resolve(ENTRY_RESULT);
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('word-popover-loading'),
    ).not.toBeInTheDocument();
    // And no stray notice either — the late result must be a total no-op.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays silent when a lookup FAILS after the popover was closed (SF-1)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(hoisted.ref.defineCalls[0]?.signal?.aborted).toBe(true);

    // Late REJECTION (a real network error, not axios's ERR_CANCELED — so
    // the aborted-guard on the error continuation is the only defense).
    await act(async () => {
      hoisted.ref.defineCalls[0]?.reject(
        new ApiError('connect ECONNREFUSED 127.0.0.1:3000', {
          status: 0,
          code: 'network',
        }),
      );
    });

    // No error notice for a lookup the user already walked away from.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('ECONNREFUSED');
  });

  it('a lookup that settles after unmount neither throws nor warns (SF-1)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const { unmount } = renderChat();

      await openDictAndType(user, '사전');
      await user.click(screen.getByRole('button', { name: 'Look up word' }));

      unmount();
      expect(hoisted.ref.defineCalls[0]?.signal?.aborted).toBe(true);

      // Late resolution against a dead tree — must be swallowed by the
      // aborted-guard, producing no state update, no throw, no warning.
      await act(async () => {
        hoisted.ref.defineCalls[0]?.resolve(ENTRY_RESULT);
      });

      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a newer lookup aborts the prior controller — only the newest result renders (SF-2)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    // Lookup A resolves and paints its popover. Its controller stays in the
    // ref, un-aborted.
    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[0]?.resolve(ENTRY_RESULT);
    });
    expect(
      within(screen.getByRole('dialog')).getByText('dictionary'),
    ).toBeInTheDocument();

    // Lookup B fires. The FIRST thing lookupWord does is abort the prior
    // controller — remove that line and A's signal stays un-aborted.
    const input = screen.getByLabelText('Dictionary word');
    await user.clear(input);
    await user.type(input, '나무');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));

    expect(hoisted.ref.defineCalls.length).toBe(2);
    expect(hoisted.ref.defineCalls[0]?.signal?.aborted).toBe(true);
    expect(hoisted.ref.defineCalls[1]?.signal?.aborted).toBe(false);

    // Only B's result paints; A's content is gone.
    await act(async () => {
      hoisted.ref.defineCalls[1]?.resolve(TREE_RESULT);
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('나무')).toBeInTheDocument();
    expect(within(dialog).getByText('tree')).toBeInTheDocument();
    expect(within(dialog).queryByText('dictionary')).not.toBeInTheDocument();
  });

  it('Add to bank mines the looked-up word with its KRDICT entry id', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[0]?.resolve(ENTRY_RESULT);
    });

    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: /Add to vocab/ }),
    );

    await waitFor(() => {
      expect(hoisted.ref.mineCalls.length).toBe(1);
    });
    expect(hoisted.ref.mineCalls[0]).toEqual({
      lemma: '사전',
      english: 'dictionary',
      pos: 'noun',
      krdictEntryId: 77,
    });
    // Button locked to its added state.
    expect(
      within(dialog).getByRole('button', { name: /Added to vocab/ }),
    ).toBeInTheDocument();
  });

  it('rolls back the optimistic flip, toasts fixed copy, and unlocks the button when the bank fails (SF-3)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    hoisted.ref.mineRejectWith = new ApiError(
      'duplicate key value violates unique constraint "vocab_entries_pkey"',
      { status: 500, code: 'server_error' },
    );
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[0]?.resolve(ENTRY_RESULT);
    });

    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: /Add to vocab/ }),
    );

    // Fixed-copy toast — never the server prose riding on the error.
    expect(
      await screen.findByText(/Couldn't bank — try again/i),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('duplicate key');

    // The re-throw reached WordPopover: its "Added" lock rolled back so the
    // user can retry. Remove the re-throw and the button stays locked.
    await waitFor(() => {
      expect(
        within(dialog).getByRole('button', { name: /Add to vocab/ }),
      ).toBeInTheDocument();
    });
    expect(
      within(dialog).queryByRole('button', { name: /Added to vocab/ }),
    ).not.toBeInTheDocument();

    // The optimistic dictMined flip rolled back too: a re-lookup of the
    // same word must NOT claim it was banked. Remove the rollback block in
    // handleDictAdd and this pill appears.
    hoisted.ref.mineRejectWith = null;
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[1]?.resolve(ENTRY_RESULT);
    });
    const dialog2 = screen.getByRole('dialog');
    expect(
      within(dialog2).queryByText('already banked'),
    ).not.toBeInTheDocument();
  });

  it('never persists a sentinel gloss as the banked English (SF-3)', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();

    await openDictAndType(user, '사전');
    await user.click(screen.getByRole('button', { name: 'Look up word' }));
    await act(async () => {
      hoisted.ref.defineCalls[0]?.resolve(SENTINEL_RESULT);
    });

    // The popover shows the sentinel (a real entry with no English gloss).
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Dictionary entry')).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: /Add to vocab/ }),
    );
    await waitFor(() => {
      expect(hoisted.ref.mineCalls.length).toBe(1);
    });

    // `english` is omitted entirely — the sentinel filter in handleDictAdd
    // must strip both GLOSS_DICTIONARY_ENTRY and GLOSS_UNAVAILABLE.
    expect(hoisted.ref.mineCalls[0]).toEqual({
      lemma: '사전',
      pos: 'noun',
      krdictEntryId: 77,
    });
    expect(hoisted.ref.mineCalls[0]).not.toHaveProperty('english');
  });

  it('leaves the send flow untouched — composer send still streams', async () => {
    resetState();
    hoisted.ref.endpoint = { kind: 'data', data: LIST };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText(OPENER_RE);

    // Open the dictionary field, then use the normal composer anyway.
    await user.click(
      screen.getByRole('button', { name: 'Dictionary lookup' }),
    );
    await user.type(screen.getByLabelText('Reply input'), '감사합니다');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(hoisted.ref.streamCalls.length).toBe(1);
    expect(hoisted.ref.streamCalls[0]?.body.content).toBe('감사합니다');
    // The dictionary lookup never fired.
    expect(hoisted.ref.defineCalls.length).toBe(0);
  });
});
