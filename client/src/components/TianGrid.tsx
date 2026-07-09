/**
 * TianGrid — CSS-only calligraphy practice square (田 grid). A FUNCTIONAL
 * stroke-placement guide, not decoration.
 *
 * Crosshair (vertical + horizontal centerline) plus a rotated dashed square
 * that becomes the diagonals once inscribed. Rendered behind the featured
 * hanja on the Hanja Today view. Seoul restyle: the strokes read the
 * neutral `--paper-mute` ink (faint pencil guides) instead of the old
 * hanji vermilion; structure and function unchanged.
 *
 * Pure CSS — no SVG — because the grid scales with the parent and inherits
 * the stroke-color CSS variable cleanly (theme-aware without re-fetching
 * paths).
 *
 * Absolute-positioned to fill the parent; the parent MUST be positioned.
 * `aria-hidden` — pure decoration.
 */
import type { CSSProperties, JSX } from 'react';
import { cn } from '../lib/cn';

export interface TianGridProps {
  /** Stroke opacity 0–1 (default 0.18, matches the prototype). */
  opacity?: number;
  className?: string;
  style?: CSSProperties;
}

export function TianGrid({
  opacity = 0.18,
  className,
  style,
}: TianGridProps): JSX.Element {
  // Expose opacity to CSS so the grid lines stay in sync without a re-render.
  // CSSProperties has no index signature for custom properties, so the
  // `--km-*` var key would otherwise widen the whole literal incorrectly.
  // Build the merged object as a plain Record and assert to CSSProperties.
  const combinedStyle = {
    '--km-tian-opacity': String(opacity),
    ...(style as Record<string, string | number>),
  } as CSSProperties;
  return (
    <div
      className={cn('km-tian', className)}
      style={combinedStyle}
      aria-hidden="true"
    >
      <span className="km-tian__v" />
      <span className="km-tian__h" />
      <span className="km-tian__diag" />
    </div>
  );
}
