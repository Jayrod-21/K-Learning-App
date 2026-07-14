/**
 * Grammar screen — the LEARN grammar-practice page (cards + practice session).
 *
 * Phase 3C-1 rework (F-063/F-064/F-065/F-066/B-024/F-024):
 *
 *   The page now has three ?view= sub-views on one route, so browser Back and
 *   deep links behave, and each nested view carries a BackButton (F-024):
 *
 *   - `cards`    (default) — the user's saved grammar patterns rendered as
 *                CARDS in the same mastery vocabulary the vocab flashcards
 *                use (F-063/F-066): a "Learning | Known" split instead of the
 *                old banked/graduate jargon. "Mark known" retires a pattern
 *                from practice + reviews (the self-graduate concept, kept);
 *                "Relearn" (mirrors the FSRS `relearning` state name) brings
 *                it back with its FSRS state intact. Rows are grouped by
 *                proficiency into CollapsibleTiles for clear separation
 *                (B-024) and the Korean pattern form never wraps (one line,
 *                ellipsized — Grammar.css). Patterns whose production card is
 *                due for review carry a "Due" pill, wired to the EXISTING
 *                `GET /vocab/cards/due` queue (the same queue the vocab
 *                session drains).
 *   - `practice` — the Pass-9 LIVE production drill, opened from the
 *                top-right "Practice" button in the header (F-064). The pool
 *                is due-first (Anki ordering): patterns whose production card
 *                is due are drilled before the rest of the rotation. Per
 *                drill: `POST /grammar-drill` generates, the learner answers,
 *                `POST /grammar-drill/:id/submit` scores AND advances the
 *                pattern's production card through the server-owned FSRS
 *                scheduler — the reveal names the derived rating with the
 *                same Again/Hard/Good/Easy vocabulary the vocab rating
 *                buttons use (F-063).
 *   - `history`  — honest stub (F-065): attempts are persisted server-side
 *                (`grammar_drill_attempts`) but no read endpoint exists yet,
 *                so this view says so instead of faking a list. Backend
 *                ticket: F-110 (grammar drill-attempts read —
 *                GET /grammar-drill/attempts).
 *
 *   NOT on this page (P1.2/D3 unchanged): the corpus browse + Bank action
 *   live in the Review library at /review/grammar (ReviewGrammar.tsx).
 *
 * Grammar's Anki review loop, honestly stated: reviewing a due grammar
 * production card = DRILLING it (FU-NF-42 — the server maps the Claude
 * verdict to an FSRS rating; there is deliberately no self-rate UX). What
 * exists is wired here: due cards surface as "Due" pills + due-first practice
 * ordering, and every scored drill advances the card. What does NOT exist is
 * a read API for per-pattern schedule state (state / next due date for
 * non-due cards) — rows therefore only badge due-NOW patterns rather than
 * inventing intervals. Backend ticket: F-111 (per-pattern grammar card
 * schedule read).
 *
 * Data:
 *   useEndpointOrMock('grammar:list', …) → PatternListItem[]   (KGIU corpus,
 *     one wide page — feeds the practice fallback pool + upgrades card rows)
 *   useEndpointOrMock('grammar:bank', …) → Map<patternKey, BankedMeta>
 *   useEndpointOrMock('grammar:due',  …) → Set<patternKey>     (due production
 *     cards, filtered out of the existing /vocab/cards/due queue)
 *   services.grammar.getPattern(id)      → detail Sheet
 *
 * Threat model:
 *   - **markKnown / relearn** (graduate/readmit endpoints) mutate only a
 *     boolean-ish flag on a row the server verifies the user owns (404
 *     otherwise); both are idempotent, id comes from the server's own bank
 *     list (never user text), and failures rewind the optimistic move with
 *     an inline error.
 *   - **getPattern / getDueCards** are GETs — no CSRF surface. A failed due
 *     fetch degrades to "no due badges" via the hook's mock fallback (an
 *     EMPTY set — never fabricated due-ness) and its error is carried on the
 *     hook for the dev badge; the cards themselves keep working.
 *   - Pattern display + title strings render through React text children,
 *     so injection from a compromised KGIU corpus row cannot escape into
 *     HTML. innerHTML and dangerouslySetInnerHTML are never touched.
 *   - The Pass-9 `POST /grammar-drill` endpoint enforces its own body caps;
 *     the `maxLength={500}` on the textarea stops a runaway paste, but the
 *     server is the source of truth.
 *   - **Fixture-as-real in PROD.** `MockBadge` renders null in production,
 *     so serving `MOCK_DRILLS` + local pseudo-scoring on a generate failure
 *     would present a fabricated drill and a fabricated score as REAL — the
 *     exact failure class `useEndpointOrMock` and MockMode gate. The
 *     practice-panel generate fallback is therefore gated to non-PROD
 *     builds; in prod a generate failure surfaces a retryable error.
 *   - `?view=` is user-controlled input read off the URL; it is parsed
 *     against a closed set (`parseView`) and never interpolated anywhere.
 *
 * F-128 reskin ("Seoul Day & Night") — the shared `PageHubHeader` (devices
 * #4/#2) replaces the bare `Topbar`; each proficiency group in the cards view
 * is a `CollapsibleTile surface="city"` signboard/hanji-paper tile (device
 * #1) with a `DancheongRail` leading edge (device #2, cycled across the four
 * fixed tones so the groups read as distinct sections); the live drill card
 * itself — the page's actual hero surface — is a `CityCard` with its own
 * rail; a Known row's standing carries a milestone `SealStamp` (device #7,
 * mirroring `ReviewGrammar`'s graduated-row treatment); every honest-empty
 * state carries `.km-giwa`/`.km-hangul-watermark` (devices #3/#6); the page
 * root gets the ambient `.km-rain-sheen` (device #8, Night-only per its own
 * CSS gate).
 *
 * F-158 ("pick a form to drill continuously") — a NEW entry point alongside
 * the existing rotation: each saved-pattern row in the cards view (in EITHER
 * the Learning or Known view — a deliberate list-as-form-picker, matching the
 * design mock) carries a "Drill" action. Tapping it sets `formTarget` (below)
 * and jumps to the practice view generating for THAT pattern only; unlike the
 * one-shot FU-NF-42 `drillTarget` deep-link (which the Review screen still
 * uses to focus a SINGLE drill before falling back to the rotation),
 * `formTarget` is CONTINUOUS — advancing never clears it or rotates to a
 * different pattern; it re-fires the generate effect for the same
 * `patternKey` every time (reusing the same retry-tick mechanism a PROD
 * generate-failure Retry already uses), so the learner gets an endless
 * stream of fresh sentences for the one form they picked. Leaving the
 * practice view (BackButton, or navigating to History) drops `formTarget` so
 * a later "Practice" tap resumes the normal pool instead of re-opening a
 * stale pick.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Bilingual } from '../components/Bilingual';
import { PageHubHeader } from '../components/PageHubHeader';
import { Card } from '../components/Card';
import { CityCard } from '../components/CityCard';
import { Button } from '../components/Button';
import { Pill, type PillTone } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { GoldRule } from '../components/GoldRule';
import { MockBadge } from '../components/MockBadge';
import { SealStamp } from '../components/SealStamp';
import { Sheet } from '../components/Sheet';
import { ErrorCard } from '../components/ErrorCard';
import { BackButton } from '../components/BackButton';
import { CollapsibleTile } from '../components/CollapsibleTile';
import type { DancheongRailTone } from '../components/DancheongRail';
import { KgiuDetailBody } from '../components/KgiuDetailBody';
import { useChatContext } from '../hooks/useChatContext';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadGrammarMock } from '../data/mocks/grammar';
import { grammarKey } from '../lib/grammarKey';
import { toServerProficiency } from '../lib/grammarBank';
import * as grammarService from '../services/grammar';
import * as vocabService from '../services/vocab';
import {
  generateDrill,
  listAttempts,
  submitDrill,
  type DrillScore,
} from '../services/grammarDrill';
import { ApiError } from '../services/api';
import { errorMessageFor } from '../lib/errorCopy';
import type {
  DrillAttemptHistoryRow,
  DrillItemPublic,
  DrillSchedule,
  FsrsRating,
  FsrsState,
  GrammarCardSchedule,
  GrammarPattern,
  KgiuEntryDetail,
  KgiuEntrySummary,
  ServerProficiency,
} from '../types/domain';
import {
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import './Grammar.css';

/** The page's nested sub-views, addressed via `?view=` so browser Back works
 *  and the F-024 BackButton has a canonical parent (`/learn/grammar`). */
