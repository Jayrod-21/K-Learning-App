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
 * `tone` (fix-pass batch-4, REVIEW_batch4-fidelity.md gap-d — "the
 * highest-value single follow-up before beta"): OPTIONAL, defaults to
 * `undefined`, which renders the exact pre-existing flat panel byte-for-byte.
 * Chat's attach popover uses its own `.km-popover`, not this component. Of
 * the actual `Sheet` consumers, nine pass no `tone` at all and are therefore
 * completely unaffected — byte-identical to pre-promotion — `ReviewGrammar`,
 * `UploadTypeModal`, `Mistakes`, `Grammar`, `ReviewVocab`, `Review`,
 * `MyVocabLists` (both its list-detail and create-list sheets), `Hanja`
 * (all four of its sheets), `Reading`. Two consumers opt in this pass:
 * `Topik`'s Study/Mock chooser (`tone="accent"`) and `Tickets`'s file-a-
 * ticket form (`tone="plain"`) — this is an opt-in promotion per call site,
 * not a redesign of the shared chrome. Passing a tone applies the same Night
 * neon-signboard-edge /
 * Day dancheong-stripe treatment `CityCard`/`DancheongRail` already use,
 * keyed off the SAME `--km-tone` CSS var (`km-tone--<tone>` utility class,
 * styles/seoul-devices.css) — a top-edge treatment rather than a left rail,
 * since a bottom sheet's "leading edge" is its top (see `.km-sheet__panel
 * .km-tone--*` rules in styles/index.css for the Day/Night specifics).
 * `plain` (or omitting `tone` altogether) both resolve to the same quiet
 * hairline top border in both themes — no visual difference from the
 * pre-promotion panel — matching `CityCard`'s own "plain = no glow" contract.
 *
 * No I/O — no threat model. `children` is caller-controlled.
 */
import { useRef, type JSX, type ReactNode } from 'react';
import { useModalA11y } from '../hooks/useModalA11y';
import { cn } from '../lib/cn';
import type { DancheongRailTone } from './DancheongRail';

export type SheetTone = DancheongRailTone;

export interface SheetProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** Fires when Esc or backdrop closes the sheet. */
  onClose: () => void;
  /** Accessible name for the dialog. */
  ariaLabel: string;
  /**
   * Seoul Day & Night tone promotion (fix-pass batch-4) — see the module
   * doc comment. Omit for the original flat panel (every pre-existing
   * consumer's exact behavior); pass `'accent' | 'blue' | 'mint' | 'ochre' |
   * 'plain'` to opt a NEW consumer into the tone-aware signboard/hanji edge.
   */
  tone?: SheetTone;
  /** Sheet body. */
  children: ReactNode;
}

export function Sheet({
  open,
  onClose,
  ariaLabel,
  tone,
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
        className={cn(
          'km-sheet__panel',
          tone !== undefined && `km-tone--${tone}`,
        )}
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
