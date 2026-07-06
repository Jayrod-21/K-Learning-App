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
 * F-011: an optional confidence band (`scoreLow`–`scoreHigh`) renders as a
 * subtle translucent range over the track — how confident the estimate is,
 * not a second score. Degenerate/omitted band → the plain pre-F-011 bar.
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
import { SKILL_MAX, clampScore, hasVisibleBand } from '../lib/skillBand';

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
   * F-011 confidence band, 0–100. When both edges are provided and
   * `scoreLow < scoreHigh`, a subtle translucent range renders across the
   * track and the bar's aria-label gains "estimated X, range Low–High".
   * Omitted or degenerate (low == high) edges render no band — the honest
   * posture when the estimate's confidence is unknown.
   */
  scoreLow?: number;
  /** Upper edge of the confidence band, 0–100. See `scoreLow`. */
  scoreHigh?: number;
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

export function SkillBar({
  label,
  kr,
  score,
  target,
  scoreLow,
  scoreHigh,
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

  const safeScore = clampScore(score);
  const safeTarget = clampScore(target);
  const meets = safeScore >= safeTarget;
  const widthPct = ready ? (safeScore / SKILL_MAX) * 100 : 0;
  const tickPct = (safeTarget / SKILL_MAX) * 100;

  // Confidence band (F-011). Clamp both edges (same malformed-data defence
  // as the score) and sort them so an inverted server pair can't render a
  // negative-width band. A degenerate band (low == high — the server's
  // "unknown confidence" fallback) renders nothing rather than a 0-width
  // sliver, so legacy snapshots degrade to exactly the pre-F-011 bar.
  const hasBand = hasVisibleBand(scoreLow, scoreHigh);
  const bandLow = hasBand
    ? Math.min(clampScore(scoreLow ?? 0), clampScore(scoreHigh ?? 0))
    : 0;
  const bandHigh = hasBand
    ? Math.max(clampScore(scoreLow ?? 0), clampScore(scoreHigh ?? 0))
    : 0;
  const trackLabel = hasBand
    ? `${label} skill — estimated ${String(safeScore)}, range ${String(bandLow)}–${String(bandHigh)}`
    : `${label} skill`;

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
        aria-label={trackLabel}
        aria-valuemin={0}
        aria-valuemax={SKILL_MAX}
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
        {/* Confidence band — a translucent overlay ABOVE the fill so the
            range stays visible across both the filled and empty halves of
            the track. Decorative for sighted users; screen readers get the
            range via the track aria-label, so the overlay is aria-hidden. */}
        {hasBand ? (
          <div
            className="km-skillbar__band"
            aria-hidden="true"
            style={{
              left: `${String(bandLow)}%`,
              width: `${String(bandHigh - bandLow)}%`,
            }}
          />
        ) : null}
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