type View = 'cards' | 'practice' | 'history';

/** Parse the untrusted `?view=` param against the closed view set. */
function parseView(raw: string | null): View {
  return raw === 'practice' || raw === 'history' ? raw : 'cards';
}

/** F-128: bilingual eyebrow copy per view, for the shared `PageHubHeader`. */
const EYEBROW_BY_VIEW: Record<View, { en: string; kr: string }> = {
  cards: { en: 'Your grammar cards', kr: '내 문법 카드' },
  practice: { en: 'Practice', kr: '연습' },
  history: { en: 'Practice history', kr: '연습 기록' },
};

/**
 * Deep-link payload the Review screen hands to the practice view (FU-NF-42
 * B3). When a grammar production card is activated in Review, it navigates to
 * `/learn/grammar` with this object in `location.state.drillTarget`. The page
 * opens the practice view focused on this pattern (generating a drill for it)
 * instead of cycling its default `pool[idx]` rotation. `patternKey` is the
 * server dedup key; `display` + `meaning` seed the generate body so the drill
 * renders even when the pattern isn't in the (possibly mock) list fetch.
 */
export interface DrillTarget {
  patternKey: string;
  display: string;
  meaning: string;
}

/** The shape we look for in `location.state` when practice is deep-linked. */
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

/**
 * One wide page for the whole corpus — the endpoint's `limit` ceiling. The
 * default server `limit` is 20; 400 covers the full set (285 listable rows:
 * 108 beginner / 93 intermediate / 84 advanced) with headroom. Mirrors
 * GRAMMAR_PAGE_SIZE in lib/libraryFilters.ts (the library browse).
 */
const KGIU_LIST_LIMIT = 400;

/**
 * Normalised row shape the cards view + practice pool render. Both the real
 * KGIU summary and the mock GrammarPattern fixture flatten into this — the
 * UI stays single-shape, the per-source quirks live in the adapters below.
 */
interface PatternListItem {
  /** Stable id for keys + detail fetch. Real rows use the BIGINT KGIU id;
   *  mock rows synthesise a negative integer so the two namespaces never
   *  collide. */
  id: number;
  /** Server-side dedup key (matches the library browse's bank key). */
  patternKey: string;
  /** Korean pattern display ("-더라도"). */
  pattern: string;
  /** English summary / title ("even if"). */
  title: string;
  /** Proficiency tag — drives the B-024 group the row renders under. */
  proficiency: ServerProficiency;
  /** Category from the source row (display metadata post-P1.2). */
  category: string;
  /** RAW corpus register string ("해요체", often composite). Kept raw;
   *  lib/grammarBank sanitizes before any POST (done in the library now). */
  register: string | null;
  /** True iff this row came from the real `listPatterns` endpoint — lets
   *  the detail Sheet know whether it can call `getPattern(id)` (real) or
   *  must render from row data alone (mock/bank-row fallback). */
  isReal: boolean;
}

/** Adapt a real KGIU summary into the normalised row shape. */
function fromKgiu(row: KgiuEntrySummary): PatternListItem {
  return {
    id: row.id,
    // `grammarKey` derives the GR-shaped dedup key the server's
    // BankBodySchema regex (`^GR-[a-z0-9_-]{1,64}$`) requires. The previous
    // raw fallback (`source_id ?? pattern`) produced keys like
    // "kgiu-beginner-002" — no GR- prefix — so EVERY bank once 400'd. It
    // also matches the key the library browse (ReviewGrammar) banks with,
    // so the bank state reconciles across both screens.
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
    // The design fixtures don't carry proficiency — default to L4.
    proficiency: 'L4',
    category: 'pattern',
    register: null,
    isReal: false,
  };
}

/** Loader: mock fixture → PatternListItem[]. Memoised at module scope so
 *  the hook's stable-fn rule (per useEndpointOrMock JSDoc) holds. */
async function loadMockListItems(): Promise<PatternListItem[]> {
  const rows = await loadGrammarMock();
  return rows.map(fromMockPattern);
}

/** Loader: real /grammar/kgiu → PatternListItem[] (the whole corpus in one
 *  wide page — a bare `listPatterns()` call would inherit the server's
 *  default `limit` of 20). Module scope keeps the identity stable per the
 *  useEndpointOrMock stable-fn convention. */
async function loadRealListItems(): Promise<PatternListItem[]> {
  const rows = await grammarService.listPatterns({ limit: KGIU_LIST_LIMIT });
  return rows.map(fromKgiu);
}

/**
 * Server-side bank metadata a card row needs. Carries BOTH the action id
 * (the graduate/readmit endpoints key on grammar_entries.id, NOT the KGIU id)
 * and enough display fields to render the pattern as a row WITHOUT the KGIU
 * list — so the cards view + practice pool stay independent of the corpus
 * fetch (SHOULD-FIX B-SF-1). Keyed by pattern_key in the loaders below.
 */
interface BankedMeta {
  /** grammar_entries row id — the :id for graduate/readmit. */
  id: number;
  /** Server-side dedup key (also this entry's map key). */
  patternKey: string;
  /** Non-null ⇒ the user marked this pattern as known. */
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
  /**
   * Real FSRS schedule of this pattern's production card (F-111). `null` =
   * never drilled yet (no card exists). Non-null covers EVERY drilled
   * pattern, due or not — this is what lets a mastery row show real
   * state/next-due instead of only the due-NOW pill (`dueKeys`, sourced
   * separately from `GET /vocab/cards/due`).
   */
  schedule: GrammarCardSchedule | null;
}

/**
 * Render a saved pattern as a list row from its OWN bank-row fields, with no
 * dependency on the (possibly filtered) KGIU list — this is what keeps the
 * cards view independent of the corpus fetch (B-SF-1). `isReal` is false
 * because the bank row carries no KGIU id: the detail Sheet renders from
 * these stored fields instead of fetching `getPattern` (which needs a KGIU
 * id, not the grammar_entries id). When the pattern IS in the loaded corpus,
 * the caller prefers the richer KGIU row for full detail-fetch fidelity;
 * this is the fallback.
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

/** Loader: mock banked map (empty until the user saves something). */
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
        schedule: e.schedule,
      },
    ]),
  );
}

/**
 * Loader: mock due set — EMPTY, never fabricated. Due-ness is a scheduling
 * fact only the server knows; a fixture inventing it would badge rows "Due"
 * that aren't (the fake-data-as-real class useEndpointOrMock gates).
 */
async function loadMockDueKeys(): Promise<ReadonlySet<string>> {
  return new Set<string>();
}

/**
 * Loader: real `GET /vocab/cards/due` → the pattern keys of due grammar
 * PRODUCTION cards (F-063 — the same Anki due queue the vocab session
 * drains). The predicate mirrors `isGrammarProductionCard` in Review.tsx:
 * face + entry id + a non-empty JOINed key must all agree, so a malformed
 * row degrades to "not badged" rather than a phantom Due pill.
 */
async function loadRealDueKeys(): Promise<ReadonlySet<string>> {
  const cards = await vocabService.getDueCards();
  const keys = new Set<string>();
  for (const c of cards) {
    if (
      c.face === 'production' &&
      c.grammar_entry_id !== null &&
      typeof c.grammarPatternKey === 'string' &&
      c.grammarPatternKey.length > 0
    ) {
      keys.add(c.grammarPatternKey);
    }
  }
  return keys;
}

