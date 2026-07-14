/**
 * Chat (Conversation) screen — multi-conversation tutor chat with a
 * collapsible sidebar (chat rework Slice 2; Phase 3D reformats the thread/
 * composer/sidebar and reworks attachments + naming — see the section
 * headers below).
 *
 * Layout:
 *   1. `PageHubHeader` (F-128 "Seoul Day & Night" reskin — devices #4/#2,
 *      same hub-header recipe as Grammar/Uploads/ReviewLibrary): "Tutor
 *      conversation" eyebrow + 대화 · Chat serif title, with a
 *      visibly-LABELED English-translations switch riding in the header's
 *      inline `actions` slot on the right (B-020 — the switch used to carry
 *      only an `aria-label`, so its purpose was invisible to sighted users;
 *      the label now reads "English · 영어"). The shared `SkylineHeader`
 *      banner it composes is height-capped for this page only (Chat.css
 *      `.km-chat__hub`) — a chat thread's vertical budget is precious
 *      (F-129 mobile pass), so the skyline motif stays present but short
 *      rather than claiming ~120px above the fold on every screen size.
 *   2. A two-pane layout below the header:
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
 *   - `titles` — DERIVED-SNIPPET sidebar titles (first user message's
 *     snippet), learned when a conversation's history loads (the list
 *     endpoint has no message bodies) or when this session sends its first
 *     message. This is only ever the FALLBACK shown before a real title
 *     resolves — see "Auto-naming (F-036)" below for the authoritative
 *     source and precedence order.
 *
 * History loading (the previously-missing capability):
 *   An effect keyed on the active conversation id fetches
 *   `getConversation(id)` with an AbortController; switching away or
 *   unmounting aborts, and every continuation is `signal.aborted`-guarded
 *   so a late resolve can never set state on a dead tree or clobber a
 *   newer selection. The fetched `version` refreshes `versionRef` so the
 *   next send's `expected_version` is correct for the switched-to
 *   conversation. Sends are gated on `threadReady` (history loaded for the
 *   active id) so a send can never ride a stale version from a previous
 *   conversation.
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
 * Auto-naming (F-036 — Claude-web style titles):
 *   The sidebar renders each row's title with this precedence:
 *     `confirmedTitles.get(id)` (a real title — user-set or Claude
 *     auto-generated, learned this session) → `row.title` (the same, as
 *     reported by the server on the list/detail envelope) → `titles.get(id)`
 *     (the derived first-message snippet) → `fallbackTitle` (mode + date).
 *   `runStream`'s `onDone` — i.e. once an assistant turn is durably
 *   persisted — fires `triggerAutoName(convId)`, which calls
 *   `POST /conversation/:id/name` (`nameConversation`) and, on success,
 *   records the returned title in `confirmedTitles`. The endpoint is
 *   idempotent (a named conversation 200s with its existing title and NO
 *   Claude call), so calling it after every turn is safe — `namedRef`
 *   still latches per conversation per session to avoid a redundant round
 *   trip once a title is known. A failed naming call releases the latch
 *   (silently — this is a cosmetic enhancement, never a user-facing error)
 *   so a transient failure gets another chance on the next turn instead of
 *   being stuck with the fallback for the rest of the session.
 *
 * Send wiring (unchanged from Pass 3 apart from the id/version source):
 *   optimistic user-bubble append, then `streamMessage(id, { content,
 *   expected_version }, { signal, onDelta, onDone, onError, requestId })`.
 *   `onDelta` grows a partial tutor bubble, `onDone` finalises it, bumps the
 *   row's recency, and triggers auto-naming; `onError` rolls the optimistic
 *   user-turn into a `failed → retry` chip.
 *
 * "Ask about this" seeding (F-020):
 *   A review surface (Mistakes / TOPIK mock / TOPIK study / Diagnostic) can
 *   navigate here with a `ChatSeedState` in router state. The seed text
 *   pre-fills the composer ONCE at mount (never auto-sent, never clobbers
 *   typed text — it's a lazy state initializer), its `mode` is preferred
 *   when THIS visit lazily starts a NEW conversation, and the router state
 *   is then cleared so a reload / back-nav can't re-seed.
 *
 * FAB entry + "Discuss the page you were on?" popup (Slice 3):
 *   The shell ChatFab navigates here with a `ChatOpenState` in router state
 *   (discriminator `kmChatOpen`, optional `ChatContext` — the page the user
 *   was on published its descriptor via `useChatContext`). A FAB entry
 *   always targets a NEW conversation: the initial selection is the pending
 *   'new' thread (lazy-started on first send, so an abandoned open never
 *   spams empty server rows) and prior conversations stay in the sidebar.
 *   When a context rode along, a focus-trapped modal (useModalA11y, Esc =
 *   No) offers it: Yes → the composer pre-fills with `buildContextSeed`
 *   (generic F-020 pattern — never auto-sent); No / no-context → the
 *   mockup's generic opener ("무엇에 대해 이야기하고 싶으세요? · What would
 *   you like to chat about?") renders instead of the default greeting. The
 *   open-state is cleared from history like the F-020 seed.
 *
 * Attachments (F-035 — "+" attach menu, Phase 3D):
 *   The composer's bottom-left "+" button (`aria-haspopup="menu"`) opens a
 *   small popup menu (`role="menu"`) with three items — Camera, Upload
 *   image, Upload document — replacing the old bare camera icon. Camera and
 *   Upload image both drive `uploadImageFile` (Slice 1/3's
 *   `uploadConversationImage`, `POST /conversation/:id/image`): the picked
 *   photo is OCR'd server-side and appends ONE user turn — the OCR'd Korean
 *   as `content`, an `image` block carrying the blob URL + English caption.
 *   They differ ONLY in which hidden `<input type="file">` they proxy: the
 *   camera item's input carries `capture="environment"` (opens the device
 *   camera directly where the platform supports it); the "Upload image"
 *   item's input has no `capture` attribute (opens the photo library /
 *   file picker). Upload document drives `uploadDocumentFile`
 *   (`uploadConversationFile`, `POST /conversation/:id/file`, F-035
 *   backend): a `.txt`/`.md` file's text becomes the turn's `content`
 *   verbatim (no OCR, no blob) and a `file` block carries display metadata
 *   (name/size/truncated). All three turn types render in the SAME bubble
 *   shape — the image above the text, or a small file chip above it.
 *
 *   Client pre-checks (type/size) are convenience only — the server
 *   re-validates everything (magic bytes / UTF-8 decode, size caps, daily
 *   Vision cap for images). Failures surface as FIXED copy
 *   (`imageUploadErrorMessage`, shared with the Images screen; the local
 *   `docUploadErrorMessage` for documents) — never server prose. A 409
 *   (stale version) on EITHER upload invalidates the loaded thread so the
 *   history effect refetches the authoritative version. One shared
 *   AbortController (`uploadCtrlRef`) covers whichever upload is in
 *   flight — camera/image/document are mutually exclusive with each other
 *   AND with a text send (`uploading` gates Send symmetrically) — aborted
 *   on unmount AND on conversation switch. Uploaded text is CONTENT —
 *   rendered like any message, never through `<Bilingual>`.
 *
 *   The menu itself is a lightweight, non-modal popup (NOT `useModalA11y` —
 *   that hook is for page-covering dialogs with a backdrop + scroll lock;
 *   this is a transient menu the rest of the page stays interactive
 *   around). It follows the WAI-ARIA menu-button pattern: opening moves
 *   focus to the first item so keyboard users land inside it immediately;
 *   ArrowUp/ArrowDown/Home/End move a roving-tabindex focus among the three
 *   items (wrapping at each end); `Escape` closes the menu AND returns focus
 *   to the "+" trigger; Tab closes the menu WITHOUT trapping focus — the
 *   browser's own default action still runs, so focus lands wherever it
 *   naturally would (the next control, or, on Shift+Tab from the first
 *   item, back to the trigger) rather than being forced onto the trigger.
 *   A mousedown outside the menu AND outside the trigger closes it the same
 *   way — no forced refocus — since the click itself may already be
 *   activating something else; forcing focus back to the trigger in that
 *   case would fight the click.
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
 *   - **Lazy-start races.** A send from the pending-'new' thread first
 *     awaits `startConversation` — a window where no stream (and no
 *     abortable controller) exists yet. That window is latched
 *     (`lazyStartRef`) so a second quick send joins the SAME new
 *     conversation instead of creating its own, and both continuations
 *     re-check `mountedRef` before opening the stream so an unmount
 *     mid-start can never leak a live, unabortable SSE (and its Claude
 *     spend) behind a dead tree.
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
 *   - **Attach-menu focus / keyboard trap avoidance.** The "+" menu is
 *     non-modal on purpose (see "Attachments" above) — it never locks body
 *     scroll or traps Tab, so it can never strand keyboard focus if a
 *     click lands elsewhere without going through the documented close
 *     paths (Escape / outside click / picking an item).
 *
 * F-128 reskin ("Seoul Day & Night") — a pure visual pass; every behavior
 * documented above is unchanged. Devices adopted:
 *   - `PageHubHeader` (#4 skyline + #2 rail) replaces the bare `Topbar`,
 *     height-capped for this page (see "Layout" above).
 *   - The "Discuss the page you were on?" popup (Slice 3) is now a real
 *     `CityCard` — one distinct, non-repeating surface, so the full
 *     hero-card treatment (outer glow in Night, hanji paper in Day) fits
 *     exactly the mockup's `.sign` card recipe. The outer `role="dialog"`
 *     wrapper (ref/aria/focus-trap target) is untouched; `CityCard` is
 *     purely its visual child.
 *   - Message bubbles deliberately do NOT nest a `CityCard` each — the
 *     mockup's own bubble CSS (`.bub.ai`/`.bub.me`) specifies an INSET
 *     hairline/tone ring, not `CityCard`'s outer hero glow, because a
 *     thread can hold dozens of bubbles and stacking dozens of glowing
 *     hero cards would read as visual noise rather than "one signboard".
 *     Bubbles instead consume the SAME shared primitive `CityCard` reads —
 *     the `km-tone--accent` utility class (`styles/seoul-devices.css`)
 *     that resolves `--km-tone` — and apply CityCard.css's day/night
 *     gradient formula at bubble scale (Chat.css). Tutor = hanji paper
 *     (Day) / dark gradient + inset tone ring (Night); user = solid
 *     accent fill, per the mockup's `.bub.me`.
 *   - The sidebar's CURRENT conversation row gets a `DancheongRail` leading
 *     edge (#2) instead of a bare colored dot only.
 *   - The thread panel carries `.km-giwa` (#3, ambient section-ground
 *     texture) always, and `.km-hangul-watermark` (#6, data-glyph "대화")
 *     only while the thread is genuinely empty (no real turns yet) — a
 *     long real conversation doesn't need a giant watermark competing
 *     with dozens of bubbles.
 *   - The page root carries `.km-rain-sheen` (#8, Night-only ambient sheen
 *     — the utility's own CSS gates it to `[data-theme="dark"]`).
 *   - Contrast fix surfaced BY the reskin: the failed-row "retry" chip used
 *     to render in `--vermilion` against a neutral bubble background; now
 *     that failed rows (always role=user) sit on a solid accent-filled
 *     bubble, reusing the same `--vermilion` text would be invisible
 *     against its own background. The failed-row retry chip therefore
 *     uses `--on-vermilion` (underline for the interactive affordance,
 *     never a color swap that could dip under AA) instead.
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
import { PageHubHeader } from '../components/PageHubHeader';
import { CityCard } from '../components/CityCard';
import { DancheongRail } from '../components/DancheongRail';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { useModalA11y } from '../hooks/useModalA11y';
import { useSettings } from '../hooks/useSettings';
import { loadConversationMock } from '../data/mocks/chat';
import { readChatSeedState, type ChatSeedState } from '../lib/askSeed';
import {
  buildContextSeed,
  readChatOpenState,
  type ChatOpenRequest,
} from '../lib/chatContext';
import { cn } from '../lib/cn';
import { navItem } from '../lib/nav';
import * as conversationService from '../services/conversation';
import { ApiError, getApiBaseUrl } from '../services/api';
import { errorMessageFor, imageUploadErrorMessage } from '../lib/errorCopy';
import type {
  Conversation,
  ConversationMessage,
  ConversationMode,
  ConversationRow,
  ConversationsList,
  StoredConversationTurn,
} from '../types/domain';
import './Chat.css';

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const CHAT_NAV = navItem('chat');

/** Default opener used while a NEW (or empty) conversation is active. */
const FALLBACK_OPENER: ConversationMessage = {
  role: 'tutor',
  kr: '안녕하십니까. 오늘은 재택근무의 장단점에 대해 이야기해 보겠습니다.',
  en: "Hello. Today we'll discuss the pros and cons of remote work.",
};

