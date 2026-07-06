/**
 * LineChart — generic single-series trend chart (F-017).
 *
 * Hand-rolled inline SVG per the project convention (no charting lib — the
 * same approach as Progress's private `TrendChart`, generalized to one
 * series fed by props). Renders a responsive line + soft area fill + point
 * markers, a recessive 3-tick y grid, and first/last date labels on x.
 *
 * Scale contract:
 *   - `unit === '%'` → the y-domain is FIXED at 0–100 (accuracy series must
 *     not zoom noise into drama).
 *   - anything else  → auto-scaled 0 → nice ceiling of the data max (counts
 *     and scores keep an honest zero baseline).
 *
 * Degenerate inputs are first-class states, not crashes:
 *   - no (finite) points → a friendly "No data yet" placeholder.
 *   - one point → a centered dot, no line/area.
 *   - non-finite values are dropped defensively before plotting.
 *
 * Hover layer (per the dataviz interaction default and the TrendChart
 * pattern): one keyboard-reachable hit button per point drives a crosshair
 * plus an always-visible readout that defaults to the latest point — the
 * data is never gated behind a pointer.
 *
 * Color: the line/area/dots wear `--km-chart-accent` (fallback vermilion),
 * so a wrapper assigns each skill its validated categorical hue (see
 * Progress.css — color follows the entity). All text wears text tokens.
 * Theme-awareness comes free from the CSS variables.
 *
 * Threat model: `unit` / `metricLabel` / `ariaLabel` and point data render
 * as React children or attribute strings → escaped by React. No HTML is
 * ever injected.
 */
import { useState } from 'react';
import type { JSX } from 'react';
import type { SeriesPoint } from '../types/domain';
import './LineChart.css';

export interface LineChartProps {
  /** Series points, ascending by date (the server contract). */
  points: SeriesPoint[];
  /** Display unit for values (`'%'`, `'cards'`, …). `'%'` fixes y at 0–100. */
  unit: string;
  /** Human name of the metric (e.g. `"Accuracy"`) — readout + hit labels. */
  metricLabel: string;
  /** Accessible name for the chart image. */
  ariaLabel: string;
}

// ─────────────────────────────────────────────────────────────
// Geometry (viewBox units; the SVG scales to container width)
// ─────────────────────────────────────────────────────────────

const W = 320;
const H = 150;
const PAD = { top: 12, right: 14, bottom: 22, left: 36 } as const;
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;
/** Beyond this many points, per-point markers become noise — endpoint only. */
const MAX_DOTTED_POINTS = 16;

function xFor(i: number, n: number): number {
  // A single point centers in the plot; division by n-1 needs n >= 2.
  if (n <= 1) return PAD.left + INNER_W / 2;
  return PAD.left + (i * INNER_W) / (n - 1);
}

function yFor(value: number, yMax: number): number {
  // Clamp into the plot so a stray out-of-range value can't paint outside
  // the axes (e.g. an accuracy of 104 from a rounding bug upstream).
  const frac = Math.min(1, Math.max(0, value / yMax));
  return PAD.top + (1 - frac) * INNER_H;
}

/**
 * Nice ceiling for the auto-scaled y-domain: the smallest 1/2/5 × 10^k that
 * covers `max`. An all-zero series scales to 1 so the baseline still reads.
 */
function niceCeil(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= max) return m * base;
  }
  return 10 * base; // unreachable — 10*base >= max by construction
}

/** Compact tick label — strips float noise (2.5 stays, 2.0 → 2). */
function formatTick(v: number): string {
  return String(Number(v.toFixed(1)));
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * "Jun 12" from "2026-06-12". Parsed by hand — `new Date('YYYY-MM-DD')` is
 * UTC-midnight, which shifts the calendar day in negative-offset locales.
 * A malformed date echoes back as-is rather than rendering "undefined NaN".
 */
function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (month === undefined) return iso;
  return `${month} ${String(Number(m[3]))}`;
}

