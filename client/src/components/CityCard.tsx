/**
 * CityCard — the themed default surface (DESIGN_SEOUL_DAY_NIGHT.md device
 * #1, §5): a neon signboard by night, hanji paper by day. This is the
 * app's SECOND card primitive, distinct from `Card` — `Card` is the calm,
 * everyday surface every screen already uses; `CityCard` is the "featured
 * surface with real identity" for the Seoul redesign (a hero card, a
 * milestone panel, a callout) and is what pages will reach for as they
 * adopt the Wave-2 look. Building it does not touch `Card` or any page
 * that already renders one.
 *
 * `tone` picks the accent family:
 *   - `accent` (default)    — tracks the user's global `[data-accent]` pick.
 *   - `blue` / `mint`       — fixed hue regardless of the picker (e.g. a
 *                             surface that always wants to read as "Vocab
 *                             blue" no matter the user's accent choice).
 *   - `ochre`               — fixed Hanja skill hue (batch-3 fix-pass
 *                             addition), same "always this hue" contract as
 *                             `blue`/`mint`. Hanja.tsx adopts this instead of
 *                             falling back to `plain`.
 *   - `plain`               — neutral edge, no glow (Night); a quiet
 *                             hairline card (Day).
 *
 * `rail` composes `DancheongRail` on the leading edge (Day: fixed
 * four-band stripe; Night: a glowing edge in `tone`). `feat` raises the
 * emphasis (thicker rail, stronger Night glow) for a single hero card on
 * a screen.
 *
 * Token-driven only (no hard-coded hex — see CityCard.css); reduced-motion
 * is a non-issue here since the card itself has no motion (only the
 * optional `.km-neon-flicker` a caller can add via className has any, and
 * that utility already no-ops under reduced-motion).
 */
import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DancheongRail, type DancheongRailTone } from './DancheongRail';
import './CityCard.css';

export type CityCardTone = DancheongRailTone;

export interface CityCardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CityCardTone;
  /** Show the leading-edge DancheongRail (Day stripe / Night glow edge). */
  rail?: boolean;
  /** Featured emphasis — stronger shadow/glow, thicker rail. */
  feat?: boolean;
  /** Optional title slot, rendered with the Day serif / Night neon-glow
   * title treatment. Pass plain children instead if a screen needs full
   * control over its own heading markup. Named `heading` (not `title`) —
   * `HTMLAttributes<HTMLDivElement>` already reserves `title` for the
   * native tooltip attribute. */
  heading?: ReactNode;
  children?: ReactNode;
}

export function CityCard({
  tone = 'accent',
  rail = false,
  feat = false,
  heading,
  className,
  children,
  ...rest
}: CityCardProps): JSX.Element {
  return (
    <div
      className={cn(
        'km-citycard',
        `km-tone--${tone}`,
        feat && 'km-citycard--feat',
        className,
      )}
      {...rest}
    >
      {rail ? <DancheongRail tone={tone} feat={feat} /> : null}
      {heading != null ? (
        <p className="km-citycard__title kr-display">{heading}</p>
      ) : null}
      {children}
    </div>
  );
}