/**
 * Opener for a FAB-opened fresh conversation (Slice 3 — mockup copy).
 * Message CONTENT like `FALLBACK_OPENER` (rendered as a tutor bubble whose
 * EN line follows the English toggle), so it is deliberately NOT
 * `<Bilingual>` chrome, and it is never run through `personalise` (that
 * helper rewrites the remote-work greeting specifically).
 */
const ASK_OPENER: ConversationMessage = {
  role: 'tutor',
  kr: '무엇에 대해 이야기하고 싶으세요?',
  en: 'What would you like to chat about?',
};

/** `accept` filter for the composer's photo inputs (camera + image-library
 *  menu items) — mirrors the server's jpeg/png/webp allowlist (convenience
 *  only; the server re-sniffs magic bytes). */
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

/** Client-side pre-check ceiling — the server's own multer cap is 8 MiB. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** `accept` filter for the "Upload document" menu item — mirrors the
 *  server's plain-text/markdown allowlist (`docAttach.ts` ALLOWED_DOC_MIMES).
 *  Extensions are included too: some OSes report a bare `.txt`/`.md` with no
 *  (or a generic) MIME type, which would otherwise fail the browser's picker
 *  filter even though the server would happily accept the bytes. */
const DOC_ACCEPT = 'text/plain,text/markdown,.txt,.md';

