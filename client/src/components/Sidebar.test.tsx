/**
 * Sidebar (device-adaptive epic, Phase D0) — the persistent left rail that
 * replaces the bottom-bar at ≥768px.
 *
 * Covers: every flattened item renders (primary tabs, the 7 LEARN
 * sub-pages, Review, Settings), `aria-current="page"` via the SAME
 * longest-prefix matcher `BottomNav` uses, the chat action's always-new-
 * conversation navigation (mirroring ChatFab's Slice 3 contract) and its
 * exam-active hide rule, and that clicking a link navigates.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ExamActiveContext } from '../hooks/exam-active-context';
import { readChatOpenState } from '../lib/chatContext';
import { Sidebar } from './Sidebar';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return (
    <>
      <div data-testid="pathname">{loc.pathname}</div>
      <div data-testid="state">{JSON.stringify(loc.state)}</div>
    </>
  );
}

function renderSidebarAt(path: string, examActive = false): void {
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
                <Sidebar />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </ExamActiveContext.Provider>,
  );
}

describe('Sidebar — structure', () => {
  it('is a labelled nav landmark', () => {
    renderSidebarAt('/');
    expect(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).toBeInTheDocument();
  });

  it('renders the brand mark', () => {
    renderSidebarAt('/');
    expect(screen.getByText('Korean Master')).toBeInTheDocument();
  });

  it('renders Today, Progress, all 7 LEARN sub-pages (under a "Learn" heading), Review, and Settings', () => {
    renderSidebarAt('/');
    expect(screen.getByRole('button', { name: /^Today/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Progress/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Learn/, level: 2 }),
    ).toBeInTheDocument();
    for (const label of [
      'TOPIK',
      'Listen',
      'Vocab flashcards',
      'Grammar practice',
      'Writing',
      'Hanja',
      'Reading',
    ]) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${label}`) }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole('button', { name: /^Library/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Settings/ }),
    ).toBeInTheDocument();
  });

  it('renders the chat action', () => {
    renderSidebarAt('/');
    expect(screen.getByRole('button', { name: /^Chat/ })).toBeInTheDocument();
  });
});

describe('Sidebar — active state (aria-current, longest-prefix match)', () => {
  it('marks Today current at the root path', () => {
    renderSidebarAt('/');
    expect(screen.getByRole('button', { name: /^Today/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('button', { name: /^Progress/ }),
    ).not.toHaveAttribute('aria-current');
  });

  it('marks Progress current on /progress', () => {
    renderSidebarAt('/progress');
    expect(screen.getByRole('button', { name: /^Progress/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the flattened LEARN sub-page current on its own route', () => {
    renderSidebarAt('/learn/vocab');
    expect(
      screen.getByRole('button', { name: /^Vocab flashcards/ }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /^Today/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('longest-prefix: /review/mistakes lights Library, not a false match', () => {
    renderSidebarAt('/review/mistakes');
    expect(screen.getByRole('button', { name: /^Library/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('the chat action never carries aria-current, even while sitting on /chat', () => {
    renderSidebarAt('/chat');
    expect(screen.getByRole('button', { name: /^Chat/ })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

describe('Sidebar — navigation', () => {
  it('clicking a link navigates to its route', async () => {
    const user = userEvent.setup();
    renderSidebarAt('/');

    await user.click(screen.getByRole('button', { name: /^Hanja/ }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/learn/hanja');
  });

  it('the chat action always opens a NEW conversation, even while already on /chat', async () => {
    const user = userEvent.setup();
    renderSidebarAt('/chat');

    await user.click(screen.getByRole('button', { name: /^Chat/ }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/chat');
    const req = readChatOpenState(
      JSON.parse(screen.getByTestId('state').textContent ?? 'null'),
    );
    expect(req).toEqual({ context: null });
  });
});

describe('Sidebar — exam-active hide rule (mirrors ChatFab)', () => {
  it('hides the chat action while a mock exam is in progress', () => {
    renderSidebarAt('/learn/topik', true);
    expect(
      screen.queryByRole('button', { name: /^Chat/ }),
    ).not.toBeInTheDocument();
  });

  it('keeps every routed nav link visible during an exam — only chat hides', () => {
    renderSidebarAt('/learn/topik', true);
    expect(screen.getByRole('button', { name: /^Today/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Settings/ }),
    ).toBeInTheDocument();
  });
});
