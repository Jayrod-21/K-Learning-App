/**
 * CornerMark — editorial L-bracket in the top-right of a positioned ancestor.
 *
 * 14px vermilion two-stroke corner; quietly editorial. Used on progress cards
 * (Hanja "Encountered" band, Today review queue) to nod at Korean book design.
 *
 * The parent MUST be `position: relative` — the bracket is absolutely
 * positioned. `aria-hidden` because the mark is purely ornamental.
 */
import type { CSSProperties, JSX } from 'react';
import { cn } from '../lib/cn';

export interface CornerMarkProps {
  className?: string;
  style?: CSSProperties;
}

export function CornerMark({ className, style }: CornerMarkProps): JSX.Element {
  return (
    <span
      className={cn('km-cornermark', className)}
      style={style}
      aria-hidden="true"
    />
  );
}
