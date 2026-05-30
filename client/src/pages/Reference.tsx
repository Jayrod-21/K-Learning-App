/**
 * Reference screen — searchable cross-corpus index.
 *
 * Pass-3 wiring:
 *   - Live search debounced 200 ms; previous in-flight aborts on every
 *     keystroke past the debounce window.
 *   - Filter chips: All / Vocab / Grammar / Hanja. Vocab + Grammar hit
 *     real endpoints; Hanja stays on the mock fixture until Pass 7.
 *   - Tap row → vocab opens `WordPopover` with `defineEntry(lemma)` data;
 *     grammar opens the same popover with the row's pattern + title.
 *
 * Data:
 *   useEndpointOrMock('ref:vocab:<q>',   mocks.vocab,
 *     { realFn: () => services.vocab.searchEntries({ q }) })
 *   useEndpointOrMock('ref:grammar:<q>', mocks.grammar,
 *     { realFn: () => services.grammar.listPatterns({ q }) })
 *   useEndpointOrMock('ref:hanja',       mocks.hanja)   // mock until Pass 7
 *   services.define.defineEntry(lemma) on vocab-row tap
 *
 * Threat model:
 *   - The search input is fully user-controlled. We DO NOT sanitise on the
 *     client — React's text rendering escapes the value in the visible
 *     count + row strings, and the server validates the `q` parameter per
 *     Zod schema. The relevant defence here is **rate**, not content:
 *       - 200 ms debounce caps the request frequency below typing speed.
 *       - The keyed `useEndpointOrMock` aborts the previous in-flight
 *         call on every keystroke past the debounce window, so a slow
 *         response never paints over a newer one (race-free UI).
 *   - Row strings come from server JSON. They render via React text
 *     children — no innerHTML, no markdown parsing — so a hostile entry
 *     can't escape into the DOM. The Pass-3 wire layer must keep `kr` /
 *     `en` as text fields.
 *   - WordPopover's `defineEntry(lemma)` call sends the row's `kr` value
 *     verbatim. That value originated server-side; we trust the Zod
 *     boundary. We do NOT pass the live user input into `defineEntry` —
 *     the lemma is always a row the server returned.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Card } from '../components/Card';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { Topbar } from '../components/Topbar';
import { ErrorCard } from '../components/ErrorCard';
import {
  WordPopover,
  type WordPopoverData,
} from '../components/WordPopover';
import { loadReferenceMock } from '../data/mocks/reference';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import * as vocabService from '../services/vocab';
import * as grammarService from '../services/grammar';
import { defineEntry } from '../services/define';
import { ApiError } from '../services/api';
import type {
  KgiuEntrySummary,
  ReferenceEntry,
  ReferenceKind,
  VocabEntry,
} from '../types/domain';

type FilterKind = 'all' | ReferenceKind;

const FILTERS: ReadonlyArray<{ id: FilterKind; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'vocab', label: 'Vocab' },
  { id: 'grammar', label: 'Grammar' },
  { id: 'hanja', label: 'Hanja' },
];

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Normalised row shape both vocab + grammar + hanja paths flatten into.
 * The discriminator drives the popover branch on tap.
 */
interface RefRow {
  kind: ReferenceKind;
  kr: string;
  en: string;
  level: string;
  /** Stable key for React + dedup. */
  key: string;
}

/** Adapt a real vocab entry into the unified row shape. */
function fromVocab(entry: VocabEntry): RefRow {
  return {
    kind: 'vocab',
    kr: entry.korean ?? '',
    en: entry.english ?? '',
    level: entry.proficiency ?? '—',
    key: `vocab:${String(entry.id)}`,
  };
}

/** Adapt a real grammar summary into the unified row shape. */
function fromGrammar(entry: KgiuEntrySummary): RefRow {
  return {
    kind: 'grammar',
    kr: entry.pattern,
    en: entry.title_en ?? entry.pattern,
    level: entry.proficiency ?? '—',
    key: `grammar:${String(entry.id)}`,
  };
}

/** Adapt a mock fixture row into the unified row shape. */
function fromMock(entry: ReferenceEntry, index: number): RefRow {
  return {
    kind: entry.kind,
    kr: entry.kr,
    en: entry.en,
    level: entry.level,
    key: `mock:${entry.kind}:${entry.kr}:${String(index)}`,
  };
}

