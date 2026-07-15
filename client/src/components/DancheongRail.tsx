/**
 * DancheongRail — the leading-edge palette stripe (Day) / neon edge
 * (Night). DESIGN_SEOUL_DAY_NIGHT.md device #2.
 *
 * Day always renders the fixed four-band temple-paint stripe (jade /
 * vermilion / cobalt / ochre) — the doc's "dancheong rail" is a FIXED motif,
 * not a tone swap. Night instead renders a single glowing edge in whichever
 * `tone` is active (`accent` tracks the user's global accent picker; `blue`
 * / `mint` / `ochre` / `cyan` / `violet` are fixed regardless of the picker —
 * `ochre` is the Hanja skill color, added in the batch-3 fix-pass so Hanja no
 * longer has to fall back to `plain`; `cyan`/`violet` are the Reading/Writing
 * skill colors, added for F-189's canonical per-skill color system so every
 * `--<hue>` token seoul-devices.css already carries (indigo/vermilion/ochre/
 * cyan/moss/violet) has a matching fixed tone, not just three of the six;
 * `plain` is a quiet neutral edge with no glow) — `--km-tone`
 * (styles/seoul-devices.css) resolves that mapping once for every
 * character-device component.
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
