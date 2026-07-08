/**
 * Chat (Conversation) screen — multi-conversation tutor chat with a
 * collapsible sidebar (chat rework Slice 2).
 *
 * Layout:
 *   1. Topbar: "Tutor conversation" eyebrow + 대화 · Chat serif title.
 *   2. A two-pane layout below the Topbar:
 *      - LEFT: a collapsible conversation sidebar (mockup: thin-rail
 *        collapse ‹, "New chat", the conversation list newest-first, a
 *        30-day retention note).
 *      - RIGHT: the message thread (tutor left / user right) + composer.
 *
 * State model (Slice 2 — replaces the single-active-conversation shape):
 *   - `rows` — the sidebar's conversation list. Derived per render from the
 *     server list (`listConversations`, metadata only), locally-started
 *     conversations (`localRows` — New chat / lazy-start), and per-send
 *     `updated_at` bumps (`touchedAt`), sorted newest-first.
 *   - `selectedKey` — the user's explicit selection (`number` id, or the
 *     'new' pending state). `activeKey` derives the effective selection:
 *     the user's pick, else the newest row, else 'new'. Mount therefore
 *     resumes the latest conversation (unchanged behavior; the force-new
 *     FAB entry is Slice 3) but now loads its FULL history.
 *   - `loaded` — which conversation's history the thread currently holds
 *     (`{ key, empty }`). `historyLoading` is DERIVED (`activeId` set but
 *     not yet loaded and not failed) rather than set synchronously in an
 *     effect, keeping the history effect clean of sync setState.
 *   - `titles` — derived sidebar titles: the first user message's snippet,
 *     learned when a conversation's history loads (the list endpoint has
 *     no message bodies) or when this session sends its first message.
 *     Fallback: Korean mode label + date.
 *
 * History loading (the previously-missing capability):
 *   An effect keyed on the active conversation id fetches
 *   `getConversation(id)` with an AbortController; switching away or
 *   unmounting aborts, and every continuation is `signal.aborted`-guarded
 *   so a late resolve can never set state on a dead tree or clobber a
 *   newer selection (F-016's abort discipline). The fetched `version`
 *   refreshes `versionRef` so the next send's `expected_version` is
 *   correct for the switched-to conversation. Sends are gated on
 *   `threadReady` (history loaded for the active id) so a send can never
 *   ride a stale version from a previous conversation.
 *
 * Sidebar behavior:
 *   - Click a row → abort any in-flight stream, clear the thread, load
 *     that conversation's history. Current row is highlighted
 *     (`aria-current`), switching is announced via a visually-hidden
 *     `role="status"` region.
 *   - Collapse toggle → Claude-style thin rail (rows shrink to dots,
 *     labels hide; everything keeps its accessible name). The preference
 *     persists in `localStorage["km.chat.sidebar-collapsed"]`; on a
 *     narrow viewport the default is collapsed so the rail never crushes
 *     the thread (mockup intent — the mockup keeps the sidebar inline on
 *     phones, just narrow).
 *   - "New chat" → `startConversation` immediately, prepend the new row,
 *     switch to it (opener thread), focus the composer. Prior
 *     conversations stay listed.
 *
 * Send wiring (unchanged from Pass 3 apart from the id/version source):
 *   optimistic user-bubble append, then `streamMessage(id, { content,
 *   expected_version }, { signal, onDelta, onDone, onError, requestId })`.
 *   `onDelta` grows a partial tutor bubble, `onDone` finalises it and
 *   bumps the row's recency, `onError` rolls the optimistic user-turn
 *   into a `failed → retry` chip.
 *
 * Dictionary lookup (F-016):
 *   A book icon next to the composer reveals a compact single-word lookup
 *   field. Submitting it calls `GET /define` directly (`defineEntry`) — the
 *   user typed the headword themselves, so the tap-chain's lemmatize +
 *   enrich steps are skipped — and the result renders in the shared
 *   `WordPopover` via `buildWordPopover(word, result, null)`. States:
 *   empty input is a no-op; the popover opens immediately with its
 *   `isLoading` stub; a lookup with no entries closes the stub and shows a
 *   fixed "no entry" notice under the field; a 503 `krdict_unavailable` /
 *   network failure shows fixed error copy (never server prose — F-UP-018);
 *   unmount / a newer lookup aborts the in-flight request. "Add to bank"
 *   inside the popover mines via `mineWord`, mirroring Ttmik's optimistic
 *   flip + rollback + fixed-copy toast contract.
 *
 * "Ask about this" seeding (F-020):
 *   A review surface (Mistakes / TOPIK mock / TOPIK study / Diagnostic) can
 *   navigate here with a `ChatSeedState` in router state. The seed text
 *   pre-fills the composer ONCE at mount (never auto-sent, never clobbers
 *   typed text — it's a lazy state initializer), its `mode` is preferred
 *   when THIS visit lazily starts a NEW conversation, and the router state
 *   is then cleared so a reload / back-nav can't re-seed.
 *
 * Threat model (FU-NF-4 closeout + Slice 2 additions):
 *   - **Streaming abort on unmount AND on conversation switch.** A
 *     controller per send is aborted when the screen unmounts or the user
 *     switches conversations mid-stream. The server persists the assistant
 *     turn ONLY after the upstream stream completes (server SECURITY.md
 *     §10) — aborting mid-stream therefore guarantees no half-turn is
 *     committed. No dangling sockets either: `streamSse` cancels the
 *     reader on abort.
 *   - **History-fetch abort.** One controller per history load, aborted by
 *     the effect cleanup on switch/unmount; both continuations are
 *     aborted-guarded, so a slow response for conversation A can never
 *     paint over conversation B or a dead tree.
 *   - **Stale-version cross-talk.** `versionRef` is only trusted once the
 *     active conversation's history (and its `version`) has loaded —
 *     `threadReady` gates Send, so switching can't emit an
 *     `expected_version` belonging to the previous thread.
 *   - **Concurrent-send race.** Send is disabled while a stream is in-
 *     flight (`aria-busy="true"`), so the user cannot start a second
 *     overlapping stream in the same conversation.
 *   - **Network-flap retry via X-Request-Id.** Each send mints
 *     `crypto.randomUUID()` once; Retry reuses the SAME id so the server
 *     short-circuits to the persisted reply rather than re-running Claude.
 *     (Failed-retry chips are session-local: switching conversations
 *     discards them — the typed text is gone, an accepted trade-off since
 *     the user explicitly navigated away.)
 *   - **XSS / template injection.** Message text, streamed deltas, and
 *     derived sidebar titles (first-user-message snippets) are rendered as
 *     React children — escaped. Never add `dangerouslySetInnerHTML` here.
 *   - **Conversation impersonation.** Conversation ids come from the
 *     server's own list/detail responses, scoped server-side to the
 *     cookie's user; `GET /conversation/:id` 404s on foreign ids (IDOR
 *     tested server-side).
 *   - **localStorage.** Only the boolean sidebar preference is stored;
 *     reads are try/catch'd (privacy mode) and coerced to a boolean —
 *     nothing attacker-controllable flows anywhere sensitive.
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
import { Bilingual } from '../components/Bilingual';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { WordPopover } from '../components/WordPopover';
import type { WordPopoverData } from '../components/WordPopover';
import { useToast } from '../components/useToast';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { useSettings } from '../hooks/useSettings';
import { loadConversationMock } from '../data/mocks/chat';
import { readChatSeedState, type ChatSeedState } from '../lib/askSeed';
import { cn } from '../lib/cn';
import { navItem } from '../lib/nav';
import {
  buildWordPopover,
  GLOSS_DICTIONARY_ENTRY,
  GLOSS_UNAVAILABLE,
} from '../lib/tapChain';
import * as conversationService from '../services/conversation';
import { defineEntry } from '../services/define';
import { mineWord } from '../services/vocab';
import { ApiError } from '../services/api';
import { errorMessageFor } from '../lib/errorCopy';
import type {
  Conversation,
  ConversationMessage,
  ConversationMode,
  ConversationRow,
  ConversationsList,
  StoredConversationTurn,
} from '../types/domain';

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const CHAT_NAV = navItem('chat');

/** Quick-reply starter strings shown under composer when hints are on. */
const HINT_STARTERS: ReadonlyArray<string> = [
  '제 생각에는',
  '예를 들어',
  '반면에',
  '그렇다면',
];

