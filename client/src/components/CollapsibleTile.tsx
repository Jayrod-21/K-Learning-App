/**
 * CollapsibleTile (F-038) — a themed surface whose body collapses behind
 * its header.
 *
 * `surface` picks the outer shell:
 *   - `'card'` (default) — composes the plain `<Card>` every screen already
 *     used before the Seoul redesign. A collapsed tile is indistinguishable
 *     from a plain card at rest — same radius, surface, elevation.
 *     BACKWARD-COMPATIBLE: every pre-existing consumer (Review, Settings,
 *     Hanja, Topik, Grammar, Mistakes, Today's Grammar/Hanja/TOPIK tiles,
 *     Progress before this prop existed) never passes `surface`, so it
 *     renders byte-identically to before this prop was added.
 *   - `'city'` — composes `CityCard` instead (DESIGN_SEOUL_DAY_NIGHT.md
 *     device #1/#2: Night neon-signboard glow, Day hanji-paper + dancheong
 *     rail), for Wave-2 pages that want their fold-away sections to read as
 *     signboards rather than plain cards (see `REVIEW_batch1-fidelity.md`
 *     C-1: two pages had independently hand-rolled/omitted this exact glow
 *     because `CollapsibleTile` only offered the plain `Card` — this variant
 *     removes both workarounds). `tone`/`rail`/`feat` forward straight to
 *     `CityCard` and are ignored under `surface="card"`.
 *
 * The header row (caller-supplied title + a rotating chevron) is one
 * full-width `<button>` regardless of surface; the whole row is the hit
 * target, not just the chevron, because a 24px icon is a hostile touch
 * target on the phone-width shell. Both surfaces get their outer padding
 * zeroed (`.km-collapsible` / the `.km-citycard.km-collapsible` override in
 * CollapsibleTile.css) so the header button can be the full-bleed hit
 * target either way.
 *
 * Collapse animation: the body is a CSS grid row animating
 * `grid-template-rows: 1fr ↔ 0fr`. This is the robust form of the classic
 * max-height animation — a max-height transition needs either a JS
 * measurement pass (stale when content resizes after expansion) or a magic
 * px cap (clips content taller than the cap); the fr-row form animates the
 * real content height with zero JS and no cap. Disabled entirely under
 * `prefers-reduced-motion: reduce` (state still flips, nothing animates).
 *
 * A11y (disclosure pattern):
 *   - The header is a real `<button>` with `aria-expanded` and
 *     `aria-controls` pointing at the body region's `id`. Space/Enter come
 *     free with native button semantics.
 *   - The body stays MOUNTED while collapsed (so the `aria-controls` target
 *     always exists and the close animation has something to animate) but
 *     is `aria-hidden` + `inert` — its contents are neither read by AT nor
 *     reachable by keyboard, exactly like SwipeCarousel's off-screen pages.
 *   - The chevron is decorative; `aria-expanded` carries the state.
 *
 * Uncontrolled by design: open/closed is presentation state nobody else
 * needs to observe. `defaultCollapsed` covers the "start folded" case
 * (e.g. secondary sections below the fold).
 *
 * No I/O — no threat model. `title`/`children` are caller-controlled.
 */
import { useId, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Card } from './Card';
import { CityCard, type CityCardTone } from './CityCard';
import { Icon } from './Icon';
import { cn } from '../lib/cn';
import './CollapsibleTile.css';

export interface CollapsibleTileProps {
  /** Header content — rendered inside the toggle button. */
  title: ReactNode;
  /** Start collapsed. Default false (open). */
  defaultCollapsed?: boolean;
  /** Body content, revealed when expanded. */
  children: ReactNode;
  /** Extra class(es) on the outer surface. */
  className?: string;
  /** Outer surface — `'card'` (default, backward-compatible) or `'city'`
   *  (CityCard-backed signboard). See the file-top doc comment. */
  surface?: 'card' | 'city';
  /** CityCard tone — only meaningful under `surface="city"`. */
  tone?: CityCardTone;
  /** CityCard leading-edge DancheongRail — only meaningful under
   *  `surface="city"`. */
  rail?: boolean;
  /** CityCard featured emphasis — only meaningful under `surface="city"`. */
  feat?: boolean;
}

export function CollapsibleTile({
  title,
  defaultCollapsed = false,
  children,
  className,
  surface = 'card',
  tone = 'accent',
  rail = false,
  feat = false,
}: CollapsibleTileProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const id = useId();
  const bodyId = `${id}-body`;

  const header = (
    <button
      type="button"
      className="km-collapsible__header focusring"
      aria-expanded={!collapsed}
      aria-controls={bodyId}
      onClick={() => {
        setCollapsed((c) => !c);
      }}
    >
      <span className="km-collapsible__title">{title}</span>
      <Icon
        name="chevron-down"
        size={16}
        className={cn(
          'km-collapsible__chevron',
          !collapsed && 'km-collapsible__chevron--open',
        )}
      />
    </button>
  );

  const body = (
    <div
      id={bodyId}
      className={cn(
        'km-collapsible__body',
        collapsed && 'km-collapsible__body--collapsed',
      )}
      aria-hidden={collapsed}
      inert={collapsed}
    >
      {/* Two wrappers, deliberately: __clip owns the 0fr overflow clip;
          __content owns the padding (padding on the clipped element would
          survive the row's collapse to 0 and leave a visible strip). */}
      <div className="km-collapsible__clip">
        <div className="km-collapsible__content">{children}</div>
      </div>
    </div>
  );

  if (surface === 'city') {
    return (
      <CityCard
        tone={tone}
        rail={rail}
        feat={feat}
        className={cn('km-collapsible', className)}
      >
        {header}
        {body}
      </CityCard>
    );
  }

  return (
    <Card className={cn('km-collapsible', className)}>
      {header}
      {body}
    </Card>
  );
}
