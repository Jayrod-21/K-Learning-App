/**
 * ReviewVocab — `/review/vocab`, the Review library's vocabulary page.
 *
 * Overhaul P1.2: the Reference page dissolved into first-class library
 * routes; this page is its former **Vocabulary tab** (curated `vocab_2000`
 * corpus — searchable, paginated against the server's real `total`, with
 * the F-003 genre/`domain` + difficulty/`book_level` filters) PLUS the
 * canonical **My Lists** surface (see components/MyVocabLists — the P1.2
 * dedup of the Review.tsx/Reference.tsx duplicate).
 *
 * Views ("Browse" is the default):
 *   - Browse   — the corpus browse; each row carries an add-to-list picker.
 *   - My lists — the unified list manager. Deep-linkable via `?tab=lists`
 *     (consumed once on mount — the param is a hint, not a contract), which
 *     is what the LEARN flashcards page links to.
 *
 * The "This Week" suggestion strip renders above the views — a transitional
 * home after the Reference dissolution; decision D4 moves the suggestion
 * function into the LEARN pages in P4.
 *
 * Threat model: the search box is user-controlled — the server Zod-validates
 * `q` and parameterises the SQL; strings render through React text children;
 * the client's defence is RATE (debounce + per-fetch abort). List mutations
 * ride the `SameSite=Strict` session cookie (services/api.ts).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bilingual } from '../../components/Bilingual';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ErrorCard } from '../../components/ErrorCard';
import { Eyebrow } from '../../components/Eyebrow';
import { Icon } from '../../components/Icon';
import {
  FilterGroup,
  Pager,
  SearchBox,
} from '../../components/LibraryControls';
import { LibrarySubnav } from '../../components/LibrarySubnav';
import { MyVocabLists } from '../../components/MyVocabLists';
import { Sheet } from '../../components/Sheet';
import { Topbar } from '../../components/Topbar';
import { WeeklySuggestions } from '../../components/WeeklySuggestions';
import { useToast } from '../../components/useToast';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import {
  DOMAIN_FILTERS,
  PAGE_SIZE,
  VOCAB_LEVEL_FILTERS,
  type DomainFilter,
  type LevelFilter,
} from '../../lib/libraryFilters';
import { errorMessageFor } from '../../lib/errorCopy';
import * as vocabService from '../../services/vocab';
import { ApiError } from '../../services/api';
import type { ServerVocabList, VocabEntry } from '../../types/domain';

type View = 'browse' | 'lists';

const VIEWS: ReadonlyArray<{ id: View; label: string; kr: string }> = [
  { id: 'browse', label: 'Browse', kr: '둘러보기' },
  { id: 'lists', label: 'My lists', kr: '내 단어장' },
];

function isView(value: string | null): value is View {
  return value !== null && VIEWS.some((v) => v.id === value);
}

/** Old Reference `?tab=` values that should land on the lists view. */
function initialView(tabParam: string | null): View {
  if (isView(tabParam)) return tabParam;
  return 'browse';
}