function Grammar(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const view = parseView(searchParams.get('view'));

  // FU-NF-42 B3: a deep-link from the Review screen lands here with a
  // `drillTarget` in router state. Read it once on mount so the practice view
  // can open focused on that pattern. We snapshot it into state (rather than
  // reading `location.state` every render) so that clearing the history
  // entry's state below — which prevents a Back/refresh from re-triggering the
  // drill — doesn't yank the target out from under the in-flight drill. The
  // target persists until CONSUMED (Skip / Next clears it): backing out of
  // practice and returning resumes the targeted pattern, which is correct —
  // the review gesture that opened it was never completed.
  const [drillTarget, setDrillTarget] = useState<DrillTarget | null>(() =>
    readDrillTarget(location.state),
  );

  // Scrub the consumed target out of the history entry AND land on the
  // practice view (`?view=practice`) in the same replace, so a Back
  // navigation or a reload doesn't replay the deep-link while the address
  // bar honestly says where the user is. Runs once on mount when a target
  // was present; `navigate(replace)` swaps the current entry without adding
  // to the stack.
  useEffect(() => {
    if (readDrillTarget(location.state)) {
      navigate(`${location.pathname}?view=practice`, {
        replace: true,
        state: null,
      });
    }
    // Mount-only: we captured the target into local state above; re-running on
    // every `location` change would clear a target before the drill consumes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Clear the focused drill target → return practice to its rotation. */
  const clearDrillTarget = useCallback((): void => {
    setDrillTarget(null);
  }, []);

  /**
   * F-158: the continuously-drilled single form, chosen explicitly via a
   * cards-row "Drill" action — the mock's form-picker. Distinct from
   * `drillTarget` above: that one is a ONE-SHOT deep link (consumed on the
   * first advance), this one is CONTINUOUS (advancing regenerates the SAME
   * pattern forever — see `PracticePanel`'s `continuous` prop).
   */
  const [formTarget, setFormTarget] = useState<DrillTarget | null>(null);

  /** F-158: row action — pick a form and jump straight into drilling it. */
  const drillForm = useCallback(
    (row: PatternListItem): void => {
      setFormTarget({
        patternKey: row.patternKey,
        display: row.pattern,
        meaning: row.title,
      });
      setSearchParams({ view: 'practice' });
    },
    [setSearchParams],
  );

  const clearFormTarget = useCallback((): void => {
    setFormTarget(null);
  }, []);

  // Leaving the practice view drops the continuous pick — a later "Practice"
  // tap must resume the normal pool rotation, not silently reopen whichever
  // form was last hand-picked.
  useEffect(() => {
    if (view !== 'practice') setFormTarget(null);
  }, [view]);

  // `formTarget` wins over a stale Review deep-link: the two entry points
  // are mutually exclusive in practice (a deep link lands on mount; a form
  // pick only happens from a click while already on this page), but a fixed
  // precedence keeps behavior deterministic if they ever did coincide.
  const activeTarget = formTarget ?? drillTarget;
  const continuousDrill = formTarget !== null;
  const clearActiveTarget = formTarget !== null ? clearFormTarget : clearDrillTarget;

  /** F-064: the top-right Practice button — push the practice view. */
  const openPractice = useCallback((): void => {
    setSearchParams({ view: 'practice' });
  }, [setSearchParams]);

  /** F-065: the practice-history view (honest stub until F-110 lands). */
  const openHistory = useCallback((): void => {
    setSearchParams({ view: 'history' });
  }, [setSearchParams]);

  // Pattern list — real first, mock fallback. The hook's `isMock` flips
  // false on a real resolve; that's how the 🅂 badge stays off here. The
  // whole corpus loads in one wide page: it feeds the practice fallback pool
  // and upgrades card rows to their richer KGIU rows (full detail fetch).
  const listState = useEndpointOrMock<PatternListItem[]>(
    'grammar:list',
    loadMockListItems,
    { realFn: loadRealListItems },
  );

  // Saved-pattern map — separate fetch so a failure on one doesn't black out
  // the other. Map<patternKey, BankedMeta> lets the row-level lookups run in
  // O(1) AND carries the bank-row id + known state the Mark-known / Relearn
  // actions need.
  const bankedState = useEndpointOrMock<ReadonlyMap<string, BankedMeta>>(
    'grammar:bank',
    loadMockBankedMeta,
    { realFn: loadRealBankedMeta },
  );

  // Due production cards (F-063) — wired to the EXISTING /vocab/cards/due
  // queue. Auxiliary decoration + practice ordering only: a failure degrades
  // to an empty set (no badges, plain rotation) via the hook's mock fallback,
  // never a blocked page or fabricated due-ness.
  const dueState = useEndpointOrMock<ReadonlySet<string>>(
    'grammar:due',
    loadMockDueKeys,
    { realFn: loadRealDueKeys },
  );
  const dueKeys = useMemo<ReadonlySet<string>>(
    () => dueState.data ?? new Set<string>(),
    [dueState.data],
  );

  // F-111: patternKey → the real FSRS schedule of that pattern's production
  // card, sourced straight off the bank fetch (the server folds `schedule`
  // into GET /grammar/bank rather than a dedicated per-pattern endpoint — see
  // the route comment). `undefined` for a key the bank map doesn't have; the
  // row lookup below normalises that to `null` (same as "never drilled").
  const scheduleByKey = useMemo<ReadonlyMap<string, GrammarCardSchedule | null>>(() => {
    const map = new Map<string, GrammarCardSchedule | null>();
    if (!bankedState.data) return map;
    for (const [key, meta] of bankedState.data) {
      map.set(key, meta.schedule);
    }
    return map;
  }, [bankedState.data]);

  // Detail Sheet state. We keep the row context alongside the fetch
  // result so the Sheet header can paint immediately while the detail
  // load resolves underneath.
  const [openRow, setOpenRow] = useState<PatternListItem | null>(null);
  const [detail, setDetail] = useState<KgiuEntryDetail | null>(null);

  // Publish the open pattern for the chat FAB's discuss-this-page popup
  // (Slice 3). Only while the detail Sheet is up — the cards list has no
  // single pattern on screen to discuss.
  useChatContext(
    openRow !== null
      ? {
          pageLabel: 'Grammar · 문법',
          summary: `${openRow.pattern} — ${openRow.title}`,
        }
      : null,
  );
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Id of the row whose detail fetch is authoritative — a slow settle for a
  // previously tapped (or since-closed) row must not paint its detail under
  // the currently open row's header. Mirrors the stale-guard in the library
  // browse's openDetail (pages/review/ReviewGrammar.tsx). Mock/banked rows
  // use negative ids, real KGIU rows positive — the namespaces never collide.
  const detailIdRef = useRef<number | null>(null);

  // Optimistic known-state overlay — patternKey → desired known state
  // (true = mark-known in flight/settling, false = relearn). Applied on top
  // of the server map so the row moves between the Learning and Known views
  // immediately, pruned once the server settle agrees so the map never grows
  // across a session.
  const [knownOverrides, setKnownOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map<string, boolean>());

  useEffect(() => {
    if (!bankedState.data) return;
    const settled = bankedState.data;
    setKnownOverrides((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map<string, boolean>();
      for (const [k, wanted] of prev) {
        const meta = settled.get(k);
        // Keep the override until the server view agrees with it; a key the
        // server doesn't know yet (optimistic save still settling) keeps its
        // override too.
        if (meta === undefined || (meta.graduatedAt !== null) !== wanted) {
          next.set(k, wanted);
        }
      }
      // Preserve identity on a no-op settle so downstream memos don't re-run.
      return next.size === prev.size ? prev : next;
    });
  }, [bankedState.data]);

  /** Effective known state for a pattern: overlay first, then server. */
  const isKnown = useCallback(
    (patternKey: string): boolean => {
      const override = knownOverrides.get(patternKey);
      if (override !== undefined) return override;
      return (bankedState.data?.get(patternKey)?.graduatedAt ?? null) !== null;
    },
    [knownOverrides, bankedState.data],
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
          errorMessageFor(err, 'Detail unavailable'),
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

  // Per-row known-state submit-in-flight + last-error.
  const [knownPendingKey, setKnownPendingKey] = useState<string | null>(null);
  const [knownError, setKnownError] = useState<string | null>(null);

  /**
   * Flip a saved pattern's known state (true = Mark known, false = Relearn).
   * Optimistic: the row hops between the Learning and Known views
   * immediately; a real failure rewinds the overlay and surfaces an inline
   * error. Requires the SERVER's bank-row id — a row that's only
   * optimistically saved (settle in flight) is a no-op here, and its action
   * button is disabled via `actionableKeys` below.
   */
  const setKnown = useCallback(
    async (row: PatternListItem, known: boolean): Promise<void> => {
      const meta = bankedState.data?.get(row.patternKey);
      if (!meta) return;
      setKnownPendingKey(row.patternKey);
      setKnownError(null);
      setKnownOverrides((prev) =>
        new Map(prev).set(row.patternKey, known),
      );
      try {
        if (known) {
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
        setKnownOverrides((prev) => {
          const next = new Map(prev);
          next.delete(row.patternKey);
          return next;
        });
        setKnownError(
          known
            ? "Couldn't mark that pattern as known. Try again."
            : "Couldn't move that pattern back to learning. Try again.",
        );
      } finally {
        setKnownPendingKey(null);
      }
    },
    [bankedState],
  );

  // Stable array identity so the `cardItems` memo doesn't re-run on
  // every render — `listState.data ?? []` would otherwise mint a fresh
  // [] each time and bust the memo.
  const items = useMemo<readonly PatternListItem[]>(
    () => listState.data ?? [],
    [listState.data],
  );

  // patternKey → KGIU list row, so a saved pattern that IS in the loaded
  // corpus can be rendered from its richer KGIU row (enabling the full
  // detail fetch) rather than the bank-row fallback.
  const itemsByKey = useMemo<ReadonlyMap<string, PatternListItem>>(() => {
    const m = new Map<string, PatternListItem>();
    for (const it of items) m.set(it.patternKey, it);
    return m;
  }, [items]);

  // The user's saved patterns sourced from the ACTUAL bank list (GET
  // /grammar/bank via `bankedState`), INDEPENDENT of the KGIU list fetch
  // (B-SF-1): a bank row whose pattern is missing from the fetched corpus
  // still renders from its own stored fields. We prefer the KGIU list row
  // when the pattern IS loaded (full detail-fetch fidelity), else fall back
  // via `bankedMetaToItem`. Insertion order follows the server's
  // `created_at DESC`, so the ordering is stable.
  const cardItems = useMemo<readonly PatternListItem[]>(() => {
    const map = bankedState.data;
    if (!map) return [];
    return Array.from(
      map.values(),
      (meta) => itemsByKey.get(meta.patternKey) ?? bankedMetaToItem(meta),
    );
  }, [bankedState.data, itemsByKey]);

  // Mastery split (F-063/F-066 vocabulary). Learning = still scheduled
  // (practice pool + due reviews); known = self-marked as known, out of
  // active learning until relearned.
  const learningItems = useMemo<readonly PatternListItem[]>(
    () => cardItems.filter((it) => !isKnown(it.patternKey)),
    [cardItems, isKnown],
  );
  const knownItems = useMemo<readonly PatternListItem[]>(
    () => cardItems.filter((it) => isKnown(it.patternKey)),
    [cardItems, isKnown],
  );
  // The practice PRIMARY pool is the user's learning cards (`learningItems`
  // — see B-SF-1). `drillableItems` is only the fallback for an account with
  // NOTHING saved, where there are no chosen patterns to protect, so
  // practising the fetched corpus is acceptable. The filter still excludes
  // known rows — practice must never serve a pattern the user marked known,
  // even via this fallback (the corpus list contains those rows too).
  const drillableItems = useMemo<readonly PatternListItem[]>(
    () => items.filter((it) => !isKnown(it.patternKey)),
    [items, isKnown],
  );
  // Rows whose bank-row id the server has confirmed — Mark known / Relearn
  // need that id, so rows still settling optimistically stay disabled.
  const actionableKeys = useMemo<ReadonlySet<string>>(
    () => new Set<string>(bankedState.data?.keys() ?? []),
    [bankedState.data],
  );

  // 🅂 badge for the cards view when BOTH wired fetches fell back to the
  // mock. Practice hits a REAL endpoint (Pass 9), so its mock signal is
  // owned by `PracticePanel` itself (which renders its own MockBadge only
  // when the generate endpoint is unreachable and it falls to a local mock
  // drill). We suppress the cards badge off the cards view so the two
  // signals don't fight over the same corner.
  const showMockBadge =
    view === 'cards' && listState.isMock && bankedState.isMock;

  const eyebrow = EYEBROW_BY_VIEW[view];

  return (
    <section
      className="screen km-grammar km-rain-sheen"
      aria-labelledby="grammar-title"
      style={{ position: 'relative' }}
    >
      {showMockBadge ? <MockBadge /> : null}

      {/* F-024: nested sub-views carry a BackButton to the canonical parent
          (the cards view). Deterministic `to` — a deep link straight into
          practice must not history-back out of the app. */}
      {view !== 'cards' ? (
        <BackButton to="/learn/grammar" label="Grammar" />
      ) : null}

      {/* F-128 devices #4/#2 — the shared hub-header recipe instead of a
          bare `Topbar`. */}
      <PageHubHeader
        titleId="grammar-title"
        eyebrow={<Bilingual en={eyebrow.en} kr={eyebrow.kr} />}
        heading={<Bilingual en="Grammar" kr="문법" />}
        actions={
          view === 'cards' ? (
            // F-064: the drill entry point is a top-right "Practice" button.
            <Button
              variant="gold"
              size="sm"
              onClick={openPractice}
              leadingIcon={<Icon name="play" size={14} />}
            >
              Practice
            </Button>
          ) : undefined
        }
      />

      {view === 'cards' ? (
        <CardsPanel
          loading={listState.loading || bankedState.loading}
          fetchErrored={
            (!listState.data && listState.error !== null) ||
            (!bankedState.data && bankedState.error !== null)
          }
          learningItems={learningItems}
          knownItems={knownItems}
          dueKeys={dueKeys}
          scheduleByKey={scheduleByKey}
          actionableKeys={actionableKeys}
          pendingKey={knownPendingKey}
          actionError={knownError}
          onOpen={(row) => {
            void openDetail(row);
          }}
          onMarkKnown={(row) => {
            void setKnown(row, true);
          }}
          onRelearn={(row) => {
            void setKnown(row, false);
          }}
          onDrillForm={drillForm}
          onBrowse={() => {
            // D3: the single grammar browse (+ Bank) lives in the library.
            navigate('/review/grammar');
          }}
          onHistory={openHistory}
          onRetry={() => {
            listState.refetch();
            bankedState.refetch();
          }}
        />
      ) : null}

      {view === 'practice' ? (
        <PracticePanel
          // ALL three pool inputs must settle before the panel builds its
          // session pool (SF-1): generating off a partial pool and letting a
          // late bank/due settle reshape it mid-answer wiped in-progress
          // answers. A deep-link target bypasses the gate (it carries its
          // own pattern).
          loading={
            listState.loading || bankedState.loading || dueState.loading
          }
          items={drillableItems}
          learningItems={learningItems}
          dueKeys={dueKeys}
          target={activeTarget}
          continuous={continuousDrill}
          onClearTarget={clearActiveTarget}
        />
      ) : null}

      {view === 'history' ? <HistoryPanel /> : null}

      <DetailSheet
        open={openRow !== null}
        row={openRow}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onClose={closeDetail}
      />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Cards panel — the saved patterns, in vocab-flashcard mastery vocabulary
// ─────────────────────────────────────────────────────────────

/**
 * Sub-views of the cards list (F-063/F-066). `learning` = saved patterns
 * still in the scheduling loop; `known` = patterns the user marked as known
 * (out of the practice pool and the due-review queue) with a Relearn path
 * back — the state names mirror the FSRS `learning` / `relearning`
 * vocabulary the vocab flashcards run on.
 */
type CardsView = 'learning' | 'known';

const CARDS_VIEWS: ReadonlyArray<{ id: CardsView; label: string }> = [
  { id: 'learning', label: 'Learning' },
  { id: 'known', label: 'Known' },
];

/**
 * B-024 grouping: the flat, separator-less list read as clutter, so rows are
 * grouped by the server's closed proficiency set into CollapsibleTiles.
 * Order is fixed easiest→hardest; only non-empty groups render.
 */
const PROFICIENCY_GROUPS: ReadonlyArray<{
  id: ServerProficiency;
  label: string;
}> = [
  { id: 'basic', label: 'Beginner · L1–L2' },
  { id: 'L3', label: 'Intermediate · L3' },
  { id: 'L4', label: 'Upper-intermediate · L4' },
  { id: 'L5+', label: 'Advanced · L5+' },
];

/**
 * F-128 device #1/#2: each proficiency group renders as its own
 * `CollapsibleTile surface="city"` signboard/hanji-paper tile with a
 * `DancheongRail` leading edge. There are exactly four groups and four fixed
 * `DancheongRailTone` values, so each group gets a distinct tone by index —
 * not a semantic difficulty→color claim (the doc reserves that kind of
 * mapping for genuinely graded signals like due/mastery), just a stable,
 * visually distinct identity per section.
 */
const GROUP_TONE_BY_INDEX: readonly DancheongRailTone[] = [
  'mint',
  'blue',
  'accent',
  'plain',
];

interface CardsPanelProps {
  loading: boolean;
  fetchErrored: boolean;
  /** Saved patterns still in the learning loop (Mark known available). */
  learningItems: readonly PatternListItem[];
  /** Patterns marked known (Relearn available). */
  knownItems: readonly PatternListItem[];
  /** Pattern keys whose production card is due for review (Due pill). */
  dueKeys: ReadonlySet<string>;
  /**
   * patternKey → real FSRS schedule (F-111), for the state/next-due line on
   * every row — not just the due-NOW ones `dueKeys` covers.
   */
  scheduleByKey: ReadonlyMap<string, GrammarCardSchedule | null>;
  /** Keys whose server bank-row id is known — action buttons enabled. */
  actionableKeys: ReadonlySet<string>;
  /** patternKey of the known-state action currently in flight, if any. */
  pendingKey: string | null;
  /** Inline error from the last failed mark-known/relearn, if any. */
  actionError: string | null;
  onOpen: (row: PatternListItem) => void;
  onMarkKnown: (row: PatternListItem) => void;
  onRelearn: (row: PatternListItem) => void;
  /** F-158: pick this pattern for the continuous single-form drill. */
  onDrillForm: (row: PatternListItem) => void;
  /** Navigate to the library's grammar browse (the single browse, D3). */
  onBrowse: () => void;
  /** Open the practice-history view (F-065). */
  onHistory: () => void;
  onRetry: () => void;
}

function CardsPanel({
  loading,
  fetchErrored,
  learningItems,
  knownItems,
  dueKeys,
  scheduleByKey,
  actionableKeys,
  pendingKey,
  actionError,
  onOpen,
  onMarkKnown,
  onRelearn,
  onDrillForm,
  onBrowse,
  onHistory,
  onRetry,
}: CardsPanelProps): JSX.Element {
  // Local view toggle — pure presentation, feeds no fetch key, so it lives
  // here rather than in the page component.
  const [view, setView] = useState<CardsView>('learning');

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        Loading your grammar cards…
      </div>
    );
  }
  if (fetchErrored) {
    return (
      <ErrorCard
        message="Your grammar cards couldn't be loaded."
        onRetry={onRetry}
      />
    );
  }

  const items = view === 'learning' ? learningItems : knownItems;
  const dueCount = learningItems.reduce(
    (n, it) => n + (dueKeys.has(it.patternKey) ? 1 : 0),
    0,
  );

  // B-024: group the visible rows by proficiency; only non-empty groups
  // render, each as a CollapsibleTile so a long deck folds away per level.
  const groups = PROFICIENCY_GROUPS.map((g) => ({
    ...g,
    rows: items.filter((it) => it.proficiency === g.id),
  })).filter((g) => g.rows.length > 0);

  return (
    <>
      <div className="km-review__tabs" role="group" aria-label="Card state">
        {CARDS_VIEWS.map((v) => {
          const selected = view === v.id;
          const count =
            v.id === 'learning' ? learningItems.length : knownItems.length;
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

      {/* Due summary — the same "N due" framing the vocab session uses.
          Rendered only when something IS due; absence of schedule data is
          silence, not a fabricated "0 due". */}
      {view === 'learning' && dueCount > 0 ? (
        <p className="km-grammar__due-note" role="status">
          {dueCount} pattern{dueCount === 1 ? '' : 's'} due for review —
          Practice serves {dueCount === 1 ? 'it' : 'them'} first.
        </p>
      ) : null}

      {actionError ? <ErrorCard message={actionError} /> : null}

      {items.length === 0 ? (
        // F-128 devices #3/#6 — honest-empty-state texture (roof-tile
        // ground + a faint hangul watermark), matching every other
        // reskinned page's empty state.
        <div
          className="km-grammar__empty-wrap km-giwa km-hangul-watermark"
          data-glyph="문법"
        >
          <Card variant="flat" role="status">
            {view === 'learning' ? (
              <>
                <Eyebrow>Nothing in learning</Eyebrow>
                <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
                  {knownItems.length > 0
                    ? 'Every card is marked as known. Tap Relearn on a card in the Known view to study it again.'
                    : 'Save patterns from the grammar library to start learning them here.'}
                </p>
                {knownItems.length === 0 ? (
                  <Button
                    variant="gold"
                    size="md"
                    onClick={onBrowse}
                    trailingIcon={<Icon name="arrow-right" size={14} />}
                  >
                    Browse all patterns
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Eyebrow>Nothing marked known yet</Eyebrow>
                <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
                  When you&apos;ve mastered a card, tap Mark known to retire it
                  from practice and reviews. It moves here, and Relearn brings
                  it back any time.
                </p>
              </>
            )}
          </Card>
        </div>
      ) : (
        groups.map((g, i) => (
          // F-128 device #1/#2: a themed city-signboard tile per proficiency
          // group instead of a plain Card, with a DancheongRail leading edge.
          <CollapsibleTile
            key={g.id}
            surface="city"
            tone={GROUP_TONE_BY_INDEX[i % GROUP_TONE_BY_INDEX.length]}
            rail
            className="km-grammar__group"
            title={
              <span className="km-grammar__group-title">
                {g.label}
                <span className="km-grammar__group-count">
                  {g.rows.length}
                </span>
              </span>
            }
          >
            {/* Explicit role: `list-style: none` (Grammar.css) makes
                Safari/VoiceOver drop the implicit list semantics (row
                count/position), so the "redundant" role is load-bearing —
                the documented exception to this lint rule. */}
            {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
            <ul className="km-grammar__list" role="list">
              {g.rows.map((row) => (
                <CardRow
                  key={row.patternKey}
                  row={row}
                  view={view}
                  due={dueKeys.has(row.patternKey)}
                  schedule={scheduleByKey.get(row.patternKey) ?? null}
                  pending={pendingKey === row.patternKey}
                  actionable={actionableKeys.has(row.patternKey)}
                  onOpen={onOpen}
                  onMarkKnown={onMarkKnown}
                  onRelearn={onRelearn}
                  onDrillForm={onDrillForm}
                />
              ))}
            </ul>
          </CollapsibleTile>
        ))
      )}

      <div className="km-grammar__panel-links">
        {/* D3: saving new patterns happens in the library's single browse. */}
        {items.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onBrowse}
            trailingIcon={<Icon name="arrow-right" size={12} />}
          >
            Browse all patterns
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={onHistory}
          leadingIcon={<Icon name="history" size={12} />}
        >
          Practice history
        </Button>
      </div>
    </>
  );
}

/**
 * FSRS state → display label, matching the vocab Anki vocabulary
 * (learning/relearning read as active study; review as the settled state).
 */
const FSRS_STATE_LABEL: Record<FsrsState, string> = {
  new: 'New',
  learning: 'Learning',
  review: 'Review',
  relearning: 'Relearning',
};

/**
 * F-111: render a pattern's real schedule line — state + next-due — from the
 * server's `GrammarCardSchedule`, or an honest "not yet practiced" when the
 * pattern has never been drilled (no production card exists). Never
 * fabricates an interval: past-due renders "due now" rather than a negative
 * day count.
 */
const ONE_DAY_MS = 86_400_000;

function scheduleStatusLine(schedule: GrammarCardSchedule | null): string {
  if (!schedule) return 'Not yet practiced';
  const label = FSRS_STATE_LABEL[schedule.state];
  const dueMs = new Date(schedule.dueAt).getTime() - Date.now();
  if (Number.isNaN(dueMs)) return label; // malformed date — state alone, no invented interval
  if (dueMs <= 0) return `${label} · due now`;
  // Sub-day intervals (a minute-scale FSRS learning/relearning step, e.g. the
  // ~6-minute HARD_STEP_DELAY_MS) must be checked BEFORE ceiling to whole
  // days — `Math.ceil` of any positive value is already >= 1, so a
  // post-ceiling `< 1` check can never fire and would misreport a 6-minute
  // step as "1 day".
  if (dueMs < ONE_DAY_MS) return `${label} · due later today`;
  const days = Math.ceil(dueMs / ONE_DAY_MS);
  return `${label} · next review in ${String(days)} day${days === 1 ? '' : 's'}`;
}

/** One saved-pattern row. The Korean form renders on ONE line (B-024 —
 *  nowrap + ellipsis in Grammar.css); the EN summary sits beneath it. */
function CardRow({
  row,
  view,
  due,
  schedule,
  pending,
  actionable,
  onOpen,
  onMarkKnown,
  onRelearn,
  onDrillForm,
}: {
  row: PatternListItem;
  view: CardsView;
  due: boolean;
  schedule: GrammarCardSchedule | null;
  pending: boolean;
  actionable: boolean;
  onOpen: (row: PatternListItem) => void;
  onMarkKnown: (row: PatternListItem) => void;
  onRelearn: (row: PatternListItem) => void;
  onDrillForm: (row: PatternListItem) => void;
}): JSX.Element {
  return (
    <li className="km-grammar__row">
      <button
        type="button"
        onClick={() => {
          onOpen(row);
        }}
        className="km-grammar__row-btn focusring"
        aria-label={`${row.pattern} ${row.title}`}
      >
        <span className="km-grammar__row-head">
          <span className="kr km-grammar__row-kr">{row.pattern}</span>
          {due ? <Pill tone="gold">Due</Pill> : null}
          {/* F-128 device #7: a Known row's standing carries a milestone
              seal (mirrors ReviewGrammar's graduated-row treatment) —
              purely decorative next to the real "Known"/"Relearn" action. */}
          {view === 'known' ? (
            <SealStamp milestone size="sm" tone="mint" />
          ) : null}
        </span>
        <span className="km-grammar__row-title">{row.title}</span>
        <span className="km-grammar__row-schedule">{scheduleStatusLine(schedule)}</span>
      </button>
      <div className="km-grammar__row-actions">
        {/* F-158: the cards list doubles as the "pick a form" picker — any
            saved pattern, Learning or Known, can be sent into a continuous
            single-form drill (matches the design mock, where every row is
            drillable regardless of its mastery pill). */}
        <Button
          variant="ghost"
          size="sm"
          className="km-grammar__row-action"
          onClick={() => {
            onDrillForm(row);
          }}
          leadingIcon={<Icon name="play" size={12} />}
          aria-label={`Drill ${row.pattern} continuously`}
        >
          Drill
        </Button>
        {view === 'learning' ? (
          <Button
            variant="ghost"
            size="sm"
            className="km-grammar__row-action"
            onClick={() => {
              onMarkKnown(row);
            }}
            disabled={pending || !actionable}
            aria-label={`Mark ${row.pattern} as known`}
          >
            {pending ? 'Saving…' : 'Mark known'}
          </Button>
        ) : (
          <Button
            variant="gold"
            size="sm"
            className="km-grammar__row-action"
            onClick={() => {
              onRelearn(row);
            }}
            disabled={pending || !actionable}
            aria-label={`Relearn ${row.pattern}`}
          >
            {pending ? 'Saving…' : 'Relearn'}
          </Button>
        )}
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────
// History panel — F-065 honest stub (no read endpoint exists yet)
// ─────────────────────────────────────────────────────────────

/**
 * F-065/F-110: every SCORED practice attempt (pattern, drill type, answer,
 * score, verdict, scored-at) is now readable via `GET /grammar-drill/attempts`
 * — the honest stub is retired. Newest first, paged (`Load more` walks the
 * offset); a generated-but-never-submitted attempt (a Skip) never appears —
 * the server excludes it (see the route's comment) so this view never shows
 * a blank row with no answer/score to speak of.
 */
const HISTORY_PAGE_SIZE = 20;

/** Drill-type → display label for the history list. */
const DRILL_TYPE_LABEL: Record<DrillAttemptHistoryRow['drill_type'], string> = {
  transformation: 'Transformation',
  cloze: 'Cloze',
  conversation: 'Conversation',
};

/** Best-effort readable date for a history row; falls back to the raw ISO
 *  string rather than throwing on a malformed value. */
function formatHistoryDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function HistoryPanel(): JSX.Element {
  const [attempts, setAttempts] = useState<DrillAttemptHistoryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback((offset: number, append: boolean): void => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        const page = await listAttempts(
          { limit: HISTORY_PAGE_SIZE, offset },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setAttempts((prev) =>
          append && prev ? [...prev, ...page.attempts] : page.attempts,
        );
        setTotal(page.total);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, "Your practice history couldn't be loaded."),
        );
      } finally {
        // Guard rather than `return` inside finally (no-unsafe-finally): a
        // return here would swallow the try/catch completion. When aborted,
        // simply skip clearing the loading flags.
        if (!ctrl.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    })();
  }, []);

  useEffect(() => {
    load(0, false);
    return () => {
      ctrlRef.current?.abort();
    };
    // Mount-only fetch; `load` is intentionally excluded from deps — its
    // identity is stable (empty dep array) but re-adding it here would only
    // add churn, not behavior. Retry/Load-more call it directly on click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        Loading practice history…
      </div>
    );
  }

  const rows = attempts ?? [];

  if (error && rows.length === 0) {
    return (
      <ErrorCard
        message={error}
        onRetry={() => {
          load(0, false);
        }}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className="km-grammar__empty-wrap km-giwa km-hangul-watermark"
        data-glyph="문법"
      >
        <Card variant="flat">
          <Eyebrow>Practice history</Eyebrow>
          <p style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
            No scored practice attempts yet. Answers you submit in Practice
            will appear here, newest first.
          </p>
        </Card>
      </div>
    );
  }

  const canLoadMore = rows.length < total;

  return (
    <>
      {error ? (
        <ErrorCard
          message={error}
          onRetry={() => {
            load(rows.length, true);
          }}
        />
      ) : null}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- see the
          identical CardsPanel list note: list-style:none drops the implicit
          list semantics in Safari/VoiceOver. */}
      <ul className="km-grammar__list" role="list">
        {rows.map((a) => (
          <HistoryRow key={a.id} attempt={a} />
        ))}
      </ul>
      {canLoadMore ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            load(rows.length, true);
          }}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </>
  );
}

/** One scored practice attempt — pattern, drill type, score/verdict, date. */
function HistoryRow({ attempt }: { attempt: DrillAttemptHistoryRow }): JSX.Element {
  const verdict = VERDICT_META[attempt.verdict];
  return (
    <li className="km-grammar__row">
      <div className="km-grammar__row-static">
        <span className="km-grammar__row-head">
          <span className="kr km-grammar__row-kr">{attempt.pattern_display}</span>
          <Pill tone={verdict.tone}>{verdict.label}</Pill>
        </span>
        <span className="km-grammar__row-title">
          {DRILL_TYPE_LABEL[attempt.drill_type]} · {attempt.score}/100 ·{' '}
          {formatHistoryDate(attempt.scored_at)}
        </span>
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────
// Practice panel — Pass-9 live production drill (generate → submit → reveal)
// ─────────────────────────────────────────────────────────────

interface PracticePanelProps {
  loading: boolean;
  /**
   * Drillable patterns — the fetched list MINUS known ones. The parent
   * filters known-state out before this panel sees anything, so the fallback
   * pool below can never serve a pattern the user marked as known.
   */
  items: readonly PatternListItem[];
  /**
   * The user's LEARNING subset of `items` (saved and not marked known).
   * When non-empty this is the PREFERRED practice pool — the learner drills
   * the patterns they chose to save; the full drillable list is the fallback
   * for a fresh account with nothing saved yet.
   */
  learningItems: readonly PatternListItem[];
  /**
   * Pattern keys whose production card is DUE (F-063). Due patterns form a
   * session-local queue the panel drains BEFORE the cursor rotation — the
   * same due-first ordering the vocab session gets from `/vocab/cards/due`.
   */
  dueKeys: ReadonlySet<string>;
  /**
   * FU-NF-42 B3 / F-158: an externally-supplied pattern to drill (a Review
   * deep-link, or an F-158 continuous form pick). When set, the panel
   * generates a drill for THIS pattern instead of its default pool rotation.
   * `null` → the existing rotation behaviour.
   */
  target?: DrillTarget | null;
  /**
   * F-158: `target` is a CONTINUOUS pick (the cards-row "Drill" action) —
   * advancing NEVER clears it or moves to a different pattern; it instead
   * regenerates a fresh drill for the same `target` forever. `false` (the
   * FU-NF-42 deep-link default) keeps the existing one-shot behaviour:
   * advancing clears `target` via `onClearTarget` and falls back to the
   * rotation.
   */
  continuous?: boolean;
  /**
   * Invoked when the learner moves past the targeted pattern (Skip / Next), so
   * the parent can drop the deep-link target and the panel falls back to its
   * normal rotation. No-op when no target was supplied, and never invoked
   * while `continuous` is true (there is nothing to fall back to — the panel
   * regenerates in place instead).
   */
  onClearTarget?: () => void;
}

/** Minimal source a PracticePanel needs to generate a drill for one pattern. */
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
 * Claude score, hence the 🅂 badge that accompanies it. Deliberately carries
 * NO `schedule`: offline pseudo-scoring must not fabricate an FSRS rating or
 * interval.
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
 * was `useState(0)` inside the panel, which unmounts on EVERY view switch and
 * on reload — so each visit restarted the rotation at `items[0]`, the first
 * id-ordered corpus row (N이다). Live evidence: all five
 * `grammar_drill_attempts` rows from the 2026-07-02 session carry
 * `pattern_key = 'kgiu-beginner-002'` and the LB log shows each generate was
 * a fresh mount, never a rotation step.
 *
 * The cursor therefore lives in localStorage: it survives remounts, view
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

/** The session's practice pool: the due queue + the cursor rotation. */
interface DrillPool {
  /** Patterns whose production card is due — drained FIRST, in order. */
  due: readonly PatternListItem[];
  /** The remaining rotation, served via the persisted cursor. */
  rest: readonly PatternListItem[];
}

const EMPTY_POOL: DrillPool = { due: [], rest: [] };

/** Partition the practice base into the due queue + the rotation (F-063).
 *  Base = the learner's saved learning patterns when any exist (drilling
 *  what they chose to study), else the full fetched KGIU list.
 *  `learningItems ⊆ items`, so an empty `items` implies an empty pool. */
function partitionPool(
  items: readonly PatternListItem[],
  learningItems: readonly PatternListItem[],
  dueKeys: ReadonlySet<string>,
): DrillPool {
  const base = learningItems.length > 0 ? learningItems : items;
  if (dueKeys.size === 0) return { due: [], rest: base };
  const due: PatternListItem[] = [];
  const rest: PatternListItem[] = [];
  for (const it of base) {
    (dueKeys.has(it.patternKey) ? due : rest).push(it);
  }
  return { due, rest };
}

function PracticePanel({
  loading,
  items,
  learningItems,
  dueKeys,
  target = null,
  continuous = false,
  onClearTarget,
}: PracticePanelProps): JSX.Element {
  // Which pattern (by index into the NON-DUE rotation) we're drilling.
  // Wraps with `%`. Initialised from the PERSISTED cursor so a remount
  // (view switch, reload) resumes the rotation where the learner left off
  // instead of resetting to the first pattern — see
  // DRILL_CURSOR_STORAGE_KEY for the live bug this fixes.
  const [idx, setIdx] = useState<number>(readDrillCursor);
  // Session-local walk through the DUE partition (F-063 due-first, B-1).
  // Due cards are a finite queue the session drains BEFORE the rotation —
  // exactly like the vocab due session. Deliberately session-local and NOT
  // fed by the persisted cursor: indexing the partitioned pool with the
  // monotonically-growing `idx` (`pool[idx % pool.length]`) almost never
  // landed on the due partition after any prior practice, silently
  // defeating the due-first ordering the cards view promises.
  const [duePos, setDuePos] = useState(0);

  // Practice pool, SNAPSHOTTED once per session (SF-1): frozen on the first
  // render after all three pool inputs settle (`loading` gates until then),
  // so a later bank/due settle can't reshape the pool mid-answer — that
  // swap re-fired the generate effect and wiped the in-progress answer.
  const poolRef = useRef<DrillPool | null>(null);
  if (poolRef.current === null && !loading) {
    poolRef.current = partitionPool(items, learningItems, dueKeys);
  }
  const pool = poolRef.current ?? EMPTY_POOL;
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
  // drill exactly that pattern (it carries its own display + meaning, so it
  // works even with an empty/mock list fetch). Otherwise the session serves
  // the DUE queue first, then the persisted `idx` rotation over the rest;
  // with nothing but due patterns the due queue wraps so practice never
  // dead-ends.
  const servingDue =
    pool.due.length > 0 &&
    (duePos < pool.due.length || pool.rest.length === 0);
  const source: DrillSource | null = target
    ? targetToSource(target)
    : servingDue
      ? rowToSource(pool.due[duePos % pool.due.length]!)
      : pool.rest.length > 0
        ? rowToSource(pool.rest[idx % pool.rest.length]!)
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
    // `idx`/`duePos` + `patternKey` are the stable triggers (`source` is a
    // fresh object each render). A deep-link target swaps the `patternKey`
    // (vs. the rotation), so it re-fires the generate cleanly; `duePos`
    // covers the single-due-pattern wrap where the key doesn't change. The
    // display/meaning are read off the same source, so the minimal deps
    // hold. `genTick` re-fires the SAME pattern after a PROD generate
    // failure (the ErrorCard's Retry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, duePos, patternKey, genTick]);

  // Move past the current pattern. With a CONTINUOUS target (F-158) there is
  // deliberately no "past" — Skip/Next just bumps `genTick` to re-fire the
  // generate effect for the SAME patternKey (the identical mechanism a PROD
  // generate-failure Retry already uses), so the learner gets an endless
  // stream of fresh sentences for the one form they picked. With a ONE-SHOT
  // deep-link target (FU-NF-42) there is no rotation to advance into either,
  // so we drop the target (→ parent clears it) and the panel falls back to
  // its pool. Otherwise, while the due queue is being drained we advance the
  // session-local `duePos` — the persisted rotation cursor must NOT move past
  // rest-patterns it never served. Otherwise we bump `idx` AND persist the
  // new cursor, so the step survives a remount — Skip / Next pattern
  // deterministically moves to a different pattern instead of regenerating
  // the same one after any view switch.
  const advance = useCallback((): void => {
    submitCtrlRef.current?.abort();
    if (target) {
      if (continuous) {
        setGenTick((t) => t + 1);
        return;
      }
      onClearTarget?.();
      return;
    }
    if (servingDue) {
      setDuePos((p) => p + 1);
      return;
    }
    setIdx((i) => i + 1);
  }, [target, continuous, onClearTarget, servingDue]);

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
  // empty/mock list fetch — only gate the loading/empty states when there's
  // no target to fall back on. The loading gate holds until ALL pool inputs
  // settle (SF-1): the session pool is frozen from the settled data above,
  // never from a partial snapshot a late settle would reshape.
  if (loading && !target) {
    return (
      <div className="km-grammar__state" role="status">
        Loading practice…
      </div>
    );
  }
  if (pool.due.length + pool.rest.length === 0 && !target) {
    return (
      // F-128 devices #3/#6 — same honest-empty texture as the cards view.
      <div
        className="km-grammar__empty-wrap km-giwa km-hangul-watermark"
        data-glyph="문법"
      >
        <div className="km-grammar__state" role="status">
          No grammar cards to practice yet. Save patterns from the grammar
          library (Review → Grammar) first.
        </div>
      </div>
    );
  }

  return (
    <>
      {isMock ? <MockBadge /> : null}
      {/* F-158: make the continuous single-form mode legible — the footer
          button copy alone (below) isn't enough context on first entry. */}
      {continuous && target ? (
        <p className="km-grammar__continuous-note" role="status">
          Drilling <span className="kr">{target.display}</span> only —{' '}
          <strong>Another</strong> gets a fresh sentence for this same form.
        </p>
      ) : null}
      {genError !== null ? (
        // PROD generate failure — there is no item (and hence no DrillCard),
        // so the error renders at panel level with its OWN Retry that
        // re-generates. Fixed copy, never server prose.
        <ErrorCard message={genError} onRetry={retryGenerate} />
      ) : phase === 'generating' || !item ? (
        <CityCard rail tone="accent" className="km-grammar__card" aria-busy="true">
          <div className="km-grammar__state" role="status">
            Generating drill…
          </div>
        </CityCard>
      ) : (
        <DrillCard
          item={item}
          phase={phase}
          score={score}
          userInput={userInput}
          error={error}
          continuous={continuous}
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
  /** F-158: continuous single-form mode — relabels Skip/Next as "Another"
   *  since there is no different pattern to move to or skip past. */
  continuous?: boolean;
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
  continuous = false,
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
    // F-128 device #1/#2: the live drill is the page's actual hero
    // surface — a CityCard signboard with a rail, not a plain Card.
    <CityCard rail tone="accent" className="km-grammar__card">
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

      {/* WCAG 4.1.3: ONE persistent live region announces the async status
          changes — "scoring" while in flight, then the score/verdict/
          schedule when the reveal mounts. Persistent + text-swap because a
          live region INSERTED already populated (e.g. role="status" inside
          the reveal itself) is unreliably announced; and a single region
          keeps it to one announcement per state change. The failure path
          stays on ErrorCard's role="alert". */}
      <p role="status" className="km-sr-only">
        {scoring
          ? 'Scoring your answer…'
          : phase === 'revealed' && score !== null
            ? revealAnnouncement(score)
            : ''}
      </p>
      {scoring ? (
        // Visual only — the live announcement comes from the region above.
        <div className="km-grammar__state">Scoring your answer…</div>
      ) : null}

      {error ? (
        <ErrorCard message={error} onRetry={onRetry} />
      ) : null}

      {revealed ? <DrillReveal score={score} revealId={revealId} /> : null}

      <div className="km-grammar__footer">
        {!revealed ? (
          <>
            <Button variant="ghost" onClick={onSkip} disabled={scoring}>
              {continuous ? 'Another' : 'Skip'}
            </Button>
            <Button variant="gold" onClick={onSubmit} disabled={!canSubmit}>
              {scoring ? 'Scoring…' : 'Submit'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onSkip}>
              {continuous ? 'Another' : 'Skip'}
            </Button>
            <Button
              variant="gold"
              onClick={onNext}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              {/* Continuous mode never moves to a DIFFERENT pattern —
                  "Next pattern" would misstate what this button does. */}
              {continuous ? 'Another' : 'Next pattern'}
            </Button>
          </>
        )}
      </div>
    </CityCard>
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

      {/* FU-NF-42 B2 + F-063: the server-derived production schedule, named
          with the SAME Again/Hard/Good/Easy rating vocabulary the vocab
          session's rating buttons use. Announced to AT via DrillCard's
          persistent role="status" line (WCAG 4.1.3) — the textarea's
          `aria-describedby` alone would never surface it, since describedby
          is only read on focus and the textarea is disabled once revealed.
          Omitted when the server didn't return a schedule (pre-bump server /
          offline mock). */}
      {score.schedule ? (
        <p className="km-grammar__schedule">{scheduleLine(score.schedule)}</p>
      ) : null}
    </Card>
  );
}

/**
 * The FSRS rating names, EXACTLY as the vocab session's rating buttons label
 * them (Review.tsx `RATINGS`) — F-063's shared mastery vocabulary. Grammar
 * has no self-rate buttons (the server derives the rating from the Claude
 * verdict), so the reveal NAMES the derived rating instead.
 */
const RATING_LABEL: Record<FsrsRating, string> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
};

/**
 * Render the schedule line from a production schedule, leading with the
 * derived FSRS rating (vocab vocabulary — F-063). `scheduledDays <= 0` is a
 * minute-scale relearning step whose TRUE delay depends on the rating
 * (server fsrs.ts: RELEARN_DELAY_MS = 50s for `again`,
 * HARD_STEP_DELAY_MS = 6 min for `hard`) — so the copy branches on the
 * rating to mirror the vocab session's `<1m` / `6m` button subs instead of
 * misstating a shared "~10 minutes" (B-034). A 1-day interval drops the
 * plural so it reads "1 day" not "1 days".
 */
function scheduleLine(schedule: DrillSchedule): string {
  const rated = `Rated ${RATING_LABEL[schedule.rating]}`;
  if (schedule.scheduledDays <= 0) {
    const soon =
      schedule.rating === 'again' ? 'in under a minute'
      : schedule.rating === 'hard' ? 'in ~6 minutes'
      : // Defensive: good/easy schedule ≥ 1 day on this engine, so this arm
        // is unreachable today — stay vague rather than invent a number.
        'later today';
    return `${rated} · next review ${soon}`;
  }
  const days = schedule.scheduledDays;
  return `${rated} · next review in ${String(days)} day${days === 1 ? '' : 's'}`;
}

/**
 * One-line SR announcement for the reveal (WCAG 4.1.3) — score, verdict,
 * and the schedule when the server returned one. Rendered into DrillCard's
 * persistent `role="status"` region.
 */
function revealAnnouncement(score: DrillScore): string {
  const schedule = score.schedule ? ` ${scheduleLine(score.schedule)}.` : '';
  return `Scored ${String(score.score)} of 100 — ${VERDICT_META[score.verdict].label}.${schedule}`;
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
  onClose: () => void;
}

/**
 * Pattern-detail Sheet. Post-P1.2 every row that opens this sheet comes from
 * the cards view (the browse tab moved to the library), so the old Bank
 * action is gone — a static "Saved" pill states the row's standing instead.
 * Saving new patterns happens on /review/grammar.
 */
function DetailSheet({
  open,
  row,
  detail,
  loading,
  error,
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
          <Pill tone="gold">Saved</Pill>
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
