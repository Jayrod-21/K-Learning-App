/**
 * Card — the main elevated surface (Seoul Neon restyle).
 *
 * `--ink-1` surface, `--radius-lg` corners, depth from the theme-aware
 * shadow tokens — no hairline borders. Rounded + elevated is deliberate:
 * light theme floats glassy white cards on soft daylight shadows, dark
 * theme edges them with a faint glass ring. (The old "don't soften the
 * corners" hanji rule is retired.)
 *
 * Variants:
 *   - `default`   — card surface, full elevation (`--shadow`).
 *   - `flat`      — elevated-surface tint, small shadow. Used inside
 *                   other cards.
 *   - `accent`    — accent-soft tint with an inset accent left bar;
 *                   for the "Review queue" CTA card on Today.
 */
import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';

export type CardVariant = 'default' | 'flat' | 'accent';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  children: ReactNode;
}

const BASE = 'km-card';

const VARIANT_CLASS: Record<CardVariant, string> = {
  default: 'km-card--default',
  flat: 'km-card--flat',
  accent: 'km-card--accent',
};

export function Card({
  variant = 'default',
  className,
  children,
  ...rest
}: CardProps): JSX.Element {
  return (
    <div className={cn(BASE, VARIANT_CLASS[variant], className)} {...rest}>
      {children}
    </div>
  );
}
