/**
 * Pill — 10px Inter, all-caps, 0.14em tracking. Used for status tags,
 * source labels, level markers. Tone tokens:
 *
 *   - `default`  — paper-mute on hairline border
 *   - `gold`     — vermilion (단청)
 *   - `red`      — indigo (청)  (yes, the design calls indigo "red" because
 *                                 the prototype's naming pre-dates the
 *                                 vermilion/indigo split)
 *   - `green`    — moss
 *   - `ochre`    — ochre (hanja)
 */
import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';

export type PillTone = 'default' | 'gold' | 'red' | 'green' | 'ochre';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  children: ReactNode;
}

const TONE_CLASS: Record<PillTone, string> = {
  default: 'km-pill--default',
  gold: 'km-pill--gold',
  red: 'km-pill--red',
  green: 'km-pill--green',
  ochre: 'km-pill--ochre',
};

export function Pill({
  tone = 'default',
  className,
  children,
  ...rest
}: PillProps): JSX.Element {
  return (
    <span className={cn('km-pill', TONE_CLASS[tone], className)} {...rest}>
      {children}
    </span>
  );
}
