/**
 * Topik screen (Study mode) — covers loading → draw, stepping through the draw,
 * submit→reveal→next, the fire-and-forget `recordTopikAnswer` analytics call,
 * empty-explanation handling, and the draw-complete / New-set path.
 *
 * `useEndpointOrMock` is module-mocked so the test owns the resolved draw and
 * `refetch` directly; `services/topik` is mocked so the analytics write is
 * observable and its failure mode is exercised without a server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TopikAnswerResult, TopikItem } from '../types/domain';

// Hoisted state the mocked hook reads from.
const hookState: {
  current: {
    data: TopikItem[] | null;
    loading: boolean;
    error: { message: string } | null;
    isMock: boolean;
    refetch: () => void;
  };
} = {
  current: {
    data: null,
    loading: true,
    error: null,
    isMock: false,
    refetch: vi.fn(),
  },
};

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: () => hookState.current,
}));

// Service mock — `vi.hoisted` is required because `vi.mock` is hoisted above
// imports; the shared mock fns must be hoisted too or the factory hits TDZ
// (the Diagnostic.test.tsx pattern).
const svc = vi.hoisted(() => ({
  recordTopikAnswer:
    vi.fn<
      (
        itemId: string,
        body: { picked: string; timeMs?: number; mode?: string },
      ) => Promise<TopikAnswerResult>
    >(),
}));

vi.mock('../services/topik', () => ({
  recordTopikAnswer: (
    itemId: string,
    body: { picked: string; timeMs?: number; mode?: string },
  ) => svc.recordTopikAnswer(itemId, body),
  // Never actually invoked — useEndpointOrMock is mocked and ignores realFn —
  // but stubbed so the module's named export exists for the screen's import.
  fetchStudyDraw: () => Promise.reject(new Error('not used in tests')),
  // Mock-mode services exist for MockMode's import; never called in these
  // Study-mode tests (no section is started).
  fetchMockTest: () => Promise.reject(new Error('not used in tests')),
  submitMockTest: () => Promise.reject(new Error('not used in tests')),
}));

const { recordTopikAnswer } = svc;

import Topik from './Topik';

const ITEM_A: TopikItem = {
  id: '201',
  section: '읽기',
  number: 28,
  level: 4,
  prompt: '이 글의 내용과 같은 것은?',
  options: [
    { id: 'a', kr: '가', en: 'A', correct: false },
    { id: 'b', kr: '나', en: 'B', correct: true },
    { id: 'c', kr: '다', en: 'C', correct: false },
    { id: 'd', kr: '라', en: 'D', correct: false },
  ],
  explanation: 'Choice B summarises the passage faithfully.',
};

// Second item ships an empty explanation — the reveal block must omit the
// explanation paragraph but still show the correctness eyebrow.
const ITEM_B: TopikItem = {
  id: '202',
  section: '듣기',
  number: 44,
  level: 3,
  prompt: '여자가 다음에 할 행동으로 알맞은 것은?',
  options: [
    { id: 'a', kr: '하나', en: 'One', correct: true },
    { id: 'b', kr: '둘', en: 'Two', correct: false },
  ],
  explanation: '',
};

function setDraw(draw: TopikItem[], isMock = true): void {
  hookState.current = {
    data: draw,
    loading: false,
    error: null,
    isMock,
    refetch: hookState.current.refetch,
  };
}

describe('Topik (Study mode)', () => {
  beforeEach(() => {
    recordTopikAnswer.mockReset();
    recordTopikAnswer.mockResolvedValue({
      correct: false,
      correctChoiceId: 'b',
      explanation: 'Choice B summarises the passage faithfully.',
    });
    hookState.current = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
  });

  it('shows the loading state until the draw resolves', () => {
    render(<Topik />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading items');
  });

  it('renders the first item, the draw position, and the MockBadge in dev', () => {
    setDraw([ITEM_A, ITEM_B]);
    render(<Topik />);
    expect(screen.getByText('이 글의 내용과 같은 것은?')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    // Eyebrow reflects 1-based position within the draw length.
    expect(screen.getByText(/Item 1 \/ 2/)).toBeInTheDocument();
    // MockBadge mounts in dev (import.meta.env.PROD === false in tests).
    expect(screen.getByTestId('mock-badge')).toBeInTheDocument();
  });

  it('does NOT render the MockBadge when the draw is from the real endpoint', () => {
    setDraw([ITEM_A, ITEM_B], false);
    render(<Topik />);
    expect(screen.queryByTestId('mock-badge')).not.toBeInTheDocument();
  });

  it('submit reveals correctness chrome + explanation and fires recordTopikAnswer', async () => {
    setDraw([ITEM_A, ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />);

    // Pick wrong choice (A) to confirm the "Not quite" branch.
    const choices = screen.getAllByRole('radio');
    await user.click(choices[0]);
    expect(choices[0]).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(screen.getByText('Not quite')).toBeInTheDocument();
    expect(
      screen.getByText(/Choice B summarises the passage faithfully/),
    ).toBeInTheDocument();
    // Footer flips: Next appears, Submit gone.
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^submit$/i }),
    ).not.toBeInTheDocument();

    // Fire-and-forget analytics fired with the item id + picked + mode.
    expect(recordTopikAnswer).toHaveBeenCalledWith('201', {
      picked: 'a',
      mode: 'study',
    });
  });

  it('keeps the reveal even when recordTopikAnswer rejects (fire-and-forget)', async () => {
    recordTopikAnswer.mockRejectedValueOnce(new Error('network down'));
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />);

    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // The reveal renders regardless of the analytics failure.
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  it('steps to the next item on Next and clears the prior pick', async () => {
    setDraw([ITEM_A, ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />);

    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Second item now showing; fresh radios, no selection carried over.
    expect(
      screen.getByText('여자가 다음에 할 행동으로 알맞은 것은?'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Item 2 \/ 2/)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('omits the explanation paragraph for an empty-explanation item but still reveals', async () => {
    setDraw([ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />);

    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // Correctness eyebrow shows; the explanation block has no paragraph text.
    expect(screen.getByText('Correct')).toBeInTheDocument();
    // No reveal paragraph rendered (empty explanation → block omitted). The
    // choices therefore carry no aria-describedby pointing at the reveal.
    expect(
      screen.getByRole('radio', { name: /하나/ }),
    ).not.toHaveAttribute('aria-describedby');
  });

  it('lands on the draw-complete state after the last item and refetches on New set', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />);

    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Past the last item → draw-complete terminal state.
    await waitFor(() => {
      expect(screen.getByText('Set complete')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /new set/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /new set/i }));
    expect(hookState.current.refetch).toHaveBeenCalledTimes(1);
  });

  it('renders an empty-draw state with a New set button on a successful empty draw', async () => {
    // A successful but empty draw (data === [], no error, not loading) must not
    // dead-end on a blank screen — it offers a fresh pull.
    hookState.current = {
      data: [],
      loading: false,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
    const user = userEvent.setup();
    render(<Topik />);

    expect(screen.getByRole('status')).toHaveTextContent(/No items match/);
    const newSet = screen.getByRole('button', { name: /new set/i });
    expect(newSet).toBeInTheDocument();

    // The button refetches via startNewSet's drawKey bump + refetch.
    await user.click(newSet);
    expect(hookState.current.refetch).toHaveBeenCalledTimes(1);
  });

  it('defaults to Study mode and exposes a Study/Mock tablist', () => {
    setDraw([ITEM_A, ITEM_B]);
    render(<Topik />);
    // Study tab is selected by default; the study item renders.
    const studyTab = screen.getByRole('tab', { name: /study/i });
    expect(studyTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /mock/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByText('이 글의 내용과 같은 것은?')).toBeInTheDocument();
    // Exactly the four answer choices are radios — the mode switch is a
    // tablist, so it doesn't add stray radios.
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('switches to Mock mode and renders the section select', async () => {
    setDraw([ITEM_A, ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />);

    await user.click(screen.getByRole('tab', { name: /mock/i }));

    expect(screen.getByRole('tab', { name: /mock/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The Mock section select shows the section cards (Reading enabled).
    expect(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    ).toBeInTheDocument();
    // Study item is gone.
    expect(
      screen.queryByText('이 글의 내용과 같은 것은?'),
    ).not.toBeInTheDocument();
  });

  it('renders an error state with a retry when the draw fails and is empty', () => {
    hookState.current = {
      data: [],
      loading: false,
      error: { message: 'network unreachable' },
      isMock: false,
      refetch: vi.fn(),
    };
    render(<Topik />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Couldn’t load study items/,
    );
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });
});
