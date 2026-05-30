/**
 * Sheet — generic bottom-attached modal sheet.
 *
 * Shape mirrors `MoreSheet` but the body is consumer-supplied. Used by
 * `ListDetailSheet`, `CreateListSheet`, `HanjaDetailSheet`, and any future
 * "tap a row → drawer up from the bottom" affordance.
 *
 * Why a second sheet component, not a generalisation of MoreSheet:
 *   - MoreSheet's content is the navigation list — it owns its own focus +
 *     routing model. Hoisting that into a generic component would push
 *     navigation concerns into every consumer. Two components is the
 *     simpler split.
 *
 * A11y:
 *   - `role="dialog"` + `aria-modal="true"` + `aria-label` (caller-supplied).
 *   - Esc closes; backdrop click closes.
 *   - Body scroll locked while open.
 *   - Focus moves to the first focusable descendant of the panel on
 *     mount; Tab is trapped inside the panel; focus restores to the
 *     previously-active element on close. All four behaviours are
 *     owned by `useModalA11y` so Sheet, WordPopover and MoreSheet share
 *     one implementation.
 *   - Open=false renders nothing — the parent controls mount/unmount,
 *     and React 19's transition handling is fine without a portal for
 *     our single-column shell layout.
 *
 * No I/O — no threat model. `children` is caller-controlled.
 */
import { useRef, type JSX, type ReactNode } from 'react';
import { useModalA11y } from '../hooks/useModalA11y';

export interface SheetProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** Fires when Esc or backdrop closes the sheet. */
  onClose: () => void;
  /** Accessible name for the dialog. */
  ariaLabel: string;
  /** Sheet body. */
  children: ReactNode;
}

export function Sheet({
  open,
  onClose,
  ariaLabel,
  children,
}: SheetProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalA11y({ open, onClose, containerRef: panelRef });

  if (!open) return null;

  return (
    <div className="km-sheet" role="presentation">
      <button
        type="button"
        className="km-sheet__backdrop"
        aria-label="Close sheet"
        // Backdrop is mouse/touch only — Esc handles keyboard dismissal so
        // the backdrop button stays out of the tab order.
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="km-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <span className="km-sheet__handle" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}
