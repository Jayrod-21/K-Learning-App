/**
 * ChatFab — the floating chat dot, ~1/5 up the right edge of the shell
 * (Overhaul P1.1 placement; chat rework Slice 3 behavior).
 *
 * Tapping it opens a NEW conversation (prior ones stay in the Chat
 * sidebar): it navigates to `/chat` carrying a `ChatOpenState` in router
 * state — the force-new discriminator plus the CURRENT page's published
 * `ChatContext` (from the chat-context store, when the page provided one).
 * Chat then shows the "Discuss the page you were on?" popup when a context
 * rode along, or goes straight to the generic opener when none did.
 *
 * Visibility — HIDDEN (renders null) when any of:
 *   - already on `/chat` (a chat button on the chat is noise);
 *   - on `/settings` (deliberate quiet zone per the design);
 *   - a timed TOPIK mock exam is running (`useExamActive` — MockMode lifts
 *     its `phase === 'exam'` flag into shared context; no tutor mid-exam);
 *   - the on-screen keyboard is up (`useKeyboardOpen` — the dot would
 *     hover over / collide with the composer the user is typing into).
 *
 * Path checks use a segment-boundary prefix match so future sub-routes
 * (`/chat/123`, `/settings/security`) inherit the hide, while a sibling
 * like `/chatter` would not.
 */
import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useExamActive } from '../hooks/useExamActive';
import { useKeyboardOpen } from '../hooks/useKeyboardOpen';
import { useCurrentChatContext } from '../hooks/useChatContext';
import { buildChatOpenState } from '../lib/chatContext';
import { Icon } from './Icon';

/** Route prefixes where the FAB stays hidden. `/chat` is the hard-contract
 *  chat path (see AskAboutThisButton.CHAT_PATH — never moves). */
const HIDDEN_PATH_PREFIXES = ['/chat', '/settings'] as const;

function isHiddenPath(pathname: string): boolean {
  // React Router matches routes case-insensitively, so a hand-typed
  // `/Chat` still renders the chat screen — lowercase before comparing so
  // the hide check agrees with the router (prefixes are lowercase by
  // construction).
  const path = pathname.toLowerCase();
  return HIDDEN_PATH_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

export function ChatFab(): JSX.Element | null {
  const location = useLocation();
  const navigate = useNavigate();
  const { examActive } = useExamActive();
  const keyboardOpen = useKeyboardOpen();
  // The CURRENT page's published descriptor (or null). Read unconditionally
  // — hooks must not sit behind the visibility early-return.
  const pageContext = useCurrentChatContext();

  if (isHiddenPath(location.pathname) || examActive || keyboardOpen) {
    return null;
  }

  return (
    <button
      type="button"
      className="km-chatfab focusring"
      aria-label="Open chat · 대화"
      onClick={() => {
        // Slice 3: the FAB always opens a NEW conversation and hands the
        // page's context along (Chat shows the discuss-this-page popup when
        // one exists). Prior conversations stay in the Chat sidebar.
        navigate('/chat', { state: buildChatOpenState(pageContext) });
      }}
    >
      <Icon name="search-fab" size={22} />
    </button>
  );
}
