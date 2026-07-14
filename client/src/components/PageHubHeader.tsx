/**
 * PageHubHeader — the shared "hub-header" recipe (DESIGN_SEOUL_DAY_NIGHT.md
 * device #4 + #2): a `SkylineHeader` carrying the real `<h1>` in its `title`
 * slot, followed by a `DancheongRail` divider underneath.
 *
 * Batch-2 fix-pass (BLOCKER-2, `REVIEW_batch2-fidelity.md` B1 + the
 * corroborating `REVIEW_batch2-grammar-mistakes.md` finding #2): this exact
 * recipe was copy-pasted verbatim into 7 files (Today, Progress, and 5 of
 * the 6 Library pages), and the two pages that were rewritten in parallel by
 * a different agent this pass (ReviewGrammar, Mistakes) simply missed the
 * memo and shipped a flat `Topbar` instead — a jarring header swap mid-
 * navigation. A single shared component is the actual fix: there is now only
 * one place a future page can copy the recipe from, and no way to almost-do
 * it by hand.
 *
 * Adopted by all 6 Library pages (ReviewLibrary, ReviewVocab,
 * ReviewDictionary, ReviewGrammar, Mistakes, Uploads) + UploadViewer. Today
 * and Progress are NOT retrofitted in this pass (out of this batch's scope,
 * even though they originated the recipe) — see FIX_REPORT_batch2.md for the
 * follow-up ticket to migrate them later.
 *
 * A11y: `heading` renders inside a REAL `<h1 id={titleId}>` (never a
 * decorative div) — every page's `aria-labelledby` continues to target a
 * genuine heading element, exactly as the pre-existing per-page copies did.
 *
 * No I/O — pure presentation; no threat model beyond the router's own.
 */
import type { JSX, ReactNode } from 'react';
import { cn } from '../lib/cn';
import type { DancheongRailTone } from './DancheongRail';
import { DancheongRail } from './DancheongRail';
import { Eyebrow } from './Eyebrow';
import { SkylineHeader } from './SkylineHeader';
import './PageHubHeader.css';

export interface PageHubHeaderProps {
  /** Stamped on the real `<h1>` — the target of the page section's own
   * `aria-labelledby`. */
  titleId: string;
  /** Eyebrow content above the heading (typically a `<Bilingual/>` pair). */
  eyebrow: ReactNode;
  /** The `<h1>`'s children — a `<Bilingual/>` pair, or any pre-composed
   * heading content (e.g. UploadViewer's plain book-title string). */
  heading: ReactNode;
  /** `DancheongRail` tone for the divider under the header. */
  railTone?: DancheongRailTone;
  /** Optional row of actions (buttons, etc.) rendered below the rail
   * divider, above the page's own content. No current consumer needs this —
   * it exists so a future page doesn't reach for a bespoke header variant
   * the first time one does. */
  actions?: ReactNode;
  /** Optional single-hangul-glyph watermark texture (device #6) on the
   * header block — for hub pages with no empty state of their own to
   * otherwise carry the texture. Purely decorative (CSS `content`, never in
   * the accessibility tree). */
  glyph?: string;
  className?: string;
}

export function PageHubHeader({
  titleId,
  eyebrow,
  heading,
  railTone = 'accent',
  actions,
  glyph,
  className,
}: PageHubHeaderProps): JSX.Element {
  return (
    <div
      className={cn(
        'km-hubheader',
        glyph !== undefined ? 'km-hangul-watermark' : undefined,
        className,
      )}
      {...(glyph !== undefined ? { 'data-glyph': glyph } : {})}
    >
      <SkylineHeader
        className="km-hubheader__skyline"
        title={
          <>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h1 id={titleId} className="kr-display km-hubheader__title">
              {heading}
            </h1>
          </>
        }
      />
      <div className="km-hubheader__rail-divider">
        <DancheongRail tone={railTone} />
      </div>
      {actions !== undefined ? (
        <div className="km-hubheader__actions">{actions}</div>
      ) : null}
    </div>
  );
}
