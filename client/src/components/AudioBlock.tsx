/**
 * AudioBlock — fake audio player used on Diagnostic listening items,
 * Reading screen, and Conversation transcripts.
 *
 * Pass-2 shape: vermilion play button + progress bar with playhead + speed
 * pills (0.75× / 1× / 1.25×) + transcript toggle. There's no real audio
 * yet — the play button toggles a fake progress that advances at a
 * speed-multiplied rate. When real TTS lands (Pass 4+) the component's
 * external surface stays the same; we'll swap the interval for an
 * `<audio>` ref.
 *
 * Why fake-but-functional: the design HTML toggles a single fake-progress
 * width; the real player needs the interaction to feel honest now (playhead
 * crosses the bar, transcript reveals, speed changes the rate) so that
 * Pass-3 reviewers can validate the gesture without waiting on TTS.
 *
 * Cleanup: the interval is cleared on unmount AND on every play→pause
 * transition. Without the unmount clear, navigating away mid-playback
 * leaks a timer.
 *
 * No I/O — no threat model. Transcript text is author-controlled.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { cn } from '../lib/cn';
import { Icon } from './Icon';

type Speed = 0.75 | 1 | 1.25;

const SPEEDS: readonly Speed[] = [0.75, 1, 1.25] as const;

/** Fake-audio total duration in seconds — keeps the playhead motion honest. */
const FAKE_DURATION_S = 8;

export interface AudioBlockProps {
  /** Korean transcript — toggled by the "Transcript" button. */
  transcriptKr: string;
  /** Optional English transcript — shown below KR when present. */
  transcriptEn?: string;
  /** Optional duration label override (seconds). Defaults to fake duration. */
  durationS?: number;
}

export function AudioBlock({
  transcriptKr,
  transcriptEn,
  durationS = FAKE_DURATION_S,
}: AudioBlockProps): JSX.Element {
  const [playing, setPlaying] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [speed, setSpeed] = useState<Speed>(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive the fake progress bar. The 100ms tick is small enough that the
  // bar appears to flow smoothly while big enough that React's batching
  // doesn't trash the main thread.
  useEffect(() => {
    if (!playing) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    const tickMs = 100;
    intervalRef.current = setInterval(() => {
      setProgress((p) => {
        const next = p + (tickMs / 1000 / durationS) * speed;
        if (next >= 1) {
          // Auto-pause + reset when the playhead reaches the end.
          setPlaying(false);
          return 0;
        }
        return next;
      });
    }, tickMs);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [playing, durationS, speed]);

  const pct = Math.round(progress * 100);

  return (
    <div className="km-audioblock">
      <div className="km-audioblock__row">
        <button
          type="button"
          className="km-audioblock__play focusring"
          aria-pressed={playing}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => {
            setPlaying((p) => !p);
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <div className="km-audioblock__meta">
          <div className="km-eyebrow km-audioblock__label">
            Audio · {durationS}s
          </div>
          <div
            className="km-audioblock__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label="Playback progress"
          >
            <div
              className="km-audioblock__fill"
              style={{ width: `${pct}%` }}
            />
            <div
              className="km-audioblock__playhead"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--sm focusring km-audioblock__transcript"
          aria-pressed={showTranscript}
          onClick={() => {
            setShowTranscript((s) => !s);
          }}
        >
          {showTranscript ? 'Hide' : 'Transcript'}
        </button>
      </div>

      <div className="km-audioblock__speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={cn(
              'km-pill km-audioblock__speed focusring',
              s === speed ? 'km-pill--gold' : 'km-pill--default',
            )}
            aria-pressed={s === speed}
            onClick={() => {
              setSpeed(s);
            }}
          >
            {s}×
          </button>
        ))}
      </div>

      {showTranscript ? (
        <div className="km-audioblock__text">
          <div className="kr km-audioblock__text-kr">{transcriptKr}</div>
          {transcriptEn ? (
            <div className="km-audioblock__text-en">{transcriptEn}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
