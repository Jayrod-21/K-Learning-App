/**
 * WordPopover — the gesture that defines the app.
 *
 * Centered popover with: KR word + POS pill + EN gloss + example + "Add
 * to bank" toggle + "More examples" drawer. Same component renders for
 * vocab words AND grammar patterns; `data.kind === 'grammar'` flips
 * pill copy ("Grammar pattern"), button copy ("grammar bank"), and the
 * subhead from gloss to pattern title.
 *
 * Why a single component for both: the gesture is the same — "I tapped
 * something, give me the definition + let me bank it". Splitting into
 * VocabPopover + GrammarPopover would duplicate ~80% of the markup.
 *
 * A11y:
 *   - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing
 *     at the KR word.
 *   - Esc closes; backdrop click closes.
 *   - Focus moves to the close button on mount (least surprising place
 *     to land — the user just tapped a word, so the next likely action
 *     is dismiss).
 *   - Tab order: close → add → info-toggle. Shift-Tab from close wraps
 *     to info. We use a small focus-trap (cycle within the dialog) so
 *     keyboard users can't tab back into the reading passage behind.
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
import {
  useRef,
  useState,
  type JSX,
} from 'react';
import { useModalA11y } from '../hooks/useModalA11y';
import type { VocabExample } from '../types/domain';
import { Icon } from './Icon';
import { Pill } from './Pill';

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
  onAdd?: (data: WordPopoverData) => void;
  /**
   * Slow-path loading affordance. When true, the popover renders an inline
   * spinner placeholder in place of the gloss + example body while the
   * tap-anything chain (lemmatize → define → enrich) is in flight. The
   * title row (KR headword + close button) stays visible so the dialog has
   * a stable accessible name; the action row is suppressed so the user
   * can't tap "Add to bank" against data that hasn't resolved yet.
   *
   * Why a single boolean and not a discriminated union: the caller already
   * owns the resolved-or-not state machine. The popover only needs to know
   * whether to swap the body for the spinner.
   */
  isLoading?: boolean;
}

export function WordPopover({
  data,
  onClose,
  onAdd,
  isLoading = false,
}: WordPopoverProps): JSX.Element {
  const [drawer, setDrawer] = useState(false);
  const [added, setAdded] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isGrammar = data.kind === 'grammar';

  // Modal a11y — focus restoration, Esc close, Tab trap, body scroll
  // lock — all in one hook (extracted in Pass 2 fix-pass; rule-of-three
  // with Sheet + MoreSheet). The close button is the least-surprising
  // landing spot for a keyboard user who just tapped a word, so we pass
  // its ref as the initial-focus override; otherwise the hook would land
  // on the first focusable descendant (the dialog div with tabIndex=-1
  // is skipped — see the hook's docstring).
  useModalA11y({
    open: true,
    onClose,
    containerRef: dialogRef,
    initialFocusRef: closeRef,
  });

  const handleAdd = (): void => {
    if (added) return;
    setAdded(true);
    onAdd?.(data);
  };

  const extras = data.extra ?? [];
  const hasUsage = Boolean(data.notes ?? data.contrast);

  return (
    <>
      <button
        type="button"
        className="km-popover__backdrop"
        aria-label="Close popover"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        className="km-popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="km-popover-title"
      >
        <div className="km-popover__head">
          <div>
            <div className="km-popover__pills">
              <Pill tone={isGrammar ? 'red' : 'gold'}>
                {isGrammar ? 'Grammar pattern' : data.pos ?? 'word'}
              </Pill>
              {data.mined ? <Pill>already banked</Pill> : null}
            </div>
            <div id="km-popover-title" className="kr km-popover__kr">
              {data.kr}
            </div>
          </div>
          <button
            ref={closeRef}
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

            <hr className="hr-gold km-popover__rule" />

            <div className="km-eyebrow km-popover__eyebrow">Example</div>
            <div className="kr km-popover__ex-kr">{data.ex_kr}</div>
            <div className="km-popover__ex-en">{data.ex_en}</div>
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
            </div>

            {drawer ? (
              <div className="km-popover__drawer">
                <div className="km-eyebrow km-popover__eyebrow">More examples</div>
                <div className="km-popover__extras">
                  {extras.map((ex, i) => (
                    <div key={i} className="km-popover__extra">
                      <div className="kr km-popover__extra-kr">{ex.kr}</div>
                      <div className="km-popover__extra-en">{ex.en}</div>
                    </div>
                  ))}
                </div>
                {hasUsage ? (
                  <>
                    <hr className="hr km-popover__usage-rule" />
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
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
