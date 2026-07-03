/**
 * MockMode (FU-NF-39) — the answer-stripped, server-graded Mock-Test flow.
 *
 * Covers the phase machine (select → exam → results), that the exam renders
 * answer-stripped items (no `correct` flag present), answering + submit +
 * results render with score + reveals, the countdown timer auto-submitting at
 * 0 (fake timers), palette jump, and the disabled Writing card.
 *
 * `services/topik` is mocked so `fetchMockTest` / `submitMockTest` are
 * controllable without a server. `data/mocks/topik` is mocked so the offline
 * fallback loaders never fire a real `mockDelay` timer that would interfere
 * with the fake-timer auto-submit test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockResult, MockTest } from '../../types/domain';

const svc = vi.hoisted(() => ({
  fetchMockTest: vi.fn(),
  submitMockTest: vi.fn(),
}));

vi.mock('../../services/topik', () => ({
  fetchMockTest: svc.fetchMockTest,
  submitMockTest: svc.submitMockTest,
}));

// Keep the offline fallbacks out of the way — they must never be reached when
// the real service resolves, and a stray fixture timer would fight the fake
// clock in the auto-submit test.
vi.mock('../../data/mocks/topik', () => ({
  loadTopikMockTest: vi.fn(() => Promise.reject(new Error('fixture off'))),
  submitTopikMockTestMock: vi.fn(() => Promise.reject(new Error('fixture off'))),
}));

import { MockMode } from './MockMode';

const TEST: MockTest = {
  sourceTest: 7,
  section: 'reading',
  items: [
    {
      id: '1001',
      section: '읽기',
      number: 1,
      level: 4,
      prompt: '첫 번째 문제입니다.',
      options: [
        { id: 'a', kr: '가', en: 'A' },
        { id: 'b', kr: '나', en: 'B' },
        { id: 'c', kr: '다', en: 'C' },
        { id: 'd', kr: '라', en: 'D' },
      ],
    },
    {
      id: '1002',
      section: '읽기',
      number: 2,
      level: 3,
      prompt: '두 번째 문제입니다.',
      options: [
        { id: 'a', kr: '하나', en: 'One' },
        { id: 'b', kr: '둘', en: 'Two' },
        { id: 'c', kr: '셋', en: 'Three' },
        { id: 'd', kr: '넷', en: 'Four' },
      ],
    },
  ],
};

const RESULT: MockResult = {
  sourceTest: 7,
  section: 'reading',
  totalItems: 2,
  answered: 2,
  correct: 1,
  percentage: 50,
  band: 'L3 range',
  items: [
    {
      itemId: 1001,
      picked: 'b',
      correctChoiceId: 'b',
      isCorrect: true,
      explanation: 'B is the consistent summary.',
    },
    {
      itemId: 1002,
      picked: 'a',
      correctChoiceId: 'c',
      isCorrect: false,
      explanation: 'C restates the phrase.',
    },
  ],
};

describe('MockMode (Mock test)', () => {
  beforeEach(() => {
    svc.fetchMockTest.mockReset();
    svc.submitMockTest.mockReset();
    svc.fetchMockTest.mockResolvedValue(TEST);
    svc.submitMockTest.mockResolvedValue(RESULT);
  });

  it('renders the section select with a disabled Writing card', () => {
    render(<MockMode />);
    expect(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Start Listening mock test/i }),
    ).toBeEnabled();
    const writing = screen.getByRole('button', {
      name: /Writing mock test, coming soon/i,
    });
    expect(writing).toBeDisabled();
  });

  it('starts a section → enters the exam with answer-stripped items', async () => {
    const user = userEvent.setup();
    render(<MockMode />);

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );

    // Exam renders: timer, progress, first item, choices.
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });
    expect(svc.fetchMockTest).toHaveBeenCalledWith(
      'reading',
      expect.any(AbortSignal),
    );
    expect(screen.getByText('첫 번째 문제입니다.')).toBeInTheDocument();
    expect(screen.getByText(/Reading · 1 \/ 2/)).toBeInTheDocument();
    // The choice radiogroup carries exactly the 4 stripped options — and the
    // item the screen received never had a `correct` flag (type-stripped).
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    const received = svc.fetchMockTest.mock.results[0]?.value as Promise<
      MockTest
    >;
    const test = await received;
    expect(test.items[0]?.options[0]).not.toHaveProperty('correct');
  });

  it('countdown timer starts at the section budget in h:mm:ss', async () => {
    const user = userEvent.setup();
    render(<MockMode />);
    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
    await waitFor(() => {
      // Reading = 70 minutes → 1:10:00 (NOT the old HH:MM "01:10", which read
      // as 1 min 10 s and only changed once a minute — the "frozen timer" FU).
      expect(screen.getByRole('timer')).toHaveTextContent('1:10:00');
    });
  });

  it('countdown timer starts at 1:00:00 for the Listening section', async () => {
    svc.fetchMockTest.mockResolvedValueOnce({ ...TEST, section: 'listening' });
    const user = userEvent.setup();
    render(<MockMode />);
    await user.click(
      screen.getByRole('button', { name: /Start Listening mock test/i }),
    );
    await waitFor(() => {
      // Listening = 60 minutes.
      expect(screen.getByRole('timer')).toHaveTextContent('1:00:00');
    });
  });

  it('countdown decrements every second and drops to mm:ss below the hour', async () => {
    // Fake timers BEFORE mount so the exam interval is on the fake clock (see
    // the auto-submit test below for the fireEvent/act pattern rationale).
    vi.useFakeTimers();
    try {
      render(<MockMode />);
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const timer = screen.getByRole('timer');
      expect(timer).toHaveTextContent('1:10:00');

      // Every tick is visible — 1 s later the clock reads 1:09:59 (the old
      // HH:MM format froze at "01:09" for a full minute here).
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(timer).toHaveTextContent('1:09:59');

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(timer).toHaveTextContent('1:09:57');

      // Cross below the hour (total elapsed 10:01) → mm:ss with no hour part.
      await act(async () => {
        vi.advanceTimersByTime((10 * 60 - 2) * 1000);
      });
      expect(timer).toHaveTextContent('59:59');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers items, submits with confirm, and shows results with reveals', async () => {
    const user = userEvent.setup();
    render(<MockMode />);

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });

    // Answer item 1 (choice b).
    await user.click(screen.getByRole('radio', { name: /나/ }));
    expect(screen.getByText(/1 \/ 2 answered/)).toBeInTheDocument();

    // Jump to item 2 via the palette, answer it.
    await user.click(screen.getByRole('button', { name: /Question 2/i }));
    expect(screen.getByText('두 번째 문제입니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /하나/ }));

    // Submit → confirm.
    await user.click(screen.getByRole('button', { name: /Submit test/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Submit$/i }));

    // Results render: score, band, per-item reveal with the now-shown
    // explanation + the correct answer for the missed item.
    await waitFor(() => {
      expect(screen.getByText('L3 range')).toBeInTheDocument();
    });
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2 correct/)).toBeInTheDocument();
    expect(screen.getByText('B is the consistent summary.')).toBeInTheDocument();
    expect(screen.getByText('C restates the phrase.')).toBeInTheDocument();

    // The submit body carried the user's picks for both items.
    const body = svc.submitMockTest.mock.calls[0]?.[0] as {
      sourceTest: number;
      section: string;
      answers: { itemId: number; picked: string }[];
    };
    expect(body.sourceTest).toBe(7);
    expect(body.section).toBe('reading');
    expect(body.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 1001, picked: 'b' }),
        expect.objectContaining({ itemId: 1002, picked: 'a' }),
      ]),
    );

    // New mock returns to section select.
    await user.click(screen.getByRole('button', { name: /New mock/i }));
    expect(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    ).toBeInTheDocument();
  });

  it('auto-submits when the countdown reaches 0', async () => {
    // Fake timers from the start so the exam's `setInterval` is faked (a timer
    // created BEFORE useFakeTimers stays on the real clock and would ignore
    // advanceTimersByTime). userEvent deadlocks against fake timers in
    // happy-dom, so the section start is driven with `fireEvent` + manual
    // promise flushes inside `act`.
    vi.useFakeTimers();
    try {
      render(<MockMode />);
      // Start the Reading section.
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
      // Flush the resolved fetch promise so the exam mounts (and starts its
      // faked interval).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole('timer')).toBeInTheDocument();

      // Reading budget = 70 min = 4200 s. Advance past expiry; the faked
      // interval decrements once/sec and the auto-submit effect fires at 0.
      await act(async () => {
        vi.advanceTimersByTime(4200 * 1000 + 1000);
      });
      // Flush the auto-submit's resolved submit promise so the phase flips.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }

    // The timer-expiry auto-submit called the server with whatever was answered
    // (nothing here) — exactly once.
    expect(svc.submitMockTest).toHaveBeenCalledTimes(1);
    const body = svc.submitMockTest.mock.calls[0]?.[0] as {
      answers: unknown[];
    };
    expect(body.answers).toEqual([]);
  });

  it('features the image description for a hasImage exam item', async () => {
    // An image-dependent item (has_image, no stored asset): the exam must
    // surface the bracketed description in the labelled TopikImageNote block.
    svc.fetchMockTest.mockResolvedValueOnce({
      ...TEST,
      items: [
        {
          id: '1001',
          section: '듣기',
          number: 1,
          level: 3,
          prompt:
            '남자: 이 책을 소포로 보내고 싶은데요.\n[알맞은 그림 고르기: ①우체국 ②서점 ③도서관 ④문구점]',
          hasImage: true,
          options: [
            { id: 'a', kr: '①', en: '' },
            { id: 'b', kr: '②', en: '' },
            { id: 'c', kr: '③', en: '' },
            { id: 'd', kr: '④', en: '' },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    render(<MockMode />);

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );

    const note = await screen.findByRole('complementary', {
      name: /image described in text/i,
    });
    expect(note).toHaveTextContent(
      '알맞은 그림 고르기: ①우체국 ②서점 ③도서관 ④문구점',
    );
    // The prompt body keeps the transcript, without the bracketed segment.
    expect(
      screen.getByText('남자: 이 책을 소포로 보내고 싶은데요.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/\[알맞은 그림 고르기/),
    ).not.toBeInTheDocument();
  });

  it('renders the shared reading passage before the choices in the exam (B-008)', async () => {
    // A shared-passage item: the answer-stripped wire carries the reading text
    // in `passage` (question content, never answer data) and the exam renders
    // it before the choices — without it the item is unanswerable.
    const passageText =
      '도시의 도로는 대부분 아스팔트로 뒤덮여 있다. 그래서 비가 오면 빗물이 지하로 잘 흘러 들어가지 ( ㉠ ) 도로가 물에 잠기는 일도 자주 발생한다.';
    svc.fetchMockTest.mockResolvedValueOnce({
      ...TEST,
      items: [{ ...TEST.items[0]!, passage: passageText }, TEST.items[1]!],
    });
    const user = userEvent.setup();
    render(<MockMode />);

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });

    const passage = screen.getByText(passageText);
    expect(passage).toHaveClass('km-topik__passage');
    const choices = screen.getByRole('radiogroup', { name: 'Answer choices' });
    expect(
      passage.compareDocumentPosition(choices) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The second item is self-contained — stepping to it drops the block.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByText(passageText)).not.toBeInTheDocument();
  });

  it('falls back to an error card (not a blank screen) when fetch + fixture both fail', async () => {
    svc.fetchMockTest.mockRejectedValueOnce(new Error('down'));
    const user = userEvent.setup();
    render(<MockMode />);

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
    // loadTopikMockTest is mocked to reject too → the error card surfaces.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
