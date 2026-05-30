/**
 * Topbar — sticky header pattern used by most screens.
 *
 * Eyebrow + serif Korean display title + optional English suffix line +
 * optional right-side slot (used for things like a `Hide hints` ghost
 * button on Conversation, or a `Filter` chip on Reference).
 *
 * Sticky so the title stays in view while the body scrolls; the gradient
 * tail fades the underlying paper texture out so content underneath
 * doesn't visibly clip behind a hard line.
 *
 * No I/O — no threat model.
 */
import type { JSX, ReactNode } from 'react';
import { Eyebrow } from './Eyebrow';

export interface TopbarProps {
  /** Korean serif display title — the page's primary header. */
  krTitle: ReactNode;
  /** English suffix shown in small caps under the title. Optional. */
  title?: ReactNode;
  /** Small eyebrow text above the title. */
  eyebrow?: ReactNode;
  /** Right-side slot — action buttons, etc. */
  right?: ReactNode;
}

export function Topbar({
  krTitle,
  title,
  eyebrow,
  right,
}: TopbarProps): JSX.Element {
  return (
    <header className="km-topbar">
      <div className="km-topbar__row">
        <div className="km-topbar__meta">
          {eyebrow ? (
            <Eyebrow className="km-topbar__eyebrow">{eyebrow}</Eyebrow>
          ) : null}
          <h1 className="kr kr-display km-topbar__title">{krTitle}</h1>
          {title ? <div className="km-topbar__subtitle">{title}</div> : null}
        </div>
        {right ? <div className="km-topbar__right">{right}</div> : null}
      </div>
    </header>
  );
}
