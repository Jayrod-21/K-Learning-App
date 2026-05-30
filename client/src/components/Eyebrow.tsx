/**
 * Eyebrow — small 10–11 px Inter, all-caps, 0.22em tracking, `paper-mute`.
 *
 * Always sits above a heading; never used alone. Renders as a div so the
 * caller can stack a `<h1>` underneath without nesting headings.
 */
import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface EyebrowProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Eyebrow({
  className,
  children,
  ...rest
}: EyebrowProps): JSX.Element {
  return (
    <div className={cn('km-eyebrow', className)} {...rest}>
      {children}
    </div>
  );
}
