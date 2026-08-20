/**
 * AudioBlock — honest transcript card for Diagnostic listening items that
 * carry NO playable audio (no mapped span, or the parent test has no mp3).
 *
 * Pass-2 shipped this as a FAKE player (vermilion play button + a progress
 * bar that advanced on a plain interval, no `<audio>` element anywhere) with
 * a "real TTS lands later, swap the interval for an `<audio>` ref" plan. That
 * plan landed differently: F-119/F-206 now map real per-item audio spans onto
 * the official exam mp3s, and Diagnostic renders a REAL player
 * (`TopikStudyAudio`, mirroring the TOPIK study screen) whenever an item
 * carries `audioUrl`/`audioStartMs`/`audioEndMs`. This component is what
 * Diagnostic falls back to for the items that DON'T have a mapped span — it
 * must never imply a Play button does anything, because there is nothing to
 * play. It shows the transcript, honestly labeled, with no playback chrome.
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
}

export function AudioBlock({
  transcriptKr,
  transcriptEn,
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
      ) : (
        // No playback exists for this item — say so, rather than showing
        // nothing where a Play button used to be.
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
