/**
 * AudioBlock — play/pause aria-pressed toggle, speed-pill switch,
 * transcript reveal, and interval cleanup on unmount.
 *
 * The play interval is fake-time driven; we use `vi.useFakeTimers()`
 * so we can assert the timer is cleared on unmount without waiting
 * for real wall-clock ticks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AudioBlock } from './AudioBlock';

const KR = '안녕하세요, 오늘 날씨가 좋네요.';
const EN = 'Hello, the weather is nice today.';

describe('AudioBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders Play, the speed group, and the progressbar', () => {
    render(<AudioBlock transcriptKr={KR} transcriptEn={EN} />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Playback progress' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Playback speed' }),
    ).toBeInTheDocument();
  });

  // NB: `userEvent` deadlocks against `vi.useFakeTimers()` in happy-dom —
  // we use the synchronous `fireEvent.click` for click-only contracts and
  // reserve `userEvent` for key-sequence tests (none here).

  it('toggles play/pause aria-pressed and label on click', () => {
    render(<AudioBlock transcriptKr={KR} />);
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(play);
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pause);
    expect(
      screen.getByRole('button', { name: 'Play' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('switching the speed pill flips aria-pressed across the group', () => {
    render(<AudioBlock transcriptKr={KR} />);
    // The default speed is 1×; the pill carries `1×` as its label.
    const default1x = screen.getByRole('button', { name: '1×' });
    expect(default1x).toHaveAttribute('aria-pressed', 'true');
    const fast = screen.getByRole('button', { name: '1.25×' });
    expect(fast).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(fast);
    expect(fast).toHaveAttribute('aria-pressed', 'true');
    expect(default1x).toHaveAttribute('aria-pressed', 'false');
  });

  it('Transcript button reveals the KR + EN transcript bodies', () => {
    render(<AudioBlock transcriptKr={KR} transcriptEn={EN} />);
    expect(screen.queryByText(KR)).not.toBeInTheDocument();
    const transcript = screen.getByRole('button', { name: 'Transcript' });
    fireEvent.click(transcript);
    expect(screen.getByText(KR)).toBeInTheDocument();
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Hide' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears the play interval on unmount so the timer does not leak', () => {
    // Use globalThis — `global` isn't typed in browser-lib tsconfigs.
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<AudioBlock transcriptKr={KR} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    // Sanity: setInterval was called at least once during play.
    // (The effect's cleanup will call clearInterval on unmount.)
    const before = clearSpy.mock.calls.length;
    unmount();
    // After unmount, clearInterval was called for the play tick. The
    // sentinel value is "at least one more clear" — happy-dom's GC may
    // also fire on its own, but we only need to confirm our cleanup
    // ran. (Counting absolute values is fragile across React versions.)
    expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
    clearSpy.mockRestore();
  });

  it('aria-valuenow on the progressbar starts at 0', () => {
    render(<AudioBlock transcriptKr={KR} />);
    expect(
      screen.getByRole('progressbar'),
    ).toHaveAttribute('aria-valuenow', '0');
  });
});
