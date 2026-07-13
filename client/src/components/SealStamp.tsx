/**
 * SealStamp — rounded accent badge with a serif Korean/Hanja glyph. Used as
 * a section anchor (`韓`, `復`, `譯`) or the completion mark on the
 * diagnostic Done screen (`完`).
 *
 * Seoul restyle: the old hanji-era 낙관 look (sharp corners, −3° tilt) is
 * gone — the badge now sits upright with app-icon rounding and re-tints
 * with the runtime accent (`--vermilion` / `--on-vermilion`).
 *
 * DESIGN_SEOUL_DAY_NIGHT.md device #7 extends this SAME component (rather
 * than adding a second, confusingly-similar one) with the "milestone 도장
 * stamp" look: `milestone` swaps in the hand-stamped rotation + `印` default
 * glyph and accepts an optional `label` caption + a `tone` (mirrors
 * CityCard/DancheongRail/SubwayProgress's four-value tone). Every existing
 * caller (Hanja/Login/Diagnostic/Images/Review — plain `char`/`size`) is
 * unaffected: `milestone` defaults false, `label` undefined, `tone`
 * `'accent'` — which is exactly what the badge already read before this
 * change (`--vermilion`).
 *
 * Sizes: `sm` 18px, `md` 28px, `lg` 44px. The badge is always
 * presentational — never the only carrier of meaning — so `aria-hidden`
 * (the optional `label` is real content and renders OUTSIDE the
 * aria-hidden glyph).
 */
import type { CSSProperties, JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';
import type { DancheongRailTone } from './DancheongRail';

export type SealSize = 'sm' | 'md' | 'lg';
export type SealTone = DancheongRailTone;

export interface SealStampProps {
  /** The glyph displayed. Defaults to `韓` (Korea), or `印` when
   * `milestone` is set and no explicit `char` is given. */
  char?: string;
  size?: SealSize;
  /** Milestone/completion look (device #7): hand-stamped rotation, default
   * glyph `印`. Off by default — existing callers keep the upright
   * section-anchor badge. */
  milestone?: boolean;
  /** Optional caption next to the glyph (e.g. "Mastered"). Only meaningful
   * with `milestone` — plain badge usage has no room for it. */
  label?: ReactNode;
  tone?: SealTone;
  /** Always applied to the glyph badge itself (never the outer `label`
   * wrapper) — so a caller can position/size the glyph the same way
   * whether or not `label` is also passed. The wrapper's own layout
   * (inline-flex + gap) is a fixed class (`km-seal-group`), not something
   * a caller needs `className` to control. */
  className?: string;
  style?: CSSProperties;
}

const SIZE_CLASS: Record<SealSize, string> = {
  sm: 'km-seal--sm',
  md: 'km-seal--md',
  lg: 'km-seal--lg',
};

export function SealStamp({
  char,
  size = 'md',
  milestone = false,
  label,
  tone = 'accent',
  className,
  style,
}: SealStampProps): JSX.Element {
  const glyph = char ?? (milestone ? '印' : '韓');
  const badge = (
    <span
      className={cn(
        'km-seal hanja',
        SIZE_CLASS[size],
        `km-tone--${tone}`,
        milestone && 'km-seal--milestone',
        className,
      )}
      style={style}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );

  if (label == null) {
    return badge;
  }

  return (
    <span className="km-seal-group">
      {badge}
      <span className="km-seal-group__label">{label}</span>
    </span>
  );
}
