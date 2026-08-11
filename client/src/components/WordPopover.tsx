/**
 * WordPopover — the gesture that defines the app.
 *
 * KR word + POS pill + EN gloss + example + "Add to bank" toggle + "More
 * examples" drawer, rendered inside the shared tone-aware `Sheet` (F-186).
 * Same component renders for vocab words AND grammar patterns;
 * `data.kind === 'grammar'` flips pill copy ("Grammar pattern"), button
 * copy ("grammar bank"), and the subhead from gloss to pattern title.
 *
 * Why a single component for both: the gesture is the same — "I tapped
 * something, give me the definition + let me bank it". Splitting into
 * VocabPopover + GrammarPopover would duplicate ~80% of the markup.
 *
 * Why `Sheet` and not bespoke dialog chrome (F-186): this was the last
 * "promote to shared primitive" of the redesign — every other tap-a-thing
 * popup in the app (Review/Grammar/Hanja detail sheets, Topik's chooser,
 * MyVocabLists) already renders on `Sheet`; WordPopover was the one
 * holdout still hand-rolling its own `role="dialog"` + backdrop + focus
 * trap. `tone="accent"` matches the Seoul kit's default signboard/hanji
 * edge treatment (same one `CityCard`/`DancheongRail` use elsewhere) so the
 * app's single most-used popup now reads as the same object as every other
 * popup, not a one-off. `Sheet` owns ALL a11y plumbing via the shared
 * `useModalA11y` hook (open/close, Esc, backdrop click, Tab-trap, restore
 * focus, ref-counted body-scroll lock) — WordPopover no longer calls the
 * hook itself, which also means it no longer double-acquires the scroll
 * lock alongside `Sheet`'s own instance.
 *
 * A11y:
 *   - `Sheet` supplies `role="dialog"` + `aria-modal="true"` +
 *     `aria-label` (we pass the KR headword/pattern, mirroring the old
 *     `aria-labelledby` target).
 *   - Esc closes; backdrop click closes; both handled by `Sheet`.
 *   - Focus lands on the close button on mount: `Sheet`'s a11y hook
 *     auto-focuses the first focusable descendant of the panel when no
 *     `initialFocusRef` is supplied, and the close button is deliberately
 *     the first focusable element in this component's markup (before Add
 *     and the info-toggle) — so the "land on close" UX from the bespoke
 *     implementation carries over for free, no `Sheet` API change needed.
 *   - Tab order: close → add → info-toggle. Shift-Tab from close wraps
 *     to info. `Sheet`'s focus-trap (cycle within the panel) keeps
 *     keyboard users from tabbing back into the reading passage behind.
 *
 * Threat model:
 *   - Display fields (`kr`, `en`, `ex_kr`, etc.) render as React text
 *     children — XSS-safe. Author-controlled in Pass 2, dictionary-API
 *     sourced in Pass 3+. The Pass-3 wire layer MUST keep this contract
 *     (text, not HTML).
 *
 * @example
 *   <WordPopover
 *     data={{ kr: '재택근무', pos: 'n.', en: 'remote work', ex_kr: '...', ex_en: '...' }}
 *     onClose={() => setPop(null)}
 *     onAdd={(d) => bank.add(d.kr)}
 *   />
 */
import { useState, type JSX } from 'react';
import type { VocabExample } from '../types/domain';
import { Icon } from './Icon';
import { Pill } from './Pill';
import { Sheet } from './Sheet';

/** Vocab + grammar fields the popover renders. Superset of both shapes. */
export interface WordPopoverData {
  /** Discriminator — `'grammar'` flips copy. Omit / `undefined` for vocab. */
  kind?: 'grammar';
  /** Korean headword (or pattern). */
  kr: string;
  /** English gloss (vocab) or pattern title (grammar). */
  en: string;
  /** Part of speech — vocab only. */
  pos?: string;
  /** Grammar pattern title — shown under the headword when `kind === 'grammar'`. */
  title?: string;
  /** Grammar pattern one-liner. */
  desc?: string;
  /** Primary example KR. */
  ex_kr: string;
  /** Primary example EN. */
  ex_en: string;
  /** Pre-banked flag — shows "already banked" sub-pill. */
  mined?: boolean;
  /**
   * KRDICT dictionary entry id (the `/define` `entries[0].id`), threaded so
   * the Add-to-bank gesture can mine the word with stable, homograph-safe
   * dedup (FU-NF-33). Optional — grammar + mock popovers leave it unset, and
   * OCR words with no `/define` lookup mine by lemma instead.
   */
  krdictEntryId?: number;
  /** Extra examples list — feeds the "More examples" drawer. */
  extra?: VocabExample[];
  /** Usage notes — shown in the drawer. */
  notes?: string;
  /** Contrast / "don't confuse with" — shown in the drawer. */
  contrast?: string;
}

