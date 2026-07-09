/**
 * SealStamp — rounded accent badge with a serif Korean/Hanja glyph. Used as
 * a section anchor (`韓`, `復`, `譯`) or the completion mark on the
 * diagnostic Done screen (`完`).
 *
 * Seoul restyle: the old hanji-era 낙관 look (sharp corners, −3° tilt) is
 * gone — the badge now sits upright with app-icon rounding and re-tints
 * with the runtime accent (`--vermilion` / `--on-vermilion`).
 *
 * Sizes: `sm` 18px, `md` 28px, `lg` 44px. The badge is always
 * presentational — never the only carrier of meaning — so `aria-hidden`.
 */
import type { CSSProperties, JSX } from 'react';
import { cn } from '../lib/cn';

export type SealSize = 'sm' | 'md' | 'lg';

export interface SealStampProps {
  /** The glyph displayed. Defaults to `韓` (Korea). */
  char?: string;
  size?: SealSize;
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
  className,
  style,
}: SealStampProps): JSX.Element {
  return (
    <span
      className={cn('km-seal hanja', SIZE_CLASS[size], className)}
      style={style}
      aria-hidden="true"
    >
      {char}
    </span>
  );
}