export default function ReviewVocab(): JSX.Element {
  // Initial view honours the `?tab=lists` deep link (from /learn/vocab and
  // the retired /reference shim); later switches are local state only.
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<View>(() =>
    initialView(searchParams.get('tab')),
  );

  return (
    <section
      className="screen km-reference km-resources"
      aria-labelledby="km-review-vocab-title"
    >
      <Topbar
        krTitle="단어"
        title="Vocabulary"
        titleId="km-review-vocab-title"
        eyebrow={<Bilingual en="Review library" kr="복습 자료실" />}
      />

      <LibrarySubnav />

      <WeeklySuggestions />

      <div
        className="km-review__tabs km-resources__tabs"
        role="tablist"
        aria-label="Vocabulary section"
      >
        {VIEWS.map((v) => {
          const selected = view === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
              onClick={() => {
                setView(v.id);
              }}
            >
              <Bilingual en={v.label} kr={v.kr} compact />
            </button>
          );
        })}
      </div>

      {view === 'browse' ? <VocabBrowse /> : null}
      {view === 'lists' ? <MyVocabLists /> : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Browse — curated corpus, searchable + paginated (F-003 filters)
// ─────────────────────────────────────────────────────────────

function VocabBrowse(): JSX.Element {
  const { input, q, setInput, clear } = useDebouncedSearch();
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<VocabEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so the Retry button re-runs the fetch effect
  // without changing `q`/`offset`.
  const [reloadTick, setReloadTick] = useState(0);
  // Add-to-list target row — opens the picker Sheet.
  const [addTarget, setAddTarget] = useState<VocabEntry | null>(null);
  // F-003 filters: genre (content_domain) + difficulty (book_level). 'all'
  // omits the param so the endpoint returns every row.
  const [domain, setDomain] = useState<DomainFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  const ctrlRef = useRef<AbortController | null>(null);

  // Reset to the first page whenever the query or a filter changes so the
  // pager never points past the new result set. Sync-to-derived-state on a
  // key change — same documented exception the hooks use.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(0);
  }, [q, domain, level]);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (a network fetch) — the same exception
    // useEndpointOrMock documents for its kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    vocabService
      .searchEntriesPage(
        {
          ...(q ? { q } : {}),
          ...(domain !== 'all' ? { domain } : {}),
          ...(level !== 'all' ? { book_level: level } : {}),
          limit: PAGE_SIZE,
          offset,
        },
        ctrl.signal,
      )
      .then((page) => {
        if (ctrl.signal.aborted) return;
        setRows(page.entries);
        // `total` is optional (pre-bump server). Fall back to "page length"
        // so the pager degrades to a single page rather than rendering NaN.
        setTotal(page.total ?? offset + page.entries.length);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load vocabulary.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [q, offset, domain, level, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  return (
    <div className="km-resources__panel">
      <SearchBox
        value={input}
        onChange={setInput}
        onClear={clear}
        placeholder="Search the 2,000 corpus"
        ariaLabel="Search vocabulary"
      />
      <FilterGroup
        ariaLabel="Filter vocabulary by topic"
        options={DOMAIN_FILTERS}
        value={domain}
        onChange={setDomain}
      />
      <FilterGroup
        ariaLabel="Filter vocabulary by level"
        options={VOCAB_LEVEL_FILTERS}
        value={level}
        onChange={setLevel}
      />
      {loading && rows.length === 0 ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading vocabulary…" kr="어휘를 불러오는 중…" />
        </div>
      ) : error ? (
        // Render the error whenever the LAST fetch failed — even when stale
        // rows from a previous page/filter are still in state. Gating this on
        // `rows.length === 0` silently swallowed pagination/filter failures:
        // the old rows kept rendering under the NEW pager range (offset had
        // already advanced), with no error and no retry surface.
        <ErrorCard message={error} onRetry={refetch} />
      ) : rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual
            en="No words match. Try a dictionary form."
            kr="맞는 단어가 없어요. 사전형으로 검색해 보세요."
          />
        </p>
      ) : (
        <>
          <Card className="km-reference__list" variant="flat">
            <ul>
              {rows.map((entry) => (
                <li key={`vocab:${String(entry.id)}`} className="km-reference__row">
                  <div className="km-resources__entry-row">
                    <span className="kr km-reference__row-kr">
                      {entry.korean ?? ''}
                    </span>
                    <span className="km-reference__row-en">
                      {entry.english ?? ''}
                    </span>
                    <span className="km-pill km-pill--default km-reference__row-level">
                      {entry.proficiency ?? '—'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<Icon name="plus" size={12} />}
                      onClick={() => {
                        setAddTarget(entry);
                      }}
                      aria-label={`Add ${entry.korean ?? 'word'} to a list`}
                    >
                      <Bilingual en="List" kr="목록" compact />
                    </Button>
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

      <AddToListSheet
        entry={addTarget}
        onClose={() => {
          setAddTarget(null);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Add-to-list Sheet — pick a list to add a vocab row into
// ─────────────────────────────────────────────────────────────

interface AddToListSheetProps {
  entry: VocabEntry | null;
  onClose: () => void;
}

function AddToListSheet({ entry, onClose }: AddToListSheetProps): JSX.Element {
  const { toast } = useToast();
  const [lists, setLists] = useState<ServerVocabList[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (entry === null) {
      setLists([]);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    vocabService
      .listLists()
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setLists(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(errorMessageFor(err, 'Could not load your lists.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [entry]);

  const add = useCallback(
    async (list: ServerVocabList): Promise<void> => {
      if (entry === null) return;
      setPendingId(list.id);
      setError(null);
      try {
        await vocabService.addListEntries(list.id, [entry.id]);
        toast({
          message: `Added to ${list.name_kr}.`,
          tone: 'success',
        });
        onClose();
      } catch (err) {
        // 409 → already in this list. The user's intent is satisfied; treat it
        // as a (gentle) success rather than a hard error.
        if (err instanceof ApiError && err.status === 409) {
          toast({
            message: `Already in ${list.name_kr}.`,
            tone: 'info',
          });
          onClose();
          return;
        }
        setError(errorMessageFor(err, 'Could not add the word.'));
      } finally {
        setPendingId(null);
      }
    },
    [entry, onClose, toast],
  );

  const krLabel = useMemo(() => entry?.korean ?? '', [entry]);

  return (
    <Sheet open={entry !== null} onClose={onClose} ariaLabel="Add to a list">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>
              <Bilingual en="Add to list" kr="목록에 추가" />
            </Eyebrow>
            <div className="kr-display km-review__sheetTitle">{krLabel}</div>
            <div className="km-review__sheetMeta">{entry?.english ?? ''}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close add to list"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-grammar__state" role="status">
            <Bilingual en="Loading your lists…" kr="목록을 불러오는 중…" />
          </div>
        ) : null}
        {error ? <ErrorCard message={error} /> : null}
        {!loading && lists.length === 0 && !error ? (
          <p className="km-reference__empty">
            <Bilingual
              en="No lists yet — create one in the My lists view first."
              kr="아직 목록이 없어요 — 내 단어장에서 먼저 만들어 주세요."
            />
          </p>
        ) : null}
        {lists.length > 0 ? (
          <ul className="km-resources__pick-list">
            {lists.map((list) => (
              <li key={`pick:${String(list.id)}`}>
                <Button
                  variant="ghost"
                  size="md"
                  fullWidth
                  onClick={() => {
                    void add(list);
                  }}
                  disabled={pendingId === list.id}
                  leadingIcon={<Icon name="plus" size={14} />}
                >
                  {pendingId === list.id ? (
                    <Bilingual en="Adding…" kr="추가 중…" />
                  ) : (
                    list.name_kr
                  )}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}
