/**
 * SkylineHeader — the Namsan skyline strip (DESIGN_SEOUL_DAY_NIGHT.md
 * device #4), for the top of the Today hub and major landings.
 *
 * One SVG carries BOTH variants as separate `<g>` layers, toggled purely
 * by CSS (`[data-theme]`, in SkylineHeader.css) rather than a JS theme
 * read — the strip renders correctly on first paint even before
 * `ThemeProvider` settles the `data-theme` attribute, and needs no
 * `useTheme()` dependency to stay in sync.
 *
 *   - Day:   hanok tiled roofs + soft rounded buildings + a red beacon.
 *   - Night: dark tower silhouettes + a Namsan-tower silhouette + lit
 *            windows + a neon horizon line.
 *
 * Gently parallaxes (the far/near layers drift at slightly different
 * rates) under `prefers-reduced-motion: no-preference`; under `reduce`
 * the layers simply render at their static rest position (see
 * SkylineHeader.css — the animation rule is itself gated by the
 * no-preference media query, so `reduce` needs no override to cancel it).
 *
 * Purely decorative illustration — `aria-hidden`. The optional `title`
 * slot is real content and renders OUTSIDE the `aria-hidden` SVG.
 */
import type { JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';
import './SkylineHeader.css';

export interface SkylineHeaderProps {
  /** Optional title overlay (e.g. the Today hub's greeting/date). Caller
   * controls heading semantics — this renders plain markup, not an <h*>. */
  title?: ReactNode;
  className?: string;
}

export function SkylineHeader({ title, className }: SkylineHeaderProps): JSX.Element {
  return (
    <div className={cn('km-skyline', className)}>
      <svg
        className="km-skyline__svg"
        viewBox="0 0 400 120"
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
        focusable="false"
      >
        {/* ── Day: hanok roofs + soft buildings + red beacon ── */}
        <g className="km-skyline__day">
          <g className="km-skyline__far">
            <rect x="10" y="55" width="34" height="50" rx="3" className="km-skyline__bldg" />
            <rect x="60" y="40" width="30" height="65" rx="3" className="km-skyline__bldg" />
            <rect x="300" y="48" width="32" height="57" rx="3" className="km-skyline__bldg" />
            <rect x="350" y="60" width="30" height="45" rx="3" className="km-skyline__bldg" />
          </g>
          <g className="km-skyline__near">
            {/* Hanok roof: a shallow curved eave over a low body. */}
            <path
              d="M120 90 Q160 62 200 90 Z"
              className="km-skyline__roof"
            />
            <rect x="132" y="90" width="56" height="18" className="km-skyline__bldg" />
            <path
              d="M215 95 Q245 74 275 95 Z"
              className="km-skyline__roof"
            />
            <rect x="224" y="95" width="42" height="13" className="km-skyline__bldg" />
            <circle cx="200" cy="60" r="4" className="km-skyline__beacon" />
          </g>
        </g>

        {/* ── Night: dark towers + Namsan tower + lit windows + neon horizon ── */}
        <g className="km-skyline__night">
          <g className="km-skyline__far">
            <rect x="8" y="50" width="30" height="55" className="km-skyline__bldg" />
            <rect x="46" y="35" width="26" height="70" className="km-skyline__bldg" />
            <rect x="310" y="45" width="28" height="60" className="km-skyline__bldg" />
            <rect x="352" y="58" width="26" height="47" className="km-skyline__bldg" />
            <rect x="20" y="60" width="4" height="4" className="km-skyline__window" />
            <rect x="54" y="50" width="4" height="4" className="km-skyline__window" />
            <rect x="54" y="70" width="4" height="4" className="km-skyline__window" />
            <rect x="320" y="62" width="4" height="4" className="km-skyline__window" />
            <rect x="360" y="72" width="4" height="4" className="km-skyline__window" />
          </g>
          <g className="km-skyline__near">
            <rect x="120" y="70" width="24" height="35" className="km-skyline__bldg" />
            <rect x="150" y="55" width="22" height="50" className="km-skyline__bldg" />
            <rect x="228" y="65" width="24" height="40" className="km-skyline__bldg" />
            {/* Namsan tower: a slender mast with a bulb, the tallest silhouette. */}
            <rect x="197" y="30" width="3" height="45" className="km-skyline__tower" />
            <circle cx="198.5" cy="26" r="6" className="km-skyline__tower" />
            <circle cx="198.5" cy="26" r="9" className="km-skyline__towerglow" />
            <rect x="128" y="80" width="4" height="4" className="km-skyline__window" />
            <rect x="128" y="92" width="4" height="4" className="km-skyline__window" />
            <rect x="158" y="66" width="4" height="4" className="km-skyline__window" />
            <rect x="236" y="76" width="4" height="4" className="km-skyline__window" />
          </g>
          <rect x="0" y="105" width="400" height="1.5" className="km-skyline__horizon" />
        </g>
      </svg>
      {title != null ? <div className="km-skyline__title kr-display">{title}</div> : null}
    </div>
  );
}
