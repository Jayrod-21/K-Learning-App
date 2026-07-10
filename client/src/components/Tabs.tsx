/**
 * Tabs (F-032) — reusable in-page tabbed area (W3C tabs pattern).
 *
 * Two prior in-page tab strips (LibrarySubnav's pill row, Chat's pane
 * switcher) each hand-rolled their own roving focus; this is the shared
 * primitive the overhaul's new sections mount instead.
 *
 * Content model: `children` is a RENDER FUNCTION `(activeId) => ReactNode`.
 * Chosen over a `panels: Record<id, node>` map because most consumers
 * switch on the id anyway (often lazily — a heavy pane shouldn't build
 * while hidden), and a function can't drift out of sync with `tabs` the way
 * a parallel record can. One `tabpanel` is rendered — the active one —
 * re-keyed per tab so aria wiring is always exact.
 *
 * Controlled or uncontrolled (the standard React dual mode):
 *   - Controlled: pass `active` (+ `onChange`); the component never touches
 *     internal state — the parent owns selection (e.g. tab in the URL).
 *   - Uncontrolled: omit `active`; `defaultTab` (or the first tab) seeds
 *     internal state. `onChange` still fires as a notification.
 *
 * A11y (W3C APG "Tabs with Automatic Activation"):
 *   - `role="tablist"` (labelled via required `ariaLabel`) of `role="tab"`
 *     buttons with `aria-selected`; the panel is `role="tabpanel"` +
 *     `aria-labelledby`, with `tabIndex={0}` so keyboard users can land in
 *     panels whose content has no focusable. Because only the ACTIVE panel
 *     is in the DOM, `aria-controls` rides only the selected tab — APG
 *     treats it as optional, and a dangling id reference on inactive tabs
 *     would be an ARIA validity violation (axe `aria-valid-attr-value`).
 *   - Roving tabindex: exactly one tab sits in the tab order. ArrowLeft/
 *     ArrowRight move selection with wrap; Home/End jump to the ends.
 *     Selection follows focus (automatic activation — same choice as
 *     SwipeCarousel's dots). In controlled mode "selection" means
 *     `onChange` fires and focus moves; the parent decides whether the
 *     active tab actually changes.
 *
 * No I/O — no threat model. Tab ids/labels are caller-controlled.
 */
import { useId, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';
import './Tabs.css';

export interface TabItem {
  /** Stable identifier — appears in `onChange` and the render function. */
  id: string;
  /** Tab button content. */
  label: ReactNode;
}

export interface TabsProps {
  /** The tabs, in display order. Must be non-empty to render anything. */
  tabs: ReadonlyArray<TabItem>;
  /** Accessible name for the tablist. */
  ariaLabel: string;
  /** Controlled active tab id. Omit for uncontrolled mode. */
  active?: string;
  /** Fires with the tab id the user activated (both modes). */
  onChange?: (id: string) => void;
  /** Uncontrolled initial tab. Defaults to the first tab. */
  defaultTab?: string;
  /** Renders the active panel's content. */
  children: (activeId: string) => ReactNode;
  /** Extra class(es) on the root. */
  className?: string;
}

export function Tabs({
  tabs,
  ariaLabel,
  active,
  onChange,
  defaultTab,
  children,
  className,
}: TabsProps): JSX.Element | null {
  const [internal, setInternal] = useState<string | undefined>(defaultTab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const uid = useId();

  // Empty tablist is a render-nothing, not a crash — consumers may build
  // `tabs` from data that can legitimately be empty while loading.
  if (tabs.length === 0) return null;

  const isControlled = active !== undefined;
  const activeId = isControlled ? active : (internal ?? tabs[0]?.id);
  // Where the roving tabindex sits. When the active id matches no tab
  // (controlled parent passed a stale id, or defaultTab was mistyped) the
  // first tab keeps a tab stop — a fully -1 row would be keyboard-dead.
  const foundIndex = tabs.findIndex((t) => t.id === activeId);
  const rovingIndex = foundIndex === -1 ? 0 : foundIndex;

  const select = (id: string): void => {
    if (!isControlled) setInternal(id);
    onChange?.(id);
  };

  // `from` is the index of the tab that RECEIVED the key event — per APG,
  // arrows move relative to the focused tab, not the selected one. The two
  // only differ in controlled mode when the parent defers/rejects onChange
  // (focus sits on the clicked tab while selection stayed put).
  const onTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    from: number,
  ): void => {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = from === last ? 0 : from + 1;
    else if (e.key === 'ArrowLeft') next = from === 0 ? last : from - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    const target = tabs[next];
    if (target === undefined) return;
    // Automatic activation: selection follows focus.
    select(target.id);
    tabRefs.current[next]?.focus();
  };

  const panelId = (id: string): string => `${uid}-panel-${id}`;
  const tabId = (id: string): string => `${uid}-tab-${id}`;

  return (
    <div className={cn('km-tabs', className)}>
      <div className="km-tabs__list" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            id={tabId(tab.id)}
            className={cn(
              'km-tabs__tab focusring',
              tab.id === activeId && 'km-tabs__tab--active',
            )}
            role="tab"
            aria-selected={tab.id === activeId}
            // Only the active panel exists in the DOM (render-one design),
            // so only the selected tab may carry aria-controls — a dangling
            // reference on the others fails axe aria-valid-attr-value.
            aria-controls={tab.id === activeId ? panelId(tab.id) : undefined}
            tabIndex={i === rovingIndex ? 0 : -1}
            onClick={() => {
              select(tab.id);
            }}
            onKeyDown={(e) => {
              onTabKeyDown(e, i);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeId !== undefined ? (
        <div
          // Re-key per tab so panel-local state never leaks across tabs.
          key={activeId}
          id={panelId(activeId)}
          className="km-tabs__panel"
          role="tabpanel"
          aria-labelledby={tabId(activeId)}
          tabIndex={0}
        >
          {children(activeId)}
        </div>
      ) : null}
    </div>
  );
}
