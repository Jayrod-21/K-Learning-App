/**
 * GoldRule — section divider. The name is legacy (it was a vermilion
 * "gold" gradient in the hanji era); since the Seoul restyle it renders a
 * plain strong hairline (`--line-strong`).
 *
 * Why a component, not raw `<hr class="hr-gold">`: callers should not need to
 * remember the legacy global class name; encapsulating it here lets us swap
 * the implementation (exactly what the Seoul restyle did) without
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
