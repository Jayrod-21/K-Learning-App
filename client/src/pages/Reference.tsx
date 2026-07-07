/**
 * Resources screen — browse-everything: curated vocab, the full KRDICT
 * dictionary, all grammar patterns, and the user's custom lists, plus a
 * suggest-only "This Week" strip.
 *
 * Tabs (Vocabulary is the default):
 *   - Vocabulary — the curated `vocab_2000` corpus (≈3,131 rows). Searchable,
 *     PAGINATED against the server's real `total` so "see all words whenever I
 *     want" is honoured rather than capped at a page. Each row carries an
 *     add-to-list affordance.
 *   - Dictionary — the full KRDICT dictionary (≈54k headwords). Far too large
 *     to scroll, so it is SEARCH-FIRST: an empty state prompts the user to
 *     type; results are paginated.
 *   - Grammar — every KGIU pattern (the full set, not the 20-row default).
 *     Each row opens a detail Sheet (`GET /grammar/kgiu/:id` — explanation,
 *     formation rules, examples, dialogues + unit via the shared
 *     `KgiuDetailBody`, the same detail surface pages/Grammar.tsx renders;
 *     F-004/F-018), and the
 *     list narrows by topic (`domain`) and level (`book_level`) filters that
 *     map 1:1 onto the endpoint's query params (F-005). The Vocabulary tab
 *     carries the same two filters against `GET /vocab/entries` (F-003).
 *   - My Lists — create a named list, see the lists, open one to view its
 *     entries and remove them.
 *
 * "This Week" (above the tabs) — ≈15 vocab + a handful of grammar picks,
 * deterministic per ISO week server-side. SUGGEST-ONLY: the server never
 * auto-banks; each card has an [Add] button that banks the pick through the
 * EXISTING per-entry / per-pattern bank path and flips to "✓ Added". The flip
 * is idempotent — a double-tap (or a server 409 "already banked") still lands
 * on the added state rather than surfacing an error.
 *
 * Threat model:
 *   - Every search box is user-controlled. We DO NOT sanitise on the client:
 *     the server Zod-validates each `q` and parameterises the SQL, and every
 *     Korean/English string renders through React text children (no
 *     innerHTML / dangerouslySetInnerHTML anywhere), so a hostile corpus row
 *     cannot escape into the DOM. The client's defence is RATE — each search
 *     debounces keystrokes (200 ms) and the keyed `useEndpointOrMock` aborts
 *     the previous in-flight call so a slow response never paints over a
 *     newer one.
 *   - The bank / list-mutation calls are POST/DELETE → CSRF surface, defended
 *     by the session cookie's `SameSite=Strict` (see services/api.ts). We
 *     never echo server message text into the optimistic UI; the flip state is
 *     derived from our own row ids.
 *   - List ownership (IDOR) is a server property: the routes 404 a list the
 *     session user doesn't own. The client passes numeric ids only — no
 *     free-form path concatenation.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { Topbar } from '../components/Topbar';
import { Sheet } from '../components/Sheet';
import { KgiuDetailBody } from '../components/KgiuDetailBody';
import { ErrorCard } from '../components/ErrorCard';
import { useToast } from '../components/useToast';
import * as vocabService from '../services/vocab';
import * as grammarService from '../services/grammar';
import { searchKrdict } from '../services/krdict';
import {
  fetchWeeklyGrammarSuggestions,
  fetchWeeklyVocabSuggestions,
} from '../services/suggestions';
import { ApiError } from '../services/api';
import { grammarKey } from '../lib/grammarKey';
import { errorMessageFor } from '../lib/errorCopy';
import type {
  BookLevel,
  ContentDomain,
  KgiuEntryDetail,
  KgiuEntrySummary,
  KrdictSearchEntry,
  ServerProficiency,
  ServerVocabList,
  VocabEntry,
  VocabListEntryRow,
} from '../types/domain';

type Tab = 'vocab' | 'dictionary' | 'grammar' | 'lists';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'vocab', label: 'Vocabulary' },
  { id: 'dictionary', label: 'Dictionary' },
  { id: 'grammar', label: 'Grammar' },
  { id: 'lists', label: 'My Lists' },
];

/**
 * Overhaul P1.1: the Review library index deep-links into a tab via
 * `?tab=vocab|dictionary|grammar|lists`. Unknown/absent values fall back to
 * the vocab default rather than erroring — the param is a hint, not a
 * contract (Reference dissolves into the library in P1.2 anyway).
 */
