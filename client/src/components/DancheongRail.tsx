/**
 * DancheongRail — the leading-edge palette stripe (Day) / neon edge
 * (Night). DESIGN_SEOUL_DAY_NIGHT.md device #2.
 *
 * Day always renders the fixed four-band temple-paint stripe (jade /
 * vermilion / cobalt / ochre) — the doc's "dancheong rail" is a FIXED motif,
 * not a tone swap. Night instead renders a single glowing edge in whichever
 * `tone` is active (`accent` tracks the user's global accent picker — used
 * by general-purpose page chrome, not by any of the 7 LEARN sub-pages
 * anymore; `blue` / `mint` / `ochre` / `cyan` / `violet` / `crimson` /
 * `stone` are all fixed regardless of the picker — `ochre` is the Hanja
 * skill color (batch-3 fix-pass); `cyan`/`violet` are Reading/Writing
 * (F-189); `crimson`/`stone` are Grammar/TOPIK (F-189 fix-pass round 4,
 * REVIEW_r4-colors.md BLOCKER-2 — Grammar and TOPIK used to share `accent`,
 * which both fused them into one honeycomb shape and could 3-way-collide
 * with another skill's fixed hue under the blue/mint accent presets; see
 * `lib/skill-colors.ts`, the single source of truth for this whole
 * skill→tone assignment); `plain` is a quiet neutral edge with no glow) —
 * `--km-tone` (styles/seoul-devices.css) resolves that mapping once for
 * every character-device component.
 *
 * Usually consumed internally by `CityCard`'s `rail` prop, but exported
 * standalone for any surface that wants the leading-edge motif without the
 * full card treatment (e.g. a list row).
 *
 * Purely decorative — the rail carries no information a screen reader
 * needs (the card's own content does), so it's `aria-hidden`.
 */
import type { JSX } from 'react';
import { cn } from '../lib/cn';
import './DancheongRail.css';

export type DancheongRailTone =
  | 'accent'
  | 'blue'
  | 'mint'
  | 'ochre'
  | 'cyan'
  | 'violet'
  | 'crimson'
  | 'stone'
  | 'plain';

export interface DancheongRailProps {
  tone?: DancheongRailTone;
  /** Featured emphasis — thicker band, stronger Night glow. */
  feat?: boolean;
  className?: string;
}

export function DancheongRail({
  tone = 'accent',
  feat = false,
  className,
}: DancheongRailProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'km-dancheong-rail',
        `km-tone--${tone}`,
        feat && 'km-dancheong-rail--feat',
        className,
      )}
    />
  );
}