/** Loader factory — searches the mock fixture for the vocab kind. */
async function loadMockVocab(): Promise<RefRow[]> {
  const rows = await loadReferenceMock();
  return rows
    .filter((r) => r.kind === 'vocab')
    .map((r, i) => fromMock(r, i));
}

/** Loader factory — searches the mock fixture for the grammar kind. */
async function loadMockGrammar(): Promise<RefRow[]> {
  const rows = await loadReferenceMock();
  return rows
    .filter((r) => r.kind === 'grammar')
    .map((r, i) => fromMock(r, i));
}

/** Loader factory — searches the mock fixture for the hanja kind. */
async function loadMockHanja(): Promise<RefRow[]> {
  const rows = await loadReferenceMock();
  return rows
    .filter((r) => r.kind === 'hanja')
    .map((r, i) => fromMock(r, i));
}

export default function Reference(): JSX.Element {
  // Two state vars — `qInput` mirrors the live <input> so typing is
  // instant; `q` is the debounced value that actually keys the fetches.
  const [qInput, setQInput] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [filter, setFilter] = useState<FilterKind>('all');
  const [popData, setPopData] = useState<WordPopoverData | null>(null);
  const [defineError, setDefineError] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      setQ(qInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [qInput]);

  // Real loaders capture `q` at call time so each keyed effect run hits
  // the server with the value the key encodes. Stable references would
  // demand a ref ping-pong; an inline closure per key tick is simpler
  // and avoids stale-closure bugs entirely.
  const vocabState = useEndpointOrMock<RefRow[]>(
    `ref:vocab:${q}`,
    loadMockVocab,
    {
      realFn: async () => {
        const rows = await vocabService.searchEntries(
          q ? { q } : {},
        );
        return rows.map(fromVocab);
      },
    },
  );

  const grammarState = useEndpointOrMock<RefRow[]>(
    `ref:grammar:${q}`,
    loadMockGrammar,
    {
      realFn: async () => {
        const rows = await grammarService.listPatterns(
          q ? { q } : {},
        );
        return rows.map(fromGrammar);
      },
    },
  );

  // Hanja stays on the mock until Pass 7. No realFn → hook stays on
  // the fixture loader; isMock = true keeps the badge honest.
  const hanjaState = useEndpointOrMock<RefRow[]>('ref:hanja', loadMockHanja);

  // Which fetches power the active filter — drives loading / error
  // derivation below without re-running the union memo. The states have
  // new identity every render but the array is cheap to recreate; we
  // skip useMemo to avoid pretending it's stable when it isn't.
  const activeStates =
    filter === 'vocab'
      ? [vocabState]
      : filter === 'grammar'
        ? [grammarState]
        : filter === 'hanja'
          ? [hanjaState]
          : [vocabState, grammarState, hanjaState];

  const loading = activeStates.some((s) => s.loading);
  // Show an inline error only when EVERY active source failed AND none
  // produced data. A single-source failure under the All filter still
  // renders the other two — the user gets partial results, not a wipe.
  const allErrored =
    activeStates.length > 0 &&
    activeStates.every((s) => s.error !== null && (s.data?.length ?? 0) === 0);
  // MockBadge gating (Pass 3 tightening): badge fires only when every
  // realFn-backed source has fallen back to mock. Hanja is mock-only
  // (no realFn — see line ~193); its constant `isMock: true` is excluded
  // from the AND so it doesn't pin the badge permanently on the 'all'
  // filter. See MockBadge.tsx JSDoc for the cross-screen rule. The
  // previous `.some()` formulation fired the badge unconditionally on
  // 'all' because hanjaState.isMock is always true.
  const isMock =
    filter === 'hanja'
      ? hanjaState.isMock
      : filter === 'vocab'
        ? vocabState.isMock
        : filter === 'grammar'
          ? grammarState.isMock
          : vocabState.isMock && grammarState.isMock;

  // Union the per-source rows according to the active filter.
  const results = useMemo<readonly RefRow[]>(() => {
    if (filter === 'vocab') return vocabState.data ?? [];
    if (filter === 'grammar') return grammarState.data ?? [];
    if (filter === 'hanja') return hanjaState.data ?? [];
    return [
      ...(vocabState.data ?? []),
      ...(grammarState.data ?? []),
      ...(hanjaState.data ?? []),
    ];
  }, [filter, vocabState.data, grammarState.data, hanjaState.data]);

  const handleRow = async (r: RefRow): Promise<void> => {
    setDefineError(null);
    if (r.kind === 'grammar') {
      setPopData({
        kind: 'grammar',
        kr: r.kr,
        en: r.en,
        title: r.en,
        desc: `${r.level} grammar pattern`,
        ex_kr: r.kr,
        ex_en: r.en,
      });
      return;
    }
    if (r.kind === 'hanja') {
      setPopData({
        kr: r.kr,
        en: r.en,
        ex_kr: r.kr,
        ex_en: r.en,
        notes: `${r.level} hanja character.`,
      });
      return;
    }
    // Vocab — open the popover synchronously with the row's own data so
    // the user sees something instantly, then enrich with KRDICT once it
    // settles. A KRDICT failure leaves the basic popover up + surfaces a
    // small inline error.
    setPopData({
      kr: r.kr,
      en: r.en,
      pos: 'n.',
      ex_kr: r.kr,
      ex_en: r.en,
    });
    try {
      const def = await defineEntry(r.kr);
      // Augment with the first KRDICT entry's part-of-speech if present;
      // the deeper fields (senses/examples) are JSONB owned by B2 and
      // need their own shape contract before the popover renders them.
      const first = def.entries[0];
      if (first?.part_of_speech) {
        setPopData((cur) =>
          cur
            ? { ...cur, pos: first.part_of_speech ?? cur.pos }
            : cur,
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // No KRDICT entry — the row's gloss is the whole story. Not an
        // error from the user's perspective; stay quiet.
        return;
      }
      setDefineError(
        err instanceof ApiError ? err.message : 'Dictionary unavailable',
      );
    }
  };

  return (
    <section
      className="screen km-reference"
      style={{ position: 'relative' }}
      aria-labelledby="km-reference-title"
    >
      {isMock ? <MockBadge /> : null}
      <Topbar
        krTitle={
          <>
            참고 <span className="km-topbar__title-en">· Reference</span>
          </>
        }
        eyebrow="Lookup"
      />

      <Card className="km-reference__search">
        <Icon name="search" size={18} />
        <input
          type="search"
          value={qInput}
          onChange={(e) => {
            setQInput(e.target.value);
          }}
          placeholder="Search Korean or English"
          className="kr focusring km-reference__input"
          aria-label="Search reference"
        />
        {qInput ? (
          <button
            type="button"
            onClick={() => {
              setQInput('');
            }}
            className="km-btn km-btn--ghost km-btn--sm focusring"
            aria-label="Clear search"
          >
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </Card>

      <div className="km-reference__filters" role="toolbar" aria-label="Filter by kind">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) setFilter(f.id);
              }}
              className={
                'km-pill focusring km-reference__filter' +
                (active ? ' km-pill--gold' : ' km-pill--default')
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {loading && results.length === 0 ? (
        <Card className="km-reference__skeleton" aria-busy="true">
          <Eyebrow>Loading reference</Eyebrow>
          <div className="km-reference__skeleton-line" />
          <div className="km-reference__skeleton-line" />
        </Card>
      ) : allErrored ? (
        <ErrorCard
          message="The lookup couldn't be loaded."
          onRetry={() => {
            for (const s of activeStates) s.refetch();
          }}
        />
      ) : (
        <>
          <div className="km-reference__count">
            {results.length} result{results.length === 1 ? '' : 's'}
          </div>
          {defineError ? <ErrorCard message={defineError} /> : null}
          <Card className="km-reference__list" variant="flat">
            {results.length === 0 ? (
              <p className="km-reference__empty">
                No results. Try a dictionary form.
              </p>
            ) : (
              <ul>
                {results.map((r) => (
                  <li key={r.key} className="km-reference__row">
                    <button
                      type="button"
                      onClick={() => {
                        void handleRow(r);
                      }}
                      className="km-reference__row-btn focusring"
                      aria-label={`${r.kr} ${r.en}`}
                    >
                      <span className="kr km-reference__row-kr">{r.kr}</span>
                      <span className="km-reference__row-en">{r.en}</span>
                      <span className="km-pill km-pill--default km-reference__row-kind">
                        {r.kind}
                      </span>
                      <span
                        className={
                          'km-pill km-reference__row-level ' +
                          (r.level === 'L4'
                            ? 'km-pill--gold'
                            : 'km-pill--default')
                        }
                      >
                        {r.level}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {popData ? (
        <WordPopover
          data={popData}
          onClose={() => {
            setPopData(null);
            setDefineError(null);
          }}
        />
      ) : null}
    </section>
  );
}
