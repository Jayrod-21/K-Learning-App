/**
 * ExamActiveProvider / useExamActive — the shared "mock exam running" flag.
 *
 * Covers the provider round-trip (set → read) and the deliberate
 * no-provider degradation (false + no-op setter, never a throw) that lets
 * study pages render standalone. MockMode's phase→flag wiring is covered
 * in MockMode.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { ExamActiveProvider } from './ExamActiveProvider';
import { useExamActive } from './useExamActive';

function Probe(): JSX.Element {
  const { examActive, setExamActive } = useExamActive();
  return (
    <div>
      <div data-testid="flag">{String(examActive)}</div>
      <button
        type="button"
        onClick={() => {
          setExamActive(!examActive);
        }}
      >
        toggle
      </button>
    </div>
  );
}

describe('ExamActiveProvider', () => {
  it('defaults to false and round-trips a set through the context', async () => {
    const user = userEvent.setup();
    render(
      <ExamActiveProvider>
        <Probe />
      </ExamActiveProvider>,
    );

    expect(screen.getByTestId('flag')).toHaveTextContent('false');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('flag')).toHaveTextContent('true');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('flag')).toHaveTextContent('false');
  });

  it('is safe OUTSIDE the provider: false + no-op setter, no throw', async () => {
    const user = userEvent.setup();
    render(<Probe />);

    expect(screen.getByTestId('flag')).toHaveTextContent('false');
    // The no-op setter must neither throw nor flip anything.
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('flag')).toHaveTextContent('false');
  });
});
