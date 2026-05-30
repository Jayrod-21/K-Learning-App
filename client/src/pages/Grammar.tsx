/**
 * Grammar screen — Pass-3 list/bank wiring on top of the Pass-2 drill UI.
 *
 * Three tabs:
 *   - `list`   — every KGIU pattern. Tap row to open detail Sheet; Bank
 *                button per row → `POST /grammar/bank` (idempotent server
 *                side). 🅂 badge OFF (real `listPatterns` + `listBanked`).
 *   - `banked` — the subset the user has already banked. Same row shape.
 *   - `drill`  — the Pass-2 production drill UI. **Mocked until Pass 9**;
 *                MockBadge is shown while this tab is active so the dev
 *                signal is honest.
 *
 * Data:
 *   useEndpointOrMock('grammar:list', loadGrammarMock(adapted),
 *     { realFn: () => services.grammar.listPatterns() })   → PatternListItem[]
 *   useEndpointOrMock('grammar:bank', () => Promise.resolve([]),
 *     { realFn: services.grammar.listBanked })             → Set<pattern_key>
 *   services.grammar.getPattern(id)                         → detail Sheet
 *   services.grammar.bankPattern(body)                      → optimistic add
 *
 * Threat model:
 *   - **bankPattern** is the only state-mutating call. Server is idempotent
 *     on `(user_id, pattern_key)` (see grammar.ts:51 + grammar.test.ts:67)
 *     — a double-tap or a stale optimistic add re-issuing the same body
 *     returns 200 not 409 (well, the test in services-land does surface
 *     409 if the route ever changes; we treat 409 as success here too,
 *     since the post-condition holds either way). CSRF defended by the
 *     cookie's `SameSite=Strict`. We do NOT echo any server message text;
 *     row strings come from our own KGIU rows.
 *   - **getPattern** is a GET — no CSRF surface. A failed detail load
 *     leaves the row tappable and surfaces an inline ErrorCard inside
 *     the Sheet; the rest of the list keeps working.
 *   - Pattern display + title strings render through React text children,
 *     so injection from a compromised KGIU corpus row cannot escape into
 *     HTML. innerHTML and dangerouslySetInnerHTML are never touched.
 *   - The Pass-9 `POST /grammar-drill` endpoint will need a body-size
 *     guard server-side; the Pass-2 `maxLength={500}` on the textarea
 *     stops a runaway paste, but the server is the source of truth.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
} from 'react';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Pill } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { GoldRule } from '../components/GoldRule';
import { MockBadge } from '../components/MockBadge';
import { Sheet } from '../components/Sheet';
import { ErrorCard } from '../components/ErrorCard';
import {
  useEndpointOrMock,
  type UseEndpointOrMockResult,
} from '../hooks/useEndpointOrMock';
import { loadGrammarMock } from '../data/mocks/grammar';
import * as grammarService from '../services/grammar';
import { ApiError } from '../services/api';
import type {
  BankGrammarBody,
  GrammarPattern,
  KgiuEntryDetail,
  KgiuEntrySummary,
  ServerProficiency,
} from '../types/domain';

const TUTOR_NOTE =
  'Your production reads natural. Check tense agreement and register; the model preserves the formal -습니다 ending.';

type Tab = 'list' | 'banked' | 'drill';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'list', label: 'List' },
  { id: 'banked', label: 'Banked' },
  { id: 'drill', label: 'Drill' },
];

/**
 * Normalised row shape the list + banked tabs render. Both the real KGIU
 * summary and the mock GrammarPattern fixture flatten into this — the UI
 * stays single-shape, the per-source quirks live in the adapters below.
 */
interface PatternListItem {
  /** Stable id for keys + detail fetch. Real rows use the BIGINT KGIU id;
   *  mock rows synthesise a negative integer so the two namespaces never
   *  collide and the optimistic bank set stays consistent. */
  id: number;
  /** Server-side dedup key for `POST /grammar/bank`. */
  patternKey: string;
  /** Korean pattern display ("-더라도"). */
  pattern: string;
  /** English summary / title ("even if"). */
  title: string;
  /** Proficiency tag rendered on the row pill. */
  proficiency: ServerProficiency;
  /** Category sent in the bank body. */
  category: string;
  /** True iff this row came from the real `listPatterns` endpoint. Drives
   *  the bank-body discriminator AND lets the detail Sheet know whether
   *  it can call `getPattern(id)` (real) or must render the mock detail. */
  isReal: boolean;
}

