/**
 * Grammar screen — Pass-3 list/bank wiring on top of the Pass-2 drill UI.
 *
 * Three tabs:
 *   - `list`   — every KGIU pattern (the full corpus — `limit` is pinned to the
 *                endpoint's 400 ceiling, which covers all 285 listable rows),
 *                with a beginner/intermediate/advanced level filter that maps to
 *                the endpoint's `corpus` query param. Tap row to open detail
 *                Sheet; Bank button per row → `POST /grammar/bank` (idempotent
 *                server side). 🅂 badge OFF (real `listPatterns` + `listBanked`).
 *   - `banked` — the subset the user has already banked, split into an
 *                Active | Known segmented view. Active rows carry a
 *                **Graduate** action (`POST /grammar/bank/:id/graduate`) that
 *                marks the pattern as known — it leaves the drill pool and its
 *                production card stops surfacing in `/vocab/cards/due`. The
 *                Known view lists graduated patterns with a **Re-admit** action
 *                (`POST /grammar/bank/:id/readmit`) that returns the pattern to
 *                active learning (FSRS state untouched server-side).
 *   - `drill`  — the Pass-9 LIVE production drill. Per pattern, the panel
 *                generates a drill via `POST /grammar-drill` (Claude picks the
 *                type by history rotation), renders the per-type DrillCard, and
 *                scores the learner's answer via `POST /grammar-drill/:id/submit`
 *                (reveal: score + verdict + corrections + reference model). The
 *                drilled pattern comes from the user's BANKED patterns when any
 *                exist, else the full fetched KGIU pool; the rotation cursor is
 *                persisted (localStorage) so Skip/Next progress through patterns
 *                durably — a tab switch or reload no longer resets the drill to
 *                the first corpus row (the live "always N이다" bug). A failed
 *                generate/submit NEVER blanks the screen — it surfaces an
 *                inline `role="alert"` + Retry. In PROD a failed generate
 *                shows a retryable ErrorCard whose Retry RE-GENERATES (no
 *                fixture substitution — see the threat model note below); in
 *                dev/non-PROD the panel falls back to a local mock drill and
 *                shows the 🅂 MockBadge so the dev signal stays honest.
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
 *   - **graduatePattern / readmitPattern** mutate only a boolean-ish flag on
 *     a row the server verifies the user owns (404 otherwise); both are
 *     idempotent, id comes from the server's own bank list (never user text),
 *     and failures rewind the optimistic move with an inline error.
 *   - **bankPattern** is the other state-mutating call. Server is idempotent
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
 *   - **Fixture-as-real in PROD.** `MockBadge` renders null in production,
 *     so serving `MOCK_DRILLS` + local pseudo-scoring on a generate failure
 *     would present a fabricated drill and a fabricated score as REAL —
 *     the exact failure class `useEndpointOrMock` and MockMode gate. The
 *     DrillPanel generate fallback is therefore gated to non-PROD builds;
 *     in prod a generate failure surfaces a retryable error instead.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Pill, type PillTone } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { GoldRule } from '../components/GoldRule';
import { MockBadge } from '../components/MockBadge';
import { Sheet } from '../components/Sheet';
import { ErrorCard } from '../components/ErrorCard';
import { KgiuDetailBody } from '../components/KgiuDetailBody';
import {
  useEndpointOrMock,
  type UseEndpointOrMockResult,
} from '../hooks/useEndpointOrMock';
import { loadGrammarMock } from '../data/mocks/grammar';
import { grammarKey } from '../lib/grammarKey';
import * as grammarService from '../services/grammar';
import {
  generateDrill,
  submitDrill,
  type DrillScore,
} from '../services/grammarDrill';
import { ApiError } from '../services/api';
import type {
  BankGrammarBody,
  DrillItemPublic,
  DrillSchedule,
  GrammarPattern,
  KgiuEntryDetail,
  KgiuEntrySummary,
  RegisterLevel,
  ServerProficiency,
} from '../types/domain';
import { useLocation, useNavigate } from 'react-router-dom';

type Tab = 'list' | 'banked' | 'drill';

/**
 * Deep-link payload the Review screen hands to the Drill tab (FU-NF-42 B3).
 * When a grammar production card is activated in Review, it navigates to
 * `/grammar` with this object in `location.state.drillTarget`. The Drill tab
 * then opens focused on this pattern (generating a drill for it) instead of
 * cycling its default `pool[idx]` rotation. `patternKey` is the server dedup
 * key; `display` + `meaning` seed the generate body so the drill renders even
 * when the pattern isn't in the (possibly mock) list fetch.
 */
export interface DrillTarget {
  patternKey: string;
  display: string;
  meaning: string;
}

/** The shape we look for in `location.state` when the Drill tab is deep-linked. */
interface GrammarLocationState {
  drillTarget?: DrillTarget;
}

/** Narrow an opaque `location.state` to a `DrillTarget`, or null if absent/malformed. */
function readDrillTarget(state: unknown): DrillTarget | null {
  if (typeof state !== 'object' || state === null) return null;
  const candidate = (state as GrammarLocationState).drillTarget;
  if (
    candidate &&
    typeof candidate.patternKey === 'string' &&
    typeof candidate.display === 'string' &&
    typeof candidate.meaning === 'string'
  ) {
    return candidate;
  }
  return null;
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'list', label: 'List' },
  { id: 'banked', label: 'Banked' },
  { id: 'drill', label: 'Drill' },
];

/**
 * List-tab level filter. Maps 1:1 onto the `corpus` query param the server's
 * `GET /grammar/kgiu` already validates (`kgiu_beginner | kgiu_intermediate |
 * kgiu_advanced` — see KgiuSearchQuerySchema in server/src/routes/grammar.ts);
 * 'all' omits the param so the endpoint returns every corpus.
 */
type LevelFilter = 'all' | 'beginner' | 'intermediate' | 'advanced';

const LEVEL_FILTERS: ReadonlyArray<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
];

/** LevelFilter → the server's `corpus` enum value ('all' → no filter). */
const LEVEL_TO_CORPUS: Record<
  Exclude<LevelFilter, 'all'>,
  NonNullable<grammarService.ListPatternsOptions['corpus']>
> = {
  beginner: 'kgiu_beginner',
  intermediate: 'kgiu_intermediate',
  advanced: 'kgiu_advanced',
};

/**
 * One wide page for the whole (level-filtered) corpus — the endpoint's `limit`
 * ceiling. The default server `limit` is 20, which is why the List previously
 * showed only the first 20 of the 285 listable patterns; 400 covers the full
 * set (285 total: 108 beginner / 93 intermediate / 84 advanced) with headroom.
 * Mirrors GRAMMAR_PAGE_SIZE in Reference.tsx.
 */
