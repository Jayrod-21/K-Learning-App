/**
 * TopikStudyAudio — F-206: the per-question listening player for STUDY mode.
 *
 * Study's draw is cross-test (`POST /topik/study` is `ORDER BY random()`), so
 * unlike the Mock exam runner — one resolved paper, one persistent buffered
 * `<audio>` element, per-item re-seeks — every study item names its OWN
 * paper's whole-section MP3 (`TopikItem.audioUrl`). This component therefore
 * owns a small self-contained element per item: mount (keyed by the item in
 * `TopikBody`) → press Play → seek to `startMs` → the `timeupdate` clamp
 * pauses at `endMs`. The seek/clamp mechanics deliberately MIRROR MockMode's
 * `playQuestionAudio`/`onAudioTimeUpdate` (same ~±250ms `timeupdate`
 * tolerance, absorbed by the recordings' announcer lead-in and trailing
 * silence); the mock's inline player is intentionally not refactored — it has
 * a different element-lifetime contract (persistent across navigation).
 *
 * Study is LEARN mode: the transcript/passage stays visible alongside the
 * player (the caller renders them; nothing here hides text). That is the
 * opposite of the timed mock, where a playable item hides its transcript.
 *
 * Failure posture (never a broken player):
 *   - `buildAudioSrc` rejects any URL outside the strict route-shape
 *     allow-list (tampered/off-origin values fail closed) → honest note;
 *   - an invalid span (non-integer, negative, empty/inverted window) →
 *     honest note — garbage must never seed `currentTime` or the clamp;
 *   - a RUNTIME stream failure (the element's `error` event) → a distinct
 *     alert, with recovery when a later load succeeds (the MockMode
 *     fix-pass S-2 posture);
 *   - `play()` rejections are swallowed — a rapid pause/unmount racing the
 *     start must not surface as an unhandled rejection.
 *
 * No autoplay anywhere: the Play button is the only thing that ever starts
 * playback, and unmount (item navigation, leaving the page) pauses it so a
 * detached element can't play on as ghost audio.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Bilingual } from '../../components/Bilingual';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { buildAudioSrc } from '../../services/ttmik';

export interface TopikStudyAudioProps {
  /** The item's paper-stream URL (`/topik/audio/<testNumber>/<1|2>`). */
  audioUrl: string;
  /** Start (ms) of this question's window into the paper stream. */
  startMs: number;
  /** End (ms, exclusive) of the window — playback pauses on crossing it. */
  endMs: number;
}

/**
 * The honest "this question has no playable audio" note — rendered by
 * `TopikBody` for listening items the server sent no audio for, and by the
 * player itself when its inputs fail validation. One component so the copy
 * can't drift between the two call sites.
 */
export function TopikStudyAudioNote(): JSX.Element {
  return (
    <p className="km-topik__audio-note" role="note">
      <Bilingual
        en="No audio for this question yet — study it from the transcript."
        kr="이 문제는 아직 음원이 없어요 — 대본으로 공부해요."
      />
    </p>
  );
}