/**
 * Bucket KGIU `proficiency` strings into the server's closed set.
 *
 * The corpus uses values like `beginner`/`intermediate`/`advanced`; the
 * `POST /grammar/bank` body requires `'basic' | 'L3' | 'L4' | 'L5+'`.
 * Unknown strings fall back to `L3` so the call never 400s on a corpus
 * vocabulary drift — better to bank with a mild miscategorisation than
 * to refuse the user's gesture.
 */
function toServerProficiency(raw: string | null | undefined): ServerProficiency {
  if (!raw) return 'L3';
  const norm = raw.toLowerCase();
  if (norm === 'basic' || norm === 'beginner' || norm.startsWith('l1') || norm.startsWith('l2')) {
    return 'basic';
  }
  if (norm === 'l3' || norm.includes('intermediate-low') || norm === 'l3-4') return 'L3';
  if (norm === 'l4' || norm === 'intermediate' || norm.includes('intermediate')) return 'L4';
  if (norm === 'l5+' || norm === 'l5' || norm === 'l6' || norm === 'advanced') return 'L5+';
  return 'L3';
}

/** Adapt a real KGIU summary into the normalised row shape. */
function fromKgiu(row: KgiuEntrySummary): PatternListItem {
  return {
    id: row.id,
    // The KGIU loader populates `source_id` per row; fall back to the
    // display string so the body always has a stable dedup key.
    patternKey: row.source_id ?? row.pattern,
    pattern: row.pattern,
    title: row.title_en ?? row.pattern,
    proficiency: toServerProficiency(row.proficiency),
    category: row.category ?? 'pattern',
    isReal: true,
  };
}

/** Adapt a mock fixture row into the normalised row shape. */
function fromMockPattern(row: GrammarPattern, index: number): PatternListItem {
  // Negative ids keep mock + real namespaces disjoint — a Sheet opened
  // on a mock id can never accidentally call `getPattern(-1)` against
  // the real server.
  return {
    id: -(index + 1),
    patternKey: `mock:${row.id}`,
    pattern: row.pattern,
    title: row.title,
    // The design fixtures don't carry proficiency — L4 matches the level
    // chip the Reference screen already paints for these rows.
    proficiency: 'L4',
    category: 'pattern',
    isReal: false,
  };
}

/** Loader: mock fixture → PatternListItem[]. Memoised at module scope so
 *  the hook's stable-fn rule (per useEndpointOrMock JSDoc) holds. */
async function loadMockListItems(): Promise<PatternListItem[]> {
  const rows = await loadGrammarMock();
  return rows.map(fromMockPattern);
}

/** Loader: real /grammar/kgiu → PatternListItem[]. */
async function loadRealListItems(): Promise<PatternListItem[]> {
  const rows = await grammarService.listPatterns();
  return rows.map(fromKgiu);
}

/** Loader: mock banked set (empty until the user banks something). */
async function loadMockBankedKeys(): Promise<ReadonlySet<string>> {
  return new Set<string>();
}

/** Loader: real /grammar/bank → Set<pattern_key>. */
async function loadRealBankedKeys(): Promise<ReadonlySet<string>> {
  const res = await grammarService.listBanked();
  return new Set(res.entries.map((e) => e.pattern_key));
}

