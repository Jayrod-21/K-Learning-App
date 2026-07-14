/**
 * SubwayProgress — the signature progress metaphor (DESIGN_SEOUL_DAY_NIGHT.md
 * device #5): a metro line with station dots. Filled = done, ringed =
 * current, hollow = ahead. Use for daily progress, multi-step exercises,
 * TOPIK question runs, onboarding — anywhere a page currently renders a
 * plain step indicator.
 *
 * Accessibility: the whole strip is a single `role="progressbar"` (the
 * dots are a visualization of ONE value, not `steps` separately-focusable
 * items) — `aria-valuenow`/`aria-valuemin`/`aria-valuemax` carry the
 * number for assistive tech; `aria-label` (or `aria-valuetext`, if the
 * caller wants the announcement to include a unit like "station 3 of 8")
 * names it. The individual dots are `aria-hidden` decoration.
 *
 * `tone` mirrors CityCard/DancheongRail's four-value tone prop so a line
 * can either track the user's global accent (`accent`, default) or pin to
 * a fixed hue (`blue`/`mint`) regardless of the picker; `plain` renders a
 * neutral line color-coded to nothing in particular.
 */
import type { JSX } from 'react';
import { cn } from '../lib/cn';
import type { DancheongRailTone } from './DancheongRail';
import './SubwayProgress.css';

export type SubwayProgressTone = DancheongRailTone;

export interface SubwayProgressProps {
  /** Total station count. Must be >= 1. */
  steps: number;
  /** 0-indexed active station. Clamped into `[0, steps - 1]`. */
  current: number;
  tone?: SubwayProgressTone;
  /** Accessible name for the progressbar (e.g. "Daily progress"). */
  label: string;
  /** Optional richer announcement, e.g. `"Station 3 of 8"`. Falls back to
   * a generic "step N of M" string when omitted. */
  valueText?: string;
  className?: string;
}

// Above this station count, a row of fixed 10px dots (no wrap, no
// overflow-x) overflows a narrow mobile content box — e.g. a 50-item TOPIK
// mock exam (`MockMode.tsx`) or a maxed-out Hanja study/draw session
// (`STUDY_SESSION_LIMIT`, `Hanja.tsx`), both of which can exceed this count.
// 24 dots is comfortably under budget on a ~330px phone content box (well
// under the design doc's §8 "nothing clips off-screen-right" bar); past it
// we fall back to the design system's own documented plain-bar fallback
// ("Progress bars ... plain bars fill with the accent",
// DESIGN_SEOUL_DAY_NIGHT.md §6) — the same accent fill line, just without
// per-station dots that would no longer be individually legible anyway.
const DOT_RENDER_CAP = 24;

export function SubwayProgress({
  steps,
  current,
  tone = 'accent',
  label,
  valueText,
  className,
}: SubwayProgressProps): JSX.Element {
  // Guard against NaN/Infinity (e.g. a caller passing a bad computed ratio
  // like `current={0 / 0}`) — `Math.floor`/`Math.min`/`Math.max` all
  // propagate NaN silently, which would otherwise render a broken
  // `aria-valuenow={NaN}` and a station loop with no clear "current" dot.
  const safeSteps = Number.isFinite(steps) ? steps : 1;
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const total = Math.max(1, Math.floor(safeSteps));
  const active = Math.min(Math.max(0, Math.floor(safeCurrent)), total - 1);
  const fillPct = total > 1 ? (active / (total - 1)) * 100 : 100;
  const condensed = total > DOT_RENDER_CAP;

  return (
    <div
      className={cn('km-subway', `km-tone--${tone}`, className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={active + 1}
      aria-valuetext={valueText ?? `Step ${String(active + 1)} of ${String(total)}`}
    >
      <div className="km-subway__track" aria-hidden="true">
        <div className="km-subway__fill" style={{ width: `${String(fillPct)}%` }} />
        {!condensed && (
          <div className="km-subway__stations">
            {Array.from({ length: total }, (_, i) => {
              const state = i < active ? 'done' : i === active ? 'current' : 'ahead';
              return (
                <span
                  key={i}
                  className={cn('km-subway__station', `km-subway__station--${state}`)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
