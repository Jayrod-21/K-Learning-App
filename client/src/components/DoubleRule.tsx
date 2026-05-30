/**
 * DoubleRule — two hairlines with a 4px gap; an optional vermilion diamond
 * marker centered between them. Traditional Korean book detail; used as a
 * section divider on long surfaces (Settings, Diagnostic intro, sheets).
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