/** Default opener used while a NEW (or empty) conversation is active. */
const FALLBACK_OPENER: ConversationMessage = {
  role: 'tutor',
  kr: '안녕하십니까. 오늘은 재택근무의 장단점에 대해 이야기해 보겠습니다.',
  en: "Hello. Today we'll discuss the pros and cons of remote work.",
};

/** Server start mode — kept here (one screen, one mode) to avoid a config dep. */
const DEFAULT_START_MODE = 'casual' as const;

/** Fixed copy for a lookup that resolved but matched no KRDICT entry (F-016).
 *  Author-controlled — the server's 404/empty body is never echoed. */
const DICT_NO_ENTRY_COPY = 'No dictionary entry found for that word.';

/** Fixed copy for the 503 `krdict_unavailable` path (F-UP-018 contract —
 *  the server's own prose never reaches the DOM). */
const DICT_UNAVAILABLE_COPY =
  'The dictionary is unavailable right now. Try again later.';

/** Fallback fixed copy for any other lookup failure. */
const DICT_FAILED_COPY = 'Could not look that word up. Try again.';

/** Fixed copy when a conversation's history fails to load (F-UP-018 —
 *  never the server's prose). */
const HISTORY_FAILED_COPY = 'This conversation could not be loaded.';

/** Fixed copy when "New chat" fails to start a conversation. */
const NEW_CHAT_FAILED_COPY = 'Could not start a new chat. Try again.';