export interface WordPopoverProps {
  /** Render data — null = closed (parent unmounts the popover entirely). */
  data: WordPopoverData;
  /** Fires when Esc / backdrop / close button is hit. */
  onClose: () => void;
  /** Fires once when the learner taps Add — button then locks to "Added". */
  onAdd?: (data: WordPopoverData) => void | Promise<void>;
  /**
   * Slow-path loading affordance. When true, the popover renders an inline
   * spinner placeholder in place of the gloss + example body while the
   * FAST half of the tap-anything chain (lemmatize → define) is in flight
   * (F-209: the slow enrich no longer holds this — see `isEnriching`). The
   * title row (KR headword + close button) stays visible so the dialog has
   * a stable accessible name; the action row is suppressed so the user
   * can't tap "Add to bank" against data that hasn't resolved yet.
   *
   * Why a single boolean and not a discriminated union: the caller already
   * owns the resolved-or-not state machine. The popover only needs to know
   * whether to swap the body for the spinner.
   */
  isLoading?: boolean;
  /**
   * Progressive-enrichment affordance (F-209 Phase 1). True while the
   * background `/enrich` (Claude) call is still in flight AFTER the
   * KRDICT-based body has painted. Renders a subtle inline "adding
   * nuance…" line under the example — never a blocking spinner — and the
   * open "More examples" drawer echoes it so a reader browsing the drawer
   * knows more content may still land. Ignored while `isLoading` is true
   * (the base body isn't painted yet, so there's nothing to annotate).
   */
  isEnriching?: boolean;
}

