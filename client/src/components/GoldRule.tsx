/**
 * GoldRule — vermilion-gradient hairline divider.
 *
 * Why a component, not raw `<hr class="hr-gold">`: callers should not need to
 * remember the legacy global class name; encapsulating it here lets us swap
 * the implementation (gradient stops, opacity, dark-theme tuning) without
 * grep-and-replace across every screen.
 *
 * Decorative — a bare `<hr>` already carries the implicit `separator` role,
 * so screen readers announce it as a section break without an explicit
 * `role` (which jsx-a11y/no-redundant-roles correctly flags as redundant).
 */
import type { CSSProperties, JSX } from 'react';
import { cn } from '../lib/cn';

export interface GoldRuleProps {
  className?: string;
  style?: CSSProperties;
}

export function GoldRule({ className, style }: GoldRuleProps): JSX.Element {
  return <hr className={cn('km-goldrule', className)} style={style} />;
}
