/**
 * ReviewDictionary — `/review/dictionary`, the Review library's "All Words"
 * page (F-050 renamed it from "Dictionary"; the route/id are contracts and
 * stay put — see lib/nav.ts).
 *
 * Overhaul P1.2 kept the full KRDICT (≈54k headwords) a SEPARATE page
 * (decision D2: a lookup corpus, not a study corpus). P3B (F-050) makes it
 * searchable two ways ON TOP of free-text search:
 *
 *   - First Hangul character: the 초성 index (14 base consonants) narrows
 *     the KRDICT browse to one section; "전체" (all) returns to the whole
 *     dictionary. A typed search supersedes any 초성 selection.
 *   - Genre: the SAME genres as the vocabulary page (`content_domain`).
 *     KRDICT rows carry no genre — the curated corpus is the only
 *     genre-tagged data — so selecting a genre pivots the page onto the
 *     existing `GET /vocab/entries` search (`domain` param, free text
 *     still applies); clearing it returns to KRDICT. One page, two
 *     honest backends, discriminated by `page.kind`.
 *
 * F-024: a BackButton to the library index tops the page (nested sub-page).
 *
 * Threat model: the search box is user-controlled — the server Zod-validates
 * `q` and parameterises the SQL; all strings render through React text
 * children. The client's defence is RATE (debounce + per-fetch abort so a
 * slow response never paints over a newer one). The genre dropdown is a
 * closed vocabulary validated at the select boundary (`toGenre`) — an
 * out-of-vocabulary value degrades to "no genre", never reaches the wire.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { BackButton } from '../../components/BackButton';
import { Bilingual } from '../../components/Bilingual';
import { Card } from '../../components/Card';
import { ErrorCard } from '../../components/ErrorCard';
import {
  FilterSelect,
  type FilterSelectOption,
} from '../../components/FilterSelect';
import { Pager, SearchBox } from '../../components/LibraryControls';
import { LibrarySubnav } from '../../components/LibrarySubnav';
import { Topbar } from '../../components/Topbar';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { DOMAIN_FILTERS, PAGE_SIZE } from '../../lib/libraryFilters';
import { errorMessageFor } from '../../lib/errorCopy';
import { searchKrdict } from '../../services/krdict';
import * as vocabService from '../../services/vocab';
import { ApiError } from '../../services/api';
import type {
  ContentDomain,
  KrdictSearchEntry,
  VocabEntry,
} from '../../types/domain';

const INITIAL_CONSONANTS = [
  'ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ',
  'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

/** Genre dropdown — the SAME genres as the vocabulary page (F-050), minus
 *  the 'all' sentinel (FilterSelect's `''` placeholder IS "all"). */
const GENRE_OPTIONS: ReadonlyArray<FilterSelectOption> = DOMAIN_FILTERS.filter(
  (f) => f.id !== 'all',
).map((f) => ({ value: f.id, label: f.label }));

/** Select-boundary guard: '' (placeholder) or anything out-of-vocabulary
 *  means "no genre lens" (null → the KRDICT path). */
function toGenre(value: string): ContentDomain | null {
  return DOMAIN_FILTERS.some((f) => f.id !== 'all' && f.id === value)
    ? (value as ContentDomain)
    : null;
}

/** The two result shapes this page can hold, discriminated by backend. */
type ResultPage =
  | { kind: 'krdict'; rows: KrdictSearchEntry[] }
  | { kind: 'vocab'; rows: VocabEntry[] };

const EMPTY_PAGE: ResultPage = { kind: 'krdict', rows: [] };

/**
 * 초성 (initial-consonant) index for the KRDICT browse — a tappable row of
 * the 14 base consonants plus "전체" (all). Selecting one narrows the browse to
 * that consonant's section; "전체" returns to the whole dictionary.
 */