function isTab(value: string | null): value is Tab {
  return value !== null && TABS.some((t) => t.id === value);
}

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 30;
/** Grammar corpus is small (≈370); one wide page covers it without a pager. */
const GRAMMAR_PAGE_SIZE = 400;

/** Outcome of an idempotent add — used to drive the ✓ flip honestly. */
type AddState = 'idle' | 'adding' | 'added' | 'error';

export default function Reference(): JSX.Element {
  // Initial tab honours the library's `?tab=` deep link; subsequent tab
  // switches are local state only (no URL writes — matches pre-P1.1
  // behaviour, and the param is consumed once on mount).
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(tabParam) ? tabParam : 'vocab');

  return (
    <section
      className="screen km-reference km-resources"
      aria-labelledby="km-resources-title"
    >
      <Topbar
        krTitle={
          <>
            자료 <span className="km-topbar__title-en">· Resources</span>
          </>
        }
        eyebrow="Browse"
      />
      <span id="km-resources-title" className="km-sr-only">
        Resources
      </span>

      <WeeklySuggestions />

      <div
        className="km-review__tabs km-resources__tabs"
        role="tablist"
        aria-label="Resources section"
      >
        {TABS.map((t) => {
          const selected = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
              onClick={() => {
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'vocab' ? <VocabularyTab /> : null}
      {tab === 'dictionary' ? <DictionaryTab /> : null}
      {tab === 'grammar' ? <GrammarTab /> : null}
      {tab === 'lists' ? <ListsTab /> : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// This Week — suggest-only picks
// ─────────────────────────────────────────────────────────────

/** A pattern is renderable/bankable only if its display string is non-blank. */
function hasPattern(p: KgiuEntrySummary): boolean {
  return p.pattern.trim().length > 0;
}

function toBankProficiency(raw: string | null): ServerProficiency {
  switch (raw) {
    case 'basic':
    case 'L3':
    case 'L4':
    case 'L5+':
      return raw;
    default:
      return 'L3';
  }
}

function WeeklySuggestions(): JSX.Element | null {
  const [vocab, setVocab] = useState<VocabEntry[] | null>(null);
  const [grammar, setGrammar] = useState<KgiuEntrySummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  // Per-pick add state, keyed by a namespaced id so vocab + grammar never
  // collide. The flip is local + idempotent — see `bankVocab` / `bankGrammar`.
  const [adds, setAdds] = useState<Record<string, AddState>>({});

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    // Fetch both picks in parallel; a failure on one leaves the other usable.
    // `allSettled` so one empty/erroring suggestion source doesn't blank the
    // whole strip (suggest-only is a nice-to-have, never a blocker).
    void Promise.allSettled([
      fetchWeeklyVocabSuggestions(ctrl.signal),
      fetchWeeklyGrammarSuggestions(ctrl.signal),
    ]).then(([v, g]) => {
      if (!alive || ctrl.signal.aborted) return;
      setVocab(v.status === 'fulfilled' ? v.value : []);
      // Defensive: drop any pattern with an empty display string. Post-F1 the
      // server already fences these out (kgiu rows whose `pattern` is blank),
      // so this should never fire — but a blank row has no banking key and
      // would render an empty card, so we skip it here too.
      setGrammar(g.status === 'fulfilled' ? g.value.filter(hasPattern) : []);
      setLoading(false);
    });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, []);

  const setAdd = useCallback((key: string, next: AddState): void => {
    setAdds((prev) => ({ ...prev, [key]: next }));
  }, []);

  const bankVocab = useCallback(
    async (entry: VocabEntry): Promise<void> => {
      const key = `v:${String(entry.id)}`;
      setAdd(key, 'adding');
      try {
        await vocabService.bankEntry(entry.id);
        setAdd(key, 'added');
      } catch (err) {
        // The bank path is idempotent server-side; a 409 means "already
        // banked", which satisfies the post-condition — flip to ✓, not error.
        if (err instanceof ApiError && err.status === 409) {
          setAdd(key, 'added');
          return;
        }
        setAdd(key, 'error');
      }
    },
    [setAdd],
  );

  const bankGrammar = useCallback(
    async (pattern: KgiuEntrySummary): Promise<void> => {
      const key = `g:${grammarKey(pattern)}`;
      setAdd(key, 'adding');
      try {
        await grammarService.bankPattern({
          pattern_key: grammarKey(pattern),
          pattern_display: pattern.pattern,
          summary_en: pattern.title_en ?? pattern.pattern,
          proficiency: toBankProficiency(pattern.proficiency),
          category: pattern.category ?? 'pattern',
          discovered_via: 'manual',
        });
        setAdd(key, 'added');
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setAdd(key, 'added');
          return;
        }
        setAdd(key, 'error');
      }
    },
    [setAdd],
  );

  // Nothing to suggest (both empty) and not loading → render nothing rather
  // than an empty card.
  const hasAny = (vocab?.length ?? 0) > 0 || (grammar?.length ?? 0) > 0;
  if (!loading && !hasAny) return null;

  return (
    <Card className="km-resources__week" variant="flat">
      <Eyebrow>이번 주 · This Week</Eyebrow>
      <p className="km-resources__week-hint">
        A fresh set every week. Tap Add to bank a card — nothing is added
        automatically.
      </p>
      {loading ? (
        <div className="km-grammar__state" role="status">
          Loading this week’s picks…
        </div>
      ) : (
        <div className="km-resources__week-cols">
          {(vocab?.length ?? 0) > 0 ? (
            <div className="km-resources__week-col">
              <Eyebrow className="km-resources__week-coltitle">Vocabulary</Eyebrow>
              <ul className="km-resources__suggest-list">
                {vocab?.map((entry) => {
                  const key = `v:${String(entry.id)}`;
                  return (
                    <SuggestRow
                      key={key}
                      kr={entry.korean ?? ''}
                      en={entry.english ?? ''}
                      level={entry.proficiency ?? '—'}
                      state={adds[key] ?? 'idle'}
                      onAdd={() => {
                        void bankVocab(entry);
                      }}
                    />
                  );
                })}
              </ul>
            </div>
          ) : null}
          {(grammar?.length ?? 0) > 0 ? (
            <div className="km-resources__week-col">
              <Eyebrow className="km-resources__week-coltitle">Grammar</Eyebrow>
              <ul className="km-resources__suggest-list">
                {grammar?.map((pattern) => {
                  const key = `g:${grammarKey(pattern)}`;
                  return (
                    <SuggestRow
                      key={key}
                      kr={pattern.pattern}
                      en={pattern.title_en ?? pattern.pattern}
                      level={pattern.proficiency ?? '—'}
                      state={adds[key] ?? 'idle'}
                      onAdd={() => {
                        void bankGrammar(pattern);
                      }}
                    />
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

interface SuggestRowProps {
  kr: string;
  en: string;
  level: string;
  state: AddState;
  onAdd: () => void;
}

function SuggestRow({ kr, en, level, state, onAdd }: SuggestRowProps): JSX.Element {
  const added = state === 'added';
  const adding = state === 'adding';
  const label = added
    ? '✓ Added'
    : adding
      ? 'Adding…'
      : state === 'error'
        ? 'Retry'
        : 'Add';
  return (
    <li className="km-resources__suggest-row">
      <span className="kr km-resources__suggest-kr">{kr}</span>
      <span className="km-resources__suggest-en">{en}</span>
      <span className="km-pill km-pill--default km-resources__suggest-level">
        {level}
      </span>
      <Button
        variant={added ? 'ghost' : 'gold'}
        size="sm"
        onClick={onAdd}
        disabled={added || adding}
        aria-pressed={added}
        aria-label={added ? `${kr} added` : `Add ${kr}`}
      >
        {label}
      </Button>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────
// Vocabulary tab — curated corpus, searchable + paginated
// ─────────────────────────────────────────────────────────────

/** Shared debounced search-input hook for the browse tabs. */
function useDebouncedSearch(): {
  input: string;
  q: string;
  setInput: (v: string) => void;
  clear: () => void;
} {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => {
      setQ(input);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [input]);
  const clear = useCallback(() => {
    setInput('');
  }, []);
  return { input, q, setInput, clear };
}

interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  placeholder: string;
  ariaLabel: string;
}

function SearchBox({
  value,
  onChange,
  onClear,
  placeholder,
  ariaLabel,
}: SearchBoxProps): JSX.Element {
  return (
    <Card className="km-reference__search">
      <Icon name="search" size={18} />
      <input
        type="search"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        className="kr focusring km-reference__input"
        aria-label={ariaLabel}
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          className="km-btn km-btn--ghost km-btn--sm focusring"
          aria-label="Clear search"
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </Card>
  );
}

/** A minimal pager — Prev / Next over a known `total`. */
function Pager({
  offset,
  pageSize,
  total,
  onPrev,
  onNext,
}: {
  offset: number;
  pageSize: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}): JSX.Element {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);
  const hasPrev = offset > 0;
  const hasNext = offset + pageSize < total;
  return (
    <div className="km-resources__pager">
      <Button variant="ghost" size="sm" onClick={onPrev} disabled={!hasPrev}>
        Prev
      </Button>
      <span className="km-resources__pager-count">
        {String(from)}–{String(to)} of {String(total)}
      </span>
      <Button variant="ghost" size="sm" onClick={onNext} disabled={!hasNext}>
        Next
      </Button>
    </div>
  );
}

/**
 * Browse-tab filter vocabularies (F-003/F-005). `'all'` omits the query param
 * so the endpoint returns every row — mirrors the Grammar screen's level
 * filter convention (pages/Grammar.tsx LEVEL_FILTERS).
 */
type DomainFilter = ContentDomain | 'all';
type LevelFilter = BookLevel | 'all';

const DOMAIN_FILTERS: ReadonlyArray<{ id: DomainFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'general', label: 'General' },
  { id: 'research', label: 'Research' },
  { id: 'business', label: 'Business' },
];

/** The curated vocab corpora carry only beginner/intermediate bands. */
const VOCAB_LEVEL_FILTERS: ReadonlyArray<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
];

/** KGIU spans all three bands. */
const GRAMMAR_LEVEL_FILTERS: ReadonlyArray<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
];

interface FilterGroupProps<T extends string> {
  ariaLabel: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}

/** One row of mutually-exclusive filter chips — same visual + a11y shape as
 *  the Grammar screen's level filter (`role="group"` + `aria-pressed`). */
function FilterGroup<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: FilterGroupProps<T>): JSX.Element {
  return (
    <div className="km-review__tabs" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={selected}
            className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
            onClick={() => {
              onChange(opt.id);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function VocabularyTab(): JSX.Element {
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
        setError(
          errorMessageFor(err, 'Could not load vocabulary.'),
        );
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
          Loading vocabulary…
        </div>
      ) : error ? (
        // Render the error whenever the LAST fetch failed — even when stale
        // rows from a previous page/filter are still in state. Gating this on
        // `rows.length === 0` silently swallowed pagination/filter failures:
        // the old rows kept rendering under the NEW pager range (offset had
        // already advanced), with no error and no retry surface. Mirrors
        // DictionaryTab, which always renders its error branch.
        <ErrorCard message={error} onRetry={refetch} />
      ) : rows.length === 0 ? (
        <p className="km-reference__empty">
          No words match. Try a dictionary form.
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
                      List
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
// Dictionary tab — full KRDICT, search-first
// ─────────────────────────────────────────────────────────────

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

function DictionaryTab(): JSX.Element {
  const { input, q, setInput, clear } = useDebouncedSearch();
  const [offset, setOffset] = useState(0);
  const [initial, setInitial] = useState<string | null>(null);
  const [rows, setRows] = useState<KrdictSearchEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // `q` empty → browse the whole dictionary (page 1 on mount, no search needed);
  // typing switches to search; clearing returns to browse.
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
          {browsing ? 'Loading dictionary…' : 'Searching…'}
        </div>
      ) : error ? (
        <ErrorCard message={error} />
      ) : rows.length === 0 ? (
        <p className="km-reference__empty">No dictionary entries found.</p>
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
  );
}

// ─────────────────────────────────────────────────────────────
// Grammar tab — every KGIU pattern
// ─────────────────────────────────────────────────────────────

function GrammarTab(): JSX.Element {
  const { input, q, setInput, clear } = useDebouncedSearch();
  const [rows, setRows] = useState<KgiuEntrySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // F-005 filters: genre (content_domain) + difficulty (book_level).
  const [domain, setDomain] = useState<DomainFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  // F-004 detail Sheet: the tapped row paints the header immediately while the
  // full `GET /grammar/kgiu/:id` detail resolves underneath (same shape as the
  // Grammar screen's DetailSheet — see pages/Grammar.tsx `openDetail`).
  const [openRow, setOpenRow] = useState<KgiuEntrySummary | null>(null);
  const [detail, setDetail] = useState<KgiuEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  // Id of the row whose detail fetch is authoritative — a slow settle for a
  // previously tapped row must not paint over the currently open one.
  const detailIdRef = useRef<number | null>(null);

  const load = useCallback(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    grammarService
      .listPatterns(
        {
          ...(q ? { q } : {}),
          ...(domain !== 'all' ? { domain } : {}),
          ...(level !== 'all' ? { book_level: level } : {}),
          limit: GRAMMAR_PAGE_SIZE,
        },
        ctrl.signal,
      )
      .then((entries) => {
        if (ctrl.signal.aborted) return;
        // Defensive: skip blank-pattern rows (post-F1 the server already
        // excludes them; a blank row would render an empty Korean cell).
        setRows(entries.filter(hasPattern));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load grammar.'),
        );
        setLoading(false);
      });
  }, [q, domain, level]);

  useEffect(() => {
    // Fetch on mount / query change. The set-state-in-effect rule only flags a
    // DIRECT setState in an effect body; `load()` is a function call (its
    // setState runs inside the async fetch), so no disable directive is needed.
    load();
    return () => {
      ctrlRef.current?.abort();
    };
  }, [load]);

  // F-004: open the detail Sheet for a tapped pattern. Mirrors the Grammar
  // screen's `openDetail` (real KGIU id → `getPattern`); the header renders
  // from the row while the detail loads, and a failure surfaces an inline
  // ErrorCard with Retry rather than closing the Sheet.
  const openDetail = useCallback(async (row: KgiuEntrySummary): Promise<void> => {
    detailIdRef.current = row.id;
    setOpenRow(row);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const d = await grammarService.getPattern(row.id);
      if (detailIdRef.current !== row.id) return; // superseded by a newer tap
      setDetail(d);
    } catch (err) {
      if (detailIdRef.current !== row.id) return;
      setDetailError(
        errorMessageFor(err, 'Detail unavailable'),
      );
    } finally {
      if (detailIdRef.current === row.id) setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback((): void => {
    detailIdRef.current = null;
    setOpenRow(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  return (
    <div className="km-resources__panel">
      <SearchBox
        value={input}
        onChange={setInput}
        onClear={clear}
        placeholder="Search all grammar patterns"
        ariaLabel="Search grammar"
      />
      <FilterGroup
        ariaLabel="Filter grammar by topic"
        options={DOMAIN_FILTERS}
        value={domain}
        onChange={setDomain}
      />
      <FilterGroup
        ariaLabel="Filter grammar by level"
        options={GRAMMAR_LEVEL_FILTERS}
        value={level}
        onChange={setLevel}
      />
      {/* Hidden while the last fetch errored — the count would otherwise
          describe the STALE row set under the new filter/search. */}
      {error === null ? (
        <div className="km-reference__count">
          {rows.length} pattern{rows.length === 1 ? '' : 's'}
        </div>
      ) : null}
      {loading && rows.length === 0 ? (
        <div className="km-grammar__state" role="status">
          Loading patterns…
        </div>
      ) : error ? (
        // Always surface a failed fetch — a filter/search change that errors
        // must not leave the previous rows rendering as if they matched the
        // new filter (the row-count caption would describe the stale set).
        // Mirrors DictionaryTab's unconditional error branch.
        <ErrorCard message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <p className="km-reference__empty">No patterns match.</p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul>
            {rows.map((p) => (
              <li key={`grammar:${String(p.id)}`} className="km-reference__row">
                <button
                  type="button"
                  className="km-resources__list-open focusring"
                  onClick={() => {
                    void openDetail(p);
                  }}
                  aria-label={`${p.pattern} ${p.title_en ?? p.pattern}`}
                >
                  <span className="kr km-reference__row-kr">{p.pattern}</span>
                  <span className="km-reference__row-en">
                    {p.title_en ?? p.pattern}
                  </span>
                  <span className="km-pill km-pill--default km-reference__row-level">
                    {p.proficiency ?? '—'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <GrammarDetailSheet
        row={openRow}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onRetry={() => {
          if (openRow) void openDetail(openRow);
        }}
        onClose={closeDetail}
      />
    </div>
  );
}

interface GrammarDetailSheetProps {
  /** The tapped list row (paints the header instantly); null = closed. */
  row: KgiuEntrySummary | null;
  detail: KgiuEntryDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Pattern-detail Sheet for the Grammar tab (F-004) — the same detail surface
 * the Grammar screen's DetailSheet renders (shared `KgiuDetailBody`:
 * explanation, formation rules, examples, dialogues, unit from
 * `GET /grammar/kgiu/:id` — F-018), minus the bank action that screen owns.
 * All strings render through React text children — a hostile corpus row
 * cannot escape into the DOM.
 */
function GrammarDetailSheet({
  row,
  detail,
  loading,
  error,
  onRetry,
  onClose,
}: GrammarDetailSheetProps): JSX.Element {
  return (
    <Sheet open={row !== null} onClose={onClose} ariaLabel="Grammar pattern detail">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>Pattern</Eyebrow>
            <div className="kr-display km-review__sheetTitle">
              {row?.pattern ?? ''}
            </div>
            <div className="km-review__sheetMeta">
              {row?.title_en ?? row?.pattern ?? ''}
              {row?.proficiency ? ` · ${row.proficiency}` : ''}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close pattern detail"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-grammar__state" role="status">
            Loading detail…
          </div>
        ) : null}
        {error ? <ErrorCard message={error} onRetry={onRetry} /> : null}
        {detail && !loading ? <KgiuDetailBody detail={detail} /> : null}
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────
// My Lists tab — create / browse / open / remove
// ─────────────────────────────────────────────────────────────

function ListsTab(): JSX.Element {
  const [lists, setLists] = useState<ServerVocabList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [openList, setOpenList] = useState<ServerVocabList | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    vocabService
      .listLists()
      .then((rows) => {
        setLists(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(
          errorMessageFor(err, 'Could not load lists.'),
        );
        setLoading(false);
      });
  }, []);

  useEffect(() => {
     
    load();
  }, [load]);

  const create = useCallback(async (): Promise<void> => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await vocabService.createList({ name_kr: name, kind: 'vocab' });
      setNewName('');
      load();
    } catch (err) {
      setCreateError(
        errorMessageFor(err, 'Could not create the list.'),
      );
    } finally {
      setCreating(false);
    }
  }, [newName, creating, load]);

  const remove = useCallback(
    async (list: ServerVocabList): Promise<void> => {
      const ok =
        typeof window !== 'undefined'
          ? window.confirm(`Delete "${list.name_kr}"? This cannot be undone.`)
          : true;
      if (!ok) return;
      try {
        await vocabService.deleteList(list.id);
        load();
      } catch (err) {
        setError(
          errorMessageFor(err, 'Could not delete the list.'),
        );
      }
    },
    [load],
  );

  return (
    <div className="km-resources__panel">
      <Card className="km-resources__create" variant="flat">
        <Eyebrow>New list</Eyebrow>
        <div className="km-resources__create-row">
          <input
            type="text"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
            }}
            placeholder="List name (Korean)"
            className="kr focusring km-resources__create-input"
            aria-label="New list name"
            maxLength={120}
          />
          <Button
            variant="gold"
            size="sm"
            onClick={() => {
              void create();
            }}
            disabled={newName.trim().length === 0 || creating}
          >
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </div>
        {createError ? <ErrorCard message={createError} /> : null}
      </Card>

      {loading ? (
        <div className="km-grammar__state" role="status">
          Loading your lists…
        </div>
      ) : error && lists.length === 0 ? (
        <ErrorCard message={error} onRetry={load} />
      ) : lists.length === 0 ? (
        <p className="km-reference__empty">
          No lists yet. Create one above, then add words from the Vocabulary
          tab.
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul>
            {lists.map((list) => (
              <li key={`list:${String(list.id)}`} className="km-reference__row">
                <div className="km-resources__list-row">
                  <button
                    type="button"
                    className="km-resources__list-open focusring"
                    onClick={() => {
                      setOpenList(list);
                    }}
                    aria-label={`Open ${list.name_kr}`}
                  >
                    <span className="kr km-reference__row-kr">
                      {list.name_kr}
                    </span>
                    {list.name_en ? (
                      <span className="km-reference__row-en">
                        {list.name_en}
                      </span>
                    ) : null}
                    <span className="km-pill km-pill--default">
                      {list.entry_count} {list.entry_count === 1 ? 'word' : 'words'}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void remove(list);
                    }}
                    aria-label={`Delete ${list.name_kr}`}
                  >
                    <Icon name="close" size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ListDetailSheet
        list={openList}
        onClose={() => {
          setOpenList(null);
        }}
        onChanged={load}
      />
    </div>
  );
}

interface ListDetailSheetProps {
  list: ServerVocabList | null;
  onClose: () => void;
  /** Fired after a membership mutation so the parent refreshes entry_count. */
  onChanged: () => void;
}

function ListDetailSheet({
  list,
  onClose,
  onChanged,
}: ListDetailSheetProps): JSX.Element {
  const [entries, setEntries] = useState<VocabListEntryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const listId = list?.id ?? null;

  const load = useCallback(() => {
    if (listId === null) return;
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    vocabService
      .getListDetail(listId, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setEntries(res.entries);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load the list.'),
        );
        setLoading(false);
      });
  }, [listId]);

  useEffect(() => {
     
    if (listId === null) {
      setEntries([]);
      setError(null);
      return;
    }
    load();
     
    return () => {
      ctrlRef.current?.abort();
    };
  }, [listId, load]);

  const removeEntry = useCallback(
    async (entryId: number): Promise<void> => {
      if (listId === null) return;
      setRemovingId(entryId);
      // Optimistic removal — drop the row immediately; restore on failure.
      const prev = entries;
      setEntries((cur) => cur.filter((e) => e.entry_id !== entryId));
      try {
        await vocabService.removeListEntry(listId, entryId);
        onChanged();
      } catch (err) {
        setEntries(prev);
        setError(
          errorMessageFor(err, 'Could not remove the word.'),
        );
      } finally {
        setRemovingId(null);
      }
    },
    [listId, entries, onChanged],
  );

  return (
    <Sheet open={list !== null} onClose={onClose} ariaLabel="List detail">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>List</Eyebrow>
            <div className="kr-display km-review__sheetTitle">
              {list?.name_kr ?? ''}
            </div>
            <div className="km-review__sheetMeta">
              {list?.name_en ? `${list.name_en} · ` : ''}
              {list?.entry_count ?? 0}{' '}
              {(list?.entry_count ?? 0) === 1 ? 'word' : 'words'}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close list detail"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-grammar__state" role="status">
            Loading words…
          </div>
        ) : null}
        {error ? <ErrorCard message={error} onRetry={load} /> : null}
        {!loading && entries.length === 0 && !error ? (
          <p className="km-reference__empty">
            No words in this list yet. Add some from the Vocabulary tab.
          </p>
        ) : null}
        {entries.length > 0 ? (
          <ul className="km-resources__list-entries">
            {entries.map((e) => (
              <li
                key={`entry:${String(e.entry_id)}`}
                className="km-resources__list-entry"
              >
                <span className="kr km-reference__row-kr">{e.korean ?? ''}</span>
                <span className="km-reference__row-en">{e.english ?? ''}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void removeEntry(e.entry_id);
                  }}
                  disabled={removingId === e.entry_id}
                  aria-label={`Remove ${e.korean ?? 'word'} from the list`}
                >
                  <Icon name="close" size={12} />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
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
        setError(
          errorMessageFor(err, 'Could not load your lists.'),
        );
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
        setError(
          errorMessageFor(err, 'Could not add the word.'),
        );
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
            <Eyebrow>Add to list</Eyebrow>
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
            Loading your lists…
          </div>
        ) : null}
        {error ? <ErrorCard message={error} /> : null}
        {!loading && lists.length === 0 && !error ? (
          <p className="km-reference__empty">
            No lists yet — create one in the My Lists tab first.
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
                  {pendingId === list.id ? 'Adding…' : list.name_kr}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}
