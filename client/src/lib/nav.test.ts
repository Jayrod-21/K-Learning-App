/**
 * nav manifest — runtime guarantees behind the P1.1 id/path model.
 *
 * The compile-time exhaustiveness check in nav.ts guards the union↔bucket
 * partition for tsc; these tests guard the properties tsc can't see —
 * path uniqueness, the /learn namespace, and the hard route contracts
 * (`/chat` never moves; `/review` is the library; the flashcards page
 * lives at `/learn/vocab`).
 */
import { describe, expect, it } from 'vitest';
import {
  LEARN_SUBPAGE_IDS,
  NAV_ITEMS,
  PRIMARY_TAB_IDS,
  SECONDARY_IDS,
  navItem,
} from './nav';

describe('nav manifest (P1.1)', () => {
  it('partitions every NavItemId into exactly one bucket', () => {
    const buckets = [
      ...PRIMARY_TAB_IDS,
      ...LEARN_SUBPAGE_IDS,
      ...SECONDARY_IDS,
    ];
    // No id appears twice across buckets…
    expect(new Set(buckets).size).toBe(buckets.length);
    // …and the buckets cover the manifest exactly.
    const manifestIds = NAV_ITEMS.map((it) => it.id).sort();
    expect([...buckets].sort()).toEqual(manifestIds);
  });

  it('registers every id in the manifest (navItem never throws)', () => {
    for (const id of [
      ...PRIMARY_TAB_IDS,
      ...LEARN_SUBPAGE_IDS,
      ...SECONDARY_IDS,
    ]) {
      expect(navItem(id).id).toBe(id);
    }
  });

  it('has globally unique paths', () => {
    const paths = NAV_ITEMS.map((it) => it.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('namespaces all 7 LEARN sub-pages under /learn/*', () => {
    expect(LEARN_SUBPAGE_IDS).toHaveLength(7);
    for (const id of LEARN_SUBPAGE_IDS) {
      expect(navItem(id).path).toMatch(/^\/learn\/[a-z]+$/);
    }
  });

  it('keeps the 4 primary tabs on their routed paths', () => {
    expect(PRIMARY_TAB_IDS).toEqual(['today', 'progress', 'review', 'settings']);
    expect(navItem('today').path).toBe('/');
    expect(navItem('progress').path).toBe('/progress');
    expect(navItem('review').path).toBe('/review');
    expect(navItem('settings').path).toBe('/settings');
  });

  it('honours the hard route contracts', () => {
    // /chat NEVER moves — AskAboutThisButton pins CHAT_PATH='/chat'.
    expect(navItem('chat').path).toBe('/chat');
    // The old flashcards page (was id `review` at /review) is now
    // `flashcards` at /learn/vocab; `review` is the library.
    expect(navItem('flashcards').path).toBe('/learn/vocab');
    expect(navItem('flashcards').label).toBe('Vocab flashcards');
    expect(navItem('review').eyebrow).toBe('Library');
    // Mistakes lives under the library.
    expect(navItem('mistakes').path).toBe('/review/mistakes');
    // ttmik keeps its id but reads "Listen" at /learn/listen.
    expect(navItem('ttmik').path).toBe('/learn/listen');
    expect(navItem('ttmik').label).toBe('Listen');
    // The NEW reading placeholder must NOT sit at the legacy /reading
    // (that path is a live redirect to /learn/listen).
    expect(navItem('reading').path).toBe('/learn/reading');
  });
});
