/**
 * Mistakes page (F-021) — render behaviour over a mocked `useEndpointOrMock`.
 *
 * The hook is mocked so we drive the loading / data / empty / error surfaces
 * directly (mirrors Hanja.test.tsx). Fixtures pass through `vi.hoisted` so the
 * hoisted `vi.mock` factory can reference them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import type { ApiError } from '../services/api';
import type { Mistake } from '../services/topik';

const hoisted = vi.hoisted(() => ({
  state: { kind: 'loading' } as
    | { kind: 'loading' }
    | { kind: 'data'; data: Mistake[] }
    | { kind: 'error' },
}));

const FAKE_ERR = new Error('boom') as unknown as ApiError;

function resultFor(): UseEndpointOrMockResult<Mistake[]> {
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
vi.mock('../services/topik', () => ({ fetchMistakes: vi.fn() }));

import Mistakes from './Mistakes';

const MISTAKE: Mistake = {
  responseId: 'r1',
  picked: 'a', // wrong — 'b' is correct
  answeredAt: '2026-07-06T09:00:00.000Z',
  mode: 'study',
  item: {
    id: 'i1',
    section: '읽기',
    number: 12,
    level: 4,
    prompt: '알맞은 것을 고르십시오.',
    options: [
      { id: 'a', kr: '가 오답', en: '', correct: false },
      { id: 'b', kr: '나 정답', en: '', correct: true },
      { id: 'c', kr: '다', en: '', correct: false },
      { id: 'd', kr: '라', en: '', correct: false },
    ],
    explanation: '정답은 나입니다.',
    hasImage: false,
  },
};

function renderPage(): void {
  render(
    <MemoryRouter>
      <Mistakes />
    </MemoryRouter>,
  );
}

describe('Mistakes page (F-021)', () => {
  beforeEach(() => {
    hoisted.state = { kind: 'loading' };
  });

  it('renders each miss with the prompt, correct answer, wrong-pick tag, and explanation', () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    renderPage();
    expect(screen.getByText('알맞은 것을 고르십시오.')).toBeInTheDocument();
    expect(screen.getByText('정답은 나입니다.')).toBeInTheDocument();
    // The user's wrong pick is tagged.
    expect(screen.getByText('Your answer')).toBeInTheDocument();
    // The correct answer is named (appears in the choice + the reveal block).
    expect(screen.getByText(/Correct answer:/)).toBeInTheDocument();
    expect(screen.getAllByText('나 정답').length).toBeGreaterThanOrEqual(1);
  });

  it('shows an empty state when there are no mistakes', () => {
    hoisted.state = { kind: 'data', data: [] };
    renderPage();
    expect(
      screen.getByText(/No mistakes in the last 30 days/i),
    ).toBeInTheDocument();
  });

  it('shows an error state when the load fails', () => {
    hoisted.state = { kind: 'error' };
    renderPage();
    expect(
      screen.getByText(/couldn't load your mistakes/i),
    ).toBeInTheDocument();
  });
});