/** localStorage key for the persisted sidebar-collapsed preference. */
const SIDEBAR_COLLAPSED_KEY = 'km.chat.sidebar-collapsed';

/** Max characters for a derived (first-user-message) sidebar title. */
const TITLE_SNIPPET_MAX = 42;

/**
 * Korean mode labels for the fallback sidebar title (used until we've seen
 * the conversation's first user message — the list endpoint carries no
 * message bodies). Unknown modes render verbatim.
 */
const MODE_TITLE_LABELS: Readonly<Record<string, string>> = {
  casual: '일상 대화',
  business: '비즈니스 대화',
  research: '연구 대화',
  topik_prep: 'TOPIK 준비',
  register_drill: '말투 연습',
};

/** Inline notice under the dictionary field — friendly status ("no entry")
 *  vs. error (lookup failed) picks the a11y role and the colour. */
interface DictNotice {
  tone: 'status' | 'error';
  text: string;
}

/**
 * Default sidebar state: collapsed on a narrow viewport so the rail never
 * crushes the thread on a phone (the mockup keeps the sidebar inline on
 * mobile, just narrow — we go one step further and start it as the thin
 * rail). Guarded — happy-dom/private-mode quirks must not throw at mount.
 */
function defaultCollapsed(): boolean {
  try {
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(max-width: 640px)').matches;
    }
  } catch {
    // Fall through to the desktop default.
  }
  return false;
}

/** Read the persisted collapse preference; fall back to the viewport default. */
function readCollapsedPref(): boolean {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Privacy mode / storage denied — viewport default below.
  }
  return defaultCollapsed();
}

/** Persist the collapse preference. Best-effort — storage may be denied. */
function writeCollapsedPref(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Best-effort only; the in-memory state still applies this session.
  }
}

/**
 * Derive a one-line sidebar title from message text: whitespace-flattened,
 * ellipsis-truncated. `null` when the text has no visible characters (the
 * caller keeps its fallback title instead).
 */
function snippetTitle(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  if (flat.length <= TITLE_SNIPPET_MAX) return flat;
  return `${flat.slice(0, TITLE_SNIPPET_MAX - 1)}…`;
}

/** Fallback sidebar title — Korean mode label + a short date. */
function fallbackTitle(row: ConversationRow): string {
  const label = MODE_TITLE_LABELS[row.mode] ?? row.mode;
  const t = Date.parse(row.updated_at);
  if (Number.isNaN(t)) return label;
  const d = new Date(t);
  return `${label} · ${String(d.getMonth() + 1)}/${String(d.getDate())}`;
}

/**
 * Compact relative-time label for a sidebar row ("2m ago" … "yesterday" …
 * "3w ago", then an absolute date). `nowMs` is captured once per mount —
 * the labels don't need to tick live.
 */
