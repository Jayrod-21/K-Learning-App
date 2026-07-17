/**
 * Sidebar — the persistent LEFT SIDEBAR rail that replaces the bottom-bar
 * at ≥768px (device-adaptive epic, Phase D0 — approved Option A nav model).
 *
 * Unlike `BottomNav`, whose center LEARN hexagon is a LAUNCHER that toggles
 * the overlay `LearnMenu`, the sidebar has room to show the destination
 * directly: the 7 LEARN sub-pages are FLATTENED into a visible "Learn"
 * section between the primary items and Review/Settings, each rendered as
 * its own real nav link. `LearnMenu`'s honeycomb overlay is a mobile-only
 * affordance and is never mounted alongside this component (Shell gates the
 * two mutually exclusively on `useDeviceClass`); the state machine that
 * drives it stays untouched in Shell either way (see Shell.tsx's header).
 *
 * Structure (top to bottom): brand mark → Today/Progress → "Learn" section
 * (7 flattened sub-pages) → Review (library) → Settings → the chat action
 * (opens a NEW conversation, mirroring `ChatFab`'s Slice-3 behavior, but as
 * a persistent rail entry rather than a floating dot — desktop has no
 * "keyboard is up" concept for the FAB's hide rule, but a running mock
 * exam still hides it, same as the FAB). It also honors `ChatFab`'s
 * `/settings` quiet zone (deliberate product policy, not FAB-specific
 * chrome — see `ChatFab.tsx`'s header): the rail entry hides there too.
 * Unlike `ChatFab`, it stays visible on `/chat` itself — a persistent rail
 * entry isn't a floating dot sitting on top of the page a user is already
 * chatting from, so "chat button on the chat page is noise" doesn't carry
 * over the same way.
 *
 * Active state: `aria-current="page"` via the SAME longest-prefix,
 * path-boundary matcher `BottomNav` uses (`matchActiveNavId`, lib/nav.ts) —
 * one shared rule for "you are here" instead of two that could drift.
 *
 * A11y: a single `<nav aria-label>` landmark; every item is a real
 * `<button>` (full keyboard reachability + Enter/Space activation for
 * free) styled with the shared `.focusring` visible-focus treatment. The
 * "Learn" group is introduced by a real `<h2>` so screen-reader users can
 * jump between sections, not just a visually-styled label. No modal
 * semantics here, so there is no focus trap to reason about.
 */
import { useCallback, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useExamActive } from '../hooks/useExamActive';
import { useCurrentChatContext } from '../hooks/useChatContext';
import { buildChatOpenState } from '../lib/chatContext';
import { cn } from '../lib/cn';
import {
  LEARN_SUBPAGE_IDS,
  matchActiveNavId,
  navItem,
  PRIMARY_TAB_IDS,
  type NavItemId,
} from '../lib/nav';
import { Bilingual } from './Bilingual';
import { Icon } from './Icon';
import { SealStamp } from './SealStamp';

/**
 * Every routed id the rail renders, in render order — used for the shared
 * active-match (`matchActiveNavId`). `chat` is intentionally excluded: the
 * chat action always forces a NEW conversation (mirrors `ChatFab`), so
 * marking it "current" while sitting on `/chat` would misstate what
 * activating it does.
 */
const SIDEBAR_ROUTE_IDS = [
  'today',
  'progress',
  ...LEARN_SUBPAGE_IDS,
  'review',
  'settings',
] as const satisfies ReadonlyArray<NavItemId>;

const LEARN_HEADING_ID = 'km-sidebar-learn-heading';

/** `/settings` quiet zone, mirroring `ChatFab.isHiddenPath`'s segment-
 *  boundary prefix match — deliberately scoped to `/settings` ONLY (unlike
 *  `ChatFab`, the rail's chat entry stays visible on `/chat`; see the
 *  header comment for why that's a considered difference, not an
 *  oversight). Kept as its own small check rather than importing
 *  `ChatFab`'s private matcher so this component doesn't reach into
 *  another component's module for a one-line prefix test. */
function isSettingsPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === '/settings' || path.startsWith('/settings/');
}

