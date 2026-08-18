/**
 * TopikStudyAudio (F-206) — the study-mode per-question listening player.
 *
 * NOTE on the media element in tests: happy-dom implements
 * HTMLMediaElement.play()/pause()/currentTime/paused natively (play() returns
 * a promise and fires the play/pause events synchronously), so no prototype
 * stubs are needed — playback state is asserted straight off the element, and
 * the ~4Hz `timeupdate` the browser would emit is driven manually via
 * fireEvent.timeUpdate after seeking (the MockMode.test.tsx pattern).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopikStudyAudio, TopikStudyAudioNote } from './TopikStudyAudio';

const VALID = {
  audioUrl: '/topik/audio/64/2',
  startMs: 12_000,
  endMs: 45_000,
};

function getAudio(): HTMLAudioElement {
  const audio = document.querySelector('audio');
  expect(audio).not.toBeNull();
  return audio as HTMLAudioElement;
}

describe('TopikStudyAudio', () => {
  it('renders a single seek-driven element (metadata preload, allow-listed src, no native controls) and a Play control', () => {
    render(<TopikStudyAudio {...VALID} />);

    const audio = getAudio();
    expect(document.querySelectorAll('audio')).toHaveLength(1);
    expect(audio).toHaveAttribute('src', '/topik/audio/64/2');
    expect(audio).toHaveAttribute('preload', 'metadata');
    // No native scrubber — it would play the tape outside the window.
    expect(audio).not.toHaveAttribute('controls');
    // No autoplay: mounts silent.
    expect(audio.paused).toBe(true);
    expect(
      screen.getByRole('button', { name: /Play question audio/i }),
    ).toBeInTheDocument();
  });

  it('Play seeks to startMs/1000 and plays; the control flips to Pause and pauses', async () => {
    const user = userEvent.setup();
    render(<TopikStudyAudio {...VALID} />);
    const audio = getAudio();

    await user.click(
      screen.getByRole('button', { name: /Play question audio/i }),
    );

    expect(audio.currentTime).toBe(12);
    expect(audio.paused).toBe(false);

    await user.click(screen.getByRole('button', { name: /일시 정지 · Pause/ }));
    expect(audio.paused).toBe(true);
  });

  it('pauses at endMs/1000 via the timeupdate clamp, and replays from the window start', async () => {
    const user = userEvent.setup();
    render(<TopikStudyAudio {...VALID} />);
    const audio = getAudio();

    await user.click(
      screen.getByRole('button', { name: /Play question audio/i }),
    );
    expect(audio.paused).toBe(false);

    // Mid-window: still inside [12s, 45s) — keeps playing.
    audio.currentTime = 30;
    fireEvent.timeUpdate(audio);
    expect(audio.paused).toBe(false);

    // Crossing the end bound (45s, +~250ms overshoot tolerance) pauses.
    audio.currentTime = 45.2;
    fireEvent.timeUpdate(audio);
    expect(audio.paused).toBe(true);

    // Unlimited replay: Play again restarts from the window start.
    await user.click(
      screen.getByRole('button', { name: /Play question audio/i }),
    );
    expect(audio.currentTime).toBe(12);
    expect(audio.paused).toBe(false);
  });

  it('a stale timeupdate after the clamp fired cannot re-pause a restarted playback (bound cleared)', async () => {
    const user = userEvent.setup();
    render(<TopikStudyAudio {...VALID} />);
    const audio = getAudio();

    await user.click(
      screen.getByRole('button', { name: /Play question audio/i }),
    );
    audio.currentTime = 45.2;
    fireEvent.timeUpdate(audio);
    expect(audio.paused).toBe(true);

    await user.click(
      screen.getByRole('button', { name: /Play question audio/i }),
    );
    // The re-armed clamp governs — a mid-window tick keeps playing.
    audio.currentTime = 20;
    fireEvent.timeUpdate(audio);
    expect(audio.paused).toBe(false);
  });

  it('a tampered/off-origin audioUrl fails closed: no element, the honest note instead', () => {
    render(
      <TopikStudyAudio
        audioUrl="https://evil.example/a.mp3"
        startMs={0}
        endMs={5_000}
      />,
    );

    expect(document.querySelector('audio')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Play question audio/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/No audio for this question yet/);
  });

  it('an invalid window (end <= start, or non-integer) fails closed into the note', () => {
    const { rerender } = render(
      <TopikStudyAudio audioUrl="/topik/audio/64/2" startMs={5_000} endMs={5_000} />,
    );
    expect(document.querySelector('audio')).toBeNull();
    expect(screen.getByRole('note')).toBeInTheDocument();

    rerender(
      <TopikStudyAudio audioUrl="/topik/audio/64/2" startMs={0.5} endMs={5_000} />,
    );
    expect(document.querySelector('audio')).toBeNull();
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('a runtime stream failure shows a distinct alert (not the "no audio" note) and recovers on a later successful load', async () => {
    const user = userEvent.setup();
    render(<TopikStudyAudio {...VALID} />);
    const audio = getAudio();

    fireEvent.error(audio);
    expect(screen.getByRole('alert')).toHaveTextContent(/Audio couldn't load/);
    expect(
      screen.queryByRole('button', { name: /Play question audio/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    // Recovery: a successful load after the failure brings the player back.
    fireEvent.canPlay(audio);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const playBtn = screen.getByRole('button', { name: /Play question audio/i });
    await user.click(playBtn);
    expect(audio.paused).toBe(false);
  });

  it('unmounting pauses playback (no ghost audio after navigating away)', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TopikStudyAudio {...VALID} />);
    const audio = getAudio();

    await user.click(
      screen.getByRole('button', { name: /Play question audio/i }),
    );
    expect(audio.paused).toBe(false);

    unmount();
    expect(audio.paused).toBe(true);
  });
});

describe('TopikStudyAudioNote', () => {
  it('renders the honest no-audio copy as a note', () => {
    render(<TopikStudyAudioNote />);
    expect(screen.getByRole('note')).toHaveTextContent(
      /No audio for this question yet/,
    );
  });
});
