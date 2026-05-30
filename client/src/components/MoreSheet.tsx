/**
 * MoreSheet — bottom-attached modal sheet listing the 7 non-primary screens
 * plus a theme toggle. Opens with a 240ms `sheetUp` slide and fades a
 * backdrop in.
 *
 * A11y:
 *   - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at
 *     the sheet's hidden title.
 *   - Closes on Escape, backdrop click, item activation, or theme toggle
 *     (theme toggle keeps the sheet open).
 *   - Focus restoration, Esc close, body scroll lock, and Tab trap are
 *     owned by `useModalA11y` (shared with WordPopover + Sheet — Pass 2
 *     fix-pass extracted them on the rule-of-three).
 *   - First row receives focus on mount via the `initialFocusRef` slot so
 *     keyboard users land in the list (the hook would otherwise pick the
 *     first focusable descendant, which would still be the first row —
 *     but passing the ref explicitly documents the intent).
 *   - Backdrop button is removed from the tab order (`tabIndex={-1}`) so
 *     Shift-Tab from the first row lands on the More trigger underneath,
 *     not on an invisible "Close menu" button. Esc + outside-tap still
 *     dismiss for keyboard users.
 */
import {
  useCallback,
  useId,
  useRef,
  type JSX,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useModalA11y } from '../hooks/useModalA11y';
import { cn } from '../lib/cn';
import { MORE_TAB_IDS, navItem } from '../lib/nav';
import { Icon } from './Icon';

export interface MoreSheetProps {
  /** Called when the sheet should close (Esc, backdrop, item activation). */
  onClose: () => void;
  /** Called when the user taps the theme toggle. */
  onToggleTheme: () => void;
  /** Current theme — drives the toggle label. */
  theme: 'light' | 'dark';
}

export function MoreSheet({
  onClose,
  onToggleTheme,
  theme,
}: MoreSheetProps): JSX.Element {
  const labelId = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Shared modal a11y (Esc + body lock + focus restore + Tab trap).
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

  return (
    <div className="km-moresheet" role="presentation">
      <button
        type="button"
        className="km-moresheet__backdrop"
        aria-label="Close menu"
        // See the file header: backdrop stays clickable (mouse / touch) but
        // out of the tab order. Esc and outside-tap cover keyboard dismiss.
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="km-moresheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <span className="km-moresheet__handle" aria-hidden="true" />
        <h2 id={labelId} className="km-eyebrow km-moresheet__title">
          More
        </h2>
        <div className="km-moresheet__list">
          {MORE_TAB_IDS.map((id, idx) => {
            const it = navItem(id);
            const active = location.pathname === it.path;
            return (
              <button
                key={id}
                ref={idx === 0 ? firstItemRef : undefined}
                type="button"
                className={cn(
                  'km-moresheet__row focusring',
                  active && 'km-moresheet__row--active',
                )}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  goto(it.path);
                }}
              >
                <Icon name={it.icon} size={20} />
                <div className="km-moresheet__rowmeta">
                  <div className="km-moresheet__rowlabel">{it.label}</div>
                  <div className="kr km-moresheet__rowkr">{it.kr}</div>
                </div>
                <Icon name="chevron-right" size={16} />
              </button>
            );
          })}
        </div>
        <hr className="hr km-moresheet__divider" />
        <button
          type="button"
          className="km-moresheet__theme focusring"
          onClick={onToggleTheme}
        >
          <Icon name="theme" size={20} />
          <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
        </button>
      </div>
    </div>
  );
}
