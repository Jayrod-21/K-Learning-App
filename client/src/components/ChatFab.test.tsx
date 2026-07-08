/**
 * ChatFab (P1.1 visibility + Slice 3 open-new-with-context) — visibility
 * matrix, navigation, and the router-state hand-off.
 *
 * Hidden when: on /chat, on /settings (incl. sub-paths), a mock exam is
 * active (ExamActiveContext), or the keyboard is open (useKeyboardOpen,
 * mocked here — the hook has its own viewport-level tests). Visible
 * everywhere else; clicking navigates to /chat carrying a `ChatOpenState`
 * — the force-new discriminator plus the current page's published
 * `ChatContext` (real store, no mock — the publish → carry chain is the
 * integration under test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { ExamActiveContext } from '../hooks/exam-active-context';
import { useChatContext } from '../hooks/useChatContext';
import { readChatOpenState } from '../lib/chatContext';
import type { ChatContext } from '../lib/chatContext';

// Controllable keyboard signal — the real hook is exercised in
// useKeyboardOpen.test.tsx; here it's an input to the visibility logic.
const keyboard = vi.hoisted(() => ({ open: false }));
vi.mock('../hooks/useKeyboardOpen', () => ({
  useKeyboardOpen: () => keyboard.open,
}));

import { ChatFab } from './ChatFab';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderFabAt(path: string, examActive = false): void {
  render(
    <ExamActiveContext.Provider
      value={{ examActive, setExamActive: () => {} }}
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <LocationProbe />
                <ChatFab />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </ExamActiveContext.Provider>,
  );
}

const FAB_NAME = 'Open chat · 대화';

describe('ChatFab (P1.1)', () => {
  beforeEach(() => {
    keyboard.open = false;
  });

  it.each(['/', '/progress', '/review', '/learn/vocab', '/review/mistakes'])(
    'is visible on %s',
    (path) => {
      renderFabAt(path);
      expect(screen.getByRole('button', { name: FAB_NAME })).toBeInTheDocument();
    },
  );

  // `/Chat` + `/Settings`: React Router matches routes case-insensitively,
  // so those casings render the real screens — the hide check must agree.
  it.each([
    '/chat',
    '/settings',
    '/chat/123',
    '/settings/security',
    '/Chat',
    '/Settings',
  ])('is hidden on %s', (path) => {
    renderFabAt(path);
    expect(
      screen.queryByRole('button', { name: FAB_NAME }),
    ).not.toBeInTheDocument();
  });

  it('is hidden while a mock exam is active', () => {
    renderFabAt('/learn/topik', true);
    expect(
      screen.queryByRole('button', { name: FAB_NAME }),
    ).not.toBeInTheDocument();
  });

  it('is hidden while the keyboard is open', () => {
    keyboard.open = true;
    renderFabAt('/');
    expect(
      screen.queryByRole('button', { name: FAB_NAME }),
    ).not.toBeInTheDocument();
  });

  it('does NOT hide on sibling paths that merely share a prefix', () => {
    renderFabAt('/chatter');
    expect(screen.getByRole('button', { name: FAB_NAME })).toBeInTheDocument();
  });

  it('navigates to /chat on tap', async () => {
    const user = userEvent.setup();
    renderFabAt('/progress');

    await user.click(screen.getByRole('button', { name: FAB_NAME }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/chat');
    // …and, having arrived on /chat, the FAB removes itself.
    expect(
      screen.queryByRole('button', { name: FAB_NAME }),
    ).not.toBeInTheDocument();
  });
});

describe('ChatFab open-new + context hand-off (Slice 3)', () => {
  beforeEach(() => {
    keyboard.open = false;
  });

  /** Renders what `/chat` received as narrowed open-request JSON. */
  function OpenStateProbe(): JSX.Element {
    const loc = useLocation();
    const req = readChatOpenState(loc.state);
    return (
      <div data-testid="open-state">
        {req === null ? 'none' : JSON.stringify(req)}
      </div>
    );
  }

  /** A stand-in page that publishes its descriptor to the real store. */
  function PublishingPage({
    descriptor,
  }: {
    descriptor: ChatContext | null;
  }): null {
    useChatContext(descriptor);
    return null;
  }

  function renderFabWithPage(descriptor: ChatContext | null): void {
    render(
      <ExamActiveContext.Provider
        value={{ examActive: false, setExamActive: () => {} }}
      >
        <MemoryRouter initialEntries={['/progress']}>
          <Routes>
            <Route path="/chat" element={<OpenStateProbe />} />
            <Route
              path="*"
              element={
                <>
                  <PublishingPage descriptor={descriptor} />
                  <ChatFab />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ExamActiveContext.Provider>,
    );
  }

  it('carries the CURRENT page\'s published context to /chat', async () => {
    const user = userEvent.setup();
    renderFabWithPage({
      pageLabel: 'Progress · 성장',
      summary: 'Latest diagnostic: Reading 62%',
    });

    await user.click(screen.getByRole('button', { name: FAB_NAME }));

    const probe = screen.getByTestId('open-state');
    expect(probe).not.toHaveTextContent('none');
    const req: unknown = JSON.parse(probe.textContent ?? 'null');
    expect(req).toEqual({
      context: {
        pageLabel: 'Progress · 성장',
        summary: 'Latest diagnostic: Reading 62%',
      },
    });
  });

  it('still sends a (context-free) open request when the page published nothing', async () => {
    const user = userEvent.setup();
    renderFabWithPage(null);

    await user.click(screen.getByRole('button', { name: FAB_NAME }));

    // The FAB's force-new contract holds even without a context — Chat
    // must be able to tell a FAB entry from a plain navigation.
    expect(screen.getByTestId('open-state')).toHaveTextContent(
      JSON.stringify({ context: null }),
    );
  });
});

describe('ChatFab stylesheet contract (P2 fix, QA R-1)', () => {
  // happy-dom does no layout, so the short-viewport overlap can't be driven
  // in this environment — pin the stylesheet instead: the FAB's bottom
  // offset must stay clamped to clear the BottomNav (a bare `bottom: 22%`
  // lands INSIDE the fixed-height bar on viewports under ~290px tall), and
  // it must stay `position: fixed` (the P1.1 stagnant-FAB behavior).
  // Read from disk: vitest runs with `css: false`, which stubs every CSS
  // import (including `?raw`) to an empty string, and vite rewrites
  // `import.meta.url` to a non-file scheme — so resolve from the vitest
  // root (the client directory).
  it('keeps the fixed position and the nav-clearing bottom clamp', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'styles', 'index.css'),
      'utf8',
    );
    const rule = /\.km-chatfab\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(rule).not.toBe('');
    expect(rule).toContain('position: fixed;');
    expect(rule).toMatch(
      /bottom:\s*max\(\s*22%,\s*calc\(var\(--shell-bottomnav-h\)\s*\+\s*12px\s*\+\s*env\(safe-area-inset-bottom\)\)\s*\)/,
    );
  });
});
