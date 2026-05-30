/**
 * ScreenStub — the Pass 1 placeholder for each of the 11 screens.
 *
 * Renders the design's screen-header pattern (small eyebrow → large serif
 * Korean title with English suffix) and a single "coming in Pass N" card.
 * Real screen bodies replace this in Pass 2 and beyond. Driven by the
 * `NavItemId` so adding a new route to the nav manifest auto-routes here.
 */
import type { JSX } from 'react';
import { Eyebrow } from '../components/Eyebrow';
import { navItem, type NavItemId, type PassNumber } from '../lib/nav';

export interface ScreenStubProps {
  id: NavItemId;
  /** Which pass will fill this screen. */
  pass: PassNumber;
  /** One-sentence description of what will live here. */
  comingCopy: string;
}

export function ScreenStub({
  id,
  pass,
  comingCopy,
}: ScreenStubProps): JSX.Element {
  const it = navItem(id);
  return (
    <section className="screen km-stub" aria-labelledby={`stub-${id}`}>
      <Eyebrow>{it.eyebrow}</Eyebrow>
      <h1 id={`stub-${id}`} className="kr-display km-stub__title">
        {it.headerTitle}
      </h1>
      <div className="km-stub__placeholder">
        <div className="km-eyebrow" style={{ marginBottom: 6 }}>
          Pass {pass}
        </div>
        {comingCopy}
      </div>
    </section>
  );
}