export function WordPopover({
  data,
  onClose,
  onAdd,
  isLoading = false,
  isEnriching = false,
}: WordPopoverProps): JSX.Element {
  const [drawer, setDrawer] = useState(false);
  const [added, setAdded] = useState(false);
  const isGrammar = data.kind === 'grammar';

  const handleAdd = (): void => {
    if (added) return;
    setAdded(true);
    // Optimistic: flip the button immediately, but if the parent's add reports
    // failure (its promise rejects), roll the button back so it can't read
    // "Added" while the durable signal (e.g. Reading's mined underline) was
    // itself rolled back. A canceled add is swallowed by the parent (resolves),
    // so the button only resets on a real failure.
    const result = onAdd?.(data);
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).then(undefined, () => {
        setAdded(false);
      });
    }
  };

  const extras = data.extra ?? [];
  const hasUsage = Boolean(data.notes ?? data.contrast);
  // The drawer (and its info toggle) only renders when it has content —
  // an empty "More examples" panel is worse than none (B-002).
  const hasDrawer = extras.length > 0 || hasUsage;

  return (
    <Sheet open onClose={onClose} ariaLabel={data.kr} tone="accent">
      <div className="km-popover__head">
        <div>
          <div className="km-popover__pills">
            <Pill tone={isGrammar ? 'red' : 'gold'}>
              {isGrammar ? 'Grammar pattern' : data.pos ?? 'word'}
            </Pill>
            {data.mined ? <Pill>already banked</Pill> : null}
          </div>
          <div className="kr km-popover__kr">{data.kr}</div>
        </div>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--sm focusring km-popover__close"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {isLoading ? (
        <div
          className="km-popover__loading"
          role="status"
          aria-live="polite"
          data-testid="word-popover-loading"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '14px 0',
          }}
        >
          <span
            className="km-popover__spinner"
            aria-hidden="true"
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: '2px solid currentColor',
              borderRightColor: 'transparent',
              animation: 'km-spin 0.8s linear infinite',
              opacity: 0.65,
            }}
          />
          <span className="km-popover__loading-label">Looking it up…</span>
        </div>
      ) : (
        <>
          <div className="km-popover__lede">
            {isGrammar ? data.title ?? data.en : data.en}
          </div>
          {isGrammar && data.desc ? (
            <div className="km-popover__desc">{data.desc}</div>
          ) : null}

          {/* Only render the Example block when there's an actual example —
              ~4% of KRDICT entries (and any enrichment miss) have none, and an
              empty "Example" label with nothing under it reads as broken. */}
          {data.ex_kr ? (
            <>
              <hr className="hr-gold km-popover__rule" />
              <div className="km-eyebrow km-popover__eyebrow">Example</div>
              <div className="kr km-popover__ex-kr">{data.ex_kr}</div>
              {data.ex_en ? (
                <div className="km-popover__ex-en">{data.ex_en}</div>
              ) : null}
            </>
          ) : null}

          {/* F-209: subtle progressive-enrichment affordance — the KRDICT
              body above is fully usable; this only signals that Claude's
              contextual nuance / extra examples are still on their way.
              Deliberately NOT the `word-popover-loading` blocker. */}
          {isEnriching ? (
            <div
              className="km-popover__enriching"
              role="status"
              aria-live="polite"
              data-testid="word-popover-enriching"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 10,
                fontSize: '0.8125rem',
                opacity: 0.55,
              }}
            >
              <span
                className="km-popover__spinner"
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  border: '2px solid currentColor',
                  borderRightColor: 'transparent',
                  animation: 'km-spin 0.8s linear infinite',
                }}
              />
              <span className="km-popover__enriching-label">adding nuance…</span>
            </div>
          ) : null}
        </>
      )}

      {isLoading ? null : (
        <>
          <div className="km-popover__actions">
            <button
              type="button"
              onClick={handleAdd}
              className={`km-btn ${added ? 'km-btn--ghost' : 'km-btn--gold'} km-btn--md focusring km-popover__add`}
              aria-pressed={added}
            >
              {added ? (
                <>
                  <Icon name="check" size={16} />
                  <span>Added to {isGrammar ? 'grammar bank' : 'vocab'}</span>
                </>
              ) : (
                <>
                  <Icon name="plus" size={16} />
                  <span>Add to {isGrammar ? 'grammar bank' : 'vocab'}</span>
                </>
              )}
            </button>
            {hasDrawer ? (
              <button
                type="button"
                className="km-btn km-btn--ghost km-btn--md focusring km-popover__info"
                aria-label="More examples"
                aria-expanded={drawer}
                onClick={() => {
                  setDrawer((d) => !d);
                }}
              >
                <Icon name="info" size={18} />
              </button>
            ) : null}
          </div>

          {drawer && hasDrawer ? (
            <div className="km-popover__drawer">
              {extras.length > 0 ? (
                <>
                  <div className="km-eyebrow km-popover__eyebrow">More examples</div>
                  <div className="km-popover__extras">
                    {extras.map((ex, i) => (
                      <div key={i} className="km-popover__extra">
                        <div className="kr km-popover__extra-kr">{ex.kr}</div>
                        <div className="km-popover__extra-en">{ex.en}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {hasUsage ? (
                <>
                  {extras.length > 0 ? (
                    <hr className="hr km-popover__usage-rule" />
                  ) : null}
                  <div className="km-eyebrow km-popover__eyebrow">Usage</div>
                  {data.notes ? (
                    <div className="km-popover__note">{data.notes}</div>
                  ) : null}
                  {data.contrast ? (
                    <div className="km-popover__note km-popover__note--contrast">
                      <span className="km-popover__contrast-tag">
                        Don&apos;t confuse:
                      </span>{' '}
                      {data.contrast}
                    </div>
                  ) : null}
                </>
              ) : null}
              {/* F-209: drawer echo of the enrichment-pending state, so a
                  reader already browsing the drawer knows more examples /
                  usage notes may still land. aria-hidden — the body's
                  role="status" line above already announces it once. */}
              {isEnriching ? (
                <div
                  className="km-popover__enriching km-popover__enriching--drawer"
                  aria-hidden="true"
                  data-testid="word-popover-drawer-enriching"
                  style={{ marginTop: 8, fontSize: '0.8125rem', opacity: 0.55 }}
                >
                  adding nuance…
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
