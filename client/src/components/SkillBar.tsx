/**
 * SkillBar — one row inside a `SkillsCompare`.
 *
 * Track (paper-2 background, 8–10px tall) with an animated fill whose color
 * encodes pass/fail relative to a target:
 *   - `score >= target` → moss (at-or-above)
 *   - `score <  target` → paper-faint (below)
 *
 * A 2px vertical reference tick marks `target%`. The tick color carries a
 * second piece of meaning: `tone='ceiling'` paints it indigo so the bar can
 * differentiate a TOPIK target (vermilion) from the Native ceiling (indigo).
 *
 * Animations:
 *   - Fill width: 720–900ms `cubic-bezier(.2,.7,.2,1)` with optional stagger.
 *     Per CSS rule, `prefers-reduced-motion: reduce` collapses this to ~0ms.
 *   - Tick position: 360ms when the user picks a different reference.
 *
 * Scoring is 0–100 mapped to TOPIK bands per the design README — we never
 * fake decimal levels like "L3.4". The numeric header shows `{score}/{target}`
 * tabular for an honest read.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';

export type SkillBarTone = 'target' | 'ceiling';

export interface SkillBarProps {
  /** English label, e.g. "Listening". */
  label: string;
  /** Korean label, e.g. "듣기". */
  kr: string;
  /** Current score, 0–100. */
  score: number;
  /** Target score, 0–100. */
  target: number;
  /**
   * Color of the reference tick.
   *   - `target` → vermilion (TOPIK band target)
   *   - `ceiling` → indigo (Native ceiling — not a goal, just an anchor)
   */
  tone?: SkillBarTone;
  /** Compact bars sit closer + drop the gap note. */
  compact?: boolean;
  /** Optional gap-note line under the bar. Suppressed in `compact` mode. */
  gapNote?: string;
  /** Animation stagger in ms; lets a parent fan-in multiple bars. */
  delayMs?: number;
}

const MAX = 100;

/** Clamp 0–100 — defends against malformed fixture data drifting on-screen. */
function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > MAX) return MAX;
  return value;
}

export function SkillBar({
  label,
  kr,
  score,
  target,
  tone = 'target',
  compact = false,
  gapNote,
  delayMs = 0,
}: SkillBarProps): JSX.Element {
  // Internal "ready" gate — mounts at 0 width so the CSS transition runs
  // once for every freshly-mounted bar. Honors reduced-motion via the
  // global CSS rule that collapses transition-duration. (The previous
  // public `animated` prop was redundant — the `ready` gate is
  // sufficient, and `animated={false}` zeroed the fill forever, which
  // every caller would have hit as a footgun. Dropped in Pass 2.)
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setReady(true);
    }, 16);
    return () => {
      window.clearTimeout(id);
    };
  }, []);

  const safeScore = clamp(score);
  const safeTarget = clamp(target);
  const meets = safeScore >= safeTarget;
  const widthPct = ready ? (safeScore / MAX) * 100 : 0;
  const tickPct = (safeTarget / MAX) * 100;

  return (
    <div className={cn('km-skillbar', compact && 'km-skillbar--compact')}>
      <div className="km-skillbar__header">
        <div className="km-skillbar__labels">
          <span className="km-skillbar__label">{label}</span>
          <span className="kr km-skillbar__kr">{kr}</span>
        </div>
        <div
          className={cn(
            'km-skillbar__score',
            meets && 'km-skillbar__score--meets',
          )}
        >
          {safeScore}
          <span className="km-skillbar__scoresep"> / {safeTarget}</span>
        </div>
      </div>
      <div
        className="km-skillbar__track"
        role="progressbar"
        aria-label={`${label} skill`}
        aria-valuemin={0}
        aria-valuemax={MAX}
        aria-valuenow={safeScore}
      >
        <div
          className={cn(
            'km-skillbar__fill',
            meets ? 'km-skillbar__fill--meets' : 'km-skillbar__fill--below',
          )}
          style={{
            width: `${String(widthPct)}%`,
            transitionDelay: `${String(delayMs)}ms`,
          }}
        />
        <div
          className={cn(
            'km-skillbar__tick',
            tone === 'ceiling'
              ? 'km-skillbar__tick--ceiling'
              : 'km-skillbar__tick--target',
          )}
          style={{ left: `${String(tickPct)}%` }}
        />
      </div>
      {!compact && gapNote ? (
        <div className="km-skillbar__note">{gapNote}</div>
      ) : null}
    </div>
  );
}
