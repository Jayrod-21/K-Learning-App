/**
 * SealStamp — 낙관-style vermilion square with a serif Korean/Hanja glyph,
 * rotated −3° by default. Used as a section anchor (`韓`, `復`, `譯`) or the
 * completion mark on the diagnostic Done screen (`完`).
 *
 * Sizes: `sm` 18px, `md` 28px, `lg` 44px. The seal is always presentational
 * — never the only carrier of meaning — so `aria-hidden`.
 */
import type { CSSProperties, JSX } from 'react';
import { cn } from '../lib/cn';

export type SealSize = 'sm' | 'md' | 'lg';

export interface SealStampProps {
  /** The glyph displayed. Defaults to `韓` (Korea). */
  char?: string;
  size?: SealSize;
  /** Rotation in degrees. Defaults to −3°. */
  tilt?: number;
  className?: string;
  style?: CSSProperties;
}

const SIZE_CLASS: Record<SealSize, string> = {
  sm: 'km-seal--sm',
  md: 'km-seal--md',
  lg: 'km-seal--lg',
};

export function SealStamp({
  char = '韓',
  size = 'md',
  tilt = -3,
  className,
  style,
}: SealStampProps): JSX.Element {
  const combinedStyle: CSSProperties = {
    transform: `rotate(${String(tilt)}deg)`,
    ...style,
  };
  return (
    <span
      className={cn('km-seal hanja', SIZE_CLASS[size], className)}
      style={combinedStyle}
      aria-hidden="true"
    >
      {char}
    </span>
  );
}
