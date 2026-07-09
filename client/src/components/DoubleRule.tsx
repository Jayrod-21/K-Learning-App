/**
 * DoubleRule — a hairline with an optional small round accent dot centered
 * between its halves. The name is legacy (hanji-era twin rules + rotated
 * diamond); since the Seoul restyle it reads as a single modern divider.
 * Used on long surfaces (Settings, Diagnostic intro, Login, sheets).
 */
import type { HTMLAttributes, JSX } from 'react';
import { cn } from '../lib/cn';

export interface DoubleRuleProps extends HTMLAttributes<HTMLDivElement> {
  /** Render the vermilion diamond accent between the rules. */
  accent?: boolean;
}

export function DoubleRule({
  accent = false,
  className,
  ...rest
}: DoubleRuleProps): JSX.Element {
  return (
    <div
      className={cn('km-doublerule', className)}
      role="separator"
      // `aria-orientation="horizontal"` is the default for `role="separator"`;
      // setting it explicitly only adds noise to the AOM tree.
      {...rest}
    >
      <span className="km-doublerule__line" />
      {accent ? <span className="km-doublerule__diamond" aria-hidden="true" /> : null}
      <span className="km-doublerule__line" />
    </div>
  );
}
