/**
 * Chat (Conversation) screen — tutor-vs-user message thread with real
 * streaming wired in.
 *
 * Layout (per design README §9):
 *   1. Topbar: "Tutor conversation" eyebrow + 대화 · Chat serif title.
 *   2. Message list — tutor left, user right; tutor in 합쇼체 (formal).
 *   3. Composer: textarea + Send + "Show hints" Toggle. When hints on,
 *      common reply starters appear under the composer.
 *
 * Wiring (Pass 3):
 *   - History: `services.conversation.listConversations()` via
 *     `useEndpointOrMock('chat:list', …, { realFn })`. Pick most-recent
 *     active conversation as the in-app thread anchor; if none, lazily
 *     start one via `startConversation` on first user submit. The local
 *     fixture (`loadConversationMock`) only seeds the UI under the mock
 *     fallback — the personalised opener still wins on the first paint
 *     (Pass 2 `seededRef` semantics preserved).
 *   - Send: optimistic user-bubble append, then
 *     `services.conversation.streamMessage(id, { content, expected_version },
 *     { signal, onDelta, onDone, onError, requestId })`. `onDelta` grows a
 *     partial tutor bubble, `onDone` finalises it, `onError` rolls the
 *     optimistic user-turn into a `failed → retry` chip and surfaces an
 *     inline error message under the composer.
 *
 * "Ask about this" seeding (F-020):
 *   A review surface (Mistakes / TOPIK mock / TOPIK study / Diagnostic) can
 *   navigate here with a `ChatSeedState` in router state. The seed text
 *   pre-fills the composer ONCE at mount (never auto-sent, never clobbers
 *   typed text — it's a lazy state initializer), its `mode` is preferred
 *   when THIS visit lazily starts the conversation, and the router state is
 *   then cleared so a reload / back-nav can't re-seed.
 *
 * Settings integration:
 *   First tutor message is personalised with `settings.name` when set
 *   (`안녕하세요, ${name}님. …`). Falls back to the fixture's generic greeting.
 *
 * Threat model (FU-NF-4 closeout):
 *   - **Streaming abort on unmount.** A controller per send is aborted when
 *     the screen unmounts or the user navigates away mid-stream. The server
 *     persists the assistant turn ONLY after the upstream stream completes
 *     (server SECURITY.md §10) — aborting mid-stream therefore guarantees
 *     no half-turn is committed. No dangling sockets either: `streamSse`
 *     cancels the reader on abort.
 *   - **Concurrent-send race.** Send is disabled while a stream is in-
 *     flight (`aria-busy="true"`), so the user cannot start a second
 *     overlapping stream in the same conversation. We never queue: the
 *     user re-submits after the current one settles. Prevents two parallel
 *     `expected_version` updates fighting over the same row.
 *   - **Network-flap retry via X-Request-Id.** Each send mints
 *     `crypto.randomUUID()` once. If the stream fails and the user clicks
 *     Retry on the failed turn, we reuse the SAME id, so the server
 *     short-circuits to the persisted reply (if one landed during the
 *     drop) rather than re-running Claude and double-billing. A fresh id
 *     is only minted for a NEW user turn.
 *   - **Optimistic-UI rollback on failure.** The optimistic user bubble is
 *     NOT removed on stream failure — it stays visible as a `failed →
 *     retry` row so the user can re-send without retyping. The partial
 *     tutor bubble is dropped (we have nothing usable to keep). Both rules
 *     guard against a UX that "loses" the user's typed text.
 *   - **XSS / template injection.** Message text, including streamed
 *     deltas, is rendered as React children — escaped. `settings.name` is
 *     interpolated into a Korean string template, also rendered as text.
 *     Never add `dangerouslySetInnerHTML` here.
 *   - **Conversation impersonation.** The conversation id comes from the
 *     server's `listConversations`, scoped server-side to the cookie's
 *     user. The client cannot forge a target.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { useSettings } from '../hooks/useSettings';
import { loadConversationMock } from '../data/mocks/chat';
import { readChatSeedState, type ChatSeedState } from '../lib/askSeed';
import * as conversationService from '../services/conversation';
import { ApiError } from '../services/api';
import type {
  Conversation,
  ConversationMessage,
  ConversationRow,
  ConversationsList,
} from '../types/domain';

/** Quick-reply starter strings shown under composer when hints are on. */
const HINT_STARTERS: ReadonlyArray<string> = [
  '제 생각에는',
  '예를 들어',
  '반면에',
  '그렇다면',
];

