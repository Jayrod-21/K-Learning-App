/**
 * Review-library browse filter vocabularies (F-003/F-005) + page sizes —
 * extracted from pages/Reference.tsx in Overhaul P1.2 so the library's
 * sibling pages (`/review/vocab`, `/review/dictionary`, `/review/grammar`)
 * share one definition. Lives in lib/ (not a component file) because
 * react-refresh/only-export-components keeps component files component-only.
 *
 * `'all'` omits the query param so the endpoint returns every row — the
 * params map 1:1 onto `GET /vocab/entries` / `GET /grammar/kgiu` query
 * params (`domain`, `book_level`).
 */
import type { BookLevel, ContentDomain } from '../types/domain';

export type DomainFilter = ContentDomain | 'all';
export type LevelFilter = BookLevel | 'all';

export interface FilterOption<T extends string> {
  readonly id: T;
  readonly label: string;
}

export const DOMAIN_FILTERS: ReadonlyArray<FilterOption<DomainFilter>> = [
  { id: 'all', label: 'All' },
  { id: 'general', label: 'General' },
  { id: 'research', label: 'Research' },
  { id: 'business', label: 'Business' },
];

/** The curated vocab corpora carry only beginner/intermediate bands. */
export const VOCAB_LEVEL_FILTERS: ReadonlyArray<FilterOption<LevelFilter>> = [
  { id: 'all', label: 'All' },
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
];

/** KGIU spans all three bands. */
export const GRAMMAR_LEVEL_FILTERS: ReadonlyArray<FilterOption<LevelFilter>> = [
  { id: 'all', label: 'All' },
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
];

/** Page size for the paginated vocab + dictionary browses. */
export const PAGE_SIZE = 30;

/** Grammar corpus is small (≈370); one wide page covers it without a pager.
 *  Matches the `GET /grammar/kgiu` endpoint's `limit` ceiling. */
export const GRAMMAR_PAGE_SIZE = 400;
