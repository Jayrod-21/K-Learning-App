/**
 * PastExams — the dedicated "Past TOPIK exams" library surface (F-103).
 *
 * `useEndpointOrMock` is mocked (mirrors Mistakes.test.tsx's harness) so
 * tests drive the loading / data / empty / error surfaces directly. The
 * BackButton / PageHubHeader / Link primitives are REAL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import type { ApiError } from '../services/api';
import type { AttemptHistoryResult } from '../services/topik';

const hoisted = vi.hoisted(() => ({
  state: { kind: 'loading' } as
    | { kind: 'loading' }
    | { kind: 'data'; data: AttemptHistoryResult }
    | { kind: 'error' },
}));

const FAKE_ERR = new Error('boom') as unknown as ApiError;

function resultFor(): UseEndpointOrMockResult<AttemptHistoryResult> {
  const s = hoisted.state;
  const refetch = vi.fn();
  if (s.kind === 'loading') {
    return { data: null, loading: true, error: null, isMock: false, refetch };
  }
  if (s.kind === 'error') {
    return { data: null, loading: false, error: FAKE_ERR, isMock: false, refetch };
  }
  return { data: s.data, loading: false, error: null, isMock: false, refetch };
}

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: vi.fn(() => resultFor()),
}));
vi.mock('../services/topik', async () => {
  const actual = await vi.importActual<typeof import('../services/topik')>(
    '../services/topik',
  );
  return { ...actual, fetchAttemptHistory: vi.fn() };
});

import PastExams from './PastExams';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/review/exams']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <PastExams />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const READING_ATTEMPT: AttemptHistoryResult['attempts'][number] = {
  attemptId: 'a1',
  section: '읽기',
  sourceTest: 91,
  topikLevel: 'TOPIK II',
  correct: 45,
  totalItems: 50,
  completedAt: '2026-06-01T00:00:00.000Z',
};

const LEGACY_ATTEMPT: AttemptHistoryResult['attempts'][number] = {
  attemptId: 'a2',
  section: '듣기',
  sourceTest: 60,
  topikLevel: null,
  correct: 10,
  totalItems: 30,
  completedAt: '2026-05-01T00:00:00.000Z',
};

beforeEach(() => {
  hoisted.state = { kind: 'loading' };
});

describe('PastExams (F-103)', () => {
  it('titles the page and carries a BackButton to the Library', () => {
    hoisted.state = { kind: 'data', data: { attempts: [], total: 0 } };
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: /Past exams/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Back to Library/i }),
    ).toBeInTheDocument();
  });

  it('shows a loading state while the fetch is in flight', () => {
    hoisted.state = { kind: 'loading' };
    renderPage();
    expect(screen.getByText(/Loading your past exams/)).toBeInTheDocument();
  });

  it('shows an honest empty state when there are no completed attempts', () => {
    hoisted.state = { kind: 'data', data: { attempts: [], total: 0 } };
    renderPage();
    expect(
      screen.getByText(/haven't completed a mock exam yet/),
    ).toBeInTheDocument();
  });

  it('shows an error card with retry when the fetch fails and no data is available', () => {
    hoisted.state = { kind: 'error' };
    renderPage();
    expect(
      screen.getByText(/Couldn't load your past exams/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('lists a completed exam with its level, section, score, and date', () => {
    hoisted.state = {
      kind: 'data',
      data: { attempts: [READING_ATTEMPT], total: 1 },
    };
    renderPage();
    const row = screen.getByRole('link', {
      name: /TOPIK II test 91, 읽기, 45\/50 · 90%/,
    });
    expect(row).toBeInTheDocument();
  });

  it('re-enters the EXACT paper (section + test number + level) on tap', async () => {
    hoisted.state = {
      kind: 'data',
      data: { attempts: [READING_ATTEMPT], total: 1 },
    };
    const user = userEvent.setup();
    renderPage();
    const row = screen.getByRole('link', {
      name: /TOPIK II test 91, 읽기/,
    });
    await user.click(row);
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/learn/topik?mode=mock&section=reading&exam=91&level=TOPIK+II',
    );
  });

  it('a listening exam re-enters with section=listening', async () => {
    hoisted.state = {
      kind: 'data',
      data: {
        attempts: [{ ...READING_ATTEMPT, attemptId: 'a3', section: '듣기' }],
        total: 1,
      },
    };
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('link', { name: /TOPIK II test 91/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('section=listening');
  });

  it('omits the level param for a legacy attempt with no persisted topikLevel (never guesses)', async () => {
    hoisted.state = {
      kind: 'data',
      data: { attempts: [LEGACY_ATTEMPT], total: 1 },
    };
    const user = userEvent.setup();
    renderPage();
    const row = screen.getByRole('link', { name: /TOPIK test 60/ });
    await user.click(row);
    const loc = screen.getByTestId('location').textContent ?? '';
    expect(loc).toContain('/learn/topik?mode=mock&section=listening&exam=60');
    expect(loc).not.toContain('level=');
  });

  it('renders a writing (쓰기) attempt read-only — visible result, no re-enter link, no crash (F-196)', () => {
    // F-196: `mockSectionFromKr` used to enforce the "no writing rows"
    // server invariant with a bare throw, called unguarded from
    // PastExamRow's render — and the only ErrorBoundary is at the app
    // root, so one unexpected row blanked the WHOLE app. Unreachable via
    // the real server today (AttemptSectionSchema rejects 'writing' at the
    // PUT boundary), but the entry's declared type is the full
    // TopikSection union, so a skewed entry must degrade to a link-less
    // row — never throw through render, and never (Batch-2 SHOULD-FIX 1)
    // silently re-enter the wrong paper.
    hoisted.state = {
      kind: 'data',
      data: {
        attempts: [{ ...READING_ATTEMPT, attemptId: 'a4', section: '쓰기' }],
        total: 1,
      },
    };
    // The anomaly is still fail-loud in dev/tests via console.warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => renderPage()).not.toThrow();
    // The row's result is still visible…
    expect(screen.getByText(/TOPIK II · 쓰기 91회/)).toBeInTheDocument();
    expect(screen.getByText('45/50 · 90%')).toBeInTheDocument();
    // …but it carries no re-enter link (the only link left on the page is
    // the Mistakes CTA) and no play-action glyph.
    expect(
      screen.queryByRole('link', { name: /tap to re-enter/ }),
    ).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('쓰기'));
    warn.mockRestore();
  });

  it('a writing row does not break its siblings — reading in the same list keeps its exact re-enter link (F-196)', () => {
    hoisted.state = {
      kind: 'data',
      data: {
        attempts: [
          { ...READING_ATTEMPT, attemptId: 'a5', section: '쓰기' },
          READING_ATTEMPT,
        ],
        total: 2,
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderPage();
    const row = screen.getByRole('link', {
      name: /TOPIK II test 91, 읽기, 45\/50 · 90%/,
    });
    expect(row).toHaveAttribute(
      'href',
      '/learn/topik?mode=mock&section=reading&exam=91&level=TOPIK+II',
    );
    warn.mockRestore();
  });

  it('links out to Mistakes for per-item wrong-answer review', () => {
    hoisted.state = { kind: 'data', data: { attempts: [], total: 0 } };
    renderPage();
    expect(
      screen.getByRole('link', { name: /Review your mistakes/ }),
    ).toHaveAttribute('href', '/review/mistakes');
  });
});
