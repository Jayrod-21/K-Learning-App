/**
 * ReviewDictionary — `/review/dictionary`, the Review library's KRDICT page.
 *
 * Overhaul P1.2: the Reference page dissolved into first-class library
 * routes; this page is its former **Dictionary tab**. Decision D2 keeps the
 * dictionary a SEPARATE page (not merged into the vocabulary browse): the
 * full KRDICT (≈54k headwords) is a lookup corpus, not a study corpus.
 *
 * Behaviour (unchanged from the extracted tab):
 *   - Browse-first: an empty query loads page 1 of the whole dictionary
 *     (the server's browse-all path returns a real page + total).
 *   - 초성 index: the 14 base consonants narrow the browse to one section;
 *     "전체" (all) returns to the whole dictionary.
 *   - Typing switches to search; clearing returns to browse. A search
 *     supersedes any 초성 selection.
 *
 * Threat model: the search box is user-controlled — the server Zod-validates
 * `q` and parameterises the SQL; all strings render through React text
 * children. The client's defence is RATE (debounce + per-fetch abort so a
 * slow response never paints over a newer one).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { Bilingual } from '../../components/Bilingual';
import { Card } from '../../components/Card';
import { ErrorCard } from '../../components/ErrorCard';
import { Pager, SearchBox } from '../../components/LibraryControls';
import { LibrarySubnav } from '../../components/LibrarySubnav';
import { Topbar } from '../../components/Topbar';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { PAGE_SIZE } from '../../lib/libraryFilters';
import { errorMessageFor } from '../../lib/errorCopy';
import { searchKrdict } from '../../services/krdict';
import { ApiError } from '../../services/api';
import type { KrdictSearchEntry } from '../../types/domain';

const INITIAL_CONSONANTS = [
  'ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ',
  'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

/**
 * 초성 (initial-consonant) index for the Dictionary browse — a tappable row of
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
  const [rows, setRows] = useState<KrdictSearchEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // `q` empty → browse the whole dictionary (page 1 on mount, no search
  // needed); typing switches to search; clearing returns to browse.
  const browsing = q.trim().length === 0;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(0);
  }, [q, initial]);

  // A whole-dictionary search supersedes any 초성 section selection.
  useEffect(() => {
    if (q.trim().length > 0 && initial !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInitial(null);
    }
  }, [q, initial]);

  useEffect(() => {
    // Browse on an empty query, search on a non-empty one. Both hit the
    // network (the server's browse-all path returns a real page + total).
    // Sync-to-external-system case.
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Omit `q` entirely when browsing so the service hits the browse-all path.
    searchKrdict(
      {
        ...(browsing ? (initial !== null ? { initial } : {}) : { q }),
        limit: PAGE_SIZE,
        offset,
      },
      ctrl.signal,
    )
      .then((page) => {
        if (ctrl.signal.aborted) return;
        setRows(page.entries);
        setTotal(page.total);
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
                  ? 'Could not load the dictionary.'
                  : 'Could not search the dictionary.',
              ),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [q, offset, browsing, initial]);

  return (
    <section
      className="screen km-reference km-resources"
      aria-labelledby="km-review-dictionary-title"
    >
      <Topbar
        krTitle="사전"
        title="Dictionary"
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
          ariaLabel="Search dictionary"
        />
        {browsing ? (
          <InitialIndexBar
            selected={initial}
            onSelect={(c) => {
              clear();
              setInitial(c);
            }}
          />
        ) : null}
        {loading && rows.length === 0 ? (
          <div className="km-grammar__state" role="status">
            {browsing ? (
              <Bilingual en="Loading dictionary…" kr="사전을 불러오는 중…" />
            ) : (
              <Bilingual en="Searching…" kr="검색 중…" />
            )}
          </div>
        ) : error ? (
          <ErrorCard message={error} />
        ) : rows.length === 0 ? (
          <p className="km-reference__empty">
            <Bilingual
              en="No dictionary entries found."
              kr="검색 결과가 없어요."
            />
          </p>
        ) : (
          <>
            <Card className="km-reference__list" variant="flat">
              <ul>
                {rows.map((entry) => (
                  <li key={`krdict:${String(entry.id)}`} className="km-reference__row">
                    <div className="km-resources__dict-row">
                      <span className="kr km-reference__row-kr">{entry.headword}</span>
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
