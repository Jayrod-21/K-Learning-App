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
import { Card } from '../components/Card';
import { Topbar } from '../components/Topbar';

function Reading(): JSX.Element {
  return (
    <section className="screen km-reading" aria-labelledby="reading-title">
      <Topbar
        krTitle={<span id="reading-title">읽기 · Reading</span>}
        eyebrow="Coming soon"
      />
      <Card variant="flat" style={{ padding: '20px 22px' }}>
        <div className="km-eyebrow" style={{ marginBottom: 6 }}>
          준비 중 · In the works
        </div>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--paper-dim)' }}>
          Reading — coming with your book scans. Graded passages from your own
          books will live here once they’re digitised.
        </p>
      </Card>
    </section>
  );
}

export default Reading;