function InitialIndexBar({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (initial: string | null) => void;
}): JSX.Element {
  return (
    <div
      className="km-resources__initials"
      role="group"
      aria-label="Browse by initial consonant"
    >
      <button
        type="button"
        className={`km-resources__initial${selected === null ? ' is-active' : ''}`}
        aria-pressed={selected === null}
        onClick={() => {
          onSelect(null);
        }}
      >
        전체
      </button>
      {INITIAL_CONSONANTS.map((c) => (
        <button
          key={c}
          type="button"
          className={`km-resources__initial kr${selected === c ? ' is-active' : ''}`}
          aria-pressed={selected === c}
          onClick={() => {
            onSelect(c);
          }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

export default function ReviewDictionary(): JSX.Element {
  const { input, q, setInput, clear } = useDebouncedSearch();
  const [offset, setOffset] = useState(0);
  const [initial, setInitial] = useState<string | null>(null);
  // F-050 — genre lens. null = the KRDICT path; a genre pivots the page
  // onto the curated-corpus search (the only genre-tagged data).
  const [genre, setGenre] = useState<ContentDomain | null>(null);
  const [page, setPage] = useState<ResultPage>(EMPTY_PAGE);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // `q` empty → browse (page 1 on mount, no search needed); typing switches
  // to search; clearing returns to browse. Applies to both backends.
  const browsing = q.trim().length === 0;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(0);
  }, [q, initial, genre]);

  // A whole-dictionary search supersedes any 초성 section selection.
  useEffect(() => {
    if (q.trim().length > 0 && initial !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInitial(null);
    }
  }, [q, initial]);

  useEffect(() => {
    // Browse on an empty query, search on a non-empty one. Both hit the
    // network. Genre set → the curated-corpus backend; genre clear → KRDICT.
    // Sync-to-external-system case.
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    const request: Promise<{ page: ResultPage; total: number }> =
      genre !== null
        ? vocabService
            .searchEntriesPage(
              {
                ...(browsing ? {} : { q }),
                domain: genre,
                limit: PAGE_SIZE,
                offset,
              },
              ctrl.signal,
            )
            .then((res) => ({
              page: { kind: 'vocab' as const, rows: res.entries },
              // `total` is optional (pre-bump server) — degrade to a single
              // page rather than NaN, same as the vocabulary page.
              total: res.total ?? offset + res.entries.length,
            }))
        : searchKrdict(
            {
              ...(browsing ? (initial !== null ? { initial } : {}) : { q }),
              limit: PAGE_SIZE,
              offset,
            },
            ctrl.signal,
          ).then((res) => ({
            page: { kind: 'krdict' as const, rows: res.entries },
            total: res.total,
          }));
    request
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setPage(res.page);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          err instanceof ApiError && err.status === 503
            ? 'The dictionary isn’t available yet.'
            : errorMessageFor(
                err,
                browsing
                  ? 'Could not load the words.'
                  : 'Could not search the words.',
              ),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [q, offset, browsing, initial, genre]);

  const rowCount = page.rows.length;

  return (
    <section
      className="screen km-reference km-resources"
      aria-labelledby="km-review-dictionary-title"
    >
      {/* F-024 — nested library sub-page: deterministic back to the index. */}
      <BackButton to="/review" label="Review" />

      <Topbar
        krTitle="전체 단어"
        title="All Words"
        titleId="km-review-dictionary-title"
        eyebrow={<Bilingual en="Review library" kr="복습 자료실" />}
      />

      <LibrarySubnav />

      <div className="km-resources__panel">
        <SearchBox
          value={input}
          onChange={setInput}
          onClear={clear}
          placeholder="Search 54,000 dictionary entries"
          ariaLabel="Search all words"
        />
        {/* F-050 — genre lens (same genres as the vocabulary page). */}
        <FilterSelect
          label="Genre"
          options={GENRE_OPTIONS}
          value={genre ?? ''}
          onChange={(v) => {
            setGenre(toGenre(v));
          }}
        />
        {/* 초성 index applies to the KRDICT browse only: hidden while a
            search or the genre lens (curated-corpus backend, no 초성
            support) is active. */}
        {browsing && genre === null ? (
          <InitialIndexBar
            selected={initial}
            onSelect={(c) => {
              clear();
              setInitial(c);
            }}
          />
        ) : null}
        {loading && rowCount === 0 ? (
          <div className="km-grammar__state" role="status">
            {browsing ? (
              <Bilingual en="Loading words…" kr="단어를 불러오는 중…" />
            ) : (
              <Bilingual en="Searching…" kr="검색 중…" />
            )}
          </div>
        ) : error ? (
          <ErrorCard message={error} />
        ) : rowCount === 0 ? (
          <p className="km-reference__empty">
            <Bilingual en="No words found." kr="검색 결과가 없어요." />
          </p>
        ) : (
          <>
            <Card className="km-reference__list" variant="flat">
              <ul>
                {page.kind === 'krdict'
                  ? page.rows.map((entry) => (
                      <li
                        key={`krdict:${String(entry.id)}`}
                        className="km-reference__row"
                      >
                        <div className="km-resources__dict-row">
                          <span className="kr km-reference__row-kr">
                            {entry.headword}
                          </span>
                          {entry.part_of_speech ? (
                            <span className="km-pill km-pill--default km-resources__pos">
                              {entry.part_of_speech}
                            </span>
                          ) : null}
                          <span className="km-reference__row-en">
                            {entry.definition_english ??
                              entry.definition_korean ??
                              ''}
                          </span>
                        </div>
                      </li>
                    ))
                  : page.rows.map((entry) => (
                      <li
                        key={`vocab:${String(entry.id)}`}
                        className="km-reference__row"
                      >
                        <div className="km-resources__dict-row">
                          <span className="kr km-reference__row-kr">
                            {entry.korean ?? ''}
                          </span>
                          <span className="km-pill km-pill--default km-resources__pos">
                            {entry.proficiency ?? '—'}
                          </span>
                          <span className="km-reference__row-en">
                            {entry.english ?? ''}
                          </span>
                        </div>
                      </li>
                    ))}
              </ul>
            </Card>
            <Pager
              offset={offset}
              pageSize={PAGE_SIZE}
              total={total}
              onPrev={() => {
                setOffset((o) => Math.max(0, o - PAGE_SIZE));
              }}
              onNext={() => {
                setOffset((o) => o + PAGE_SIZE);
              }}
            />
          </>
        )}
      </div>
    </section>
  );
}