/** Client-side pre-check ceiling — mirrors the server's 256 KiB cap
 *  (`docAttach.ts` MAX_DOC_UPLOAD_BYTES; a chat attachment is a note, not a
 *  book). */
const MAX_DOC_BYTES = 256 * 1024;

/** Declared-mime allowlist for the client pre-check — mirrors
 *  `docAttach.ts` ALLOWED_DOC_MIMES. Convenience only (many OSes report an
 *  empty type for a bare `.txt`, so an empty `file.type` is never rejected
 *  here); the server's UTF-8 decode is the real authority. */
const ALLOWED_DOC_TYPES: readonly string[] = ['text/plain', 'text/markdown'];

/** Fixed copy when an attachment upload (image OR document) hit a stale
 *  `expected_version` (409). The thread is refetched (authoritative
 *  version) so a retry can succeed. Shared across both upload kinds — the
 *  cause and the recovery are identical either way. */
const ATTACHMENT_CONFLICT_COPY =
  'This conversation changed — reloading it. Try again.';

/** Server start mode — kept here (one screen, one mode) to avoid a config dep. */
const DEFAULT_START_MODE = 'casual' as const;

/** Fixed copy when a conversation's history fails to load (F-UP-018 —
 *  never the server's prose). */
const HISTORY_FAILED_COPY = 'This conversation could not be loaded.';

/** Fixed copy when "New chat" fails to start a conversation. */
const NEW_CHAT_FAILED_COPY = 'Could not start a new chat. Try again.';

/** localStorage key for the persisted sidebar-collapsed preference. */
const SIDEBAR_COLLAPSED_KEY = 'km.chat.sidebar-collapsed';

/** Max characters for a derived (first-user-message) sidebar title. */
const TITLE_SNIPPET_MAX = 42;

/** Number of items in the "+" attach menu (Camera / Upload image / Upload
 *  document) — the roving-tabindex bound for its keyboard navigation. */
const ATTACH_ITEM_COUNT = 3;

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

/**
 * Fixed copy for a failed document attach (`POST /conversation/:id/file`,
 * F-035 backend — see `docAttach.ts`). Kept local (unlike
 * `imageUploadErrorMessage`) because only Chat attaches documents; there is
 * no second surface to share copy with. Keyed on the structured
 * status/code only — server prose (which could include a raw UTF-8 decode
 * failure detail) is never echoed.
 *
 * Two DIFFERENT 400s reach this route and must not share copy: a generic
 * format/encoding rejection (empty file, non-UTF-8 bytes, wrong declared
 * type) vs. the shared prompt-injection guard flagging otherwise-well-formed
 * text (`docAttach.ts`'s `ContentRejectedError`, `code: 'content_rejected'`).
 * Folding both into "wrong format" would send a user with a genuinely clean
 * `.txt` off re-encoding or renaming a file that was never going to be
 * accepted — the `code` field (structured, not prose) is the discriminator.
 */
function docUploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return err.retryAfter !== undefined
        ? `Rate-limited. Try again in about ${String(Math.ceil(err.retryAfter))} seconds.`
        : 'Rate-limited right now. Wait a moment and try again.';
    }
    if (err.status === 413) {
      return 'That file is too large. Pick one under 256 KB.';
    }
    if (err.code === 'content_rejected') {
      return "That document's content can't be sent to the tutor. Try a different file.";
    }
    if (err.status === 400) {
      return "That file couldn't be attached. Use a plain text (.txt or .md) file under 256 KB.";
    }
    if (err.code === 'network') {
      return 'Network unreachable. Check your connection and try again.';
    }
  }
  return 'Attachment failed. Try again.';
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
 * Join a server-relative blob path onto the API base — the same rule
 * `services/images.ts` `blobUrlFor` applies (same-origin in prod, absolute
 * base in dev). The path only ever originates from a server response.
 */
function joinApiPath(path: string): string {
  const base = getApiBaseUrl();
  return base === '' ? path : `${base}${path}`;
}

/**
 * Map ONE wire turn (`StoredConversationTurn`, role user/assistant) into a
 * render row (role user/tutor). Image turns carry the OCR'd Korean text as
 * `content` (CONTENT — rendered like any message text); their English
 * caption rides as the bubble's EN line (the English toggle governs
 * display) and the image itself renders above the text via `row.image`.
 * Document turns (F-035) carry the document's own text as `content` and a
 * small file chip (`row.file`) above it — no English caption (there is
 * none to show).
 */
function storedTurnToRow(turn: StoredConversationTurn): ThreadRow {
  return {
    role: turn.role === 'assistant' ? 'tutor' : 'user',
    kr: turn.content,
    en: turn.image?.caption_en ?? '',
    ...(turn.image !== undefined
      ? { image: { src: joinApiPath(turn.image.blob_url) } }
      : {}),
    ...(turn.file !== undefined
      ? { file: { name: turn.file.name, truncated: turn.file.truncated } }
      : {}),
  };
}