function Grammar(): JSX.Element {
  const [tab, setTab] = useState<Tab>('list');

  // Pattern list — real first, mock fallback. The hook's `isMock` flips
  // false on a real resolve; that's how the 🅂 badge stays off here.
  const listState = useEndpointOrMock<PatternListItem[]>(
    'grammar:list',
    loadMockListItems,
    { realFn: loadRealListItems },
  );

  // Banked set — separate fetch so a failure on one doesn't black out
  // the other. Set<patternKey> lets the row-level "Banked" pill check
  // run in O(1) without scanning an array per render.
  const bankedState = useEndpointOrMock<ReadonlySet<string>>(
    'grammar:bank',
    loadMockBankedKeys,
    { realFn: loadRealBankedKeys },
  );

  // Optimistic overlay — keyed by patternKey so it survives a refetch
  // that returns a stale snapshot. The prune effect below clears entries
  // that have been reconciled with the server's `bankedState.data` so
  // the set doesn't accumulate indefinitely across a long session.
  const [optimisticBanked, setOptimisticBanked] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // E-SF-1 fix: prune the optimistic overlay against the server's bank
  // settle. Any pattern_key now present in `bankedState.data` has been
  // reconciled — it can leave the overlay without changing the merged
  // `bankedKeys` view. We also bound the overlay at 50 entries as a
  // defensive cap: a healthy session keeps the overlay small (one entry
  // per in-flight bank request), and runaway growth would indicate a bug
  // elsewhere (e.g. the server's bank refetch returning a stale snapshot
  // that doesn't include the just-banked rows). The cap drops the OLDEST
  // overlay entries first (Set iteration order = insertion order), which
  // matches the "stale because the user banked it long ago" hypothesis.
  useEffect(() => {
    if (!bankedState.data) return;
    const settled = bankedState.data;
    setOptimisticBanked((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const k of prev) {
        if (!settled.has(k)) next.add(k);
      }
      if (next.size > 50) {
        // Drop the oldest entries — keep the most recent 50.
        const keep = Array.from(next).slice(-50);
        return new Set(keep);
      }
      // Preserve identity when no entries were pruned, so consumers of
      // `optimisticBanked` (the memo below) don't re-run on no-op settles.
      return next.size === prev.size ? prev : next;
    });
  }, [bankedState.data]);

  // Per-row bank submit-in-flight + last-error so the row UI can disable
  // its button and surface a localised error without blocking the list.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [bankError, setBankError] = useState<string | null>(null);

  // Detail Sheet state. We keep the row context alongside the fetch
  // result so the Sheet header can paint immediately while the detail
  // load resolves underneath.
  const [openRow, setOpenRow] = useState<PatternListItem | null>(null);
  const [detail, setDetail] = useState<KgiuEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const bankedKeys = useMemo<ReadonlySet<string>>(() => {
    const base = bankedState.data ?? new Set<string>();
    if (optimisticBanked.size === 0) return base;
    const merged = new Set<string>(base);
    for (const k of optimisticBanked) merged.add(k);
    return merged;
  }, [bankedState.data, optimisticBanked]);

  const openDetail = useCallback(
    async (row: PatternListItem): Promise<void> => {
      setOpenRow(row);
      setDetail(null);
      setDetailError(null);
      if (!row.isReal) return; // mock rows render from row data alone
      setDetailLoading(true);
      try {
        const d = await grammarService.getPattern(row.id);
        setDetail(d);
      } catch (err) {
        setDetailError(
          err instanceof ApiError ? err.message : 'Detail unavailable',
        );
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  const closeDetail = useCallback((): void => {
    setOpenRow(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  const bank = useCallback(
    async (row: PatternListItem): Promise<void> => {
      if (bankedKeys.has(row.patternKey)) return;
      setPendingKey(row.patternKey);
      setBankError(null);
      // Optimistic add — flip the chip immediately. If the call fails
      // non-idempotently we rewind below; a 409 conflict means it was
      // already banked, so the optimistic add stays.
      setOptimisticBanked((prev) => {
        const next = new Set(prev);
        next.add(row.patternKey);
        return next;
      });
      const body: BankGrammarBody = {
        pattern_key: row.patternKey,
        pattern_display: row.pattern,
        summary_en: row.title,
        proficiency: row.proficiency,
        category: row.category,
        discovered_via: 'manual',
      };
      try {
        await grammarService.bankPattern(body);
        // Re-fetch the banked set so the server view becomes the source
        // of truth on the next render.
        bankedState.refetch();
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : null;
        // 409 → already banked. Post-condition holds; keep the optimistic
        // add and refetch to pull the row the server already has.
        if (apiErr && apiErr.status === 409) {
          bankedState.refetch();
        } else {
          // Real failure — rewind the optimistic add and surface the
          // error so the user can retry. Don't echo server text.
          setOptimisticBanked((prev) => {
            const next = new Set(prev);
            next.delete(row.patternKey);
            return next;
          });
          setBankError("Couldn't bank that pattern. Try again.");
        }
      } finally {
        setPendingKey(null);
      }
    },
    [bankedKeys, bankedState],
  );

  // Stable array identity so the `bankedItems` memo doesn't re-run on
  // every render — `listState.data ?? []` would otherwise mint a fresh
  // [] each time and bust the memo.
  const items = useMemo<readonly PatternListItem[]>(
    () => listState.data ?? [],
    [listState.data],
  );
  const bankedItems = useMemo<readonly PatternListItem[]>(
    () => items.filter((it) => bankedKeys.has(it.patternKey)),
    [items, bankedKeys],
  );

  // 🅂 badge ONLY when the user is on the drill tab (always mocked) OR
  // both wired fetches fell back to the mock. Drill tab gets the badge
  // regardless because the drill itself never hits a real endpoint in
  // Pass 3 — only Pass 9 will flip it.
  const showMockBadge =
    tab === 'drill' || (listState.isMock && bankedState.isMock);

  return (
    <section
      className="screen km-grammar"
      aria-labelledby="grammar-title"
      style={{ position: 'relative' }}
    >
      {showMockBadge ? <MockBadge /> : null}
      <Topbar
        krTitle={<span id="grammar-title">문법 · Grammar</span>}
        eyebrow={
          tab === 'drill' ? 'Production drill · mock' : 'Patterns + bank'
        }
      />

      <div className="km-review__tabs" role="tablist" aria-label="Grammar section">
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

      {tab === 'list' ? (
        <ListPanel
          state={listState}
          items={items}
          bankedKeys={bankedKeys}
          pendingKey={pendingKey}
          bankError={bankError}
          onOpen={(row) => {
            void openDetail(row);
          }}
          onBank={(row) => {
            void bank(row);
          }}
        />
      ) : null}

      {tab === 'banked' ? (
        <BankedPanel
          loading={listState.loading || bankedState.loading}
          fetchErrored={
            (!listState.data && listState.error !== null) ||
            (!bankedState.data && bankedState.error !== null)
          }
          items={bankedItems}
          onOpen={(row) => {
            void openDetail(row);
          }}
          onRetry={() => {
            listState.refetch();
            bankedState.refetch();
          }}
        />
      ) : null}

      {tab === 'drill' ? (
        <DrillPanel
          loading={listState.loading}
          items={items}
        />
      ) : null}

      <DetailSheet
        open={openRow !== null}
        row={openRow}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        banked={openRow ? bankedKeys.has(openRow.patternKey) : false}
        pending={openRow ? pendingKey === openRow.patternKey : false}
        onBank={() => {
          if (openRow) void bank(openRow);
        }}
        onClose={closeDetail}
      />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// List panel
// ─────────────────────────────────────────────────────────────

interface ListPanelProps {
  state: UseEndpointOrMockResult<PatternListItem[]>;
  items: readonly PatternListItem[];
  bankedKeys: ReadonlySet<string>;
  pendingKey: string | null;
  bankError: string | null;
  onOpen: (row: PatternListItem) => void;
  onBank: (row: PatternListItem) => void;
}

function ListPanel({
  state,
  items,
  bankedKeys,
  pendingKey,
  bankError,
  onOpen,
  onBank,
}: ListPanelProps): JSX.Element {
  if (state.loading) {
    return (
      <div className="km-grammar__state" role="status">
        Loading patterns…
      </div>
    );
  }
  if (state.error && items.length === 0) {
    return (
      <ErrorCard
        message="The grammar patterns couldn't be loaded."
        onRetry={state.refetch}
      />
    );
  }
  if (items.length === 0) {
    return (
      <div className="km-grammar__state" role="status">
        No grammar patterns available.
      </div>
    );
  }
  return (
    <>
      {bankError ? (
        <ErrorCard message={bankError} />
      ) : null}
      <ul className="km-grammar__list">
        {items.map((row) => (
          <PatternRow
            key={row.patternKey}
            row={row}
            banked={bankedKeys.has(row.patternKey)}
            pending={pendingKey === row.patternKey}
            onOpen={() => {
              onOpen(row);
            }}
            onBank={() => {
              onBank(row);
            }}
          />
        ))}
      </ul>
    </>
  );
}

interface PatternRowProps {
  row: PatternListItem;
  banked: boolean;
  pending: boolean;
  onOpen: () => void;
  onBank: () => void;
}

function PatternRow({
  row,
  banked,
  pending,
  onOpen,
  onBank,
}: PatternRowProps): JSX.Element {
  return (
    <li className="km-grammar__row">
      <button
        type="button"
        onClick={onOpen}
        className="km-grammar__row-btn focusring"
        aria-label={`${row.pattern} ${row.title}`}
      >
        <span className="kr km-grammar__row-kr">{row.pattern}</span>
        <span className="km-grammar__row-title">{row.title}</span>
        <span className="km-pill km-pill--default km-grammar__row-level">
          {row.proficiency}
        </span>
      </button>
      <Button
        variant={banked ? 'ghost' : 'gold'}
        size="sm"
        onClick={onBank}
        disabled={banked || pending}
        aria-pressed={banked}
        aria-label={banked ? 'Already banked' : `Bank ${row.pattern}`}
      >
        {banked ? 'Banked' : pending ? 'Banking…' : 'Bank'}
      </Button>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────
// Banked panel
// ─────────────────────────────────────────────────────────────

interface BankedPanelProps {
  loading: boolean;
  fetchErrored: boolean;
  items: readonly PatternListItem[];
  onOpen: (row: PatternListItem) => void;
  onRetry: () => void;
}

function BankedPanel({
  loading,
  fetchErrored,
  items,
  onOpen,
  onRetry,
}: BankedPanelProps): JSX.Element {
  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        Loading banked patterns…
      </div>
    );
  }
  if (fetchErrored) {
    return (
      <ErrorCard
        message="The banked patterns couldn't be loaded."
        onRetry={onRetry}
      />
    );
  }
  if (items.length === 0) {
    return (
      <Card variant="flat" role="status">
        <Eyebrow>Nothing banked yet</Eyebrow>
        <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
          Tap Bank on any pattern in the List tab to add it here.
        </p>
      </Card>
    );
  }
  return (
    <ul className="km-grammar__list">
      {items.map((row) => (
        <li key={row.patternKey} className="km-grammar__row">
          <button
            type="button"
            onClick={() => {
              onOpen(row);
            }}
            className="km-grammar__row-btn focusring"
            aria-label={`${row.pattern} ${row.title}`}
          >
            <span className="kr km-grammar__row-kr">{row.pattern}</span>
            <span className="km-grammar__row-title">{row.title}</span>
            <span className="km-pill km-pill--default km-grammar__row-level">
              {row.proficiency}
            </span>
          </button>
          <Pill tone="gold">Banked</Pill>
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────
// Drill panel — Pass-2 mock-only production drill
// ─────────────────────────────────────────────────────────────

interface DrillPanelProps {
  loading: boolean;
  items: readonly PatternListItem[];
}

function DrillPanel({ loading, items }: DrillPanelProps): JSX.Element {
  const [idx, setIdx] = useState(0);
  const [userInput, setUserInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  // Pull the live mock fixture so we get the drill block per row. The
  // list-level adapter strips the drill payload by design (it isn't on
  // the wire shape); the drill panel calls the mock loader directly to
  // round-trip the seed/model/note. Held in state so the async settle
  // doesn't trigger a re-render storm during navigation.
  const [patterns, setPatterns] = useState<readonly GrammarPattern[] | null>(
    null,
  );

  // Kick off the mock load once per mount. The fixture is in-memory after
  // first call (no network), so this is effectively synchronous past the
  // initial mockDelay. Cleanup flag prevents an unmount-during-load setState.
  useEffect(() => {
    let alive = true;
    void loadGrammarMock().then((rows) => {
      if (alive) setPatterns(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (loading && !patterns) {
    return (
      <div className="km-grammar__state" role="status">
        Loading drill…
      </div>
    );
  }
  if (!patterns || patterns.length === 0) {
    // Fall back to row count if mock fixture failed but list loaded — the
    // drill UI needs a `drill` block that only the fixture carries, so we
    // show a friendly empty state rather than crash. `items` participates
    // in the count so a future real-data drill source doesn't break.
    return (
      <div className="km-grammar__state" role="status">
        {items.length === 0
          ? 'No drill patterns available.'
          : 'Drill data unavailable.'}
      </div>
    );
  }
  const pattern = patterns[idx % patterns.length];
  return (
    <DrillCard
      pattern={pattern}
      userInput={userInput}
      submitted={submitted}
      onInput={(v) => {
        setUserInput(v);
      }}
      onSubmit={() => {
        if (userInput.trim().length > 0) setSubmitted(true);
      }}
      onSkip={() => {
        setUserInput('');
        setSubmitted(false);
        setIdx((i) => i + 1);
      }}
      onNext={() => {
        setUserInput('');
        setSubmitted(false);
        setIdx((i) => i + 1);
      }}
    />
  );
}

interface DrillCardProps {
  pattern: GrammarPattern;
  userInput: string;
  submitted: boolean;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onNext: () => void;
}

function DrillCard({
  pattern,
  userInput,
  submitted,
  onInput,
  onSubmit,
  onSkip,
  onNext,
}: DrillCardProps): JSX.Element {
  const drill = pattern.drill;
  const revealId = `gr-reveal-${pattern.id}`;
  const inputId = `gr-input-${pattern.id}`;
  const canSubmit = userInput.trim().length > 0;

  return (
    <Card className="km-grammar__card">
      <div className="km-grammar__header">
        <div>
          <Eyebrow>Pattern</Eyebrow>
          <h2 className="kr km-grammar__pattern">{pattern.pattern}</h2>
          <p className="km-grammar__title">{pattern.title}</p>
        </div>
        <Pill tone="gold">Production</Pill>
      </div>

      <GoldRule className="km-grammar__rule" />

      <Eyebrow>Situation</Eyebrow>
      <p className="km-grammar__context kr">
        {drill?.context ?? pattern.desc}
      </p>

      {drill ? (
        <>
          <Eyebrow className="km-grammar__seed-eyebrow">
            Seed sentence — fill it in
          </Eyebrow>
          <div className="kr km-grammar__seed">{drill.seed}</div>
        </>
      ) : null}

      <p className="km-grammar__instruction">
        Use <span className="kr">{pattern.pattern}</span> to write a full
        Korean sentence for this situation.
      </p>

      <label htmlFor={inputId} className="km-sr-only">
        Your answer in Korean
      </label>
      <textarea
        id={inputId}
        className="kr km-grammar__textarea focusring"
        value={userInput}
        onChange={(e) => {
          onInput(e.target.value);
        }}
        placeholder={`Write the full sentence using ${pattern.pattern}…`}
        aria-describedby={submitted ? revealId : undefined}
        rows={3}
        disabled={submitted}
        // Soft cap — defensive; the server-side handler in Pass 9 will
        // enforce its own bound. Keeps a runaway paste from filling memory.
        maxLength={500}
      />

      {submitted && drill ? (
        <Card variant="flat" className="km-grammar__reveal" id={revealId}>
          <Eyebrow>Model answer</Eyebrow>
          <p className="kr km-grammar__model">{drill.model}</p>
          <p className="km-grammar__model-en">{drill.model_en}</p>
          <p className="km-grammar__tutor-note">
            <span className="km-grammar__tutor-label">Tutor · </span>
            {TUTOR_NOTE}
          </p>
        </Card>
      ) : null}

      <div className="km-grammar__footer">
        {!submitted ? (
          <>
            <Button variant="ghost" onClick={onSkip}>
              Skip
            </Button>
            <Button variant="gold" onClick={onSubmit} disabled={!canSubmit}>
              Submit
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onSkip}>
              Skip
            </Button>
            <Button
              variant="gold"
              onClick={onNext}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              Next pattern
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail Sheet
// ─────────────────────────────────────────────────────────────

interface DetailSheetProps {
  open: boolean;
  row: PatternListItem | null;
  detail: KgiuEntryDetail | null;
  loading: boolean;
  error: string | null;
  banked: boolean;
  pending: boolean;
  onBank: () => void;
  onClose: () => void;
}

function DetailSheet({
  open,
  row,
  detail,
  loading,
  error,
  banked,
  pending,
  onBank,
  onClose,
}: DetailSheetProps): JSX.Element {
  return (
    <Sheet open={open} onClose={onClose} ariaLabel="Grammar pattern detail">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>Pattern</Eyebrow>
            <div className="kr-display km-review__sheetTitle">
              {row?.pattern ?? ''}
            </div>
            <div className="km-review__sheetMeta">
              {row?.title ?? ''}
              {row ? ` · ${row.proficiency}` : ''}
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

        <div className="km-review__sheetActions">
          <Button
            variant={banked ? 'ghost' : 'gold'}
            size="md"
            onClick={onBank}
            disabled={banked || pending || row === null}
            aria-pressed={banked}
            leadingIcon={<Icon name="plus" size={14} />}
          >
            {banked ? 'Already banked' : pending ? 'Banking…' : 'Bank pattern'}
          </Button>
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-grammar__state" role="status">
            Loading detail…
          </div>
        ) : null}
        {error ? (
          <ErrorCard message={error} />
        ) : null}
        {detail && !loading ? (
          <>
            {detail.explanation ? (
              <>
                <Eyebrow>Explanation</Eyebrow>
                <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
                  {detail.explanation}
                </p>
              </>
            ) : null}
            <div className="km-eyebrow" style={{ marginTop: 16 }}>
              Unit · {detail.unit ?? '—'}
            </div>
          </>
        ) : null}
        {!loading && !detail && !error && row && !row.isReal ? (
          <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
            Mock pattern — detail loads when the real KGIU corpus is wired.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

export default Grammar;
