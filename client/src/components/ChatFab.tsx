/**
 * ChatFab — the floating chat dot, ~1/5 up the right edge of the shell
 * (Overhaul P1.1, per the approved mockup). In P1.1 it simply navigates to
 * the existing `/chat` screen; the chat rework (force-new conversation,
 * context hand-off, sidebar) is P4.
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
import { Icon } from './Icon';

/** Route prefixes where the FAB stays hidden. `/chat` is the hard-contract
 *  chat path (see AskAboutThisButton.CHAT_PATH — never moves). */
const HIDDEN_PATH_PREFIXES = ['/chat', '/settings'] as const;

function isHiddenPath(pathname: string): boolean {
  return HIDDEN_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function ChatFab(): JSX.Element | null {
  const location = useLocation();
  const navigate = useNavigate();
  const { examActive } = useExamActive();
  const keyboardOpen = useKeyboardOpen();

  if (isHiddenPath(location.pathname) || examActive || keyboardOpen) {
    return null;
  }

  return (
    <button
      type="button"
      className="km-chatfab focusring"
      aria-label="Open chat · 대화"
      onClick={() => {
        navigate('/chat');
      }}
    >
      <Icon name="search-fab" size={22} />
    </button>
  );
}