function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const seconds = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${String(days)}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${String(weeks)}w ago`;
  const d = new Date(t);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Newest-first comparator on ISO-8601 `updated_at` (lexicographic = chrono). */
function byUpdatedAtDesc(a: ConversationRow, b: ConversationRow): number {
  if (a.updated_at === b.updated_at) return 0;
  return a.updated_at < b.updated_at ? 1 : -1;
}

/**
 * Map the wire history (`StoredConversationTurn[]`, role user/assistant)
 * into render rows (role user/tutor). Image turns already carry the OCR'd
 * Korean text as `content`; their English translation rides as the bubble's
 * EN line (the hints toggle governs display). Rendering the image itself is
 * Slice 3 (composer upload + <img> bubble).
 */
function mapStoredTurns(turns: StoredConversationTurn[]): ThreadRow[] {
  return turns.map((turn) => ({
    role: turn.role === 'assistant' ? 'tutor' : 'user',
    kr: turn.content,
    en: turn.image?.caption_en ?? '',
  }));
}

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
function personalise(msgs: Conversation, name: string): Conversation {
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

/** Which conversation the thread pane is showing: a server id, or the
 *  not-yet-started "new chat" pending state. */
type ActiveKey = number | 'new';

/** What the thread currently holds — set ONLY from a settled history load
 *  or a just-started (known-empty) conversation. */
interface LoadedThread {
  key: number;
  /** True when the server history was empty — the opener renders above. */
  empty: boolean;
}

export function Chat(): JSX.Element {
  const { settings } = useSettings();
  const { toast } = useToast();
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

  // ── Conversation list (sidebar) ────────────────────────────────────
  // Conversations started THIS session (New chat / lazy-start) — the server
  // list won't contain them until a refetch, so they're merged in locally.
  const [localRows, setLocalRows] = useState<ConversationRow[]>([]);
  // Per-conversation recency bumps from sends this session, so the sidebar
  // order + relative times stay honest without refetching the list.
  const [touchedAt, setTouchedAt] = useState<ReadonlyMap<number, string>>(
    () => new Map<number, string>(),
  );
  // Derived sidebar titles (first user message snippet). Learned from a
  // history load or this session's first send; fallback is mode + date.
  const [titles, setTitles] = useState<ReadonlyMap<number, string>>(
    () => new Map<number, string>(),
  );
  // Captured once per mount — relative labels don't need to tick live.
  const [nowMs] = useState<number>(() => Date.now());

  const rows = useMemo<ConversationRow[]>(() => {
    const seen = new Set<number>();
    const merged: ConversationRow[] = [];
    for (const row of [...localRows, ...(serverList?.conversations ?? [])]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const bump = touchedAt.get(row.id);
      merged.push(
        bump !== undefined && bump > row.updated_at
          ? { ...row, updated_at: bump }
          : row,
      );
    }
    merged.sort(byUpdatedAtDesc);
    return merged;
  }, [localRows, serverList, touchedAt]);

  // ── Active conversation (explicit selection + derived default) ─────
  // `selectedKey` only changes on user action (row click / New chat /
  // first-send pin); the default — newest row, else the pending 'new'
  // state — is DERIVED, so mount needs no list-adoption effect.
  const [selectedKey, setSelectedKey] = useState<ActiveKey | null>(null);
  const activeKey: ActiveKey = selectedKey ?? rows[0]?.id ?? 'new';
  const activeId: number | null = typeof activeKey === 'number' ? activeKey : null;

  // What the thread pane currently holds + the failure marker for the
  // active load. `historyLoading` is derived — no sync setState in effects.
  const [loaded, setLoaded] = useState<LoadedThread | null>(null);
  const [historyError, setHistoryError] = useState<{ forId: number } | null>(
    null,
  );
  const historyLoading =
    activeId !== null &&
    loaded?.key !== activeId &&
    historyError?.forId !== activeId;
  /** True when sends may trust `versionRef` for the active conversation. */
  const threadReady = activeId === null || loaded?.key === activeId;

  // Version snapshot for optimistic concurrency: refreshed by every history
  // load / conversation start, bumped by every committed stream.
  const versionRef = useRef<number>(0);

  // Visually-hidden announcement for switch/load transitions (a11y). Set
  // from handlers + settled loads only, so mid-conversation state changes
  // (e.g. a title learned on first send) never re-announce.
  const [announce, setAnnounce] = useState<string>('');

  const [msgs, setMsgs] = useState<ThreadRow[]>([]);
  // Composer text — pre-filled from an "Ask about this" seed when one rode
  // in on the navigation (F-020). Pre-fill only: the user reviews and hits
  // Send themselves, nothing is auto-sent.
  const [input, setInput] = useState<string>(chatSeed?.seedText ?? '');
  const [hintsOn, setHintsOn] = useState<boolean>(true);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // "New chat" in-flight latch — the button is disabled while starting.
  const [creating, setCreating] = useState<boolean>(false);

  // ── Sidebar collapse (persisted) ───────────────────────────────────
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readCollapsedPref(),
  );
  const toggleCollapsed = useCallback((): void => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsedPref(next);
      return next;
    });
  }, []);

  // Composer focus target for "New chat".
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // Mounted marker for async handlers that have no AbortSignal to thread
  // (startConversation). Re-armed on StrictMode remount.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  // ── History load (Slice 2 — the previously-missing capability) ─────
  // Fetch the active conversation's full history. Cleanup aborts on
  // switch/unmount; continuations are aborted-guarded. Re-runs when
  // `loaded`/`historyError` change but early-returns once the active id is
  // settled, so it never loops. A failed load re-arms only via the explicit
  // Retry (which clears `historyError`).
  useEffect(() => {
    if (activeId === null) return;
    if (loaded?.key === activeId) return;
    if (historyError?.forId === activeId) return;
    const ctrl = new AbortController();
    conversationService.getConversation(activeId, ctrl.signal).then(
      (res) => {
        if (ctrl.signal.aborted) return;
        const detail = res.conversation;
        versionRef.current = detail.version;
        setMsgs(mapStoredTurns(detail.messages));
        const firstUser = detail.messages.find((m) => m.role === 'user');
        const title =
          firstUser !== undefined ? snippetTitle(firstUser.content) : null;
        if (title !== null) {
          setTitles((prev) =>
            prev.get(detail.id) === title
              ? prev
              : new Map(prev).set(detail.id, title),
          );
        }
        setLoaded({ key: detail.id, empty: detail.messages.length === 0 });
        setAnnounce(`Conversation loaded: ${title ?? 'chat'}`);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setHistoryError({ forId: activeId });
      },
    );
    return () => {
      ctrl.abort();
    };
  }, [activeId, loaded, historyError]);

  // ── Thread base rows (rendered ABOVE `msgs`, never stored) ─────────
  // The personalised opener shows for a new/empty conversation; the mock
  // fixture stands in when the endpoint fell back. Deriving (instead of
  // seeding state) means a `settings.name` change re-personalises for free
  // and there is no seeding effect to guard.
  const baseRows = useMemo<Conversation>(() => {
    if (serverList !== null) {
      if (activeId === null) {
        return personalise([FALLBACK_OPENER], settings.name);
      }
      if (loaded?.key === activeId && loaded.empty) {
        return personalise([FALLBACK_OPENER], settings.name);
      }
      return [];
    }
    if (mockSeed.length > 0) {
      return personalise(mockSeed, settings.name);
    }
    return [];
  }, [serverList, activeId, loaded, mockSeed, settings.name]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // ── In-flight send tracking ────────────────────────────────────────
  // One controller per send; cleared on settle. Aborted on unmount AND on
  // conversation switch so we never stream into a thread that no longer
  // shows that conversation.
  const sendCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      sendCtrlRef.current?.abort();
    };
  }, []);

  const retry = (): void => {
    refetch();
  };

  /**
   * Adopt a conversation this session just started (New chat button or the
   * lazy-start-on-send path): prepend its row, select it, and mark its
   * (known-empty) history as loaded so no fetch fires. `clearThread` is
   * false on the lazy-start path — the optimistic user bubble of the send
   * that triggered the start must survive.
   */
  const adoptStartedConversation = useCallback(
    (id: number, mode: ConversationMode, opts: { clearThread: boolean }): void => {
      const nowIso = new Date().toISOString();
      setLocalRows((prev) => [
        {
          id,
          mode,
          target_register: null,
          version: 1,
          updated_at: nowIso,
          message_count: 0,
        },
        ...prev.filter((r) => r.id !== id),
      ]);
      setSelectedKey(id);
      setLoaded({ key: id, empty: true });
      setHistoryError(null);
      if (opts.clearThread) setMsgs([]);
    },
    [],
  );

  /** Switch the thread to a sidebar conversation. */
  const selectConversation = useCallback(
    (id: number): void => {
      if (id === activeKey) return;
      // Abort any in-flight stream — it belongs to the previous thread.
      sendCtrlRef.current?.abort();
      setSendError(null);
      setHistoryError(null);
      setSelectedKey(id);
      // Clear immediately so the previous thread never flashes under the
      // new selection; the history effect repopulates.
      setMsgs([]);
      setAnnounce('Loading conversation…');
    },
    [activeKey],
  );

  /**
   * "New chat" — eagerly start a fresh conversation, switch to it (opener
   * thread), and focus the composer. Prior conversations stay in the list.
   * Eager (vs. the lazy-start-on-send path) so the new conversation is
   * immediately real: visible in the sidebar and safe to switch away from.
   */
  const startNewChat = useCallback((): void => {
    if (creating) return;
    sendCtrlRef.current?.abort();
    setCreating(true);
    setSendError(null);
    conversationService
      .startConversation({ mode: DEFAULT_START_MODE })
      .then(
        (started) => {
          if (!mountedRef.current) return;
          versionRef.current = 1;
          adoptStartedConversation(started.conversation.id, DEFAULT_START_MODE, {
            clearThread: true,
          });
          setCreating(false);
          setAnnounce('New chat started');
          composerRef.current?.focus();
        },
        (err: unknown) => {
          if (!mountedRef.current) return;
          setCreating(false);
          setSendError(errorMessageFor(err, NEW_CHAT_FAILED_COPY));
        },
      );
  }, [creating, adoptStartedConversation]);

  /** Re-arm the history effect after a failed load. */
  const retryHistory = useCallback((): void => {
    setHistoryError(null);
  }, []);

  /**
   * Ensure the active conversation exists server-side; lazy-start if the
   * pending 'new' state is active. An "Ask about this" seed's mode (F-020,
   * `topik_prep`) wins over the screen default when it is this navigation
   * that starts the conversation — an existing conversation keeps its own
   * mode untouched.
   */
  const ensureActiveConversationId = useCallback(async (): Promise<number> => {
    if (activeId !== null) return activeId;
    const mode = chatSeed?.mode ?? DEFAULT_START_MODE;
    const started = await conversationService.startConversation({ mode });
    versionRef.current = 1;
    adoptStartedConversation(started.conversation.id, mode, {
      clearThread: false,
    });
    return started.conversation.id;
  }, [activeId, chatSeed, adoptStartedConversation]);

  /** Record a first-message-derived title if the conversation has none. */
  const learnTitleFromSend = useCallback(
    (convId: number, text: string): void => {
      const title = snippetTitle(text);
      if (title === null) return;
      setTitles((prev) =>
        prev.has(convId) ? prev : new Map(prev).set(convId, title),
      );
    },
    [],
  );

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

      // Per-send controller. The unmount cleanup and a conversation switch
      // abort whichever is current at the time.
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
              // Bump the sidebar row's recency so ordering stays honest.
              setTouchedAt((prev) =>
                new Map(prev).set(convId, new Date().toISOString()),
              );
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
        // unmount/switch path. Swallow it so we don't paint a chip on the
        // way out.
        if (err instanceof ApiError && err.code === 'canceled') {
          return;
        }
        const message = errorMessageFor(err, 'Stream failed. Please retry.');
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
    if (streaming || !threadReady) return;
    const text = input.trim();
    if (!text) return;
    setInput('');
    // Pin the derived default selection: from here on this send's target is
    // an explicit choice, immune to list reordering.
    if (selectedKey === null && typeof activeKey === 'number') {
      setSelectedKey(activeKey);
    }
    const userTurn: ThreadRow = { role: 'user', kr: text, en: '' };
    setMsgs((prev) => [...prev, userTurn]);
    const requestId = mintRequestId();
    void (async (): Promise<void> => {
      try {
        const convId = await ensureActiveConversationId();
        learnTitleFromSend(convId, text);
        await runStream({ convId, content: text, requestId });
      } catch (err) {
        // Failure to start the conversation (lazy-start path). Mark the
        // user turn as failed and surface the error.
        const message = errorMessageFor(err, 'Could not start conversation.');
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
  }, [
    activeKey,
    ensureActiveConversationId,
    input,
    learnTitleFromSend,
    runStream,
    selectedKey,
    streaming,
    threadReady,
  ]);

  const retryFailedRow = useCallback(
    (row: ThreadRow): void => {
      if (streaming || !threadReady) return;
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
          const convId = await ensureActiveConversationId();
          await runStream({ convId, content, requestId });
        } catch (err) {
          const message = errorMessageFor(err, 'Retry failed.');
          setSendError(message);
        }
      })();
    },
    [ensureActiveConversationId, runStream, streaming, threadReady],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter inserts a newline. Mirrors the prototype and
    // is the convention every chat textarea ships with.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // ── Dictionary lookup (F-016) ──────────────────────────────────────
  // Book button toggles a compact single-word field under the composer;
  // submitting it runs `defineEntry` → `buildWordPopover` → WordPopover.
  const [dictOpen, setDictOpen] = useState<boolean>(false);
  const [dictInput, setDictInput] = useState<string>('');
  const [dictPop, setDictPop] = useState<WordPopoverData | null>(null);
  const [dictLoading, setDictLoading] = useState<boolean>(false);
  const [dictNotice, setDictNotice] = useState<DictNotice | null>(null);
  // Session-scoped set of banked headwords — re-looking one up shows the
  // "already banked" pill (same convention as Ttmik's minedIds).
  const [dictMined, setDictMined] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Lookup-scoped controller — aborted on a newer lookup, popover close,
  // or unmount, so a late resolve can never set state on a dead tree.
  const dictCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      dictCtrlRef.current?.abort();
    };
  }, []);

  const toggleDict = useCallback((): void => {
    // Toggling always clears the notice — a stale "no entry" line must not
    // survive a close/reopen. The typed word is kept (cheap undo). The two
    // set calls stay side by side (never one inside the other's updater —
    // updaters must be pure).
    setDictNotice(null);
    setDictOpen((open) => !open);
  }, []);

  /**
   * Run one lookup. The popover opens immediately with its `isLoading`
   * stub (same gesture as Ttmik's tap path); a no-entry result or a
   * failure closes the stub and surfaces fixed copy under the field
   * instead — WordPopover has no error body, and an inline line next to
   * where the user just typed reads better than a near-empty dialog.
   */
  const lookupWord = useCallback((): void => {
    const word = dictInput.trim();
    if (!word) return;
    dictCtrlRef.current?.abort();
    const ctrl = new AbortController();
    dictCtrlRef.current = ctrl;

    setDictNotice(null);
    setDictLoading(true);
    setDictPop({
      kr: word,
      en: '',
      pos: 'word',
      ex_kr: '',
      ex_en: '',
      mined: dictMined.has(word),
    });

    void defineEntry(word, ctrl.signal).then(
      (result) => {
        if (ctrl.signal.aborted) return;
        if (result.entries.length === 0) {
          // 200-with-empty-entries — the "typo / not in KRDICT" path.
          setDictPop(null);
          setDictLoading(false);
          setDictNotice({ tone: 'status', text: DICT_NO_ENTRY_COPY });
          return;
        }
        // Direct typed lookup: the user supplied the headword, so the
        // define result alone is the popover (no lemmatize/enrich pass).
        const popover = buildWordPopover(word, result, null);
        popover.mined = dictMined.has(popover.kr);
        setDictPop(popover);
        setDictLoading(false);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setDictPop(null);
        setDictLoading(false);
        if (err instanceof ApiError && err.status === 404) {
          // Older server contract surfaced "no entry" as a 404 — same
          // friendly copy, never the server body.
          setDictNotice({ tone: 'status', text: DICT_NO_ENTRY_COPY });
          return;
        }
        const text =
          err instanceof ApiError && err.code === 'krdict_unavailable'
            ? DICT_UNAVAILABLE_COPY
            : errorMessageFor(err, DICT_FAILED_COPY);
        setDictNotice({ tone: 'error', text });
      },
    );
  }, [dictInput, dictMined]);

  /** Close the popover and abort any still-pending lookup. */
  const closeDictPopover = useCallback((): void => {
    dictCtrlRef.current?.abort();
    dictCtrlRef.current = null;
    setDictPop(null);
    setDictLoading(false);
  }, []);

  const onDictKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Mirror the search button's disabled state exactly: Enter must not
      // restart an in-flight lookup (it would abort + refire behind a
      // visibly disabled button) and must not submit whitespace.
      if (dictLoading || !dictInput.trim()) return;
      lookupWord();
    }
  };

  /**
   * Add-to-bank (FU-NF-33) — Ttmik's contract verbatim: optimistic flip,
   * rollback + fixed-copy toast on a real failure, a close-aborted request
   * swallowed. Sentinel glosses are never persisted as the word's English.
   */
  const handleDictAdd = useCallback(
    (d: WordPopoverData): void | Promise<void> => {
      const lemma = d.kr;
      setDictMined((prev) => {
        const next = new Set(prev);
        next.add(lemma);
        return next;
      });

      // Reuse the lookup-scoped controller so a popover close cancels the
      // bank too; fall back to a fresh one if it was already cleared.
      const ctrl = dictCtrlRef.current ?? new AbortController();
      dictCtrlRef.current = ctrl;

      return mineWord(
        {
          lemma,
          ...(d.en &&
          d.en !== GLOSS_DICTIONARY_ENTRY &&
          d.en !== GLOSS_UNAVAILABLE
            ? { english: d.en }
            : {}),
          ...(d.pos && d.pos !== 'word' ? { pos: d.pos } : {}),
          ...(d.krdictEntryId !== undefined
            ? { krdictEntryId: d.krdictEntryId }
            : {}),
        },
        ctrl.signal,
      ).then(
        () => undefined,
        (err: unknown) => {
          if (err instanceof ApiError && err.code === 'canceled') return;
          setDictMined((prev) => {
            if (!prev.has(lemma)) return prev;
            const next = new Set(prev);
            next.delete(lemma);
            return next;
          });
          toast({ message: "Couldn't bank — try again", tone: 'error' });
          // Re-throw so WordPopover rolls its "Added" button back too.
          throw err instanceof Error ? err : new Error('bank failed');
        },
      );
    },
    [toast],
  );

  // List-level failure: the loader truly failed AND no mock came through.
  const hasNothingToShow = !data;

  return (
    <section
      className="screen km-chat"
      aria-labelledby="chat-title"
      style={{ position: 'relative', padding: '0 18px 32px' }}
    >
      {isMock ? <MockBadge /> : null}

      <Topbar
        krTitle="대화"
        title="Chat"
        titleId="chat-title"
        eyebrow={<Bilingual en={CHAT_NAV.eyebrow} kr={CHAT_NAV.krEyebrow} />}
        right={
          <Toggle
            ariaLabel="Show hints"
            checked={hintsOn}
            onChange={setHintsOn}
          />
        }
      />

      {/* Switch/load announcements for screen readers. A bare polite live
          region (no role="status") — the dictionary notice owns the page's
          single status role (F-016 contract, and its tests query it
          exclusively). */}
      <div className="km-sr-only" aria-live="polite" data-testid="chat-announce">
        {announce}
      </div>

      {loading ? (
        <SkeletonCard />
      ) : hasNothingToShow ? (
        <ErrorCard
          message="The conversation couldn't be loaded."
          onRetry={retry}
        />
      ) : (
        <div
          className={cn(
            'km-chat__layout',
            collapsed && 'km-chat__layout--collapsed',
          )}
        >
          {/* ── Conversation sidebar ────────────────────────────────── */}
          <nav className="km-chat__side" aria-label="Conversations">
            <div className="km-chat__sideHead">
              <button
                type="button"
                className="km-chat__collapse focusring"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                aria-controls="chat-conversations"
                aria-label={
                  collapsed
                    ? 'Expand conversation list'
                    : 'Collapse conversation list'
                }
              >
                <Icon
                  name={collapsed ? 'chevron-right' : 'chevron-left'}
                  size={16}
                />
              </button>
              {!collapsed ? (
                <span className="km-eyebrow km-chat__sideLabel">
                  <Bilingual en="Chats" kr="대화" />
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="km-chat__newChat focusring"
              onClick={startNewChat}
              disabled={creating}
              aria-busy={creating ? 'true' : 'false'}
              aria-label="New chat"
            >
              <Icon name="plus" size={14} />
              {!collapsed ? <Bilingual en="New chat" kr="새 대화" /> : null}
            </button>
            <ul
              id="chat-conversations"
              className="km-chat__convList"
              aria-label="Conversation history"
            >
              {rows.map((row) => {
                const isActive = row.id === activeKey;
                const title = titles.get(row.id) ?? fallbackTitle(row);
                const when = relativeTime(row.updated_at, nowMs);
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={cn(
                        'km-chat__convRow',
                        'focusring',
                        isActive && 'km-chat__convRow--current',
                      )}
                      onClick={() => {
                        selectConversation(row.id);
                      }}
                      aria-current={isActive ? 'true' : undefined}
                      aria-label={when ? `${title}, ${when}` : title}
                      title={title}
                    >
                      <span className="km-chat__convDot" aria-hidden="true" />
                      {!collapsed ? (
                        <span className="km-chat__convText">
                          <span className="kr km-chat__convTitle">
                            {title}
                          </span>
                          <span className="km-chat__convWhen">{when}</span>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {!collapsed ? (
              <p className="km-chat__retention">
                <Bilingual
                  en="Chats are kept 30 days, then cleared"
                  kr="대화는 30일 뒤 삭제됩니다"
                />
              </p>
            ) : null}
          </nav>

          {/* ── Thread + composer ───────────────────────────────────── */}
          <div className="km-chat__main">
            <div
              ref={scrollRef}
              className="km-chat__thread"
              role="log"
              aria-live="polite"
              aria-label="Conversation"
              aria-busy={historyLoading ? 'true' : 'false'}
            >
              {historyError !== null && historyError.forId === activeId ? (
                <div role="alert" className="km-chat__historyError">
                  <span>{HISTORY_FAILED_COPY}</span>
                  <Button variant="ghost" size="sm" onClick={retryHistory}>
                    <Bilingual en="Retry" kr="다시 시도" />
                  </Button>
                </div>
              ) : historyLoading ? (
                <div className="km-chat__historyLoading">
                  <Bilingual
                    en="Loading conversation…"
                    kr="대화 불러오는 중…"
                  />
                </div>
              ) : (
                <>
                  {baseRows.map((m, i) => (
                    <Bubble key={`base-${String(i)}`} msg={m} showEn={hintsOn} />
                  ))}
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
                </>
              )}
            </div>

            {/* Composer */}
            <div className="km-chat__composer">
              <label className="km-chat__composerLabel" htmlFor="chat-input">
                {/* The 합쇼체 register cue stays OUTSIDE the bilingual pair —
                    it's the target register, not a translation of "Reply". */}
                <span className="km-eyebrow">
                  <Bilingual en="Reply" kr="답장" /> · 합쇼체
                </span>
              </label>
              <div className="km-chat__composerRow">
                <textarea
                  id="chat-input"
                  ref={composerRef}
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
                  disabled={!input.trim() || streaming || !threadReady}
                  aria-label="Send"
                  aria-busy={streaming ? 'true' : 'false'}
                >
                  <Icon name="send" size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={toggleDict}
                  aria-label="Dictionary lookup"
                  aria-expanded={dictOpen}
                  aria-controls="chat-dict-row"
                >
                  <Icon name="book" size={16} />
                </Button>
              </div>
              {dictOpen ? (
                <div id="chat-dict-row" className="km-chat__dictRow">
                  <label
                    className="km-chat__composerLabel"
                    htmlFor="chat-dict-input"
                  >
                    <span className="km-eyebrow">
                      <Bilingual en="Dictionary" kr="사전" />
                    </span>
                  </label>
                  <div className="km-chat__dictInputRow">
                    <input
                      id="chat-dict-input"
                      type="text"
                      className="kr focusring km-chat__dictInput"
                      value={dictInput}
                      onChange={(e) => {
                        setDictInput(e.target.value);
                      }}
                      onKeyDown={onDictKeyDown}
                      placeholder="Korean word — e.g. 사전"
                      aria-label="Dictionary word"
                      autoComplete="off"
                    />
                    <Button
                      variant="gold"
                      size="md"
                      onClick={lookupWord}
                      disabled={!dictInput.trim() || dictLoading}
                      aria-label="Look up word"
                      aria-busy={dictLoading ? 'true' : 'false'}
                    >
                      <Icon name="search" size={16} />
                    </Button>
                  </div>
                  {dictNotice ? (
                    <div
                      role={dictNotice.tone === 'error' ? 'alert' : 'status'}
                      className={`km-chat__dictNotice${
                        dictNotice.tone === 'error'
                          ? ' km-chat__dictNotice--error'
                          : ''
                      }`}
                    >
                      {dictNotice.text}
                    </div>
                  ) : null}
                </div>
              ) : null}
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
          </div>
        </div>
      )}

      {dictPop ? (
        <WordPopover
          data={dictPop}
          onClose={closeDictPopover}
          onAdd={handleDictAdd}
          isLoading={dictLoading}
        />
      ) : null}
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
          {isUser ? (
            <Bilingual en="You" kr="나" />
          ) : (
            <Bilingual en="Tutor" kr="튜터" />
          )}
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
            <Bilingual en="failed — retry" kr="실패 — 다시 시도" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default Chat;