/** Default opener used until the personalised line lands or a server thread loads. */
const FALLBACK_OPENER: ConversationMessage = {
  role: 'tutor',
  kr: '안녕하십니까. 오늘은 재택근무의 장단점에 대해 이야기해 보겠습니다.',
  en: "Hello. Today we'll discuss the pros and cons of remote work.",
};

/** Server start mode — kept here (one screen, one mode) to avoid a config dep. */
const DEFAULT_START_MODE = 'casual' as const;

/** Skeleton placeholder during load. */
function SkeletonCard(): JSX.Element {
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: 220, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

/** Personalise the first tutor message with the user's name if set. */
function personalise(
  msgs: Conversation,
  name: string,
): Conversation {
  if (!name.trim()) return msgs;
  const first = msgs[0];
  if (!first || first.role !== 'tutor') return msgs;
  return [
    {
      ...first,
      kr: `안녕하세요, ${name}님. 오늘은 재택근무의 장단점에 대해 이야기해 보겠습니다.`,
      en: `Hello, ${name}. Today we'll discuss the pros and cons of remote work.`,
    },
    ...msgs.slice(1),
  ];
}

/**
 * Pick the most recent active conversation row from the listConversations
 * envelope. Null when the user has no conversations yet — Chat will lazy-
 * start one on the first send.
 */
function pickActiveConversation(
  list: ConversationsList | null,
): ConversationRow | null {
  if (!list || !Array.isArray(list.conversations)) return null;
  const rows = [...list.conversations];
  rows.sort((a, b) => {
    // ISO-8601 strings sort lexicographically same as chronologically.
    if (a.updated_at === b.updated_at) return 0;
    return a.updated_at < b.updated_at ? 1 : -1;
  });
  return rows[0] ?? null;
}

/**
 * Local thread row — extends a wire ConversationMessage with an optional
 * status so the UI can mark optimistic / streaming / failed turns without
 * mutating the canonical shape.
 */
interface ThreadRow extends ConversationMessage {
  status?: 'streaming' | 'failed';
  /** Set on user rows that hit a stream error — retry reuses this id. */
  failedRequestId?: string;
  /** Original content for failed user rows — retry reuses this verbatim. */
  failedContent?: string;
}

export function Chat(): JSX.Element {
  const { settings } = useSettings();
  const location = useLocation();
  const navigate = useNavigate();

  // ── "Ask about this" seed (F-020) ──────────────────────────────────
  // A review surface may navigate here with a `ChatSeedState` in router
  // state. It is captured ONCE via a lazy state initializer — the seed can
  // only ever apply at mount, so it can never clobber a conversation in
  // progress or text the user has since typed, and there is no set-state-
  // in-effect. The state is untrusted history state, so it is runtime-
  // narrowed (see askSeed.ts threat model).
  const [chatSeed] = useState<ChatSeedState | null>(() =>
    readChatSeedState(location.state),
  );

  // Real call: list the user's conversations. Mock fallback: load the
  // fixture as a stand-in "conversation" the screen still renders.
  const { data, loading, isMock, refetch } = useEndpointOrMock<
    ConversationsList | Conversation
  >('chat:list', loadConversationMock, {
    realFn: conversationService.listConversations,
  });

  // Disambiguate the real envelope from the mock fixture. `conversations`
  // is the unique discriminator on the wire envelope.
  const serverList = useMemo<ConversationsList | null>(() => {
    if (!data) return null;
    if (Array.isArray(data)) return null;
    if ('conversations' in data) return data;
    return null;
  }, [data]);
  const mockSeed = useMemo<Conversation>(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return [];
  }, [data]);

  const active = useMemo<ConversationRow | null>(
    () => pickActiveConversation(serverList),
    [serverList],
  );

  // Conversation id + version are what every send needs. We track them
  // mutably because a successful send bumps `version` server-side — we
  // pre-compute via `expected_version = current + 1` after stream `done`.
  // Lazy-start path also writes here on first send.
  const [conversationId, setConversationId] = useState<number | null>(null);
  const versionRef = useRef<number>(0);

  // Seed once — and only once — when fresh data arrives. The previous
  // shape re-ran `setMsgs(seed)` on every `seed` identity change, which
  // wiped user-sent turns whenever `settings.name` changed (the
  // personalised first message is recomputed → new identity → reset).
  // We track whether we've seeded yet with a ref so a settings.name
  // change while the thread is already populated only refreshes the
  // first message in place.
  const seed = useMemo<Conversation>(() => {
    // Real path: server gave us a conversation header but not full message
    // history — we open with the personalised opener until the user's first
    // send streams in a tutor reply. (Full history fetch lands in a later
    // pass; the contract for now is conversation-list + open with a
    // greeting.)
    if (active) {
      return personalise([FALLBACK_OPENER], settings.name);
    }
    if (mockSeed.length > 0) {
      return personalise(mockSeed, settings.name);
    }
    return [];
  }, [active, mockSeed, settings.name]);

  const [msgs, setMsgs] = useState<ThreadRow[]>([]);
  // Composer text — pre-filled from an "Ask about this" seed when one rode
  // in on the navigation (F-020). Pre-fill only: the user reviews and hits
  // Send themselves, nothing is auto-sent.
  const [input, setInput] = useState<string>(chatSeed?.seedText ?? '');
  const [hintsOn, setHintsOn] = useState<boolean>(true);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Sync the resolved active conversation id into local state. Done in an
  // effect to avoid a setState-during-render and to keep `versionRef` in
  // lockstep with the conversation we adopted.
  useEffect(() => {
    if (active) {
      setConversationId(active.id);
      versionRef.current = active.version;
    }
  }, [active]);

  // Clear the consumed seed out of router/history state so a reload or a
  // back-navigation to /chat never re-seeds the composer (F-020). Navigation
  // is a side effect (not a state set), and the ref-guard makes it fire at
  // most once even though the replace itself changes `location` identity.
  const seedClearedRef = useRef<boolean>(false);
  useEffect(() => {
    if (chatSeed === null || seedClearedRef.current) return;
    seedClearedRef.current = true;
    // Preserve search + hash: rebuilding the URL from the pathname alone
    // would silently strip any future query param (deep-linked conversation
    // id, ?mode=…) from a seeded arrival. Only the state is dropped.
    navigate(
      {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      { replace: true, state: null },
    );
  }, [chatSeed, navigate, location.pathname, location.search, location.hash]);

  const seededRef = useRef<boolean>(false);
  useEffect(() => {
    if (loading) return;
    if (!seededRef.current && seed.length > 0) {
      // First-paint seed — adopt the entire seed as the local thread.
      // Sync-to-external-system case (same shape as AuthProvider's probe
      // and Diagnostic's mode-init).
      setMsgs(seed);
      seededRef.current = true;
      return;
    }
    if (seededRef.current && seed.length > 0) {
      // Subsequent identity change (e.g. `settings.name` flipped). Only
      // refresh the first tutor message; preserve user-sent turns +
      // streamed tutor replies.
      setMsgs((prev) => {
        if (prev.length === 0) return seed;
        const head = seed[0];
        if (!head) return prev;
        const cur = prev[0];
        if (cur && cur.role === head.role && cur.kr === head.kr) return prev;
        return [head, ...prev.slice(1)];
      });
    }
  }, [seed, loading]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // ── In-flight send tracking ────────────────────────────────────────
  // One controller per send; cleared on settle. The unmount cleanup
  // aborts it so we never stream into a dead React tree.
  const sendCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      sendCtrlRef.current?.abort();
    };
  }, []);

  const retry = (): void => {
    seededRef.current = false;
    refetch();
  };

  /**
   * Ensure we have a server conversation id; lazy-start if none. An "Ask
   * about this" seed's mode (F-020, `topik_prep`) wins over the screen
   * default when it is this navigation that starts the conversation — an
   * already-active conversation keeps its own mode untouched.
   */
  const ensureConversationId = useCallback(async (): Promise<number> => {
    if (conversationId !== null) return conversationId;
    const started = await conversationService.startConversation({
      mode: chatSeed?.mode ?? DEFAULT_START_MODE,
    });
    setConversationId(started.conversation.id);
    versionRef.current = 1;
    return started.conversation.id;
  }, [conversationId, chatSeed]);

  /**
   * Drive one streaming send. Body and requestId are passed in so a Retry
   * can re-use the same id (idempotency) and re-use the same text without
   * re-typing.
   */
  const runStream = useCallback(
    async (params: {
      convId: number;
      content: string;
      requestId: string;
    }): Promise<void> => {
      const { convId, content, requestId } = params;

      // Insert (or upgrade) a streaming tutor placeholder. We track its
      // index implicitly via "the last row is the partial tutor" — every
      // setMsgs that touches it scans from the tail.
      setMsgs((prev) => [
        ...prev,
        { role: 'tutor', kr: '', en: '', status: 'streaming' },
      ]);
      setStreaming(true);
      setSendError(null);

      // Per-send controller. The unmount cleanup aborts whichever is
      // current at the time the screen tears down.
      const ctrl = new AbortController();
      sendCtrlRef.current = ctrl;

      try {
        await conversationService.streamMessage(
          convId,
          {
            content,
            expected_version: versionRef.current,
          },
          {
            signal: ctrl.signal,
            requestId,
            onDelta: (chunk: string): void => {
              setMsgs((prev) => {
                const last = prev[prev.length - 1];
                if (!last || last.status !== 'streaming') return prev;
                const updated: ThreadRow = {
                  ...last,
                  kr: last.kr + chunk,
                };
                return [...prev.slice(0, -1), updated];
              });
            },
            onDone: (): void => {
              setMsgs((prev) => {
                const last = prev[prev.length - 1];
                if (!last || last.status !== 'streaming') return prev;
                // Finalise — drop the streaming marker.
                const finalRow: ThreadRow = {
                  role: 'tutor',
                  kr: last.kr,
                  en: '',
                };
                return [...prev.slice(0, -1), finalRow];
              });
              // Server bumped the row's version by 1 on commit.
              versionRef.current += 1;
            },
            onError: (err: Error): void => {
              // Marker-based; the catch below also runs and is the
              // authoritative cleanup. Kept for visibility only.
              void err;
            },
          },
        );
      } catch (err) {
        // Abort is not an error condition the UI surfaces — it's the
        // unmount path. Swallow it so we don't paint a chip on the way out.
        if (err instanceof ApiError && err.code === 'canceled') {
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Stream failed. Please retry.';
        // Roll back: drop the partial tutor row, mark the user row as
        // `failed` so the user can hit Retry without retyping.
        setMsgs((prev) => {
          // Drop trailing streaming row, if present.
          const trimmed =
            prev.length > 0 && prev[prev.length - 1]?.status === 'streaming'
              ? prev.slice(0, -1)
              : prev;
          // Mark the most recent user turn matching `content` as failed.
          const out: ThreadRow[] = [];
          let marked = false;
          for (let i = trimmed.length - 1; i >= 0; i -= 1) {
            const row = trimmed[i];
            if (!row) continue;
            if (
              !marked &&
              row.role === 'user' &&
              row.kr === content &&
              row.status !== 'failed'
            ) {
              out.unshift({
                ...row,
                status: 'failed',
                failedRequestId: requestId,
                failedContent: content,
              });
              marked = true;
            } else {
              out.unshift(row);
            }
          }
          return out;
        });
        setSendError(message);
      } finally {
        // Only release the in-flight latch if this controller is still
        // the current one — concurrent-send guard means it should be, but
        // an unmount-in-flight could have replaced it.
        if (sendCtrlRef.current === ctrl) {
          sendCtrlRef.current = null;
          setStreaming(false);
        }
      }
    },
    [],
  );

  /**
   * Mint a fresh request id and dispatch a new user-turn send.
   *
   * SSR-/test-safety: prefer `crypto.randomUUID`; fall back to a v4-shaped
   * pseudo-id if the runtime lacks it. The id is opaque to the server —
   * any sufficiently unique string is fine for idempotency.
   */
  const mintRequestId = (): string => {
    const c: Crypto | undefined =
      typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // Last-resort fallback — happy-dom in some configs ships an older
    // Web Crypto without randomUUID. Length matches a v4 UUID's textual form.
    const r = (): string =>
      Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .slice(1);
    return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
  };

  const send = useCallback((): void => {
    if (streaming) return;
    const text = input.trim();
    if (!text) return;
    setInput('');
    const userTurn: ThreadRow = { role: 'user', kr: text, en: '' };
    setMsgs((prev) => [...prev, userTurn]);
    const requestId = mintRequestId();
    void (async (): Promise<void> => {
      try {
        const convId = await ensureConversationId();
        await runStream({ convId, content: text, requestId });
      } catch (err) {
        // Failure to start the conversation (lazy-start path). Mark the
        // user turn as failed and surface the error.
        const message =
          err instanceof Error ? err.message : 'Could not start conversation.';
        setMsgs((prev) => {
          const out: ThreadRow[] = [];
          let marked = false;
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const row = prev[i];
            if (!row) continue;
            if (!marked && row.role === 'user' && row.kr === text) {
              out.unshift({
                ...row,
                status: 'failed',
                failedRequestId: requestId,
                failedContent: text,
              });
              marked = true;
            } else {
              out.unshift(row);
            }
          }
          return out;
        });
        setSendError(message);
      }
    })();
  }, [ensureConversationId, input, runStream, streaming]);

  const retryFailedRow = useCallback(
    (row: ThreadRow): void => {
      if (streaming) return;
      if (!row.failedContent || !row.failedRequestId) return;
      const content = row.failedContent;
      const requestId = row.failedRequestId;
      // Clear the `failed` flag on this row (still the same optimistic
      // user bubble) and fire a fresh stream with the SAME request id so
      // the server can short-circuit to a persisted reply if one landed.
      setMsgs((prev) =>
        prev.map((r) =>
          r === row
            ? {
                role: 'user',
                kr: r.kr,
                en: r.en,
              }
            : r,
        ),
      );
      setSendError(null);
      void (async (): Promise<void> => {
        try {
          const convId = await ensureConversationId();
          await runStream({ convId, content, requestId });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Retry failed.';
          setSendError(message);
        }
      })();
    },
    [ensureConversationId, runStream, streaming],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter inserts a newline. Mirrors the prototype and
    // is the convention every chat textarea ships with.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Empty-state condition: we have no data AND we're not loading. With the
  // realFn flipped on, the hook may resolve with an empty `conversations`
  // array — that's not an error, that's "new user, no thread yet". The old
  // ErrorCard branch only fires when the loader truly failed AND no mock
  // came through either.
  const hasNothingToShow = msgs.length === 0 && !data;

  return (
    <section
      className="screen km-chat"
      aria-labelledby="chat-title"
      style={{ position: 'relative', padding: '0 18px 32px' }}
    >
      {isMock ? <MockBadge /> : null}

      <Topbar
        krTitle={<span id="chat-title">대화 · Chat</span>}
        eyebrow="Tutor conversation"
        right={
          <Toggle
            ariaLabel="Show hints"
            checked={hintsOn}
            onChange={setHintsOn}
          />
        }
      />

      {loading ? (
        <SkeletonCard />
      ) : hasNothingToShow ? (
        <ErrorCard
          message="The conversation couldn't be loaded."
          onRetry={retry}
        />
      ) : (
        <>
          <div
            ref={scrollRef}
            className="km-chat__thread"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            {msgs.map((m, i) => (
              <Bubble
                key={i}
                msg={m}
                showEn={hintsOn}
                onRetry={
                  m.status === 'failed' && !streaming
                    ? () => {
                        retryFailedRow(m);
                      }
                    : undefined
                }
              />
            ))}
          </div>

          {/* Composer */}
          <div className="km-chat__composer">
            <label className="km-chat__composerLabel" htmlFor="chat-input">
              <span className="km-eyebrow">Reply · 합쇼체</span>
            </label>
            <div className="km-chat__composerRow">
              <textarea
                id="chat-input"
                className="kr focusring km-chat__textarea"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                }}
                onKeyDown={onKeyDown}
                placeholder="Reply in Korean — formal register…"
                rows={2}
                aria-label="Reply input"
              />
              <Button
                variant="gold"
                size="md"
                onClick={send}
                disabled={!input.trim() || streaming}
                aria-label="Send"
                aria-busy={streaming ? 'true' : 'false'}
              >
                <Icon name="send" size={16} />
              </Button>
            </div>
            {sendError ? (
              <div
                role="alert"
                className="km-chat__sendError"
                style={{
                  marginTop: 8,
                  fontSize: 13,
                  color: 'var(--vermilion)',
                }}
              >
                {sendError}
              </div>
            ) : null}
            {hintsOn ? (
              <div
                className="km-chat__hints"
                role="group"
                aria-label="Reply starters"
              >
                {HINT_STARTERS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="km-chat__hint focusring"
                    onClick={() => {
                      setInput((prev) => (prev ? `${prev} ${h}` : h));
                    }}
                  >
                    {h}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/** Single chat bubble. Tutor left, user right; user has stronger border. */
function Bubble({
  msg,
  showEn,
  onRetry,
}: {
  msg: ThreadRow;
  showEn: boolean;
  onRetry?: () => void;
}): JSX.Element {
  const isUser = msg.role === 'user';
  const isFailed = msg.status === 'failed';
  return (
    <div
      className={`km-chat__row${isUser ? ' km-chat__row--user' : ''}`}
    >
      <div
        className={`km-chat__bubble${isUser ? ' km-chat__bubble--user' : ' km-chat__bubble--tutor'}${
          isFailed ? ' km-chat__bubble--failed' : ''
        }`}
      >
        <div className="km-eyebrow km-chat__role">
          {isUser ? 'You' : 'Tutor'}
        </div>
        <div className="kr km-chat__text">{msg.kr}</div>
        {showEn && msg.en ? (
          <div className="km-chat__en">{msg.en}</div>
        ) : null}
        {isFailed && onRetry ? (
          <button
            type="button"
            className="km-chat__retry focusring"
            onClick={onRetry}
            aria-label="Retry sending message"
            style={{
              marginTop: 6,
              fontSize: 12,
              color: 'var(--vermilion)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            failed — retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default Chat;