export function Sidebar(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { examActive } = useExamActive();
  // The CURRENT page's published chat descriptor (or null) — read
  // unconditionally, same rule ChatFab follows (hooks must not sit behind
  // an early return).
  const pageContext = useCurrentChatContext();

  const activeId = matchActiveNavId(location.pathname, SIDEBAR_ROUTE_IDS);

  const goto = useCallback(
    (path: string): void => {
      if (location.pathname !== path) {
        navigate(path);
      }
    },
    [navigate, location.pathname],
  );

  const openChat = useCallback((): void => {
    // Slice 3 parity with ChatFab: always opens a NEW conversation, handing
    // the current page's context along (no guard on already being on
    // `/chat` — the force-new discriminator lives in the router state, not
    // in whether navigate() is a no-op).
    navigate('/chat', { state: buildChatOpenState(pageContext) });
  }, [navigate, pageContext]);

  function renderLink(id: (typeof SIDEBAR_ROUTE_IDS)[number]): JSX.Element {
    const it = navItem(id);
    const active = activeId === id;
    return (
      <button
        key={id}
        type="button"
        className={cn(
          'km-sidebar__link focusring',
          active && 'km-sidebar__link--active',
        )}
        aria-current={active ? 'page' : undefined}
        // A fixed English-first accessible name regardless of the visual
        // language-display setting — same convention as BottomNav's tab
        // cells, so a screen-reader user's reading order never depends on
        // a visual preference that has nothing to do with them.
        aria-label={`${it.label} · ${it.kr}`}
        // Guided-tour anchor — PRIMARY tabs share BottomNav's `tab-<id>`
        // keys (the two chromes are mutually exclusive, so a selector only
        // ever resolves one). LEARN sub-page links carry no anchor: the
        // tour's "learn-launcher" step targets the section wrapper below.
        data-tour={
          (PRIMARY_TAB_IDS as ReadonlyArray<string>).includes(id)
            ? `tab-${id}`
            : undefined
        }
        onClick={() => {
          goto(it.path);
        }}
      >
        <Icon name={it.icon} size={20} />
        <span className="km-sidebar__label">
          <Bilingual en={it.label} kr={it.kr} />
        </span>
      </button>
    );
  }

  return (
    // Distinct accessible name from `BottomNav`'s "Primary navigation" —
    // Shell mounts the two mutually exclusively today, but a distinct label
    // means two `navigation` landmarks are never indistinguishable by
    // landmark-navigation if that ever stops being true (a debug toggle, a
    // transitional breakpoint state).
    <nav className="km-sidebar" aria-label="Primary navigation, sidebar">
      <div className="km-sidebar__brand" aria-hidden="true">
        <SealStamp char="韓" size="sm" />
        <span className="km-sidebar__brandtext">
          <Bilingual kr="한국어 마스터" en="Korean Master" />
        </span>
      </div>

      <div className="km-sidebar__section">
        {renderLink('today')}
        {renderLink('progress')}
      </div>

      {/* Guided-tour anchor: on desktop there is no hexagon launcher, so the
          first-run tour's LEARN step spotlights this whole section. */}
      <div className="km-sidebar__section" data-tour="learn-launcher">
        <h2 id={LEARN_HEADING_ID} className="km-eyebrow km-sidebar__heading">
          <Bilingual en="Learn" kr="배움" />
        </h2>
        <div
          className="km-sidebar__group"
          role="group"
          aria-labelledby={LEARN_HEADING_ID}
        >
          {LEARN_SUBPAGE_IDS.map((id) => renderLink(id))}
        </div>
      </div>

      <div className="km-sidebar__section">
        {renderLink('review')}
        {renderLink('settings')}
      </div>

      {!examActive && !isSettingsPath(location.pathname) ? (
        <button
          type="button"
          className="km-sidebar__link km-sidebar__chat focusring"
          aria-label="Chat · 대화"
          data-tour="chat-fab"
          onClick={openChat}
        >
          <Icon name="chat" size={20} />
          <span className="km-sidebar__label">
            <Bilingual en="Chat" kr="대화" />
          </span>
        </button>
      ) : null}
    </nav>
  );
}
