/**
 * Card — the main "paper on table" shape.
 *
 * `--ink-1` paper, 1px `--line` border, 4px radius, hairline top shadow.
 * Squared corners are deliberate; widening past 4px breaks the aesthetic
 * (see design README: "Don't soften the corners").
 *
 * Variants:
 *   - `default`   — paper background, hairline border.
 *   - `flat`      — transparent, hairline border. Used inside other cards.
 *   - `accent`    — vermilion-soft tint with vermilion left border;
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
