/**
 * Topbar — sticky header pattern used by most screens.
 *
 * Eyebrow + serif display title + optional right-side slot (used for things
 * like a `Hide hints` ghost button on Conversation, or a `Filter` chip on
 * Reference).
 *
 * Title (Overhaul P3a): when BOTH `krTitle` and `title` are plain strings the
 * h1 renders them through `<Bilingual/>`, so the page title follows the
 * user's language-display setting (English / Korean / both + orientation +
 * sub size). Pages not yet migrated (P3b) keep passing a pre-composed
 * ReactNode `krTitle` and render exactly as before.
 *
 * `titleId` stamps an id on the h1 itself for `aria-labelledby` wiring —
 * pre-P3a pages buried the id inside the krTitle span; putting it on the
 * heading keeps the reference stable across display modes.
 *
 * Sticky so the title stays in view while the body scrolls; the gradient
 * tail fades the underlying paper texture out so content underneath
 * doesn't visibly clip behind a hard line.
 *
 * No I/O — no threat model.
 */
import type { JSX, ReactNode } from 'react';
import { Bilingual } from './Bilingual';
import { Eyebrow } from './Eyebrow';

export interface TopbarProps {
  /**
   * Korean display title. Pass a plain STRING together with a string `title`
   * to get the language-display-aware bilingual rendering; a ReactNode is the
   * legacy pre-composed form (renders verbatim, ignores the setting).
   */
  krTitle: ReactNode;
  /** English title. With a string `krTitle`, the pair renders `<Bilingual/>`. */
  title?: string;
  /** id for the h1 — target of the page section's `aria-labelledby`. */
  titleId?: string;
  /** Small eyebrow text above the title. */
  eyebrow?: ReactNode;
  /** Right-side slot — action buttons, etc. */
  right?: ReactNode;
}

export function Topbar({
  krTitle,
  title,
  titleId,
  eyebrow,
  right,
}: TopbarProps): JSX.Element {
  const bilingual =
    typeof krTitle === 'string' && typeof title === 'string';
  return (
    <header className="km-topbar">
      <div className="km-topbar__row">
        <div className="km-topbar__meta">
          {eyebrow ? (
            <Eyebrow className="km-topbar__eyebrow">{eyebrow}</Eyebrow>
          ) : null}
          <h1 id={titleId} className="kr kr-display km-topbar__title">
            {bilingual ? <Bilingual kr={krTitle} en={title} /> : krTitle}
          </h1>
        </div>
        {right ? <div className="km-topbar__right">{right}</div> : null}
      </div>
    </header>
  );
}
