/**
 * useModalA11y — modal accessibility primitives in one hook.
 *
 * Three call sites (`WordPopover`, `Sheet`, `MoreSheet`) used to repeat the
 * same Esc handler + body-scroll-lock + initial-focus + missing focus
 * restoration. The rule-of-three triggered; this hook is the single
 * source of truth.
 *
 * Behaviour (when `open` is true):
 *   1. Captures `document.activeElement` on open so we can restore focus
 *      when the modal closes.
 *   2. Moves focus to the first focusable descendant of the dialog (or to
 *      a caller-provided `initialFocusRef`) on mount. Falls back to the
 *      dialog itself if no focusable descendant exists.
 *   3. Traps Tab / Shift-Tab inside the dialog so keyboard users can't
 *      sneak back into the page behind. Uses the canonical
 *      `button:not([disabled]), [href], [tabindex]:not([tabindex="-1"]),
 *       input:not([disabled]), select:not([disabled]),
 *       textarea:not([disabled])` selector — a superset of the four-element
 *      shape any of the existing modals exposed.
 *   4. Closes on `Escape` by calling `onClose`. The Esc handler is a
 *      passive listener — it does NOT call `stopPropagation` so a nested
 *      modal (a Sheet inside a Sheet, say) can still receive the same Esc
 *      and close in stack order.
 *   5. Locks body scroll while the dialog is mounted, capturing the
 *      previous `overflow` value so the restore is exact (no clobbering
 *      a parent that had set its own overflow).
 *   6. On unmount, restores focus to the captured element via
 *      `queueMicrotask` so React's commit-phase teardown completes before
 *      we move focus. Without the microtask, the parent's re-render can
 *      steal focus mid-restore.
 *
 * Returns nothing — the hook is fire-and-forget, owning the side effects.
 *
 * Threat model:
 *   - Focus restoration is a usability + a11y property, not a security
 *     one. Pre-existing modals leaked focus to `<body>` on close (Pass 2
 *     blocker A-B2); this hook closes that gap uniformly.
 *   - The Tab trap is purely keyboard-mode confinement; nothing prevents
 *     a determined user from clicking outside (that's the backdrop's
 *     job, which dispatches `onClose` separately).
 *
 * @example
 *   const dialogRef = useRef<HTMLDivElement | null>(null);
 *   useModalA11y({ open, onClose, containerRef: dialogRef });
 *   return open ? <div ref={dialogRef} role="dialog" …>…</div> : null;
 */
import { useEffect, type RefObject } from 'react';

/** CSS selector for "focusable in the keyboard tab order" elements. */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
].join(', ');

export interface UseModalA11yOptions {
  /**
   * Whether the modal is currently open. When false, the hook is a
   * no-op (no listeners installed, no body lock applied). Toggling
   * back to true re-arms everything.
   */
  open: boolean;
  /** Called on `Escape`. Caller decides whether to actually close. */
  onClose: () => void;
  /**
   * Ref to the dialog container — the element whose descendants form the
   * focus-trap universe. Must point at a mounted element when `open` is
   * true; the hook narrows on `containerRef.current` per render.
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Optional ref to the element to focus on mount. When omitted, the
   * hook auto-focuses the first focusable descendant of the container.
   * Pass this when the natural landing place is not the first focusable
   * (e.g. WordPopover wants to land on the close button so the
   * least-surprising next gesture is dismiss).
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useModalA11y({
  open,
  onClose,
  containerRef,
  initialFocusRef,
}: UseModalA11yOptions): void {
  // (1) Capture previously-active element + restore on close.
  // (3) Esc handler.
  // (5) Body scroll lock.
  // We bundle (1) + (5) in one effect because both should fire on
  // open-edge and restore on close-edge; splitting them duplicates the
  // open/close gating logic.
  useEffect(() => {
    if (!open) return;

    const previouslyActive = (document.activeElement instanceof HTMLElement)
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent): void => {
      // Esc closes — passive listener (no stopPropagation) so nested
      // modals up the stack can also close on the same press.
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      // queueMicrotask — defer focus restoration until after React's
      // commit-phase teardown so the parent's re-render can't steal
      // focus mid-restore.
      queueMicrotask(() => {
        if (previouslyActive && document.contains(previouslyActive)) {
          previouslyActive.focus();
        }
      });
    };
  }, [open, onClose]);

  // (2) Initial focus on mount.
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    // Caller-supplied target wins. Otherwise pick the first focusable
    // descendant, then fall back to the container itself (which gets a
    // synthetic tabIndex via the parent's markup — both Sheet and the
    // popover's dialog div carry tabindex=-1 by default which would be
    // ignored by the focusable selector; intentional, because the dialog
    // shouldn't appear in normal tab order).
    const target =
      initialFocusRef?.current ??
      container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      container;
    target.focus();
    // Only re-run when `open` flips — caller-supplied refs are stable
    // by convention (created via useRef in the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // (3) Focus trap — handled via a keydown listener scoped to the
  // container. Using window-level instead of an `onKeyDown` prop means
  // the trap works regardless of which descendant has focus.
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      // Only trap when focus is inside our container — otherwise we'd
      // bounce a sibling modal's Tab into our dialog.
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !container.contains(active)) {
        return;
      }
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onTab);
    return () => {
      window.removeEventListener('keydown', onTab);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
