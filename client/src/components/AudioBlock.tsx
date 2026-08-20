/**
 * AudioBlock — the transcript reveal card for Diagnostic listening items,
 * in one of two mutually exclusive modes (Diagnostic.tsx renders exactly one
 * `AudioBlock` per item, chosen by a single `audioUrl ? … : …` branch — see
 * B1 fix-pass):
 *
 *   - default (`playerPresent` unset/false): the item carries NO playable
 *     audio (no mapped span, or the parent test has no mp3) — the collapsed
 *     state shows an honest "no audio for this question yet" note. There is
 *     no Play button anywhere in this component; it must never imply one
 *     does anything.
 *   - `playerPresent`: a REAL player (`TopikStudyAudio`) is already rendered
 *     above this block for the same item (F-206) — this is just the
 *     transcript-caption toggle alongside it. The collapsed state renders
 *     NOTHING instead of the note: claiming "no audio" here would be exactly
 *     the false statement this component exists to prevent, since audio is
 *     playing right above it.
 *
 * Pass-2 shipped this as a FAKE player (vermilion play button + a progress
 * bar that advanced on a plain interval, no `<audio>` element anywhere) with
 * a "real TTS lands later, swap the interval for an `<audio>` ref" plan. That
 * plan landed differently: F-119/F-206 now map real per-item audio spans onto
 * the official exam mp3s, and Diagnostic renders a REAL player
 * (`TopikStudyAudio`, mirroring the TOPIK study screen) whenever an item
 * carries `audioUrl`/`audioStartMs`/`audioEndMs`. Before the B1 fix-pass this
 * component's honest-note branch rendered unconditionally alongside that real
 * player too (a working Play button captioned by a false "no audio" claim);
 * `playerPresent` is what keeps the two mutually exclusive now.
 *
 * No I/O — no threat model. Transcript text is author-controlled.
 */
import { useState, type JSX } from 'react';
import { Bilingual } from './Bilingual';

export interface AudioBlockProps {
  /** Korean transcript. */
  transcriptKr: string;
  /** Optional English transcript — shown below KR when present. */
  transcriptEn?: string;
  /**
   * True when Diagnostic already rendered a REAL player (`TopikStudyAudio`)
   * for this item — this instance is only the transcript-caption toggle
   * beside it, never the sole audio-related surface. Suppresses the
   * "no audio" note in the collapsed state. Defaults to false (the
   * no-playable-audio fallback card, this component's original contract).
   */
  playerPresent?: boolean;
}

export function AudioBlock({
  transcriptKr,
  transcriptEn,
  playerPresent = false,
}: AudioBlockProps): JSX.Element {
  const [showTranscript, setShowTranscript] = useState(false);

  return (
    <div className="km-audioblock">
      <div className="km-audioblock__row">
        <div className="km-eyebrow km-audioblock__label">
          <Bilingual en="Transcript" kr="대본" compact />
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

      {showTranscript ? (
        <div className="km-audioblock__text">
          <div className="kr km-audioblock__text-kr">{transcriptKr}</div>
          {transcriptEn ? (
            <div className="km-audioblock__text-en">{transcriptEn}</div>
          ) : null}
        </div>
      ) : playerPresent ? null : (
        // No playback exists for this item — say so, rather than showing
        // nothing where a Play button used to be. (Never rendered when a
        // real player is already on screen — see `playerPresent` above.)
        <p className="km-audioblock__note" role="note">
          <Bilingual
            en="No audio for this question yet — study it from the transcript."
            kr="이 문제는 아직 음원이 없어요 — 대본으로 공부해요."
          />
        </p>
      )}
    </div>
  );
}
