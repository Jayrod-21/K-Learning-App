/**
 * HanjaCell — square card for a single hanja in the index grid.
 *
 * State-encoded 2px top border so the index reads as a learning map at a
 * glance, reading the shared `--km-mastery-*` triad (styles/index.css,
 * fix-pass batch-3 — fixed regardless of accent, AA-checked ≥3:1 non-text
 * contrast in both themes; see FIX_REPORT_batch3.md for the measured
 * numbers):
 *   - `banked`     → --km-mastery-mastered (moss — green, "mastered")
 *   - `practicing` → --km-mastery-practicing (ochre-ink — amber, "active SRS")
 *   - `new`        → --km-mastery-new (paper-mute — neutral gray, "not
 *                    started"; NOT red/danger, which would misread a
 *                    never-studied character as a problem)
 *
 * 32px Noto-Serif character + sound caption beneath. Renders as a button so
 * the whole tile is the gesture; click fires `onClick`. Inherits `.focusring`
 * + keyboard `Enter`/`Space` activation comes free with the native button.
 */
import type { JSX } from 'react';
import { cn } from '../lib/cn';

export type HanjaState = 'new' | 'practicing' | 'banked';

export interface HanjaCellProps {
  /** The hanja character itself, e.g. "韓". */
  char: string;
  /** Sino-Korean reading, e.g. "한". */
  sound: string;
  /** Optional Korean gloss displayed before the sound (e.g. "나라"). */
  gloss?: string;
  state: HanjaState;
  onClick?: () => void;
}

const STATE_CLASS: Record<HanjaState, string> = {
  banked: 'km-hanjacell--banked',
  practicing: 'km-hanjacell--practicing',
  new: 'km-hanjacell--new',
};

export function HanjaCell({
  char,
  sound,
  gloss,
  state,
  onClick,
}: HanjaCellProps): JSX.Element {
  // aria-label assembles the human-readable cell name; without it, a screen
  // reader would only announce raw CJK + an unlabelled state color.
  const label = gloss ? `${char} ${gloss} ${sound}` : `${char} ${sound}`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn('km-hanjacell focusring', STATE_CLASS[state])}
      data-state={state}
    >
      <span className="hanja km-hanjacell__char">{char}</span>
      <span className="kr km-hanjacell__caption">
        {gloss ? <span className="km-hanjacell__gloss">{gloss} </span> : null}
        <span className="km-hanjacell__sound">{sound}</span>
      </span>
    </button>
  );
}