const KGIU_LIST_LIMIT = 400;

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
  /** RAW corpus register string ("해요체", but often composite like
   *  "해요체 / 하십시오체"). Kept raw here; `buildBankBody` sanitizes it
   *  against the server's closed RegisterLevel set before any POST. */
  register: string | null;
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
    // `grammarKey` derives the GR-shaped dedup key the server's
    // BankBodySchema regex (`^GR-[a-z0-9_-]{1,64}$`) requires. The previous
    // raw fallback (`source_id ?? pattern`) produced keys like
    // "kgiu-beginner-002" — no GR- prefix — so EVERY bank from this screen
    // 400'd. It also matches the key Reference.tsx banks with, so the
    // "Banked" pill reconciles across both screens.
    patternKey: grammarKey(row),
    pattern: row.pattern,
    title: row.title_en ?? row.pattern,
    proficiency: toServerProficiency(row.proficiency),
    category: row.category ?? 'pattern',
    register: row.register ?? null,
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
    register: null,
    isReal: false,
  };
}

/**
 * The server's closed register vocabulary — mirrors `BankBodySchema` in
 * server/src/routes/grammar.ts. The KGIU corpus stores register as FREE TEXT,
 * frequently composite ("해요체 / 하십시오체", "formal/written", "literary"),
 * and the server hard-400s any value outside this set.
 */
const SERVER_REGISTER_LEVELS: ReadonlySet<string> = new Set<RegisterLevel>([
  '반말',
  '해요체',
  '합쇼체',
  '문어체',
  '하오체',
  '하게체',
]);

/** Sanitize a raw corpus register: exact member of the server set (after a
 *  trim) or nothing. Composite values are dropped, never guessed at —
 *  `register` is optional metadata and must not fail the whole bank. */
function toServerRegister(
  raw: string | null | undefined,
): RegisterLevel | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return SERVER_REGISTER_LEVELS.has(trimmed)
    ? (trimmed as RegisterLevel)
    : undefined;
}

/**
 * Build a schema-valid `POST /grammar/bank` body from a list row.
 *
 * The server's `BankBodySchema` is strict (min/max lengths, closed register
 * enum) and corpus data is messy — this is the single choke point where the
 * row is coerced into something the server will accept, so a data quirk can
 * never turn the user's Bank tap into a 400:
 *   - `register`  — included only when it exactly matches the server enum;
 *                   composite corpus values are OMITTED (field is optional).
 *   - `category`  — never empty (min 1): falls back to 'uncategorized';
 *                   clamped to the 40-char ceiling.
 *   - `summary_en`— never empty (min 1): falls back to the Korean pattern,
 *                   then the key; clamped to the 240-char ceiling.
 *   - `pattern_display` — clamped to 120; falls back to the key if blank.
 *   - `pattern_key` — NOT rewritten here; `grammarKey()` already derives a
 *                   regex-valid key in the adapters above.
 *
 * Covered by Grammar.test.tsx through the UI: Bank tap → mocked
 * `services.grammar.bankPattern` → assert the outgoing body. (Not exported —
 * react-refresh/only-export-components keeps page files component-only.)
 */
function buildBankBody(row: PatternListItem): BankGrammarBody {
  const display = row.pattern.trim().slice(0, 120) || row.patternKey;
  const summary =
    (row.title.trim() || row.pattern.trim() || row.patternKey).slice(0, 240);
  const category = (row.category.trim() || 'uncategorized').slice(0, 40);
  const register = toServerRegister(row.register);
  return {
    pattern_key: row.patternKey,
    pattern_display: display,
    summary_en: summary,
    proficiency: row.proficiency,
    category,
    ...(register !== undefined ? { register } : {}),
    discovered_via: 'manual',
  };
}

/** Loader: mock fixture → PatternListItem[]. Memoised at module scope so
 *  the hook's stable-fn rule (per useEndpointOrMock JSDoc) holds. */
async function loadMockListItems(): Promise<PatternListItem[]> {
  const rows = await loadGrammarMock();
  return rows.map(fromMockPattern);
}

/** Loader: real /grammar/kgiu → PatternListItem[] for one level filter.
 *  Always requests the full-corpus page size — the bare `listPatterns()`
 *  call this replaces inherited the server's default `limit` of 20. */
async function loadRealListItems(
  level: LevelFilter,
): Promise<PatternListItem[]> {
  const rows = await grammarService.listPatterns({
    limit: KGIU_LIST_LIMIT,
    ...(level === 'all' ? {} : { corpus: LEVEL_TO_CORPUS[level] }),
  });
  return rows.map(fromKgiu);
}

/**
 * Per-level real loaders, memoised at module scope so the stable-fn convention
 * `useEndpointOrMock` documents holds (the hook reads loaders through refs, but
 * module scope keeps identities stable and intent obvious). The hook's `key`
 * carries the level, so switching the filter triggers a genuine refetch.
 */
const REAL_LIST_LOADERS: Record<LevelFilter, () => Promise<PatternListItem[]>> =
  {
    all: () => loadRealListItems('all'),
    beginner: () => loadRealListItems('beginner'),
    intermediate: () => loadRealListItems('intermediate'),
    advanced: () => loadRealListItems('advanced'),
  };

/**
 * Server-side bank metadata a banked row needs. Carries BOTH the action id
 * (the graduate/readmit endpoints key on grammar_entries.id, NOT the KGIU id)
 * and enough display fields to render the pattern as a row WITHOUT the KGIU
 * list — so the Banked tab + drill pool stay independent of the List tab's
 * level filter (SHOULD-FIX B-SF-1). Keyed by pattern_key in the loaders below.
 */
interface BankedMeta {
  /** grammar_entries row id — the :id for graduate/readmit. */
  id: number;
  /** Server-side dedup key (also this entry's map key). */
  patternKey: string;
  /** Non-null ⇒ the user marked this pattern as known/graduated. */
  graduatedAt: string | null;
  /** Korean pattern display, from the bank row (level-independent). */
  patternDisplay: string;
  /** English summary / title, from the bank row. */
  summaryEn: string;
  /** Proficiency tag bucketed into the server's closed set. */
  proficiency: ServerProficiency;
  /** Category, from the bank row. */
  category: string;
  /** Raw register string from the bank row (may be composite / null). */
  register: string | null;
}

/**
 * Render a banked pattern as a list row from its OWN bank-row fields, with no
 * dependency on the (level-filtered) KGIU list — this is what keeps a List-tab
 * level filter from hiding banked patterns of other levels (B-SF-1). `isReal`
 * is false because the bank row carries no KGIU id: the detail Sheet renders
 * from these stored fields instead of fetching `getPattern` (which needs a
 * KGIU id, not the grammar_entries id). When the pattern's level IS the one
 * currently loaded, the caller prefers the richer KGIU list row for full
 * detail-fetch fidelity; this is the cross-level fallback.
 */
function bankedMetaToItem(meta: BankedMeta): PatternListItem {
  return {
    // Negative synthetic id keeps this out of the real-KGIU id namespace; it is
    // inert because `isReal: false` gates the getPattern(id) detail fetch, and
    // React keys are keyed on patternKey (never id).
    id: -meta.id,
    patternKey: meta.patternKey,
    pattern: meta.patternDisplay,
    title: meta.summaryEn,
    proficiency: meta.proficiency,
    category: meta.category,
    register: meta.register,
    isReal: false,
  };
}

