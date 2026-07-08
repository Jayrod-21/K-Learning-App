/**
 * Reading — `/learn/reading` placeholder (Overhaul P1.1).
 *
 * The real Reading feature arrives in P6, once Jared's scanned books are
 * ingested. This page exists so the LEARN menu's seventh slot lands
 * somewhere honest instead of 404-ing or being omitted.
 *
 * NOT at `/reading` — that legacy path is a permanent redirect to
 * `/learn/listen` (the retired Read screen's content lives in Listen).
 *
 * No I/O — no threat model.
 */
import type { JSX } from 'react';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { Topbar } from '../components/Topbar';
import { navItem } from '../lib/nav';

/** Page chrome source — nav.ts owns the en/kr pair (P3b Batch A). */
const READING_NAV = navItem('reading');

function Reading(): JSX.Element {
  return (
    <section className="screen km-reading" aria-labelledby="reading-title">
      <Topbar
        krTitle="읽기"
        title="Reading"
        titleId="reading-title"
        eyebrow={
          <Bilingual en={READING_NAV.eyebrow} kr={READING_NAV.krEyebrow} />
        }
      />
      <Card variant="flat" style={{ padding: '20px 22px' }}>
        {/* P3b trim: the card's own "준비 중 · In the works" eyebrow repeated
            the topbar eyebrow, and the two-sentence pitch is now one line. */}
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--paper-dim)' }}>
          <Bilingual
            en="Graded passages from your scanned books will live here."
            kr="스캔한 책의 지문이 여기에 담길 예정이에요."
          />
        </p>
      </Card>
    </section>
  );
}

export default Reading;