/** Map the wire history into render rows. */
function mapStoredTurns(turns: StoredConversationTurn[]): ThreadRow[] {
  return turns.map(storedTurnToRow);
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
  /** Present on image turns (Slice 3) — the photo renders above the text. */
  image?: { src: string };
  /** Present on document turns (F-035) — a small file chip renders above
   *  the text. */
  file?: { name: string; truncated: boolean };
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

  // ── FAB open request (Slice 3) ─────────────────────────────────────
  // The shell ChatFab navigates here with a `ChatOpenState` (discriminated
  // by `kmChatOpen`, so an F-020 seed can never be misread as one). Same
  // once-at-mount lazy capture + untrusted-state narrowing as the seed.
  const [openRequest] = useState<ChatOpenRequest | null>(() =>
    readChatOpenState(location.state),
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
  // Derived sidebar titles (first user message snippet) — the FALLBACK
  // shown before a real title resolves. Learned from a history load or
  // this session's first send.
  const [titles, setTitles] = useState<ReadonlyMap<number, string>>(
    () => new Map<number, string>(),
  );
  // Real titles (F-036) — user-set or Claude auto-generated — learned this
  // session from a history load's `title` field or a successful
  // `nameConversation` call. Takes precedence over `titles` and the list
  // row's own `title` at render (see `rows.map` below); a separate map
  // (rather than folding into `titles`) keeps "confirmed name" and "derived
  // guess" from ever being confused with each other.
  const [confirmedTitles, setConfirmedTitles] = useState<
    ReadonlyMap<number, string>
  >(() => new Map<number, string>());
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
  // state — is DERIVED, so mount needs no list-adoption effect. A FAB
  // entry (Slice 3) pre-selects the pending 'new' thread: the FAB always
  // opens a NEW conversation (lazy-started on first send so an abandoned
  // open never creates an empty server row) while prior conversations stay
  // in the sidebar.
  const [selectedKey, setSelectedKey] = useState<ActiveKey | null>(() =>
    openRequest !== null ? 'new' : null,
  );
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
  // B-020: this is the ONLY thing the switch controls (F-034 removed the
  // reply-starter chips it used to also gate) — its visible label in the
  // Topbar now names that purpose directly instead of the ambiguous
  // "Show hints".
  const [showEnglish, setShowEnglish] = useState<boolean>(true);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // "New chat" in-flight latch — the button is disabled while starting.
  const [creating, setCreating] = useState<boolean>(false);

  // ── "Discuss the page you were on?" popup (Slice 3) ────────────────
  // Open exactly when the FAB entry carried a page context; a no-context
  // FAB entry skips straight to the generic ASK_OPENER. Lazy initializer —
  // the popup can only ever arm at mount, mirroring the seed contract.
  const popupContext = openRequest?.context ?? null;
  const [contextPopupOpen, setContextPopupOpen] = useState<boolean>(
    () => popupContext !== null,
  );
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Composer focus target for "New chat" + the popup's dismiss handlers.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Settle the popup. Yes → pre-fill the composer with the generic context
   * seed (F-020's pattern: pre-fill only, never auto-sent, never clobbers
   * text the user somehow already typed). Either way focus the composer —
   * deferred a macrotask so it lands AFTER useModalA11y's microtask focus
   * restore (which would otherwise fire last and win).
   */
  const answerContextPopup = useCallback(
    (useIt: boolean): void => {
      setContextPopupOpen(false);
      if (useIt && popupContext !== null) {
        const seed = buildContextSeed(popupContext);
        setInput((prev) => (prev.trim() === '' ? seed : prev));
      }
      window.setTimeout(() => {
        composerRef.current?.focus();
      }, 0);
    },
    [popupContext],
  );
  const dismissContextPopup = useCallback((): void => {
    // Esc = No (the popup is an offer, not a gate).
    answerContextPopup(false);
  }, [answerContextPopup]);

  // List-level failure: the loader truly failed AND no mock came through.
  const hasNothingToShow = !data;

  // The popup's DOM lives inside the LOADED branch of the screen — the
  // skeleton (loading) and list-error branches never mount it. useModalA11y
  // must therefore arm on this render-accurate flag, NOT on
  // `contextPopupOpen` alone: in prod the list fetch is async, so the first
  // render is always the skeleton, and an unconditionally-armed hook would
  // run its container-reading effects (initial focus + Tab trap, keyed on
  // `open` only) once against a null `popupRef` and never re-arm — a dialog
  // claiming `aria-modal` with no focus trap — while the body scroll lock
  // (container-free) would leak onto the skeleton/error screens with no
  // dialog ever mounting to release it (Slice-3 review B-1).
  const contextPopupVisible =
    contextPopupOpen && popupContext !== null && !loading && !hasNothingToShow;
  useModalA11y({
    open: contextPopupVisible,
    onClose: dismissContextPopup,
    containerRef: popupRef,
  });

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

  // Mounted marker for async handlers that have no AbortSignal to thread
  // (startConversation). Re-armed on StrictMode remount.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Clear the consumed seed / FAB open-request out of router/history state
  // so a reload or a back-navigation to /chat never re-seeds the composer
  // (F-020) or re-arms the popup (Slice 3). Navigation is a side effect
  // (not a state set), and the ref-guard makes it fire at most once even
  // though the replace itself changes `location` identity.
  const seedClearedRef = useRef<boolean>(false);
  useEffect(() => {
    if (
      (chatSeed === null && openRequest === null) ||
      seedClearedRef.current
    ) {
      return;
    }
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
  }, [
    chatSeed,
    openRequest,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);

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
        // F-036: a real title (user-set or previously auto-generated) rides
        // the detail envelope — record it so it wins over the derived
        // snippet even before the sidebar's own list row catches up.
        const confirmedTitle = detail.title;
        if (confirmedTitle !== null) {
          setConfirmedTitles((prev) =>
            prev.get(detail.id) === confirmedTitle
              ? prev
              : new Map(prev).set(detail.id, confirmedTitle),
          );
        }
        setLoaded({ key: detail.id, empty: detail.messages.length === 0 });
        setAnnounce(`Conversation loaded: ${detail.title ?? title ?? 'chat'}`);
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
    // While the context popup is up the opener stays hidden (mockup: the
    // opener bubble appears only once the popup is answered).
    if (contextPopupOpen) return [];
    // A FAB entry (Slice 3) swaps the default greeting for the generic
    // "what would you like to chat about?" opener on every empty thread of
    // this visit — the FAB's contract is a fresh, topic-open conversation.
    const opener: Conversation =
      openRequest !== null
        ? [ASK_OPENER]
        : personalise([FALLBACK_OPENER], settings.name);
    if (serverList !== null) {
      if (activeId === null) {
        return opener;
      }
      if (loaded?.key === activeId && loaded.empty) {
        return opener;
      }
      return [];
    }
    if (mockSeed.length > 0) {
      return personalise(mockSeed, settings.name);
    }
    return [];
  }, [
    contextPopupOpen,
    openRequest,
    serverList,
    activeId,
    loaded,
    mockSeed,
    settings.name,
  ]);

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

  // ── In-flight attachment upload tracking (image OR document) ───────
  // Same discipline as sends: one controller per upload, aborted on
  // unmount and on conversation switch (a late OCR/doc turn must never
  // append into a different thread). Shared across camera/image/document —
  // only one attachment can be in flight at a time (the menu items and the
  // Send button all gate on `uploading`).
  const [uploading, setUploading] = useState<boolean>(false);
  const uploadCtrlRef = useRef<AbortController | null>(null);
  // Three hidden inputs behind the "+" menu — see the "Attachments" header
  // section for why camera/image are two separate inputs (the `capture`
  // attribute) rather than one toggled dynamically.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    return () => {
      uploadCtrlRef.current?.abort();
    };
  }, []);

  // ── "+" attach menu (F-035) ─────────────────────────────────────────
  // Non-modal popup menu (WAI-ARIA menu-button pattern) — see the header's
  // "Attachments" section for why this is deliberately NOT useModalA11y.
  const [attachMenuOpen, setAttachMenuOpen] = useState<boolean>(false);
  const attachTriggerRef = useRef<HTMLButtonElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  // Roving-tabindex bookkeeping for the three `menuitem`s (Camera / Upload
  // image / Upload document, in DOM order). Only the item at
  // `attachActiveIndex` carries `tabIndex={0}`; the rest carry `-1` — the
  // APG menu-button pattern's roving-tabindex scheme, so a single Tab moves
  // focus straight out of the menu (see the Tab handler below) instead of
  // stepping through all three items first.
  const attachItemRefs = useRef<Array<HTMLButtonElement | null>>(
    Array<HTMLButtonElement | null>(ATTACH_ITEM_COUNT).fill(null),
  );
  const [attachActiveIndex, setAttachActiveIndex] = useState<number>(0);
  // A REF mirror of `attachActiveIndex`, read by the keydown handler below.
  // The listener-attaching effect must NOT depend on `attachActiveIndex`
  // itself: if it did, every arrow-key move would re-run that effect, and
  // re-running it would re-execute its "menu just opened" reset (see the
  // next effect) — snapping focus straight back to item 0 on every single
  // keypress. The ref lets the handler always read the CURRENT index
  // without the effect needing to re-subscribe when it changes.
  const attachActiveIndexRef = useRef<number>(0);
  const setAttachItemRef = useCallback(
    (index: number) =>
      (el: HTMLButtonElement | null): void => {
        attachItemRefs.current[index] = el;
      },
    [],
  );

  const closeAttachMenu = useCallback((refocusTrigger: boolean): void => {
    setAttachMenuOpen(false);
    if (refocusTrigger) attachTriggerRef.current?.focus();
  }, []);

  const toggleAttachMenu = useCallback((): void => {
    setAttachMenuOpen((open) => !open);
  }, []);

  const focusAttachItem = useCallback((index: number): void => {
    const wrapped = (index + ATTACH_ITEM_COUNT) % ATTACH_ITEM_COUNT;
    attachActiveIndexRef.current = wrapped;
    setAttachActiveIndex(wrapped);
    attachItemRefs.current[wrapped]?.focus();
  }, []);

  // Runs ONLY when the menu transitions open (not on every keypress): focus
  // the first item so keyboard users land inside it immediately, and reset
  // the roving-tabindex pointer to match.
  useEffect(() => {
    if (!attachMenuOpen) return;
    focusAttachItem(0);
  }, [attachMenuOpen, focusAttachItem]);

  // Keyboard/pointer handling while the menu is open. Escape closes +
  // refocuses the trigger. ArrowUp/ArrowDown/Home/End move the
  // roving-tabindex focus among the three items (wrapping at each end). Tab
  // closes the popup WITHOUT stopping the browser's own default action —
  // i.e. it doesn't trap focus — so the menu never sits open+orphaned once
  // focus has moved on to the next (or, on Shift+Tab, the previous) control;
  // it just stops being visible once focus has left it. A mousedown outside
  // the menu AND outside the trigger closes it the same way, without moving
  // focus (the click itself is left to do whatever it was going to do).
  useEffect(() => {
    if (!attachMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAttachMenu(true);
        return;
      }
      if (e.key === 'Tab') {
        // Don't preventDefault: let the browser move focus (forward past
        // the last item, or backward — e.g. Shift+Tab from the first item
        // back to the trigger) exactly as it would for any other control;
        // we only need to stop rendering the popup so it can't be left
        // open and visually orphaned once focus is gone.
        closeAttachMenu(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusAttachItem(attachActiveIndexRef.current + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusAttachItem(attachActiveIndexRef.current - 1);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        focusAttachItem(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        focusAttachItem(ATTACH_ITEM_COUNT - 1);
      }
    };
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (attachMenuRef.current?.contains(target)) return;
      if (attachTriggerRef.current?.contains(target)) return;
      closeAttachMenu(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [attachMenuOpen, closeAttachMenu, focusAttachItem]);

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
          title: null,
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
      // Abort any in-flight stream / image upload — both belong to the
      // previous thread.
      sendCtrlRef.current?.abort();
      uploadCtrlRef.current?.abort();
      setSendError(null);
      setHistoryError(null);
      setSelectedKey(id);
      // Invalidate the thread cache: `msgs` is cleared below, so whatever
      // conversation `loaded` says the thread holds is no longer rendered.
      // Without this, a fast A→B→A bounce (B's fetch still pending, so
      // `loaded` still names A) hits the history effect's early return and
      // leaves A permanently blank. The `id === activeKey` guard above keeps
      // re-clicking the current row refetch-free, so the normal
      // already-loaded case never refetches redundantly.
      setLoaded(null);
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
    uploadCtrlRef.current?.abort();
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
  // Lazy-start latch — two rapid sends while the pending-'new' thread is
  // active must share ONE `startConversation` (without it, each send creates
  // its own conversation and the two messages split across two threads).
  // The second caller awaits the first's in-flight promise. A failed start
  // clears the latch so Retry can start fresh; a successful one needs no
  // clearing — adoption sets `activeId`, so the latch is never consulted
  // again for this thread.
  const lazyStartRef = useRef<Promise<number> | null>(null);

  const ensureActiveConversationId = useCallback(async (): Promise<number> => {
    if (activeId !== null) return activeId;
    if (lazyStartRef.current !== null) return lazyStartRef.current;
    const mode = chatSeed?.mode ?? DEFAULT_START_MODE;
    const pending = (async (): Promise<number> => {
      const started = await conversationService.startConversation({ mode });
      versionRef.current = 1;
      // Post-unmount, adopting would only set state on a dead tree; the
      // callers' own mounted-guards stop the stream from opening.
      if (mountedRef.current) {
        adoptStartedConversation(started.conversation.id, mode, {
          clearThread: false,
        });
      }
      return started.conversation.id;
    })();
    lazyStartRef.current = pending;
    void pending.catch((): void => {
      if (lazyStartRef.current === pending) lazyStartRef.current = null;
    });
    return pending;
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

  // Per-session latch: at most one `nameConversation` call in flight (or
  // already answered) per conversation id, so repeatedly calling
  // `triggerAutoName` after every turn never spams the endpoint even though
  // the endpoint itself is idempotent server-side.
  const namedRef = useRef<ReadonlySet<number>>(new Set());

  /**
   * F-036 — fire-and-forget auto-naming trigger. Called once an assistant
   * turn is durably persisted (`runStream`'s `onDone`). `nameConversation`
   * 200s immediately with NO Claude call if the conversation is already
   * named, so calling this after every turn is cheap; `namedRef` still
   * latches so a session only ever makes ONE round trip per conversation
   * once that round trip has succeeded. A failure releases the latch
   * (silently — this is a cosmetic enhancement, never a user-facing error)
   * so a transient failure gets another chance on the next turn.
   */
  const triggerAutoName = useCallback((convId: number): void => {
    if (namedRef.current.has(convId)) return;
    namedRef.current = new Set(namedRef.current).add(convId);
    void conversationService.nameConversation(convId).then(
      (res) => {
        if (!mountedRef.current) return;
        setConfirmedTitles((prev) =>
          prev.get(convId) === res.title
            ? prev
            : new Map(prev).set(convId, res.title),
        );
      },
      () => {
        // Release the latch so a later turn can retry — see doc above.
        namedRef.current = new Set(
          [...namedRef.current].filter((id) => id !== convId),
        );
      },
    );
  }, []);

  /**
   * Upload one photo onto the active conversation (Slice 3). The server
   * OCRs it and appends ONE user turn (OCR'd Korean `content` + image
   * block); on success that turn renders in the thread and the version
   * snapshot advances to the server's post-append value. Client pre-checks
   * mirror the server limits for fast feedback only — the server re-sniffs
   * magic bytes and re-enforces the cap. Fixed-copy failures only
   * (`imageUploadErrorMessage` — shared with the Images screen); a 409
   * invalidates the loaded thread so the history effect refetches the
   * authoritative version before the user retries.
   */
  const uploadImageFile = useCallback(
    (file: File): void => {
      if (uploading || streaming || !threadReady) return;
      // Pre-checks reuse the shared fixed copy by synthesising the matching
      // structured error — one source of truth for the strings, zero drift.
      if (file.size > MAX_IMAGE_BYTES) {
        setSendError(
          imageUploadErrorMessage(
            new ApiError('client size pre-check', {
              status: 413,
              code: 'payload_too_large',
            }),
          ),
        );
        return;
      }
      if (file.type !== '' && !IMAGE_ACCEPT.split(',').includes(file.type)) {
        setSendError(
          imageUploadErrorMessage(
            new ApiError('client type pre-check', {
              status: 400,
              code: 'unsupported_image',
            }),
          ),
        );
        return;
      }
      setSendError(null);
      setUploading(true);
      // Pin the derived default selection — same rule as `send`.
      if (selectedKey === null && typeof activeKey === 'number') {
        setSelectedKey(activeKey);
      }
      const ctrl = new AbortController();
      uploadCtrlRef.current = ctrl;
      void (async (): Promise<void> => {
        try {
          const convId = await ensureActiveConversationId();
          // Unmounted / switched away during a lazy start — nothing to
          // upload into anymore.
          if (!mountedRef.current || ctrl.signal.aborted) return;
          const result = await conversationService.uploadConversationImage(
            convId,
            file,
            versionRef.current,
            ctrl.signal,
          );
          if (ctrl.signal.aborted) return;
          versionRef.current = result.version;
          setMsgs((prev) => [...prev, storedTurnToRow(result.turn)]);
          learnTitleFromSend(convId, result.turn.content);
          setTouchedAt((prev) =>
            new Map(prev).set(convId, new Date().toISOString()),
          );
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          if (err instanceof ApiError && err.status === 409) {
            // Stale expected_version — drop the loaded-thread cache so the
            // history effect refetches (thread AND authoritative version).
            setLoaded(null);
            setSendError(ATTACHMENT_CONFLICT_COPY);
            return;
          }
          setSendError(imageUploadErrorMessage(err));
        } finally {
          if (uploadCtrlRef.current === ctrl) uploadCtrlRef.current = null;
          if (mountedRef.current) setUploading(false);
        }
      })();
    },
    [
      activeKey,
      ensureActiveConversationId,
      learnTitleFromSend,
      selectedKey,
      streaming,
      threadReady,
      uploading,
    ],
  );

  /**
   * Attach one text document onto the active conversation (F-035). Mirrors
   * `uploadImageFile`'s contract exactly (shared `uploading`/`uploadCtrlRef`
   * so the two are mutually exclusive; same lazy-start / version / abort
   * discipline; same 409 → invalidate-and-refetch handling) but targets
   * `uploadConversationFile` and the document pre-checks/copy instead of
   * the image ones — kept as a separate function rather than a shared
   * generic because the two pre-check shapes (mime allowlist vs. UTF-8
   * text) and result shapes genuinely differ, and a two-call-site generic
   * would add more indirection than the ~30 duplicated lines it removes.
   */
  const uploadDocumentFile = useCallback(
    (file: File): void => {
      if (uploading || streaming || !threadReady) return;
      if (file.size > MAX_DOC_BYTES) {
        setSendError(
          docUploadErrorMessage(
            new ApiError('client size pre-check', {
              status: 413,
              code: 'payload_too_large',
            }),
          ),
        );
        return;
      }
      if (file.type !== '' && !ALLOWED_DOC_TYPES.includes(file.type)) {
        setSendError(
          docUploadErrorMessage(
            new ApiError('client type pre-check', {
              status: 400,
              code: 'unsupported_document',
            }),
          ),
        );
        return;
      }
      setSendError(null);
      setUploading(true);
      if (selectedKey === null && typeof activeKey === 'number') {
        setSelectedKey(activeKey);
      }
      const ctrl = new AbortController();
      uploadCtrlRef.current = ctrl;
      void (async (): Promise<void> => {
        try {
          const convId = await ensureActiveConversationId();
          if (!mountedRef.current || ctrl.signal.aborted) return;
          const result = await conversationService.uploadConversationFile(
            convId,
            file,
            versionRef.current,
            ctrl.signal,
          );
          if (ctrl.signal.aborted) return;
          versionRef.current = result.version;
          setMsgs((prev) => [...prev, storedTurnToRow(result.turn)]);
          learnTitleFromSend(convId, result.turn.content);
          setTouchedAt((prev) =>
            new Map(prev).set(convId, new Date().toISOString()),
          );
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          if (err instanceof ApiError && err.status === 409) {
            setLoaded(null);
            setSendError(ATTACHMENT_CONFLICT_COPY);
            return;
          }
          setSendError(docUploadErrorMessage(err));
        } finally {
          if (uploadCtrlRef.current === ctrl) uploadCtrlRef.current = null;
          if (mountedRef.current) setUploading(false);
        }
      })();
    },
    [
      activeKey,
      ensureActiveConversationId,
      learnTitleFromSend,
      selectedKey,
      streaming,
      threadReady,
      uploading,
    ],
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
              // F-036: the assistant turn is now durably persisted — this is
              // "after the first exchange" for a brand-new conversation, and
              // a cheap idempotent no-op for one that's already named.
              triggerAutoName(convId);
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
    [triggerAutoName],
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
    // `uploading` gates too (symmetric with the camera button's gate on
    // `streaming`): a text send fired while an image upload is in flight
    // would carry the SAME expected_version as the upload, so the server
    // is guaranteed to 409 one of them — a wasted Claude stream or Vision
    // call the client can simply prevent (Slice-3 image review SF-1).
    if (streaming || uploading || !threadReady) return;
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
        // Unmounted while the lazy-start was in flight? Opening the SSE now
        // would stream a real Claude turn into a dead tree with nothing left
        // to abort it — the unmount cleanup already ran and `runStream`
        // would mint a fresh controller it never sees.
        if (!mountedRef.current) return;
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
    uploading,
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
          // Same post-unmount guard as `send` — never open a stream the
          // unmount cleanup can no longer abort.
          if (!mountedRef.current) return;
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

  return (
    <section
      className="screen km-chat km-rain-sheen"
      aria-labelledby="chat-title"
      style={{ position: 'relative', padding: '0 18px 32px' }}
    >
      {isMock ? <MockBadge /> : null}

      {/* F-128 devices #4/#2 — the shared hub-header recipe (same one
          Grammar/Uploads/ReviewLibrary use) instead of a bare `Topbar`;
          `km-chat__hub` height-caps the skyline banner (Chat.css) so it
          doesn't eat the thread's vertical budget. */}
      <PageHubHeader
        className="km-chat__hub"
        titleId="chat-title"
        eyebrow={<Bilingual en={CHAT_NAV.eyebrow} kr={CHAT_NAV.krEyebrow} />}
        heading={<Bilingual kr="대화" en="Chat" />}
        actions={
          // B-020: the switch used to render with only an `aria-label` — its
          // purpose was invisible to sighted users. A visible bilingual
          // caption now sits beside it (same convention as Settings' named
          // toggle rows); the Toggle's own `ariaLabel` stays the
          // authoritative accessible name for AT. This wrapper is a real
          // `<label>` (not a bare `<span>`) precisely BECAUSE it carries
          // `cursor: pointer` (Chat.css) — a `<button>` is a labelable
          // element, so wrapping it in a `<label>` makes the whole row
          // (including the "English · 영어" text) actually clickable via the
          // browser's built-in label→control delegation, matching the
          // pointer cursor's affordance instead of contradicting it.
          <label className="km-chat__engToggle">
            <span className="km-chat__engToggleLabel km-eyebrow">
              <Bilingual en="English" kr="영어" />
            </span>
            <Toggle
              ariaLabel="Show English translations"
              checked={showEnglish}
              onChange={setShowEnglish}
            />
          </label>
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
            {/* F-128: the shared ghost `Button` (soft accent fill, Seoul
                pill/glow treatment) instead of a hand-rolled button — one
                less bespoke control to keep in sync with the design
                system. */}
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              className="km-chat__newChat"
              onClick={startNewChat}
              disabled={creating}
              aria-busy={creating ? 'true' : 'false'}
              aria-label="New chat"
              leadingIcon={<Icon name="plus" size={14} />}
            >
              {!collapsed ? <Bilingual en="New chat" kr="새 대화" /> : undefined}
            </Button>
            <ul
              id="chat-conversations"
              className="km-chat__convList"
              aria-label="Conversation history"
            >
              {rows.map((row) => {
                const isActive = row.id === activeKey;
                // F-036 precedence: a real title (this session's naming call
                // or the server's own list row) wins; otherwise fall back to
                // the derived snippet, then mode + date. See the header's
                // "Auto-naming" section.
                const title =
                  confirmedTitles.get(row.id) ??
                  row.title ??
                  titles.get(row.id) ??
                  fallbackTitle(row);
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
                      {/* F-128 device #2 — the current conversation gets a
                          DancheongRail leading edge instead of only the
                          colored dot below (Chat.css gives the row
                          `position: relative` + `overflow: hidden` so the
                          rail's absolute edge clips to the row's own
                          rounded corners). Decorative like every other
                          DancheongRail use — `aria-current` above already
                          carries the "this is the active row" fact for AT. */}
                      {isActive ? (
                        <DancheongRail
                          tone="accent"
                          className="km-chat__convRail"
                        />
                      ) : null}
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
            {/* "Discuss the page you were on?" (Slice 3) — modal offer of
                the page context the FAB carried in. Focus-trapped via
                useModalA11y; Esc = No. Page label/summary are descriptor
                text (rendered as escaped text nodes); the button labels are
                chrome → Bilingual. Gated on `contextPopupVisible` (the same
                flag useModalA11y arms on) so the hook and the DOM can never
                disagree about whether the dialog exists (B-1). */}
            {contextPopupVisible && popupContext !== null ? (
              <>
                {/* Backdrop — makes the dialog's aria-modal="true" honest
                    for pointer users too: the sidebar/thread behind the
                    offer is not clickable while it is up; clicking the
                    scrim answers No (same as Esc). Mouse/touch only
                    (tabIndex -1) — keyboard dismissal is Esc, and the Tab
                    trap confines focus to the dialog. Same fixed-inset
                    button pattern as WordPopover/Sheet backdrops. */}
                <button
                  type="button"
                  className="km-chat__askpopBackdrop"
                  aria-label="Dismiss — start fresh"
                  tabIndex={-1}
                  data-testid="chat-askpop-backdrop"
                  onClick={() => {
                    answerContextPopup(false);
                  }}
                />
                <div
                  ref={popupRef}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="chat-askpop-title"
                  className="km-chat__askpopWrap"
                >
                  {/* F-128 device #1 — a real `CityCard` (hanji paper Day /
                      neon signboard Night, `feat` for hero emphasis). One
                      distinct, non-repeating surface — unlike the message
                      bubbles below, there's exactly one of these on screen
                      at a time, so the full hero-card treatment fits. The
                      outer div above stays the a11y/focus-trap target
                      (`popupRef`); this is purely its visual child. */}
                  <CityCard tone="accent" feat className="km-chat__askpop">
                    <div id="chat-askpop-title" className="km-chat__askpopTitle">
                      <Bilingual
                        en="Discuss the page you were on?"
                        kr="보던 페이지에 대해 이야기할까요?"
                      />
                    </div>
                    <div className="km-chat__askpopCtx">
                      <span className="km-eyebrow">
                        <Bilingual en="From" kr="이전 화면" />
                      </span>
                      <span className="km-chat__askpopFrom">
                        {popupContext.pageLabel} — {popupContext.summary}
                      </span>
                    </div>
                    <div className="km-chat__askpopRow">
                      <Button
                        variant="gold"
                        size="sm"
                        onClick={() => {
                          answerContextPopup(true);
                        }}
                      >
                        <Bilingual en="Yes, use it" kr="네, 좋아요" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          answerContextPopup(false);
                        }}
                      >
                        <Bilingual en="No, start fresh" kr="아니요, 새로 시작" />
                      </Button>
                    </div>
                  </CityCard>
                </div>
              </>
            ) : null}
            <div
              ref={scrollRef}
              className={cn(
                'km-chat__thread',
                // F-128 device #3 — a faint roof-tile/city-grid ground
                // texture, always present (very low contrast per
                // seoul-devices.css, never competes with bubbles).
                'km-giwa',
                // F-128 device #6 — the giant faint 대화 watermark only
                // while the thread is genuinely empty (no real turns yet
                // — a long real conversation has no room, and no need,
                // for it).
                msgs.length === 0 && 'km-hangul-watermark',
              )}
              {...(msgs.length === 0 ? { 'data-glyph': '대화' } : {})}
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
                    <Bubble key={`base-${String(i)}`} msg={m} showEn={showEnglish} />
                  ))}
                  {msgs.map((m, i) => (
                    <Bubble
                      key={i}
                      msg={m}
                      showEn={showEnglish}
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
                {/* Three hidden pickers behind the "+" menu — camera and
                    image share IMAGE_ACCEPT/uploadImageFile and differ only
                    in `capture` (see the header's "Attachments" section). */}
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  capture="environment"
                  hidden
                  aria-hidden="true"
                  tabIndex={-1}
                  data-testid="chat-camera-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) uploadImageFile(file);
                  }}
                />
                <input
                  ref={imageInputRef}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  hidden
                  aria-hidden="true"
                  tabIndex={-1}
                  data-testid="chat-image-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Clear so re-picking the SAME file re-fires change.
                    e.target.value = '';
                    if (file) uploadImageFile(file);
                  }}
                />
                <input
                  ref={docInputRef}
                  type="file"
                  accept={DOC_ACCEPT}
                  hidden
                  aria-hidden="true"
                  tabIndex={-1}
                  data-testid="chat-file-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) uploadDocumentFile(file);
                  }}
                />
                <div className="km-chat__attach">
                  <Button
                    ref={attachTriggerRef}
                    variant="ghost"
                    size="md"
                    className="km-chat__attachTrigger"
                    onClick={toggleAttachMenu}
                    disabled={uploading || streaming || !threadReady}
                    aria-label="Attach"
                    aria-haspopup="menu"
                    aria-expanded={attachMenuOpen}
                    aria-controls="chat-attach-menu"
                    aria-busy={uploading ? 'true' : 'false'}
                  >
                    <Icon name="plus" size={16} />
                  </Button>
                  {attachMenuOpen ? (
                    <div
                      ref={attachMenuRef}
                      id="chat-attach-menu"
                      role="menu"
                      aria-label="Attach"
                      // F-128: the same shared `--km-tone` mechanism
                      // CityCard/DancheongRail read (seoul-devices.css) —
                      // a Night tone-glow border / Day hairline for this
                      // popover, without duplicating CityCard's own rules.
                      className={cn('km-chat__attachMenu', 'km-tone--accent')}
                    >
                      <button
                        ref={setAttachItemRef(0)}
                        type="button"
                        role="menuitem"
                        tabIndex={attachActiveIndex === 0 ? 0 : -1}
                        className="km-chat__attachItem focusring"
                        onFocus={() => {
                          attachActiveIndexRef.current = 0;
                          setAttachActiveIndex(0);
                        }}
                        onClick={() => {
                          closeAttachMenu(true);
                          cameraInputRef.current?.click();
                        }}
                      >
                        <Icon name="camera" size={16} />
                        <Bilingual en="Camera" kr="카메라" />
                      </button>
                      <button
                        ref={setAttachItemRef(1)}
                        type="button"
                        role="menuitem"
                        tabIndex={attachActiveIndex === 1 ? 0 : -1}
                        className="km-chat__attachItem focusring"
                        onFocus={() => {
                          attachActiveIndexRef.current = 1;
                          setAttachActiveIndex(1);
                        }}
                        onClick={() => {
                          closeAttachMenu(true);
                          imageInputRef.current?.click();
                        }}
                      >
                        <Icon name="image" size={16} />
                        <Bilingual en="Upload image" kr="이미지 업로드" />
                      </button>
                      <button
                        ref={setAttachItemRef(2)}
                        type="button"
                        role="menuitem"
                        tabIndex={attachActiveIndex === 2 ? 0 : -1}
                        className="km-chat__attachItem focusring"
                        onFocus={() => {
                          attachActiveIndexRef.current = 2;
                          setAttachActiveIndex(2);
                        }}
                        onClick={() => {
                          closeAttachMenu(true);
                          docInputRef.current?.click();
                        }}
                      >
                        <Icon name="upload" size={16} />
                        <Bilingual en="Upload document" kr="문서 업로드" />
                      </button>
                    </div>
                  ) : null}
                </div>
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
                  className="km-chat__sendBtn"
                  onClick={send}
                  disabled={
                    !input.trim() || streaming || uploading || !threadReady
                  }
                  aria-label="Send"
                  aria-busy={streaming ? 'true' : 'false'}
                >
                  <Icon name="send" size={16} />
                </Button>
              </div>
              {uploading ? (
                <div role="status" className="km-chat__uploadStatus">
                  <Bilingual en="Uploading…" kr="업로드 중…" />
                </div>
              ) : null}
              {sendError ? (
                <div role="alert" className="km-chat__sendError">
                  {sendError}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Single chat bubble. Tutor left, user right.
 *
 * F-128 reskin — tutor = hanji-paper (Day) / dark-gradient-with-inset-tone-
 * ring (Night) per the mockup's `.bub.ai`; user = solid accent fill per
 * `.bub.me`. Both read `--km-tone` via the shared `km-tone--accent` utility
 * (styles/seoul-devices.css) — the SAME variable CityCard/DancheongRail
 * resolve — rather than nesting a full `CityCard` per bubble (see the
 * page-level doc comment's "F-128 reskin" section for why: a thread can
 * hold dozens of these, and CityCard's outer hero glow was never meant to
 * repeat dozens of times in one scroll region).
 */
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
        className={`km-chat__bubble km-tone--accent${isUser ? ' km-chat__bubble--user' : ' km-chat__bubble--tutor'}${
          isFailed ? ' km-chat__bubble--failed' : ''
        }`}
      >
        <div
          className={`km-eyebrow km-chat__role${!isUser ? ' km-neon-text' : ''}`}
        >
          {isUser ? (
            <Bilingual en="You" kr="나" />
          ) : (
            <Bilingual en="Tutor" kr="튜터" />
          )}
        </div>
        {msg.image ? (
          // Slice 3 image turn — the photo renders above its OCR'd text.
          // Decorative for AT (empty alt): the OCR'd Korean + English
          // caption directly below ARE this image's textual content, so an
          // alt would only announce the same thing twice (and jsx-a11y
          // rightly bans "photo/image" filler labels).
          <img
            className="km-chat__bubbleImg"
            src={msg.image.src}
            alt=""
            data-testid="chat-bubble-image"
          />
        ) : null}
        {msg.file ? (
          // F-035 document turn — a small file chip above the text (its own
          // content, below, IS the document's text — nothing more to show).
          <div className="km-chat__fileChip" data-testid="chat-bubble-file">
            <Icon name="upload" size={14} />
            <span className="km-chat__fileName">{msg.file.name}</span>
            {msg.file.truncated ? (
              <span className="km-chat__fileTruncated">
                <Bilingual en="(truncated)" kr="(일부만)" />
              </span>
            ) : null}
          </div>
        ) : null}
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
          >
            <Bilingual en="failed — retry" kr="실패 — 다시 시도" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default Chat;