export function LineChart({
  points,
  unit,
  metricLabel,
  ariaLabel,
}: LineChartProps): JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Drop non-finite values defensively — one NaN from a bad row must not
  // corrupt the whole polyline into an invisible chart.
  const pts = points.filter((p) => Number.isFinite(p.value));
  const n = pts.length;

  if (n === 0) {
    return (
      <div className="km-linechart km-linechart--empty">
        <span className="km-linechart__emptyText">No data yet</span>
      </div>
    );
  }

  const isPercent = unit === '%';
  const yMax = isPercent ? 100 : niceCeil(Math.max(...pts.map((p) => p.value)));
  const yTicks = [0, yMax / 2, yMax];

  const formatValue = (v: number): string =>
    isPercent
      ? `${String(Math.round(v))}%`
      : `${formatTick(v)}${unit !== '' ? ` ${unit}` : ''}`;

  const xs = pts.map((_, i) => xFor(i, n));
  const linePoints = pts
    .map((p, i) => `${String(xs[i] ?? 0)},${String(yFor(p.value, yMax))}`)
    .join(' ');
  // Area = the line path closed down to the zero baseline.
  const baselineY = yFor(0, yMax);
  const areaPoints =
    n >= 2
      ? `${linePoints} ${String(xs[n - 1] ?? 0)},${String(baselineY)} ${String(xs[0] ?? 0)},${String(baselineY)}`
      : '';

  // Every point gets a marker while they still read as marks; beyond that
  // only the endpoint is dotted and the hover layer carries per-point detail.
  const dotted = n <= MAX_DOTTED_POINTS ? pts.map((_, i) => i) : [n - 1];

  // The readout defaults to the latest point so its value is visible with no
  // pointer at all — hover/focus enhances, never gates.
  const readoutIdx = hoverIdx ?? n - 1;
  const readoutPt = pts[readoutIdx];

  return (
    <div className="km-linechart">
      <div className="km-linechart__plotwrap">
        <svg
          className="km-linechart__svg"
          viewBox={`0 0 ${String(W)} ${String(H)}`}
          role="img"
          aria-label={ariaLabel}
        >
          {/* Grid + y ticks (recessive; baseline slightly stronger) */}
          {yTicks.map((t) => (
            <g key={`grid-${String(t)}`}>
              <line
                className={t === 0 ? 'km-linechart__axis' : 'km-linechart__grid'}
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yFor(t, yMax)}
                y2={yFor(t, yMax)}
              />
              <text
                className="km-linechart__tick"
                x={PAD.left - 6}
                y={yFor(t, yMax) + 3}
                textAnchor="end"
              >
                {formatTick(t)}
              </text>
            </g>
          ))}

          {/* X labels — first + last date only; the readout names the rest */}
          <text
            className="km-linechart__tick"
            x={xs[0] ?? 0}
            y={H - PAD.bottom + 14}
            textAnchor={n <= 1 ? 'middle' : 'start'}
          >
            {formatDay(pts[0]?.date ?? '')}
          </text>
          {n >= 2 ? (
            <text
              className="km-linechart__tick"
              x={xs[n - 1] ?? 0}
              y={H - PAD.bottom + 14}
              textAnchor="end"
            >
              {formatDay(pts[n - 1]?.date ?? '')}
            </text>
          ) : null}

          {/* Crosshair for the hovered/focused point */}
          {hoverIdx !== null ? (
            <line
              className="km-linechart__crosshair"
              x1={xs[hoverIdx]}
              x2={xs[hoverIdx]}
              y1={PAD.top}
              y2={H - PAD.bottom}
            />
          ) : null}

          {/* Series: soft area + 2px line + markers */}
          {n >= 2 ? (
            <>
              <polygon className="km-linechart__area" points={areaPoints} />
              <polyline className="km-linechart__line" points={linePoints} />
            </>
          ) : null}
          {dotted.map((i) => (
            <circle
              key={`dot-${pts[i]?.date ?? String(i)}`}
              className="km-linechart__dot"
              cx={xs[i]}
              cy={yFor(pts[i]?.value ?? 0, yMax)}
              r={4}
            />
          ))}
        </svg>

        {/* Keyboard-reachable hover layer: one real button per point. */}
        {pts.map((p, i) => {
          const startX = i === 0 ? PAD.left - 10 : ((xs[i - 1] ?? 0) + (xs[i] ?? 0)) / 2;
          const endX =
            i === n - 1 ? W - PAD.right + 10 : ((xs[i] ?? 0) + (xs[i + 1] ?? 0)) / 2;
          return (
            <button
              key={`hit-${p.date}`}
              type="button"
              className="km-linechart__hit focusring"
              style={{
                left: `${String((startX / W) * 100)}%`,
                width: `${String(((endX - startX) / W) * 100)}%`,
              }}
              aria-label={`${metricLabel} on ${formatDay(p.date)}: ${formatValue(p.value)}`}
              onMouseEnter={() => {
                setHoverIdx(i);
              }}
              onMouseLeave={() => {
                setHoverIdx(null);
              }}
              onFocus={() => {
                setHoverIdx(i);
              }}
              onBlur={() => {
                setHoverIdx(null);
              }}
            />
          );
        })}
      </div>

      {/* Always-visible readout — the tooltip's home. role="status" = polite
          live region, so hover/focus changes are announced. */}
      <div className="km-linechart__readout" role="status">
        <span className="km-linechart__readoutMetric">{metricLabel}</span>
        {readoutPt !== undefined ? (
          <span>
            {formatDay(readoutPt.date)} · {formatValue(readoutPt.value)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default LineChart;