export function TopikStudyAudio({
  audioUrl,
  startMs,
  endMs,
}: TopikStudyAudioProps): JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  // The armed question-end bound (seconds), or null when no clamp is armed.
  // A ref, not state: `timeupdate` fires ~4Hz and the clamp must not re-render.
  const clampEndSecRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [audioError, setAudioError] = useState(false);

  // Render-time belt to the service normalization's suspender (the MockMode
  // `audioSpanOf` posture): a caller that skips `fetchStudyDraw` — a fixture,
  // a future call path — still can't seed the seek/clamp with a half,
  // negative, or inverted window.
  const spanValid =
    Number.isInteger(startMs) &&
    Number.isInteger(endMs) &&
    startMs >= 0 &&
    endMs > startMs;
  const audioSrc = buildAudioSrc(audioUrl);

  // Play this question's window. Every press restarts from the window start
  // (unlimited replay — the F-119 decision #3 posture carried into study).
  const playQuestionAudio = useCallback((): void => {
    const el = audioRef.current;
    if (el === null) return;
    clampEndSecRef.current = endMs / 1000;
    el.currentTime = startMs / 1000;
    // play() rejections (AbortError from a rapid pause/navigation racing the
    // start, or a decode failure) must never surface as an unhandled
    // rejection; a REAL stream failure reaches the user via the element's
    // `error` event (onAudioError) instead.
    void el.play().catch(() => {
      /* swallowed — see comment above */
    });
  }, [startMs, endMs]);

  const pauseQuestionAudio = useCallback((): void => {
    audioRef.current?.pause();
  }, []);

  // The clamp: pause when playback crosses the armed question-end bound.
  // `timeupdate` fires every ~250ms, so the overshoot is at most that —
  // inside the trailing-silence padding. Cleared before pausing so the
  // handler can't re-fire against a stale bound on the pause's own final
  // timeupdate.
  const onAudioTimeUpdate = useCallback((): void => {
    const el = audioRef.current;
    const end = clampEndSecRef.current;
    if (el === null || end === null) return;
    if (el.currentTime >= end) {
      clampEndSecRef.current = null;
      el.pause();
    }
  }, []);

  const onAudioPlay = useCallback((): void => {
    setPlaying(true);
  }, []);
  const onAudioPause = useCallback((): void => {
    setPlaying(false);
  }, []);
  const onAudioError = useCallback((): void => {
    setAudioError(true);
  }, []);
  // Recovery: a successful load AFTER a failure (`loadedmetadata`/`canplay`
  // firing means the stream is fetchable again — e.g. a transient blip on the
  // metadata preload) clears the error so the player comes back instead of
  // staying dead for the rest of the draw.
  const onAudioLoaded = useCallback((): void => {
    setAudioError(false);
  }, []);

  // Unmount (Next/Skip navigation re-keys the component per item, leaving the
  // page unmounts it) stops playback: the next item starts silent, and a
  // detached-but-referenced media element can't play on as ghost audio. The
  // element is captured at effect time — its identity is stable for the
  // component's whole life, so the capture is exact.
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      clampEndSecRef.current = null;
      el?.pause();
    };
  }, []);

  if (audioSrc === null || !spanValid) {
    // Fail closed into the honest note — never a dead Play button.
    return <TopikStudyAudioNote />;
  }

  return (
    <div className="km-topik__audio">
      {/* No `controls`: playback is driven only by the button below (seek +
          timeupdate clamp) — a native scrubber would play the whole section
          tape outside this question's window. No timed caption track exists
          for the exam recordings; study keeps the TRANSCRIPT visible right
          on the card instead, hence the a11y rule exemption. No autoplay. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        preload="metadata"
        src={audioSrc}
        onTimeUpdate={onAudioTimeUpdate}
        onPlay={onAudioPlay}
        onPause={onAudioPause}
        onError={onAudioError}
        onLoadedMetadata={onAudioLoaded}
        onCanPlay={onAudioLoaded}
      />
      {audioError ? (
        // Runtime stream failure — a visible, distinct alert (never conflated
        // with the expected "no audio" note). Study keeps the transcript on
        // the card, so the learner loses nothing but the sound.
        <p className="km-topik__audio-error" role="alert">
          <Bilingual
            en="Audio couldn't load — study this question from its transcript."
            kr="오디오를 불러올 수 없어요 — 이 문제는 대본으로 공부해요."
          />
        </p>
      ) : (
        <div className="km-topik__audio-controls">
          <Button
            variant="gold"
            size="sm"
            leadingIcon={<Icon name={playing ? 'pause' : 'play'} size={14} />}
            onClick={playing ? pauseQuestionAudio : playQuestionAudio}
          >
            {playing ? (
              <Bilingual en="Pause" kr="일시 정지" compact />
            ) : (
              <Bilingual en="Play question audio" kr="문제 음원 듣기" compact />
            )}
          </Button>
          <span className="km-topik__audio-hint">
            <Bilingual
              en="Listen as many times as you like."
              kr="원하는 만큼 다시 들을 수 있어요."
              compact
            />
          </span>
        </div>
      )}
    </div>
  );
}
