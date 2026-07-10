/**
 * WritingTopicGenerator (F-027) — style choice, generate lifecycle, error
 * paths, and the unmount abort.
 *
 * `services/writing` is mocked so `generateWritingPrompt` never touches the
 * network; the real `ApiError` class drives the fixed-copy error branches
 * (errorCopy keys on instanceof + structured fields).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';

vi.mock('../services/writing', () => ({
  generateWritingPrompt: vi.fn(() =>
    Promise.reject(new Error('not wired in tests')),
  ),
}));

import { WritingTopicGenerator } from './WritingTopicGenerator';
import { generateWritingPrompt } from '../services/writing';
import type { GeneratedWritingPrompt } from '../services/writing';

const generateMock = vi.mocked(generateWritingPrompt);

const TOPIK_PROMPT: GeneratedWritingPrompt = {
  promptKr: '현대 사회에서 독서의 중요성에 대해 자신의 의견을 쓰십시오.',
  promptEn: 'Write your opinion on the importance of reading in modern society.',
  lengthHint: '600-700자',
  mode: 'topik',
  rubric: 'topik_ii_54',
};

const GENERAL_PROMPT: GeneratedWritingPrompt = {
  promptKr: '가장 기억에 남는 여행에 대해 자유롭게 써 보세요.',
  promptEn: 'Write freely about your most memorable trip.',
  lengthHint: null,
  mode: 'general',
  rubric: null,
};

describe('WritingTopicGenerator', () => {
  beforeEach(() => {
    generateMock.mockReset();
    generateMock.mockRejectedValue(new Error('not wired in tests'));
  });

  it('renders the style radiogroup with TOPIK-style selected by default', () => {
    render(<WritingTopicGenerator />);

    const topik = screen.getByRole('radio', { name: /TOPIK-style/ });
    const general = screen.getByRole('radio', { name: /Free write/ });
    expect(topik).toHaveAttribute('aria-checked', 'true');
    expect(general).toHaveAttribute('aria-checked', 'false');
    // Roving tabindex — only the selected radio is in the tab order.
    expect(topik).toHaveAttribute('tabindex', '0');
    expect(general).toHaveAttribute('tabindex', '-1');
  });

  it('moves the selection with arrow keys (radiogroup pattern, wrapping)', async () => {
    const user = userEvent.setup();
    render(<WritingTopicGenerator />);

    const topik = screen.getByRole('radio', { name: /TOPIK-style/ });
    const general = screen.getByRole('radio', { name: /Free write/ });

    topik.focus();
    await user.keyboard('{ArrowRight}');
    expect(general).toHaveAttribute('aria-checked', 'true');
    expect(general).toHaveFocus();

    // Wraps: another ArrowRight from the last option returns to the first.
    await user.keyboard('{ArrowRight}');
    expect(topik).toHaveAttribute('aria-checked', 'true');
    expect(topik).toHaveFocus();
  });

  it('generates a TOPIK-style topic and renders it (Korean task, gloss, length hint)', async () => {
    generateMock.mockResolvedValue(TOPIK_PROMPT);
    const user = userEvent.setup();
    render(<WritingTopicGenerator />);

    await user.click(screen.getByRole('button', { name: /Generate topic/ }));

    expect(await screen.findByText(TOPIK_PROMPT.promptKr)).toBeInTheDocument();
    expect(screen.getByText(TOPIK_PROMPT.promptEn)).toBeInTheDocument();
    expect(screen.getByText('600-700자')).toBeInTheDocument();
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledWith(
      { mode: 'topik' },
      expect.any(AbortSignal),
    );
    // The button relabels to the regenerate affordance.
    expect(
      screen.getByRole('button', { name: /New topic/ }),
    ).toBeInTheDocument();
  });

  it('sends mode=general when Free write is chosen, and omits the length pill when the hint is null', async () => {
    generateMock.mockResolvedValue(GENERAL_PROMPT);
    const user = userEvent.setup();
    render(<WritingTopicGenerator />);

    await user.click(screen.getByRole('radio', { name: /Free write/ }));
    await user.click(screen.getByRole('button', { name: /Generate topic/ }));

    expect(
      await screen.findByText(GENERAL_PROMPT.promptKr),
    ).toBeInTheDocument();
    expect(generateMock).toHaveBeenCalledWith(
      { mode: 'general' },
      expect.any(AbortSignal),
    );
    // lengthHint: null → no fabricated pill (only the mode pill renders).
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.km-topicgen__tags .km-pill')).toHaveLength(1);
  });

  it('disables the button and marks the panel busy while the call is in flight', async () => {
    let resolveCall: (p: GeneratedWritingPrompt) => void = () => undefined;
    generateMock.mockImplementation(
      () =>
        new Promise<GeneratedWritingPrompt>((resolve) => {
          resolveCall = resolve;
        }),
    );
    const user = userEvent.setup();
    const { container } = render(<WritingTopicGenerator />);

    await user.click(screen.getByRole('button', { name: /Generate topic/ }));

    expect(screen.getByRole('button', { name: /Generating/ })).toBeDisabled();
    expect(
      container.querySelector('.km-topicgen[aria-busy="true"]'),
    ).not.toBeNull();

    resolveCall(TOPIK_PROMPT);
    expect(await screen.findByText(TOPIK_PROMPT.promptKr)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New topic/ })).toBeEnabled();
  });

  it('renders the structured 429 retry copy and keeps the button as the retry', async () => {
    generateMock.mockRejectedValue(
      new ApiError('too many requests', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 30,
      }),
    );
    const user = userEvent.setup();
    render(<WritingTopicGenerator />);

    const button = screen.getByRole('button', { name: /Generate topic/ });
    await user.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Rate-limited. Try again in about 30 seconds.',
    );
    expect(button).toBeEnabled();

    // Retrying after the window clears the error and lands the topic.
    generateMock.mockResolvedValue(TOPIK_PROMPT);
    await user.click(button);
    expect(await screen.findByText(TOPIK_PROMPT.promptKr)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a 429 without retryAfter and other failures as fixed copy — never server prose', async () => {
    generateMock.mockRejectedValue(
      new ApiError('upstream exploded: pg constraint xyz', {
        status: 502,
        code: 'upstream_error',
      }),
    );
    const user = userEvent.setup();
    render(<WritingTopicGenerator />);

    await user.click(screen.getByRole('button', { name: /Generate topic/ }));

    const alert = await screen.findByRole('alert');
    // Fixed fallback copy — the server's message never reaches the DOM.
    expect(alert).toHaveTextContent('Could not generate a topic. Try again.');
    expect(alert).not.toHaveTextContent(/pg constraint/);
  });

  it('aborts an in-flight generation on unmount (no late setState)', async () => {
    // Holder object — TS can't track assignments made inside the mock's
    // closure on a plain `let`, so it narrows the local to `null`.
    const captured: { signal: AbortSignal | null } = { signal: null };
    generateMock.mockImplementation(
      (_body, signal) =>
        new Promise<GeneratedWritingPrompt>(() => {
          captured.signal = signal ?? null;
        }),
    );
    const user = userEvent.setup();
    const { unmount } = render(<WritingTopicGenerator />);

    await user.click(screen.getByRole('button', { name: /Generate topic/ }));
    expect(captured.signal).not.toBeNull();
    expect(captured.signal?.aborted).toBe(false);

    unmount();
    expect(captured.signal?.aborted).toBe(true);
  });
});
