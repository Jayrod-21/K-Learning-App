/**
 * LearnMenu — the upward-expanding study-page menu behind the LEARN hexagon
 * (Overhaul P1.1, per the approved mockup).
 *
 * A scrim + a stacked column of the 7 LEARN sub-pages (icon + label + kr)
 * that rises from just above the BottomNav. Rows reveal with a small
 * bottom-up stagger (the row nearest the hexagon lands first); the global
 * `prefers-reduced-motion` block zeroes both durations AND delays, so
 * reduced-motion users get an instant, complete list.
 *
 * Close paths: scrim tap, Esc (via `useModalA11y`), row activation
 * (navigate + close), hexagon re-tap (the scrim stops ABOVE the nav so the
 * bar stays tappable — Shell's toggle handles it), and route change
 * (Shell watches `location.pathname` as a safety net for browser
 * back/forward while open).
 *
 * A11y:
 *   - `role="dialog"`, `aria-modal`, labelled by the menu title.
 *   - Focus trap / initial focus / Esc / body scroll-lock / focus restore
 *     are owned by `useModalA11y` (shared with Sheet + WordPopover; it
 *     restores focus to the hexagon that opened us).
 *   - Scrim is click-dismiss only and out of the tab order (`tabIndex=-1`),
 *     mirroring the retired MoreSheet's backdrop pattern.
 */
import { useCallback, useId, useRef, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useModalA11y } from '../hooks/useModalA11y';
import { LEARN_SUBPAGE_IDS, navItem } from '../lib/nav';
import { Icon } from './Icon';

/** Per-row reveal stagger (ms) — bottom row first, like the mockup. */
const ROW_STAGGER_MS = 30;

export interface LearnMenuProps {
  /** DOM id for the dialog panel — matches BottomNav's `aria-controls`. */
  id: string;
  /** Called when the menu should close (Esc, scrim, row activation). */
  onClose: () => void;
}

export function LearnMenu({ id, onClose }: LearnMenuProps): JSX.Element {
  const labelId = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  // Shared modal a11y (Esc + body lock + focus trap + focus restore).
  useModalA11y({
    open: true,
    onClose,
    containerRef: panelRef,
    initialFocusRef: firstItemRef,
  });

  const goto = useCallback(
    (path: string): void => {
      if (location.pathname !== path) {
        navigate(path);
      }
      onClose();
    },
    [navigate, location.pathname, onClose],
  );

  const count = LEARN_SUBPAGE_IDS.length;

  return (
    <div className="km-learnmenu" role="presentation">
      <button
        type="button"
        className="km-learnmenu__scrim"
        aria-label="Close Learn menu"
        // Click/touch dismiss only — kept out of the tab order so Shift-Tab
        // from the first row lands back on the page, not on an invisible
        // button. Esc covers keyboard dismiss.
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        id={id}
        className="km-learnmenu__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <div id={labelId} className="km-eyebrow km-learnmenu__title">
          배움 · Learn
        </div>
        {LEARN_SUBPAGE_IDS.map((navId, idx) => {
          const it = navItem(navId);
          const active = location.pathname === it.path;
          return (
            <button
              key={navId}
              ref={idx === 0 ? firstItemRef : undefined}
              type="button"
              className="km-learnmenu__row focusring"
              // Bottom-up stagger: the row nearest the hexagon reveals
              // first. Zeroed wholesale under prefers-reduced-motion by the
              // global CSS block (duration AND delay).
              style={{ animationDelay: `${(count - 1 - idx) * ROW_STAGGER_MS}ms` }}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                goto(it.path);
              }}
            >
              <Icon name={it.icon} size={20} />
              <span className="km-learnmenu__rowlabel">{it.label}</span>
              <span className="kr km-learnmenu__rowkr">{it.kr}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