/** Loader: mock banked map (empty until the user banks something). */
async function loadMockBankedMeta(): Promise<ReadonlyMap<string, BankedMeta>> {
  return new Map<string, BankedMeta>();
}

/** Loader: real /grammar/bank → pattern_key → BankedMeta. */
async function loadRealBankedMeta(): Promise<ReadonlyMap<string, BankedMeta>> {
  const res = await grammarService.listBanked();
  return new Map(
    res.entries.map((e) => [
      e.pattern_key,
      {
        id: e.id,
        patternKey: e.pattern_key,
        graduatedAt: e.graduated_at,
        patternDisplay: e.pattern_display,
        summaryEn: e.summary_en,
        proficiency: toServerProficiency(e.proficiency),
        category: e.category,
        register: e.register,
      },
    ]),
  );
}

function Grammar(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();

  // FU-NF-42 B3: a deep-link from the Review screen lands here with a
  // `drillTarget` in router state. Read it once on mount so the Drill tab can
  // open focused on that pattern. We snapshot it into state (rather than
  // reading `location.state` every render) so that clearing the history
  // entry's state below — which prevents a Back/refresh from re-triggering the
  // drill — doesn't yank the target out from under the in-flight drill.
  const [drillTarget, setDrillTarget] = useState<DrillTarget | null>(() =>
    readDrillTarget(location.state),
  );
  const [tab, setTab] = useState<Tab>(() =>
    readDrillTarget(location.state) ? 'drill' : 'list',
  );

  // Scrub the consumed target out of the history entry so a Back navigation or
  // a reload doesn't replay the deep-link. Runs once on mount when a target was
  // present; `navigate(replace)` swaps the current entry's state for an empty
  // one without adding to the stack. Guarded on `location.state` so it doesn't
  // fight a fresh deep-link arriving while mounted (React Router remounts the
  // route element on a same-path state change anyway).
  useEffect(() => {
    if (readDrillTarget(location.state)) {
      navigate(location.pathname, { replace: true, state: null });
    }
    // Mount-only: we captured the target into local state above; re-running on
    // every `location` change would clear a target before the drill consumes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Clear the focused drill target → return the Drill tab to its rotation. */
  const clearDrillTarget = useCallback((): void => {
    setDrillTarget(null);
  }, []);

  // List-tab level filter. Lives here (not in ListPanel) because it feeds the
  // fetch key below — switching level refetches the corpus with the matching
  // `corpus` query param. It scopes ONLY the List browse view: the Banked tab
  // and the drill pool source their patterns from the user's bank list
  // (`bankedItems`, below), which is independent of this filter (B-SF-1).
  const [level, setLevel] = useState<LevelFilter>('all');

  // Pattern list — real first, mock fallback. The hook's `isMock` flips
  // false on a real resolve; that's how the 🅂 badge stays off here. The
  // level is part of the key, so a filter change aborts any in-flight fetch
  // and re-runs the loader for the newly selected corpus.
  const listState = useEndpointOrMock<PatternListItem[]>(
    `grammar:list:${level}`,
    loadMockListItems,
    { realFn: REAL_LIST_LOADERS[level] },
  );

  // Banked map — separate fetch so a failure on one doesn't black out
  // the other. Map<patternKey, BankedMeta> lets the row-level "Banked"
  // check run in O(1) AND carries the bank-row id + graduation state the
  // Banked tab's Graduate / Re-admit actions need.
  const bankedState = useEndpointOrMock<ReadonlyMap<string, BankedMeta>>(
    'grammar:bank',
    loadMockBankedMeta,
    { realFn: loadRealBankedMeta },
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
  // Id of the row whose detail fetch is authoritative — a slow settle for a
  // previously tapped (or since-closed) row must not paint its detail under
  // the currently open row's header. Mirrors the stale-guard in
  // Reference.tsx's GrammarTab.openDetail. Mock/banked rows use negative ids,
  // real KGIU rows positive — the namespaces never collide.
  const detailIdRef = useRef<number | null>(null);

  const bankedKeys = useMemo<ReadonlySet<string>>(() => {
    const merged = new Set<string>(bankedState.data?.keys() ?? []);
    for (const k of optimisticBanked) merged.add(k);
    return merged;
  }, [bankedState.data, optimisticBanked]);

  // Optimistic graduation overlay — patternKey → desired graduated state
  // (true = graduate in flight/settling, false = re-admit). Mirrors the
  // `optimisticBanked` overlay: applied on top of the server map so the row
  // moves between the Active and Known views immediately, pruned once the
  // server settle agrees so the map never grows across a session.
  const [graduationOverrides, setGraduationOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map<string, boolean>());

  useEffect(() => {
    if (!bankedState.data) return;
    const settled = bankedState.data;
    setGraduationOverrides((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map<string, boolean>();
      for (const [k, wanted] of prev) {
        const meta = settled.get(k);
        // Keep the override until the server view agrees with it; a key the
        // server doesn't know yet (optimistic bank still settling) keeps its
        // override too.
        if (meta === undefined || (meta.graduatedAt !== null) !== wanted) {
          next.set(k, wanted);
        }
      }
      // Preserve identity on a no-op settle so downstream memos don't re-run.
      return next.size === prev.size ? prev : next;
    });
  }, [bankedState.data]);

  /** Effective graduation state for a pattern: overlay first, then server. */
  const isGraduated = useCallback(
    (patternKey: string): boolean => {
      const override = graduationOverrides.get(patternKey);
      if (override !== undefined) return override;
      return (bankedState.data?.get(patternKey)?.graduatedAt ?? null) !== null;
    },
    [graduationOverrides, bankedState.data],
  );

  const openDetail = useCallback(
    async (row: PatternListItem): Promise<void> => {
      detailIdRef.current = row.id;
      setOpenRow(row);
      setDetail(null);
      setDetailError(null);
      if (!row.isReal) {
        // Mock/banked rows render from row data alone — no fetch. Reset the
        // loading flag explicitly: a prior real row's in-flight fetch would
        // otherwise leave it stuck true (its guarded finally below no longer
        // owns the sheet).
        setDetailLoading(false);
        return;
      }
      setDetailLoading(true);
      try {
        const d = await grammarService.getPattern(row.id);
        if (detailIdRef.current !== row.id) return; // superseded by a newer tap / close
        setDetail(d);
      } catch (err) {
        if (detailIdRef.current !== row.id) return;
        setDetailError(
          err instanceof ApiError ? err.message : 'Detail unavailable',
        );
      } finally {
        if (detailIdRef.current === row.id) setDetailLoading(false);
      }
    },
    [],
  );

  const closeDetail = useCallback((): void => {
    detailIdRef.current = null;
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
      const body: BankGrammarBody = buildBankBody(row);
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

  // Per-row graduation submit-in-flight + last-error, separate from the
  // bank action's so a Graduate failure never disables a Bank button.
  const [graduationPendingKey, setGraduationPendingKey] = useState<
    string | null
  >(null);
  const [graduationError, setGraduationError] = useState<string | null>(null);

  /**
   * Flip a banked pattern's graduation state (true = Graduate, false =
   * Re-admit). Optimistic: the row hops between the Active and Known views
   * immediately; a real failure rewinds the overlay and surfaces an inline
   * error. Requires the SERVER's bank-row id — a row that's only optimistically
   * banked (settle in flight) is a no-op here, and its action button is
   * disabled via `actionableKeys` below.
   */
  const setKnown = useCallback(
    async (row: PatternListItem, graduated: boolean): Promise<void> => {
      const meta = bankedState.data?.get(row.patternKey);
      if (!meta) return;
      setGraduationPendingKey(row.patternKey);
      setGraduationError(null);
      setGraduationOverrides((prev) =>
        new Map(prev).set(row.patternKey, graduated),
      );
      try {
        if (graduated) {
          await grammarService.graduatePattern(meta.id);
        } else {
          await grammarService.readmitPattern(meta.id);
        }
        // Refetch so the server view becomes the source of truth (and the
        // prune effect can retire the overlay entry).
        bankedState.refetch();
      } catch {
        // Rewind the optimistic flip and surface the error. Don't echo
        // server text.
        setGraduationOverrides((prev) => {
          const next = new Map(prev);
          next.delete(row.patternKey);
          return next;
        });
        setGraduationError(
          graduated
            ? "Couldn't mark that pattern as known. Try again."
            : "Couldn't re-admit that pattern. Try again.",
        );
      } finally {
        setGraduationPendingKey(null);
      }
    },
    [bankedState],
  );

  // Stable array identity so the `bankedItems` memo doesn't re-run on
  // every render — `listState.data ?? []` would otherwise mint a fresh
  // [] each time and bust the memo.
  const items = useMemo<readonly PatternListItem[]>(
    () => listState.data ?? [],
    [listState.data],
  );

  // patternKey → KGIU list row, so a banked pattern that IS in the currently
  // loaded level can be rendered from its richer KGIU row (enabling the full
  // detail fetch) rather than the bank-row fallback.
  const itemsByKey = useMemo<ReadonlyMap<string, PatternListItem>>(() => {
    const m = new Map<string, PatternListItem>();
    for (const it of items) m.set(it.patternKey, it);
    return m;
  }, [items]);

  // Banked patterns sourced from the user's ACTUAL bank list (GET /grammar/bank
  // via `bankedState`), INDEPENDENT of the level-filtered KGIU list. A List-tab
  // level filter must only reshape the List browse view — never hide banked
  // patterns of other levels, skew the Active/Known counts, or repoint the drill
  // pool (SHOULD-FIX B-SF-1). We prefer the KGIU list row when the pattern's
  // level is loaded (full detail-fetch fidelity), else fall back to the bank
  // row's own stored fields via `bankedMetaToItem`. Insertion order follows the
  // server's `created_at DESC`, so the Banked tab ordering is stable.
  const bankedItems = useMemo<readonly PatternListItem[]>(() => {
    const map = bankedState.data;
    if (!map) return [];
    return Array.from(
      map.values(),
      (meta) => itemsByKey.get(meta.patternKey) ?? bankedMetaToItem(meta),
    );
  }, [bankedState.data, itemsByKey]);

  // Graduation split. Active = still learning (drill pool + reviews);
  // known = graduated out of active learning until re-admitted.
  const activeBankedItems = useMemo<readonly PatternListItem[]>(
    () => bankedItems.filter((it) => !isGraduated(it.patternKey)),
    [bankedItems, isGraduated],
  );
  const knownItems = useMemo<readonly PatternListItem[]>(
    () => bankedItems.filter((it) => isGraduated(it.patternKey)),
    [bankedItems, isGraduated],
  );
  // The drill's PRIMARY pool is the user's active banked patterns
  // (`activeBankedItems`, level-independent — see B-SF-1). `drillableItems` is
  // only the fallback for an account with NOTHING banked, where there are no
  // banked patterns to protect, so drilling the currently-browsed corpus is
  // acceptable. The filter still excludes graduated rows — the drill must never
  // serve a graduated pattern even via this fallback (the corpus list contains
  // graduated rows too).
  const drillableItems = useMemo<readonly PatternListItem[]>(
    () => items.filter((it) => !isGraduated(it.patternKey)),
    [items, isGraduated],
  );
  // Rows whose bank-row id the server has confirmed — Graduate/Re-admit need
  // that id, so rows still settling optimistically keep their action disabled.
  const actionableKeys = useMemo<ReadonlySet<string>>(
    () => new Set<string>(bankedState.data?.keys() ?? []),
    [bankedState.data],
  );

  // 🅂 badge for the list/banked tabs when BOTH wired fetches fell back to
  // the mock. The drill tab now hits a REAL endpoint (Pass 9), so its mock
  // signal is owned by `DrillPanel` itself (which renders its own MockBadge
  // only when the generate endpoint is unreachable and it falls to a local
  // mock drill). We suppress the list/banked badge while on the drill tab so
  // the two signals don't fight over the same corner.
  const showMockBadge =
    tab !== 'drill' && listState.isMock && bankedState.isMock;

  return (
    <section
      className="screen km-grammar"
      aria-labelledby="grammar-title"
      style={{ position: 'relative' }}
    >
      {showMockBadge ? <MockBadge /> : null}
      <Topbar
        krTitle={<span id="grammar-title">문법 · Grammar</span>}
        eyebrow={tab === 'drill' ? 'Production drill' : 'Patterns + bank'}
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
        <>
          <div
            className="km-review__tabs"
            role="group"
            aria-label="Level filter"
          >
            {LEVEL_FILTERS.map((f) => {
              const selected = level === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={selected}
                  className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
                  onClick={() => {
                    setLevel(f.id);
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
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
        </>
      ) : null}

      {tab === 'banked' ? (
        <BankedPanel
          loading={listState.loading || bankedState.loading}
          fetchErrored={
            (!listState.data && listState.error !== null) ||
            (!bankedState.data && bankedState.error !== null)
          }
          activeItems={activeBankedItems}
          knownItems={knownItems}
          actionableKeys={actionableKeys}
          pendingKey={graduationPendingKey}
          actionError={graduationError}
          onOpen={(row) => {
            void openDetail(row);
          }}
          onGraduate={(row) => {
            void setKnown(row, true);
          }}
          onReadmit={(row) => {
            void setKnown(row, false);
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
          items={drillableItems}
          bankedItems={activeBankedItems}
          target={drillTarget}
          onClearTarget={clearDrillTarget}
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

/**
 * Sub-views of the Banked tab. `active` = banked patterns still in the
 * learning loop; `known` = graduated patterns (out of the drill pool and the
 * due-review queue) with a Re-admit path back.
 */
type BankedView = 'active' | 'known';

const BANKED_VIEWS: ReadonlyArray<{ id: BankedView; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'known', label: 'Known' },
];

interface BankedPanelProps {
  loading: boolean;
  fetchErrored: boolean;
  /** Banked patterns still in active learning (Graduate available). */
  activeItems: readonly PatternListItem[];
  /** Graduated patterns (Re-admit available). */
  knownItems: readonly PatternListItem[];
  /** Keys whose server bank-row id is known — action buttons enabled. */
  actionableKeys: ReadonlySet<string>;
  /** patternKey of the graduation action currently in flight, if any. */
  pendingKey: string | null;
  /** Inline error from the last failed graduate/re-admit, if any. */
  actionError: string | null;
  onOpen: (row: PatternListItem) => void;
  onGraduate: (row: PatternListItem) => void;
  onReadmit: (row: PatternListItem) => void;
  onRetry: () => void;
}

function BankedPanel({
  loading,
  fetchErrored,
  activeItems,
  knownItems,
  actionableKeys,
  pendingKey,
  actionError,
  onOpen,
  onGraduate,
  onReadmit,
  onRetry,
}: BankedPanelProps): JSX.Element {
  // Local view toggle — pure presentation, feeds no fetch key, so it lives
  // here rather than in the page component (unlike the List level filter).
  const [view, setView] = useState<BankedView>('active');

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

  const items = view === 'active' ? activeItems : knownItems;

  return (
    <>
      <div className="km-review__tabs" role="group" aria-label="Banked view">
        {BANKED_VIEWS.map((v) => {
          const selected = view === v.id;
          const count = v.id === 'active' ? activeItems.length : knownItems.length;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={selected}
              className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
              onClick={() => {
                setView(v.id);
              }}
            >
              {v.label} ({count})
            </button>
          );
        })}
      </div>

      {actionError ? <ErrorCard message={actionError} /> : null}

      {items.length === 0 ? (
        <Card variant="flat" role="status">
          {view === 'active' ? (
            <>
              <Eyebrow>Nothing in active learning</Eyebrow>
              <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
                {knownItems.length > 0
                  ? 'Everything you banked is marked as known. Re-admit a pattern from the Known view to study it again.'
                  : 'Tap Bank on any pattern in the List tab to add it here.'}
              </p>
            </>
          ) : (
            <>
              <Eyebrow>Nothing graduated yet</Eyebrow>
              <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
                When you&apos;re comfortable with a banked pattern, tap
                Graduate to retire it from drills and reviews. It moves here,
                and you can re-admit it any time.
              </p>
            </>
          )}
        </Card>
      ) : (
        <ul className="km-grammar__list">
          {items.map((row) => {
            const pending = pendingKey === row.patternKey;
            const actionable = actionableKeys.has(row.patternKey);
            return (
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
                {view === 'active' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onGraduate(row);
                    }}
                    disabled={pending || !actionable}
                    aria-label={`Graduate ${row.pattern}`}
                  >
                    {pending ? 'Saving…' : 'Graduate'}
                  </Button>
                ) : (
                  <>
                    <Pill tone="green">Known</Pill>
                    <Button
                      variant="gold"
                      size="sm"
                      onClick={() => {
                        onReadmit(row);
                      }}
                      disabled={pending || !actionable}
                      aria-label={`Re-admit ${row.pattern}`}
                    >
                      {pending ? 'Saving…' : 'Re-admit'}
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Drill panel — Pass-9 live production drill (generate → submit → reveal)
// ─────────────────────────────────────────────────────────────

interface DrillPanelProps {
  loading: boolean;
  /**
   * Drillable patterns — the fetched list MINUS graduated ones. The parent
   * filters graduation out before this panel sees anything, so the fallback
   * pool below can never serve a pattern the user has marked as known.
   */
  items: readonly PatternListItem[];
  /**
   * The user's ACTIVE banked subset of `items` (banked and not graduated).
   * When non-empty this is the PREFERRED drill pool — the learner drills the
   * patterns they chose to bank; the full drillable list is the fallback for
   * a fresh account with nothing banked yet.
   */
  bankedItems: readonly PatternListItem[];
  /**
   * FU-NF-42 B3: an externally-supplied pattern to drill (a Review deep-link).
   * When set, the panel generates a drill for THIS pattern instead of its
   * default pool rotation. `null` → the existing rotation behaviour.
   */
  target?: DrillTarget | null;
  /**
   * Invoked when the learner moves past the targeted pattern (Skip / Next), so
   * the parent can drop the deep-link target and the panel falls back to its
   * normal rotation. No-op when no target was supplied.
   */
  onClearTarget?: () => void;
}

/** Minimal source a DrillPanel needs to generate a drill for one pattern. */
interface DrillSource {
  patternKey: string;
  patternDisplay: string;
  meaning: string;
}

/** Project a deep-link target onto the generate-body source shape. */
function targetToSource(target: DrillTarget): DrillSource {
  return {
    patternKey: target.patternKey,
    patternDisplay: target.display,
    meaning: target.meaning,
  };
}

/** Project a list row onto the generate-body source shape. */
function rowToSource(row: PatternListItem): DrillSource {
  return {
    patternKey: row.patternKey,
    patternDisplay: row.pattern,
    meaning: row.title,
  };
}

/**
 * Phases of the per-pattern drill lifecycle. There is deliberately NO 'error'
 * phase: failure is failure-SAFE, not a terminal state. A generate failure in
 * dev falls back to a local mock drill (still 'ready', with a 🅂 badge); in
 * PROD it returns to 'ready' with `genError` set (panel-level ErrorCard whose
 * Retry re-generates). A submit failure returns to 'ready' with an inline
 * role=alert ErrorCard and the answer preserved for Retry. The screen never
 * blanks, so an unreachable 'error' phase would be a dead union member that a
 * future `switch (phase)` could mishandle.
 */
type DrillPhase = 'generating' | 'ready' | 'scoring' | 'revealed';

/**
 * Local mock drills — one per type — used as the fall-back when the generate
 * endpoint is unreachable IN NON-PROD BUILDS ONLY, so a dev / offline session
 * still exercises the full render + submit flow. The panel rotates these by
 * `idx` and shows the 🅂 badge while any of them is in play. They carry the
 * SAME public shape as a real `DrillItemPublic` (no reference model — that's
 * revealed only on submit), so the DrillCard renders them identically to live
 * items. In PROD the badge renders null, which is exactly why these fixtures
 * must never be served there (fabricated drill + fabricated score would read
 * as real) — the generate catch gates on `import.meta.env.PROD`.
 */
const MOCK_DRILLS: readonly DrillItemPublic[] = [
  {
    type: 'transformation',
    patternKey: 'mock:transformation',
    patternDisplay: '-더라도',
    instruction: 'Rewrite the sentence using -더라도 (even if / even though).',
    sourceKr: '비가 와요. 우리는 갈 거예요.',
    sourceEn: "It's raining. We will go.",
  },
  {
    type: 'cloze',
    patternKey: 'mock:cloze',
    patternDisplay: '-느라고',
    instruction: 'Fill the blank with a -느라고 clause explaining the result.',
    context: 'Explain why you missed dinner — you were preparing a presentation.',
    seedKr: '발표 자료를 ___ 저녁을 못 먹었어요.',
  },
  {
    type: 'conversation',
    patternKey: 'mock:conversation',
    patternDisplay: '-ㄹ 뿐만 아니라',
    instruction: 'Reply using -ㄹ 뿐만 아니라 (not only … but also).',
    scenario: 'A friend asks what you think of the new café.',
    promptKr: '새로 생긴 카페 어때요?',
    promptEn: 'How is the new café?',
  },
];

/**
 * Fixed copy for a PROD generate failure. Author-controlled — ErrorCard's
 * contract forbids echoing untrusted server message text (mirrors the
 * `Login.messageFor` fixed-lookup rule).
 */
const DRILL_GENERATE_ERROR_COPY =
  "The drill couldn't be generated. Check your connection and try again.";

/**
 * Synthesize a plausible reveal for a mock drill so the offline flow can paint
 * the full reveal block (score + verdict + correction + reference model). The
 * reference model is derived from the mock item's own fields — never a real
 * Claude score, hence the 🅂 badge that accompanies it.
 */
function mockScoreFor(item: DrillItemPublic, answer: string): DrillScore {
  const used = answer.includes(stripParticle(item.patternDisplay));
  return {
    score: used ? 82 : 48,
    verdict: used ? 'good' : 'needs_work',
    usesPattern: used,
    summary: used
      ? 'Offline practice — your answer reads natural and uses the target pattern. Connect to score it for real.'
      : 'Offline practice — the target pattern looks absent. Connect to score it for real.',
    corrections: [],
    referenceModelKr: mockReferenceKr(item),
    referenceModelEn: 'A natural sentence that uses the target pattern.',
  };
}

/** Strip a leading dash from a pattern display so a naïve "did they use it"
 *  mock check matches the bare morpheme. Purely for the offline heuristic. */
function stripParticle(display: string): string {
  return display.replace(/^-/, '').replace(/^ㄹ /, '');
}

/** Build a mock reference sentence from the item's own seed/source text. */
function mockReferenceKr(item: DrillItemPublic): string {
  switch (item.type) {
    case 'transformation':
      return item.sourceKr;
    case 'cloze':
      return item.seedKr.replace('___', `${item.patternDisplay}`);
    case 'conversation':
      return item.promptKr;
  }
}

/**
 * Persisted drill-rotation cursor (localStorage).
 *
 * ROOT CAUSE of the live "Drill always produces N이다" bug: the rotation index
 * was `useState(0)` inside DrillPanel, which unmounts on EVERY tab switch
 * (`{tab === 'drill' ? <DrillPanel/> : null}`) and on reload — so each visit to
 * the Drill tab restarted the rotation at `items[0]`, the first id-ordered
 * corpus row (N이다). Live evidence: all five `grammar_drill_attempts` rows
 * from the 2026-07-02 session carry `pattern_key = 'kgiu-beginner-002'` and
 * the LB log shows each generate was a fresh mount, never a rotation step.
 *
 * The cursor therefore lives in localStorage: it survives remounts, tab
 * switches, and reloads, so the learner deterministically progresses through
 * the pool (`pool[cursor % pool.length]`) instead of looping on pattern #1.
 *
 * Threat model: localStorage is same-origin, user-local UI state — no secret,
 * no server trust. Reads are validated (finite non-negative integer, else 0)
 * so a corrupted/foreign value can't produce a negative index or NaN; both
 * accessors swallow storage failures (private mode, quota) and degrade to
 * in-memory-only rotation.
 */
const DRILL_CURSOR_STORAGE_KEY = 'km.grammar.drillCursor';

/** Read the persisted cursor; 0 on absence, corruption, or storage failure. */
function readDrillCursor(): number {
  try {
    const raw = window.localStorage.getItem(DRILL_CURSOR_STORAGE_KEY);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Best-effort persist — a storage failure must never break the drill. */
function writeDrillCursor(cursor: number): void {
  try {
    window.localStorage.setItem(DRILL_CURSOR_STORAGE_KEY, String(cursor));
  } catch {
    // Private mode / quota — rotation continues in-memory for this mount.
  }
}

function DrillPanel({
  loading,
  items,
  bankedItems,
  target = null,
  onClearTarget,
}: DrillPanelProps): JSX.Element {
  // Which pattern (by index into the pool) we're drilling. Wraps with `%`.
  // Initialised from the PERSISTED cursor so a remount (tab switch, reload)
  // resumes the rotation where the learner left off instead of resetting to
  // pool[0] — see DRILL_CURSOR_STORAGE_KEY for the live bug this fixes.
  const [idx, setIdx] = useState<number>(readDrillCursor);

  // Drill pool: the learner's banked patterns when any exist (drilling what
  // they chose to study), else the full fetched KGIU list. `bankedItems` is a
  // subset of `items`, so an empty `items` implies an empty pool and the
  // existing empty-state gates below still hold.
  const pool = bankedItems.length > 0 ? bankedItems : items;
  const [phase, setPhase] = useState<DrillPhase>('generating');
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [item, setItem] = useState<DrillItemPublic | null>(null);
  const [score, setScore] = useState<DrillScore | null>(null);
  const [userInput, setUserInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  // True iff the current item came from the local mock fall-back (the generate
  // endpoint was unreachable). Drives the 🅂 badge + the offline-mock scoring.
  const [isMock, setIsMock] = useState(false);
  // PROD generate failure: `item` stays null and this holds the fixed error
  // copy for the panel-level ErrorCard. Distinct from `error` (a SUBMIT
  // failure rendered inside DrillCard, whose Retry re-submits): a generate
  // failure has no item to submit against — `submit()`'s `if (!item) return`
  // would dead-end — so its Retry must RE-GENERATE via `genTick` instead.
  const [genError, setGenError] = useState<string | null>(null);
  // Bumped by the generate-failure Retry to re-fire the generate effect for
  // the SAME pattern (idx/patternKey unchanged).
  const [genTick, setGenTick] = useState(0);

  // FU-NF-42 B3: a deep-link target wins over the rotation. When present we
  // drill exactly that pattern; otherwise we cycle `pool[idx]`. The targeted
  // pattern can be drilled even when the pool is empty (the list fetch is
  // mock/empty) — the target carries its own display + meaning.
  const source: DrillSource | null = target
    ? targetToSource(target)
    : pool.length > 0
      ? rowToSource(pool[idx % pool.length]!)
      : null;
  const patternKey = source?.patternKey ?? null;

  // Generate-in-flight controller so navigating away (Skip/Next) or unmount
  // aborts a stale generate and its settle doesn't clobber the next pattern.
  const genCtrlRef = useRef<AbortController | null>(null);
  const submitCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      genCtrlRef.current?.abort();
      submitCtrlRef.current?.abort();
    };
  }, []);

  // Generate a drill whenever the active pattern changes (idx → pattern) or
  // the generate-failure Retry bumps `genTick`. The generate is real-first;
  // on failure the screen never dead-ends — dev falls back to a local mock
  // drill, PROD surfaces a retryable ErrorCard (never fixture data). A stale
  // settle is dropped via the abort signal.
  useEffect(() => {
    if (!source) return;
    genCtrlRef.current?.abort();
    const ctrl = new AbortController();
    genCtrlRef.current = ctrl;

    // Reset per-pattern state up front so the loading view paints cleanly and
    // no stale answer/score leaks across patterns. Sync-to-external-system
    // case (a fresh network round-trip), same shape as useEndpointOrMock.
    setPhase('generating');
    setAttemptId(null);
    setItem(null);
    setScore(null);
    setUserInput('');
    setError(null);
    setIsMock(false);
    setGenError(null);

    const mockItem = MOCK_DRILLS[idx % MOCK_DRILLS.length];

    void (async (): Promise<void> => {
      try {
        const gen = await generateDrill(
          {
            patternKey: source.patternKey,
            patternDisplay: source.patternDisplay,
            meaning: source.meaning,
          },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setAttemptId(gen.attemptId);
        setItem(gen.item);
        setPhase('ready');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        // Canceled (navigated away) — let the superseding run own the state.
        if (err instanceof ApiError && err.code === 'canceled') return;
        // PROD: no fixture substitution — MockBadge renders null in prod, so
        // a mock drill + local pseudo-scoring would read as a REAL drill and
        // a REAL score (the fake-data-as-real class useEndpointOrMock and
        // MockMode gate). Surface the retryable error; Retry re-generates.
        if (import.meta.env.PROD) {
          setGenError(DRILL_GENERATE_ERROR_COPY);
          setPhase('ready');
          return;
        }
        // DEV failure-safe: endpoint unreachable / upstream down → fall back
        // to a local mock drill rather than blanking the screen. The 🅂 badge
        // flags it.
        setItem(mockItem);
        setAttemptId(null);
        setIsMock(true);
        setPhase('ready');
      }
    })();
    // `idx` + `patternKey` are the stable triggers (`source` is a fresh object
    // each render). A deep-link target swaps the `patternKey` (vs. the
    // rotation), so it re-fires the generate cleanly. The display/meaning are
    // read off the same source, so the minimal deps hold. `genTick` re-fires
    // the SAME pattern after a PROD generate failure (the ErrorCard's Retry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, patternKey, genTick]);

  // Move past the current pattern. With a deep-link target active there is no
  // `idx` rotation to advance into, so we drop the target (→ parent clears it)
  // and the panel falls back to its `pool[idx]` rotation. Without a target we
  // bump `idx` AND persist the new cursor, so the step survives a remount —
  // Skip / Next pattern now deterministically moves to a different pattern
  // instead of regenerating the same one after any tab switch.
  const advance = useCallback((): void => {
    submitCtrlRef.current?.abort();
    if (target) {
      onClearTarget?.();
      return;
    }
    setIdx((i) => i + 1);
  }, [target, onClearTarget]);

  // Persist the cursor on every step (and on mount, an idempotent re-write of
  // the value just read). An effect rather than a write inside the setIdx
  // updater keeps the updater pure (StrictMode double-invokes updaters).
  useEffect(() => {
    writeDrillCursor(idx);
  }, [idx]);

  // Retry for a GENERATE failure: re-fire the generate effect for the same
  // pattern. This must NOT be `submit` — with `item === null` (the generate
  // never produced a drill) `submit()`'s `if (!item) return` guard makes the
  // button a silent no-op. The effect itself clears `genError` on re-run.
  const retryGenerate = useCallback((): void => {
    setGenTick((t) => t + 1);
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (!item) return;
    const answer = userInput.trim();
    if (answer.length === 0) return;
    setPhase('scoring');
    setError(null);
    submitCtrlRef.current?.abort();
    const ctrl = new AbortController();
    submitCtrlRef.current = ctrl;
    try {
      // Offline / mock path — no real attempt to submit against; synthesize a
      // plausible reveal so the flow is exercised end to end.
      if (isMock || attemptId === null) {
        const synthetic = mockScoreFor(item, answer);
        if (ctrl.signal.aborted) return;
        setScore(synthetic);
        setPhase('revealed');
        return;
      }
      const result = await submitDrill(attemptId, answer, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setScore(result);
      setPhase('revealed');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (err instanceof ApiError && err.code === 'canceled') return;
      // Submit failed — the attempt stays unscored server-side, so the user
      // can retry. Surface an inline alert and return to the ready phase with
      // the answer intact (don't blank their work).
      setError(
        'Scoring your answer failed. Your answer is still here — try again.',
      );
      setPhase('ready');
    }
  }, [item, userInput, isMock, attemptId]);

  // A deep-link target carries its own pattern, so it can drill even with an
  // empty/mock list fetch — only gate the loading/empty states when there's no
  // target to fall back on.
  if (loading && items.length === 0 && !target) {
    return (
      <div className="km-grammar__state" role="status">
        Loading drill…
      </div>
    );
  }
  if (items.length === 0 && !target) {
    return (
      <div className="km-grammar__state" role="status">
        No grammar patterns to drill yet. Bank or browse patterns first.
      </div>
    );
  }

  return (
    <>
      {isMock ? <MockBadge /> : null}
      {genError !== null ? (
        // PROD generate failure — there is no item (and hence no DrillCard),
        // so the error renders at panel level with its OWN Retry that
        // re-generates. Fixed copy, never server prose.
        <ErrorCard message={genError} onRetry={retryGenerate} />
      ) : phase === 'generating' || !item ? (
        <Card className="km-grammar__card" aria-busy="true">
          <div className="km-grammar__state" role="status">
            Generating drill…
          </div>
        </Card>
      ) : (
        <DrillCard
          item={item}
          phase={phase}
          score={score}
          userInput={userInput}
          error={error}
          onInput={setUserInput}
          onSubmit={() => {
            void submit();
          }}
          // The only error `DrillCard` ever renders is a SUBMIT failure (a
          // generate failure never reaches DrillCard: dev falls back to the
          // local mock drill, prod renders the panel-level ErrorCard above
          // whose Retry re-generates), and its copy promises "Your answer is
          // still here — try again". Retry therefore RE-SUBMITS the preserved
          // answer; wiring it to a regenerate would erase the answer and mint
          // a fresh drill, contradicting the message.
          onRetry={() => {
            void submit();
          }}
          onSkip={advance}
          onNext={advance}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Drill card — renders by item.type; reveal block post-submit
// ─────────────────────────────────────────────────────────────

interface DrillCardProps {
  item: DrillItemPublic;
  phase: DrillPhase;
  score: DrillScore | null;
  userInput: string;
  error: string | null;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onNext: () => void;
}

/** Verdict → Pill tone + label. Each verdict maps to a distinct Pill tone:
 *  green (excellent) → gold (good) → ochre (needs work) → red (incorrect),
 *  a four-step warm-to-alarm gradient within the design's tone vocabulary. */
const VERDICT_META: Record<
  DrillScore['verdict'],
  { tone: PillTone; label: string; cls: string }
> = {
  excellent: { tone: 'green', label: 'Excellent', cls: 'km-grammar__verdict--excellent' },
  good: { tone: 'gold', label: 'Good', cls: 'km-grammar__verdict--good' },
  needs_work: { tone: 'ochre', label: 'Needs work', cls: 'km-grammar__verdict--needs-work' },
  incorrect: { tone: 'red', label: 'Incorrect', cls: 'km-grammar__verdict--incorrect' },
};

function DrillCard({
  item,
  phase,
  score,
  userInput,
  error,
  onInput,
  onSubmit,
  onRetry,
  onSkip,
  onNext,
}: DrillCardProps): JSX.Element {
  const revealId = `gr-reveal-${item.patternKey}`;
  const inputId = `gr-input-${item.patternKey}`;
  const revealed = phase === 'revealed' && score !== null;
  const scoring = phase === 'scoring';
  const canSubmit = userInput.trim().length > 0 && !revealed && !scoring;

  return (
    <Card className="km-grammar__card">
      <div className="km-grammar__header">
        <div>
          <Eyebrow>Pattern</Eyebrow>
          <h2 className="kr km-grammar__pattern">{item.patternDisplay}</h2>
        </div>
        <Pill tone="gold">Production</Pill>
      </div>

      <GoldRule className="km-grammar__rule" />

      <DrillBody item={item} />

      <p className="km-grammar__instruction">{item.instruction}</p>

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
        placeholder={`Write your answer using ${item.patternDisplay}…`}
        aria-describedby={revealed ? revealId : undefined}
        rows={3}
        disabled={revealed || scoring}
        // Soft cap — defensive; the server enforces its own 1..600 bound.
        // Keeps a runaway paste from filling memory before the request.
        maxLength={500}
      />

      {scoring ? (
        <div className="km-grammar__state" role="status">
          Scoring your answer…
        </div>
      ) : null}

      {error ? (
        <ErrorCard message={error} onRetry={onRetry} />
      ) : null}

      {revealed ? <DrillReveal score={score} revealId={revealId} /> : null}

      <div className="km-grammar__footer">
        {!revealed ? (
          <>
            <Button variant="ghost" onClick={onSkip} disabled={scoring}>
              Skip
            </Button>
            <Button variant="gold" onClick={onSubmit} disabled={!canSubmit}>
              {scoring ? 'Scoring…' : 'Submit'}
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

/** Per-type body — the task framing above the textarea. */
function DrillBody({ item }: { item: DrillItemPublic }): JSX.Element {
  switch (item.type) {
    case 'transformation':
      return (
        <>
          <Eyebrow>Transform this</Eyebrow>
          <p className="km-grammar__context kr">{item.sourceKr}</p>
          <p className="km-grammar__model-en">{item.sourceEn}</p>
        </>
      );
    case 'cloze':
      return (
        <>
          <Eyebrow>Situation</Eyebrow>
          <p className="km-grammar__context">{item.context}</p>
          <Eyebrow className="km-grammar__seed-eyebrow">
            Seed — fill the blank
          </Eyebrow>
          <div className="kr km-grammar__seed">{item.seedKr}</div>
        </>
      );
    case 'conversation':
      return (
        <>
          <Eyebrow>Scenario</Eyebrow>
          <p className="km-grammar__context">{item.scenario}</p>
          <Eyebrow className="km-grammar__seed-eyebrow">They say</Eyebrow>
          <div className="kr km-grammar__seed">{item.promptKr}</div>
          <p className="km-grammar__model-en">{item.promptEn}</p>
        </>
      );
  }
}

/** Post-submit reveal — score, verdict, corrections, reference model. */
function DrillReveal({
  score,
  revealId,
}: {
  score: DrillScore;
  revealId: string;
}): JSX.Element {
  const verdict = VERDICT_META[score.verdict];
  return (
    <Card variant="flat" className="km-grammar__reveal" id={revealId}>
      <div className="km-grammar__score-head">
        <div className="km-grammar__score">
          <span className="km-grammar__score-num">{score.score}</span>
          <span className="km-grammar__score-max"> / 100</span>
        </div>
        <Pill tone={verdict.tone} className={verdict.cls}>
          {verdict.label}
        </Pill>
      </div>

      <p className="km-grammar__uses-pattern">
        {score.usesPattern
          ? 'Uses the target pattern.'
          : 'The target pattern was not detected — try to include it.'}
      </p>

      <p className="km-grammar__summary">{score.summary}</p>

      {score.corrections.length > 0 ? (
        <>
          <Eyebrow className="km-grammar__seed-eyebrow">Corrections</Eyebrow>
          <ul className="km-grammar__corrections">
            {score.corrections.map((c, i) => (
              <li
                key={`${c.span}-${String(i)}`}
                className="km-grammar__correction"
              >
                <span className="kr km-grammar__correction-span">{c.span}</span>
                <span className="km-grammar__correction-issue">{c.issue}</span>
                <span className="km-grammar__correction-fix">→ {c.fix}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <Eyebrow className="km-grammar__seed-eyebrow">Model answer</Eyebrow>
      <p className="kr km-grammar__model">{score.referenceModelKr}</p>
      <p className="km-grammar__model-en">{score.referenceModelEn}</p>

      {/* FU-NF-42 B2: server-derived production schedule. Subtle, hanji-styled,
          and inside the already-announced reveal region (the card carries
          `aria-describedby={revealId}` while revealed), so AT picks it up with
          the rest of the grade without a second live announcement. Omitted when
          the server didn't return a schedule (pre-bump server / offline mock). */}
      {score.schedule ? (
        <p className="km-grammar__schedule">{scheduleLine(score.schedule)}</p>
      ) : null}
    </Card>
  );
}

/**
 * Render the "added to your review" line from a production schedule.
 * `scheduledDays === 0` (an `again` relearning step) reads as "~10 minutes";
 * a 1-day interval drops the plural so it reads "1 day" not "1 days".
 */
function scheduleLine(schedule: DrillSchedule): string {
  if (schedule.scheduledDays <= 0) {
    return 'Added to your review · next in ~10 minutes';
  }
  const days = schedule.scheduledDays;
  return `Added to your review · next in ${String(days)} day${days === 1 ? '' : 's'}`;
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
        {detail && !loading ? <KgiuDetailBody detail={detail} /> : null}
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
