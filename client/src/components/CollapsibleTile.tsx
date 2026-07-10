/**
 * CollapsibleTile (F-038) — a Card whose body collapses behind its header.
 *
 * Built ON the Card visual language (it literally composes `<Card>`) so a
 * collapsed tile is indistinguishable from a plain card at rest — same
 * radius, surface, and elevation. The header row (caller-supplied title +
 * a rotating chevron) is one full-width `<button>`; the whole row is the
 * hit target, not just the chevron, because a 24px icon is a hostile
 * touch target on the phone-width shell.
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
  /** Extra class(es) on the outer Card. */
  className?: string;
}

export function CollapsibleTile({
  title,
  defaultCollapsed = false,
  children,
  className,
}: CollapsibleTileProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const id = useId();
  const bodyId = `${id}-body`;

  return (
    <Card className={cn('km-collapsible', className)}>
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
    </Card>
  );
}
