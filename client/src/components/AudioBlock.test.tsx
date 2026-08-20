/**
 * AudioBlock — the honest "no playable audio, here's the transcript" card
 * Diagnostic falls back to for listening items with no mapped audio span.
 *
 * Pass-2 shipped this as a fake player (Play button + a progress bar driven
 * by a plain interval, no `<audio>` element). That is gone: there is no Play
 * button, no progressbar, no speed control — only a transcript reveal toggle
 * and, until revealed, an honest "no audio for this question" note.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AudioBlock } from './AudioBlock';

const KR = '안녕하세요, 오늘 날씨가 좋네요.';
const EN = 'Hello, the weather is nice today.';

describe('AudioBlock', () => {
  it('never renders a Play button or a progressbar — there is nothing to play', () => {
    render(<AudioBlock transcriptKr={KR} transcriptEn={EN} />);
    expect(screen.queryByRole('button', { name: /play/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /speed/i })).not.toBeInTheDocument();
  });

  it('shows the honest "no audio" note before the transcript is revealed', () => {
    render(<AudioBlock transcriptKr={KR} />);
    expect(screen.getByRole('note')).toHaveTextContent(/no audio for this question/i);
    expect(screen.queryByText(KR)).not.toBeInTheDocument();
  });

  it('Transcript button reveals the KR + EN transcript and clears the note', () => {
    render(<AudioBlock transcriptKr={KR} transcriptEn={EN} />);
    const transcript = screen.getByRole('button', { name: 'Transcript' });
    fireEvent.click(transcript);
    expect(screen.getByText(KR)).toBeInTheDocument();
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('Hide toggles back to the note, dropping the transcript', () => {
    render(<AudioBlock transcriptKr={KR} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(screen.getByText(KR)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText(KR)).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('renders no EN transcript line when transcriptEn is omitted', () => {
    render(<AudioBlock transcriptKr={KR} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(screen.getByText(KR)).toBeInTheDocument();
    expect(screen.queryByText(EN)).not.toBeInTheDocument();
  });
});
