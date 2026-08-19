/**
 * Hanja screen — 한자 character study.
 *
 * Root views, locally state-toggled:
 *   - `today` — `HanjaFeature` card for the day's featured character,
 *               vermilion 田 grid backdrop, 96px serif glyph, compound
 *               word chips beneath a `GoldRule`.
 *   - `index` — filter chips (All / Mastered / Practicing / New) over a
 *               grid of `<HanjaCell>`s, windowed by `usePagination` +
 *               `<ShowMore>` so a large corpus doesn't render at once.
 *
 * Nested sub-views (Phase 3C-1), routed on the `view` search param so each
 * is deep-linkable and gets a real `<BackButton>` (F-024):
 *   - `?view=study`          — FSRS flashcard drill over due hanja cards
 *                              (F-075/B-028). Mirrors the vocab Review
 *                              session: flip, 4 self-ratings, spacebar
 *                              reveal, server-authoritative scheduling.
 *   - `?view=lists`          — hanja list index + creation (F-075/F-166).
 *   - `?view=list&id=N`      — one list's characters: remove, seed the
 *                              whole list into the deck, bulk-add more
 *                              characters (F-166), paginated rows.
 *   - `?view=draw&char=X`    — the drawing drill (F-076), reworked for
 *                              Wave-2 (F-165) into an Anki-style right/
 *                              wrong loop over a small session queue that
 *                              feeds the SAME real mastery pool the index
 *                              (F-167) and the drill's own progress bar
 *                              (F-170) read. F-115 adds a second, NON-GRADED
 *                              Trace mode (product decision: no stroke
 *                              dataset, no automated grading): the target
 *                              character renders as a faint template BEHIND
 *                              the same drawing canvas so the user traces
 *                              over it; a plain Next advances the queue and
 *                              nothing is judged or written. A Recall/Trace
 *                              toggle switches modes; the Recall loop is
 *                              untouched.
 *
 * Tapping any cell or the feature card opens a `<Sheet>` with the
 * etymology + compound network + drill / bank / draw / add-to-list CTAs.
 * Per design `screens-c.jsx` HanjaDetailSheet — only the studied character
 * is vermilion inside each compound; the other glyphs stay paper ink.
 *
 * Wave-2 ("Seoul Day & Night", `DESIGN_SEOUL_DAY_NIGHT.md`) — F-128 + the
 * page's own ticket set:
 *   - F-128 reskin: the shared `PageHubHeader` (skyline + dancheong rail)
 *     replaces the bare `Topbar`; the featured card and the encountered
 *     band are `CityCard` signboards/hanji-paper with a rail leading edge;
 *     empty states carry the hangul-watermark + giwa texture; the root
 *     carries the ambient rain-sheen (Night-only); a mastery moment (deck
 *     clear / drill complete) gets a milestone `SealStamp` with a sparing
 *     najeon shimmer. Every CityCard/CollapsibleTile-city surface on this
 *     page uses `tone="ochre"` (batch-3 fix-pass: `DancheongRailTone` /
 *     `CityCardTone` gained a dedicated `ochre` value — the Hanja skill
 *     hue — so this page no longer has to fall back to `plain`, the same
 *     workaround `Today.tsx`'s own Hanja tile still uses; see that page's
 *     own follow-up ticket to adopt `ochre` too, tracked separately since
 *     Today is out of this batch's edit scope). The two `SubwayProgress`
 *     instances deliberately keep `tone="accent"` instead — a session
 *     progress fill tracking the user's chosen accent reads as reward, not
 *     as "this is Hanja," so it's a different, still-correct choice.
 *   - F-164 spacing / F-129 mobile: tightened gutters + vertical rhythm and
 *     a narrow-viewport clamp on the two fixed-size glyph squares, applied
 *     as page-scoped overrides in `Hanja.css` (see that file's header note
 *     — most of this page's classnames are defined in the SHARED
 *     `styles/index.css`, out of this pass's edit scope, so overrides use
 *     a `.screen.km-hanja …` prefix to win the cascade on specificity
 *     rather than load order).
 *   - F-165: the draw drill now runs a real right/wrong loop
 *     (`buildDrawQueue`/`promoteState`) over `Hanja.state` — the SAME
 *     three-band signal (`new` → `practicing` → `banked`) the index colors
 *     (F-167) and the encountered band already track. A right answer
 *     promotes the character one band via the existing `onSetState` (no
 *     parallel/fabricated mastery signal); a wrong answer just re-queues
 *     it, no write. `F-171` (Wave-2 follow-ups) already names the gap this
 *     inherits: there is no per-attempt Hanja history endpoint, so a daily
 *     "drilled today" count (unlike Grammar/Writing/TOPIK) still isn't
 *     available — this page can only read the lifetime band, which is what
 *     it does.
 *   - F-166: a `Sheet`-based create-list popup (mirroring
 *     `MyVocabLists.tsx`'s pattern) replaces the always-visible inline
 *     create form, plus a new bulk `AddHanjaPicker` sheet on the list
 *     detail view for adding characters INTO a list (the existing
 *     `AddToListTile` in the character detail sheet already covers the
 *     other direction — one character into a list).
 *   - F-167: index tiles color by the real `Hanja.state` band via
 *     `HanjaCell`'s own shared classes. Batch-3 fix-pass (2 BLOCKERs,
 *     `REVIEW_batch3-hanja.md`): the shared classes used to read
 *     accent-tracking `--vermilion` for `practicing` (silently recolored
 *     with the user's accent choice) and `--danger`/red for `new` (a
 *     never-studied character misread as "trouble") — both fixed at the
 *     SHARED layer (`styles/index.css`'s new `--km-mastery-*` triad, fixed
 *     + AA-checked in both themes), which retired this page's own
 *     `.km-hanja__grid` CSS override entirely rather than deepening it.
 *   - F-168: each index tile gets a "+" quick-add affordance opening a
 *     lightweight `QuickAddSheet` (existing lists, tap-to-add, inline
 *     create) with an "added to list" toast confirmation.
 *   - F-169: the index tiles pass `HanjaCell` only `sound` (the hangul
 *     reading), never `gloss` (the Korean gloss WORD) — `HanjaCell`
 *     already renders the gloss caption only when it receives one, so
 *     simply omitting the prop is the fix.
 *   - F-170: a live `SubwayProgress` bar drives both drill loops (the FSRS
 *     study session and the new Anki draw-drill queue), tracking real
 *     session position/mastered-count — not a fabricated animation. The
 *     pre-existing Encountered-band bar (`EncounteredBand`, unchanged
 *     logic) already recomputes live off the same optimistic overlay, so
 *     the aggregate mastery reading was already real; these two are the
 *     new PER-SESSION "drill progress" readings the ticket asks for.
 *
 * Data:
 *   - `GET /hanja`, `GET /hanja/today`, `GET /hanja/progress` via
 *     `useEndpointOrMock` (dev-only 🅂 badge while a source is on its mock
 *     fallback); `POST /hanja/:char/state` with the optimistic overlay
 *     described at `onSetState`.
 *   - Flashcards (F-075/B-028): `POST /hanja/:char/card` (idempotent seed),
 *     `GET /hanja/cards/due`, `POST /hanja/cards/:cardId/reviews`
 *     (`expected_version` optimistic concurrency; 409 = stale → refresh).
 *   - Lists (F-075/F-166): `GET /vocab/lists?kind=hanja`, `POST /vocab/lists`
 *     (kind 'hanja'), `GET /vocab/lists/:id` (049 multitype rows),
 *     `POST /vocab/lists/:id/entries` (typed hanja items; 409 = duplicate),
 *     `DELETE …/entries/:id?type=hanja`, `DELETE /vocab/lists/:id`.
 *   The sub-views fetch directly (abortable AbortController effects with
 *   real error + retry paths) — they have no mock fixtures, so routing them
 *   through `useEndpointOrMock` would only fabricate an empty fallback. The
 *   new `AddHanjaPicker` follows the same convention: it fetches the whole
 *   `GET /hanja` pool itself when it opens, rather than threading the
 *   root's pool through props into an unrelated sub-view.
 *
 * Accessibility:
 *   - The view toggle is a `role="tablist"` of `role="tab"` buttons whose
 *     selected state is `aria-selected` (matching Grammar.tsx / Review.tsx).
 *   - The filter chips are plain `<button>`s (a `role="toolbar"`), so they
 *     use `aria-pressed` for their toggled state — correct for buttons.
 *   - Study ratings are a `role="group"` of buttons; submit failures are
 *     `role="alert"`; the reveal is the shared `Flashcard` contract.
 *   - The drawing canvas is pointer-only by nature; the drill's "About"
 *     tile states that plainly and links keyboard/AT users to the
 *     flashcard drill, which exercises the same recall. Reveal/undo/clear
 *     are real buttons; the reveal toggle carries `aria-pressed`. The new
 *     Right/Wrong judgment is a `role="group"` of real buttons too — no
 *     drag/swipe gesture required to advance the drill. The F-115
 *     Recall/Trace mode toggle follows the filter-chip pattern (plain
 *     buttons in a `role="group"`, toggled state on `aria-pressed`); the
 *     trace template glyph is `aria-hidden` decoration behind the canvas
 *     (same treatment as the recall reveal ghost).
 *   - Nested views carry a `BackButton` with an explicit `to` (F-024) so
 *     deep links can never strand the user.
 *   - Mastery color (F-167) is never the ONLY carrier of state: every
 *     index tile's accessible name still includes the hangul reading
 *     (F-169), and the color mapping only supplements the detail sheet's
 *     own named state pill, which a screen-reader user reaches by opening
 *     the tile.
 *
 * Threat model: reads are GETs (no CSRF surface); every write is a POST /
 * DELETE defended by the `SameSite=Strict` session cookie and user-scoped
 * server-side. No user input flows into HTML outside React's escaping; all
 * error copy is author-controlled via `errorMessageFor` (never server
 * prose). A failed `setHanjaState` applies NO optimistic overlay entry (the
 * overlay is written only after the await resolves). Review scheduling is
 * server-authoritative — the client sends only its rating + the card's
 * `expected_version`, so a tampered client cannot park or rush a card. The
 * new picker/quick-add sheets reuse the exact same seed-then-membership
 * write pair `AddToListTile` already used — no new write surface, just a
 * second, faster entry point onto it. Toast messages are fixed, author-
 * controlled copy (never server prose), matching `errorMessageFor`'s
 * existing contract.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Bilingual } from '../components/Bilingual';
import { CityCard } from '../components/CityCard';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { FilterSelect } from '../components/FilterSelect';
import { Flashcard } from '../components/Flashcard';
import { GoldRule } from '../components/GoldRule';
import { HanjaCell } from '../components/HanjaCell';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { PageHubHeader } from '../components/PageHubHeader';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { Sheet } from '../components/Sheet';
import { ShowMore } from '../components/ShowMore';
import { SubwayProgress } from '../components/SubwayProgress';
import { TianGrid } from '../components/TianGrid';
import { useToast } from '../components/useToast';
import {
  loadHanjaMock,
  loadHanjaProgressMock,
  loadHanjaTodayMock,
} from '../data/mocks/hanja';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { usePagination } from '../hooks/usePagination';
import {
  encounteredBarAria,
  hanjaProgressSummary,
} from '../lib/encounteredBar';
import { errorMessageFor } from '../lib/errorCopy';
import { isInteractiveElement } from '../lib/interactiveElement';
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import {
  addHanjaToList,
  fetchHanjaDueCards,
  fetchHanjaList,
  fetchHanjaListDetail,
  fetchHanjaLists,
  fetchHanjaProgress,
  fetchHanjaToday,
  removeHanjaFromList,
  seedHanjaCard,
  setHanjaState,
  submitHanjaCardReview,
  type HanjaDueCard,
  type HanjaListEntryRow,
} from '../services/hanja';
import { createList, deleteList } from '../services/vocab';
import type {
  FsrsRating,
  Hanja,
  HanjaProgress,
  HanjaState,
  ServerVocabList,
} from '../types/domain';
import './Hanja.css';

type ViewMode = 'today' | 'index';
type FilterMode = 'all' | HanjaState;
/** Nested sub-view, parsed off the `view` search param. */
type SubView = 'study' | 'lists' | 'list' | 'draw';
/** F-115 — the draw drill's two modes. `recall` is the F-165 Anki loop
 *  (draw from memory → self-judge Right/Wrong → mastery write). `trace` is
 *  the guided trace-along: the character shows as a faint template behind
 *  the canvas, a plain Next advances the queue, and NOTHING is graded or
 *  written (product decision — no stroke dataset, no automated grading). */
type DrawMode = 'recall' | 'trace';

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const HANJA_NAV = navItem('hanja');

/** Canonical route — sub-view links + BackButton targets build on this. */
const HANJA_PATH = '/learn/hanja';

/** Due cards drawn per study session (server caps the page at 200). */
const STUDY_SESSION_LIMIT = 50;

/** `duration_ms` binds to INTEGER server-side — clamp before sending. */
const INT4_MAX = 2_147_483_647;

/** Index-grid window (usePagination). The pool is one fetch; the window
 *  only bounds render cost, so the cap is generous. */
const GRID_WINDOW = { initial: 48, step: 48, max: 960 } as const;

/** List-detail row window. */
const LIST_WINDOW = { initial: 30, step: 30, max: 300 } as const;

/** F-165 — the draw-drill Anki session cap. A finite, honest session size
 *  (mirrors `STUDY_SESSION_LIMIT`'s precedent) so tapping "Drawing drill" on
 *  one character doesn't silently balloon into a queue over the entire
 *  corpus. */
const DRAW_SESSION_LIMIT = 20;

/** Characters shown to the F-166 bulk add-hanja picker before "type to
 *  narrow" — a render-cost cap, not a data cap (the fetch itself still
 *  pulls the whole pool so search always has the full corpus to filter). */
const PICKER_RENDER_CAP = 100;

const FILTER_OPTIONS: ReadonlyArray<{
  id: FilterMode;
  label: string;
  kr: string;
}> = [
  { id: 'all', label: 'All', kr: '전체' },
  { id: 'banked', label: 'Mastered', kr: '숙달' },
  { id: 'practicing', label: 'Practicing', kr: '연습 중' },
  { id: 'new', label: 'New', kr: '신규' },
];

/** F-077 reword — the `banked` STATE ID is wire/API vocabulary and never
 *  changes, but its display label is now "Mastered"/"숙달": the old
 *  "Banked"/"담김" (a vocab-mining metaphor) collided with the app's decided
 *  mastery vocabulary (Progress's word-mastery bucket is already
 *  Mastered/숙달, and the index grid styles this state with
 *  `--km-mastery-mastered`). One concept, one word, on every surface. */
const STATE_PILL_LABEL: Record<HanjaState, string> = {
  banked: 'Mastered',
  practicing: 'Practicing',
  new: 'New',
};

/** Korean chrome labels for the three hanja states. `banked` reads 숙달 to
 *  match Progress's mastery buckets (F-077 — replaced the P3b-era 담김). */
const STATE_PILL_KR: Record<HanjaState, string> = {
  banked: '숙달',
  practicing: '연습 중',
  new: '신규',
};

const STATE_PILL_TONE = {
  banked: 'green',
  practicing: 'gold',
  new: 'default',
} as const;

/** FSRS self-ratings for the study drill. The interval subs mirror the
 *  vocab session's rating buttons EXACTLY (Review.tsx `RATINGS`, B-021) and
 *  are pinned to the same retuned server engine hanja reviews run through
 *  (`applyCardReview` → server/src/services/fsrs.ts): RELEARN_DELAY_MS
 *  < 1 min, HARD_STEP_DELAY_MS = 6 min, good graduates at 1 day, easy at
 *  4 days. Same engine, same truth — a drifted label is a lying UI. */
const HANJA_RATINGS: ReadonlyArray<{
  id: FsrsRating;
  label: string;
  kr: string;
  sub: string;
  className: string;
}> = [
  { id: 'again', label: 'Again', kr: '다시', sub: '<1m', className: 'km-hanja__rating--again' },
  { id: 'hard', label: 'Hard', kr: '어려움', sub: '6m', className: 'km-hanja__rating--hard' },
  { id: 'good', label: 'Good', kr: '좋음', sub: '1d', className: 'km-hanja__rating--good' },
  { id: 'easy', label: 'Easy', kr: '쉬움', sub: '4d', className: 'km-hanja__rating--easy' },
];

/** F-115 — the draw drill's Recall/Trace mode chips. Same chip pattern as
 *  `FILTER_OPTIONS` (plain buttons, `aria-pressed`), rendered by `DrawView`. */
const DRAW_MODE_OPTIONS: ReadonlyArray<{
  id: DrawMode;
  label: string;
  kr: string;
}> = [
  { id: 'recall', label: 'Recall', kr: '기억해서 쓰기' },
  { id: 'trace', label: 'Trace', kr: '따라 쓰기' },
];

/** Route builder for the drawing drill (char URL-encoded — single glyph). */
function drawPathFor(ch: string): string {
  return `${HANJA_PATH}?view=draw&char=${encodeURIComponent(ch)}`;
}

/** Parse the `view` param into a known sub-view; anything else is root. */
function parseSubView(value: string | null): SubView | null {
  return value === 'study' || value === 'lists' || value === 'list' || value === 'draw'
    ? value
    : null;
}

/** Parse a positive-integer list id off the `id` param; null when garbage. */
function parseListId(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** True when `err` is the cancellation our abortable fetches raise. */
function isCanceled(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'canceled';
}

/**
 * F-165 — one step toward mastery: `new` → `practicing` → `banked`; an
 * already-banked character stays banked (a right answer there just
 * confirms it — a no-op write, deliberately skipped by the caller). This is
 * the SAME three-band pool `STATE_PILL_TONE`, the index colors (F-167), and
 * the encountered band already read — the draw drill's "right" judgment is
 * one more writer onto that one real signal, never a parallel one.
 */
function promoteState(state: HanjaState): HanjaState {
  if (state === 'new') return 'practicing';
  return 'banked';
}

/**
 * F-165 — builds the draw-drill's session queue: the requested character
 * first, then other not-yet-banked characters from the SAME fetched pool
 * (practicing before new — closer to mastery first), capped at
 * `DRAW_SESSION_LIMIT`. Deterministic over the pool's own order (no
 * shuffling) so the drill — and its tests — stay reproducible.
 */
function buildDrawQueue(chars: readonly Hanja[], start: string): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  const practicing = chars.filter((h) => h.state === 'practicing' && h.ch !== start);
  const fresh = chars.filter((h) => h.state === 'new' && h.ch !== start);
  for (const h of [...practicing, ...fresh]) {
    if (queue.length >= DRAW_SESSION_LIMIT) break;
    if (seen.has(h.ch)) continue;
    seen.add(h.ch);
    queue.push(h.ch);
  }
  return queue;
}

export default function Hanja(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sub = parseSubView(searchParams.get('view'));

  // Whole-pool fetch; the screen filters locally over the four state chips, so
  // the key stays constant and `realFn` requests the whole pool (no filter).
  const charsResult = useEndpointOrMock<Hanja[]>('hanja:list', loadHanjaMock, {
    realFn: () => fetchHanjaList(),
  });
  const progressResult = useEndpointOrMock<HanjaProgress>(
    'hanja:progress',
    loadHanjaProgressMock,
    { realFn: () => fetchHanjaProgress() },
  );
  // The server owns the "today" weighting (recently-mined words → frequency →
  // deterministic-by-day) and may return null on an empty corpus.
  const todayResult = useEndpointOrMock<Hanja | null>(
    'hanja:today',
    loadHanjaTodayMock,
    { realFn: () => fetchHanjaToday() },
  );

  const [view, setView] = useState<ViewMode>('today');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  // F-168 — the index tile "+" quick-add popup's target character, or null
  // when closed. A separate slot from `openId` (the full detail sheet) so
  // the two popups never fight over the same piece of state.
  const [quickAddChar, setQuickAddChar] = useState<Hanja | null>(null);
  // Tracks an in-flight `setHanjaState` so the detail control can disable
  // itself and surface a failure without ever mutating the rendered pool.
  const [stateError, setStateError] = useState<string | null>(null);
  const [pendingChar, setPendingChar] = useState<string | null>(null);
  // Optimistic overlay: char → its locally-applied state after a successful
  // write. Layered over the fetched data so a bank/practice updates the screen
  // WITHOUT a refetch that would reset the list to null — which would unmount
  // the open detail sheet and flash the loading skeleton. An entry is written
  // only after `setHanjaState` resolves, so a failed write adds nothing and the
  // rendered state stays exactly as fetched.
  const [stateOverrides, setStateOverrides] = useState<Record<string, HanjaState>>(
    {},
  );

  // Apply the optimistic overlay over the fetched pool. Keyed by `ch` (the
  // server identity used by the write), so an override follows the character
  // across both the index grid and the featured card.
  const chars = useMemo<Hanja[] | null>(() => {
    const fetched = charsResult.data;
    if (!fetched) return null;
    if (Object.keys(stateOverrides).length === 0) return fetched;
    return fetched.map((h) => {
      const to = stateOverrides[h.ch];
      return to && to !== h.state ? { ...h, state: to } : h;
    });
  }, [charsResult.data, stateOverrides]);

  // Recompute the progress band from the overlay deltas so the Mastered /
  // Practicing / New counts move in lockstep with the optimistic list. Only
  // characters present in the fetched pool contribute a delta (the counts are
  // pool-derived), so an overlay for an off-pool char is a no-op here.
  const progress = useMemo<HanjaProgress | null>(() => {
    const base = progressResult.data;
    if (!base) return null;
    const fetched = charsResult.data;
    if (!fetched || Object.keys(stateOverrides).length === 0) return base;
    const counts = { banked: base.banked, practicing: base.practicing, new: base.new };
    let encountered = base.encountered;
    for (const h of fetched) {
      const to = stateOverrides[h.ch];
      if (!to || to === h.state) continue;
      counts[h.state] = Math.max(0, counts[h.state] - 1);
      counts[to] += 1;
      // A character leaving 'new' for the first time becomes "encountered".
      if (h.state === 'new') encountered += 1;
    }
    return { ...base, ...counts, encountered };
  }, [progressResult.data, charsResult.data, stateOverrides]);

  const featured = useMemo<Hanja | null>(() => {
    const f = todayResult.data ?? null;
    if (!f) return null;
    const to = stateOverrides[f.ch];
    return to && to !== f.state ? { ...f, state: to } : f;
  }, [todayResult.data, stateOverrides]);

  const isMock =
    charsResult.isMock || progressResult.isMock || todayResult.isMock;

  // Set a character's state, then apply it optimistically to the local overlay.
  // The write is gated: the overlay entry is written only AFTER the await
  // resolves, so a rejected call surfaces an inline error and leaves the
  // rendered data untouched (no optimistic mutation to roll back). No refetch
  // fires, so the open detail sheet stays mounted and the screen never flashes
  // its skeleton. Shared verbatim by the draw drill (F-165) — one write path,
  // one overlay, for both surfaces.
  const onSetState = useCallback(
    async (ch: string, next: HanjaState): Promise<void> => {
      setPendingChar(ch);
      setStateError(null);
      try {
        await setHanjaState(ch, next);
        setStateOverrides((prev) => ({ ...prev, [ch]: next }));
      } catch {
        setStateError("We couldn't update that hanja. Try again in a moment.");
      } finally {
        setPendingChar(null);
      }
    },
    [],
  );

  const filtered = useMemo<Hanja[]>(() => {
    if (!chars) return [];
    if (filter === 'all') return chars;
    return chars.filter((h) => h.state === filter);
  }, [chars, filter]);

  const opened = useMemo<Hanja | null>(() => {
    if (!openId || !chars) return null;
    return chars.find((h) => h.id === openId) ?? null;
  }, [openId, chars]);

  // Sheet CTAs that leave this page (study / draw) close the sheet first so
  // returning to the root never resurrects a stale detail sheet.
  const onSheetNavigate = useCallback(
    (to: string): void => {
      setOpenId(null);
      void navigate(to);
    },
    [navigate],
  );

  const loading =
    charsResult.loading || progressResult.loading || todayResult.loading;
  // The list + progress are required to paint anything; `today` is not — a null
  // featured character (empty corpus) is a valid state the Today view handles
  // on its own, so `todayResult.error` is intentionally excluded here. A FAILED
  // featured fetch renders its own scoped ErrorCard inside the Today view
  // (F-UP-018) — never the "no hanja yet" empty state.
  const fatal =
    !loading && (!chars || !progress) && (charsResult.error ?? progressResult.error);

  // F-024: every nested view gets an explicit-parent BackButton. The list
  // detail goes up to the Lists index; everything else returns to the root.
  const backTo = sub === 'list' ? `${HANJA_PATH}?view=lists` : HANJA_PATH;
  const backLabel = sub === 'list' ? 'Lists' : 'Hanja';

  let subContent: JSX.Element | null = null;
  if (sub === 'study') {
    subContent = (
      <StudyView
        onDraw={(ch) => {
          void navigate(drawPathFor(ch));
        }}
      />
    );
  } else if (sub === 'lists') {
    subContent = (
      <ListsView
        onOpenList={(id) => {
          void navigate(`${HANJA_PATH}?view=list&id=${String(id)}`);
        }}
      />
    );
  } else if (sub === 'list') {
    subContent = (
      <ListDetailView
        listId={parseListId(searchParams.get('id'))}
        onStudy={() => {
          void navigate(`${HANJA_PATH}?view=study`);
        }}
      />
    );
  } else if (sub === 'draw') {
    subContent = (
      <DrawView
        chars={chars}
        loading={charsResult.loading}
        onRetry={charsResult.refetch}
        char={searchParams.get('char')}
        onStudy={() => {
          void navigate(`${HANJA_PATH}?view=study`);
        }}
        onSetState={onSetState}
        pendingChar={pendingChar}
        stateError={stateError}
      />
    );
  }

  return (
    <section
      className="screen km-hanja km-rain-sheen"
      style={{ position: 'relative' }}
      aria-labelledby="km-hanja-title"
    >
      {isMock && sub === null ? <MockBadge /> : null}
      {sub !== null ? (
        <BackButton to={backTo} label={backLabel} className="km-hanja__back" />
      ) : null}
      <PageHubHeader
        titleId="km-hanja-title"
        // P3b trim — adopts nav.ts's terse pair (was the flowery
        // "the bones inside the words").
        eyebrow={<Bilingual en={HANJA_NAV.eyebrow} kr={HANJA_NAV.krEyebrow} />}
        heading={<Bilingual en="Hanja" kr="한자" />}
        railTone="ochre"
      />

      {subContent ??
        (loading ? (
          <Card className="km-hanja__skeleton" aria-busy="true">
            <Eyebrow>
              <Bilingual en="Loading hanja" kr="한자를 불러오는 중" />
            </Eyebrow>
            <div className="km-hanja__skeleton-line" />
            <div className="km-hanja__skeleton-line" />
          </Card>
        ) : fatal ? (
          <Card className="km-hanja__error" role="alert">
            <Eyebrow>
              <Bilingual en="Hanja unavailable" kr="한자를 불러오지 못했어요" />
            </Eyebrow>
            <p>We couldn&apos;t load 한자 right now. Pull to retry shortly.</p>
          </Card>
        ) : progress && chars ? (
          <>
            <EncounteredBand progress={progress} />
            <QuickNav
              onStudy={() => {
                void navigate(`${HANJA_PATH}?view=study`);
              }}
              onLists={() => {
                void navigate(`${HANJA_PATH}?view=lists`);
              }}
            />
            <ViewToggle view={view} onChange={setView} />
            {view === 'today' &&
              (featured ? (
                <HanjaFeature
                  h={featured}
                  onOpen={() => {
                    setOpenId(featured.id);
                  }}
                />
              ) : todayResult.error !== null ? (
                // F-UP-018: the featured fetch FAILED — say so. Pre-fix this
                // fell through to the "No featured 한자 yet" empty state (a
                // data statement), indistinguishable from a genuinely-empty
                // corpus. Fixed copy + a retry scoped to the today source
                // only (list/progress rendered fine above).
                <ErrorCard
                  message="Couldn’t load today’s featured 한자."
                  onRetry={todayResult.refetch}
                />
              ) : (
                <Card className="km-hanja__empty km-giwa km-hangul-watermark" data-glyph="한">
                  <Eyebrow>
                    <Bilingual
                      en="No featured 한자 yet"
                      kr="아직 오늘의 한자가 없어요"
                    />
                  </Eyebrow>
                  <p>
                    Read a passage to start mining 한자 — your daily character
                    will surface here.
                  </p>
                </Card>
              ))}
            {view === 'index' && (
              <IndexView
                chars={filtered}
                filter={filter}
                onFilter={setFilter}
                onOpen={setOpenId}
                onQuickAdd={setQuickAddChar}
              />
            )}
          </>
        ) : (
          <Card className="km-hanja__empty km-giwa km-hangul-watermark" data-glyph="한">
            <Eyebrow>
              <Bilingual en="No hanja yet" kr="아직 한자가 없어요" />
            </Eyebrow>
            <p>Read a passage to start encountering 한자.</p>
          </Card>
        ))}

      {sub === null ? (
        <>
          <Sheet
            open={Boolean(opened)}
            onClose={() => {
              setOpenId(null);
            }}
            ariaLabel="Hanja detail"
          >
            {opened ? (
              <HanjaDetail
                h={opened}
                pending={pendingChar === opened.ch}
                error={stateError}
                onSetState={onSetState}
                onNavigate={onSheetNavigate}
              />
            ) : null}
          </Sheet>
          {/* F-168 — the index tile "+" quick-add popup. Always mounted
              (closed by default) so opening it is a state flip, not a
              remount; `QuickAddSheet` itself no-ops its data effect while
              `h` is null. */}
          <QuickAddSheet
            h={quickAddChar}
            onClose={() => {
              setQuickAddChar(null);
            }}
          />
        </>
      ) : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Pieces — kept in-file because they're consumed only here.
// ─────────────────────────────────────────────────────────────

function EncounteredBand({
  progress,
}: {
  progress: HanjaProgress;
}): JSX.Element {
  const pct =
    progress.targetL4 > 0
      ? Math.min(100, (progress.encountered / progress.targetL4) * 100)
      : 0;
  const summary = hanjaProgressSummary(progress);
  return (
    // F-128 device #1/#2 — a CityCard signboard/hanji-paper surface with a
    // leading-edge DancheongRail, replacing the plain `Card`. `km-hanja__band`
    // only ever set padding/margin/position (never background/border/shadow),
    // so combining it with CityCard's own chrome classes is additive, not
    // conflicting — verified before this change, not assumed.
    <CityCard tone="ochre" rail className="km-hanja__band">
      <Eyebrow>
        <Bilingual
          en={`Encountered · ${String(progress.encountered)} of ~${String(progress.targetL4)} at L4`}
          kr={`접한 한자 · ${String(progress.encountered)} / 약 ${String(progress.targetL4)} (L4 기준)`}
        />
      </Eyebrow>
      <div className="km-hanja__chips">
        {/* F-077 — display copy only; the wire state stays `banked`. */}
        <StateChip label="Mastered" kr="숙달" count={progress.banked} tone="moss" />
        <StateChip
          label="Practicing"
          kr="연습 중"
          count={progress.practicing}
          tone="ochre"
        />
        <StateChip label="New" kr="신규" count={progress.new} tone="mute" />
      </div>
      {/* Clamped/degenerate-safe ARIA — shared with the Progress page's
          Hanja mastery tab via lib/encounteredBar. This bar is already
          "live" (F-170): it recomputes off the optimistic overlay above, so
          a bank/practice write anywhere on the page moves it immediately. */}
      <div
        className="km-hanja__bar"
        {...encounteredBarAria(progress.encountered, progress.targetL4)}
      >
        <div
          className="km-hanja__bar-fill"
          style={{ width: `${pct.toFixed(1)}%` }}
        />
      </div>
      {/* F-077 — composed client-side (bilingual + reword-consistent) via
          the shared lib/encounteredBar helper; the server's pre-templated
          English `note` still says "banked", so it is no longer rendered. */}
      <p className="km-hanja__note">
        <Bilingual en={summary.en} kr={summary.kr} />
      </p>
    </CityCard>
  );
}

function StateChip({
  label,
  kr,
  count,
  tone,
}: {
  label: string;
  kr: string;
  count: number;
  /** F-180 — `ochre` reads the SAME `--km-mastery-practicing` token the
   *  index grid's `HanjaCell` mastery border reads (F-167), not the
   *  accent-tracking `--vermilion`. Both "Practicing" reads on this page
   *  now agree regardless of the user's chosen accent color. */
  tone: 'moss' | 'ochre' | 'mute';
}): JSX.Element {
  return (
    <div className={`km-hanja__statechip km-hanja__statechip--${tone}`}>
      <span className="km-hanja__statechip-count">{count}</span>
      <span className="km-hanja__statechip-label">
        {/* Compact — the chip is tight; the sr name still carries both. */}
        <Bilingual en={label} kr={kr} compact />
      </span>
    </div>
  );
}

/**
 * QuickNav — the root's two doorways into the F-075 surfaces: the flashcard
 * drill and the lists index. Pure navigation (no fetch at the root — the
 * study view reports its own due count once opened, so the root never has
 * to choose between an extra request and a silently-wrong badge).
 */
function QuickNav({
  onStudy,
  onLists,
}: {
  onStudy: () => void;
  onLists: () => void;
}): JSX.Element {
  return (
    <div className="km-hanja__quick">
      <button
        type="button"
        className="km-hanja__quick-btn focusring"
        onClick={onStudy}
        data-tour="hanja-study"
      >
        <Icon name="cards" size={18} />
        <span className="km-hanja__quick-meta">
          <span className="km-hanja__quick-title">
            <Bilingual en="Flashcards" kr="플래시카드" compact />
          </span>
          <span className="km-hanja__quick-sub">
            <Bilingual en="Drill your due hanja" kr="복습할 한자 연습" compact />
          </span>
        </span>
        <Icon name="chevron-right" size={14} />
      </button>
      <button
        type="button"
        className="km-hanja__quick-btn focusring"
        onClick={onLists}
        data-tour="hanja-lists"
      >
        <Icon name="list" size={18} />
        <span className="km-hanja__quick-meta">
          <span className="km-hanja__quick-title">
            <Bilingual en="My lists" kr="내 목록" compact />
          </span>
          <span className="km-hanja__quick-sub">
            <Bilingual en="Curate character sets" kr="한자 목록 관리" compact />
          </span>
        </span>
        <Icon name="chevron-right" size={14} />
      </button>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (next: ViewMode) => void;
}): JSX.Element {
  const tabs: ReadonlyArray<{ id: ViewMode; label: string; kr: string }> = [
    { id: 'today', label: "Today's 한자", kr: '오늘의 한자' },
    { id: 'index', label: 'Index', kr: '색인' },
  ];
  return (
    <div
      className="km-hanja__viewtoggle"
      role="tablist"
      aria-label="Hanja view"
      data-tour="hanja-view"
    >
      {tabs.map((t) => {
        const active = view === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={
              'km-hanja__viewtab focusring' +
              (active ? ' km-hanja__viewtab--active' : '')
            }
            onClick={() => {
              if (!active) onChange(t.id);
            }}
          >
            <Bilingual en={t.label} kr={t.kr} compact />
          </button>
        );
      })}
    </div>
  );
}

function HanjaFeature({
  h,
  onOpen,
}: {
  h: Hanja;
  onOpen: () => void;
}): JSX.Element {
  return (
    // F-128 — the CityCard signboard/hanji-paper hero, feat-emphasised
    // (this is the page's one "featured surface") with a rail leading edge.
    // A NEW outer classname (`feature-card`, not the old bare `feature`) so
    // the shared `.km-hanja__feature` button rule (background/border/
    // cursor, built for a raw `<button>`) never collides with CityCard's own
    // chrome — the inner button below owns the full-bleed click target
    // instead, the same idiom `CollapsibleTile` already uses.
    <CityCard tone="ochre" rail feat className="km-hanja__feature-card">
      <button
        type="button"
        onClick={onOpen}
        className="km-hanja__feature-btn focusring"
        aria-label={`Today's hanja ${h.ch} — ${h.gloss} ${h.sound}`}
      >
        <span className="km-hanja__feature-seal">
          <SealStamp char="韓" size="md" />
        </span>

        <div className="km-hanja__feature-row">
          <div className="km-hanja__feature-square">
            <TianGrid />
            <span className="hanja km-hanja__feature-char">{h.ch}</span>
          </div>

          <div className="km-hanja__feature-meta">
            <Eyebrow>
              <Bilingual en="Today's 한자" kr="오늘의 한자" />
            </Eyebrow>
            <div className="kr kr-display km-hanja__feature-gloss">
              <span className="km-hanja__feature-gloss-kr">{h.gloss}</span>{' '}
              <span className="km-hanja__feature-gloss-sound">{h.sound}</span>
            </div>
            <div className="km-hanja__feature-en">{h.en}</div>
            <div className="km-hanja__feature-pills">
              <Pill>
                <Bilingual
                  en={`${String(h.strokes)} strokes`}
                  kr={`${String(h.strokes)}획`}
                  compact
                />
              </Pill>
              <Pill>{h.level}</Pill>
              <Pill tone={STATE_PILL_TONE[h.state]}>
                <Bilingual
                  en={STATE_PILL_LABEL[h.state]}
                  kr={STATE_PILL_KR[h.state]}
                  compact
                />
              </Pill>
            </div>
          </div>
        </div>

        <GoldRule />

        <div className="km-hanja__feature-compounds">
          <Eyebrow>
            <Bilingual
              en={`Words you unlock · ${String(h.compounds.length)}`}
              kr={`열리는 단어 · ${String(h.compounds.length)}개`}
            />
          </Eyebrow>
          <div className="km-hanja__compound-row">
            {h.compounds.map((c, i) => (
              <span key={`${c.kr}-${String(i)}`} className="km-hanja__compound-chip kr">
                <span className="hanja km-hanja__compound-han">{c.kr}</span>
                <span className="km-hanja__compound-en">{c.en}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="km-hanja__feature-foot">
          <span>
            <Bilingual en="Tap for etymology + drill" kr="눌러서 어원과 연습 보기" />
          </span>
          <Icon name="arrow-right" size={16} />
        </div>
      </button>
    </CityCard>
  );
}

function IndexView({
  chars,
  filter,
  onFilter,
  onOpen,
  onQuickAdd,
}: {
  chars: Hanja[];
  filter: FilterMode;
  onFilter: (next: FilterMode) => void;
  onOpen: (id: string) => void;
  /** F-168 — opens the quick "+"-to-list popup for one character. */
  onQuickAdd: (h: Hanja) => void;
}): JSX.Element {
  // Window the grid so a large corpus doesn't render hundreds of cells in
  // one commit; a filter change collapses back to the initial window.
  const pager = usePagination(chars, GRID_WINDOW);
  const resetPager = pager.reset;
  return (
    <>
      <div className="km-hanja__filters" role="toolbar" aria-label="Filter hanja by state">
        {FILTER_OPTIONS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) {
                  onFilter(f.id);
                  resetPager();
                }
              }}
              className={
                'km-pill focusring km-hanja__filter' +
                (active ? ' km-pill--gold' : ' km-pill--default')
              }
            >
              <Bilingual en={f.label} kr={f.kr} compact />
            </button>
          );
        })}
      </div>
      {chars.length === 0 ? (
        <p className="km-hanja__index-empty">
          <Bilingual
            en="No hanja match that filter yet."
            kr="이 필터에 맞는 한자가 없어요."
          />
        </p>
      ) : (
        <>
          <div className="km-hanja__grid">
            {pager.visible.map((h) => (
              // F-169 — `HanjaCell` gets `sound` (the hangul reading) only,
              // never `gloss` (the Korean gloss WORD): the shared component
              // renders its gloss caption ONLY when a caller passes one, so
              // simply omitting the prop is the whole fix. F-167's mastery
              // color rides `HanjaCell`'s existing `data-state`/state class —
              // remapped onto the real green/yellow/red tokens in Hanja.css.
              <div key={h.id} className="km-hanja__cell-wrap">
                <HanjaCell
                  char={h.ch}
                  sound={h.sound}
                  state={h.state}
                  onClick={() => {
                    onOpen(h.id);
                  }}
                />
                {/* F-168 — quick "+"-to-list, a sibling of (not nested
                    inside) the cell's own button: HanjaCell IS a button, and
                    a button-in-a-button is both invalid HTML and untappable
                    on most browsers. Absolutely positioned in the corner of
                    the (position:relative) wrapper instead. */}
                <button
                  type="button"
                  className="km-hanja__cell-add focusring"
                  aria-label={`Add ${h.ch} to a list`}
                  onClick={() => {
                    onQuickAdd(h);
                  }}
                >
                  <Icon name="plus" size={12} />
                </button>
              </div>
            ))}
          </div>
          <ShowMore
            canShowMore={pager.canShowMore}
            onShowMore={pager.showMore}
            remaining={pager.remaining}
          />
        </>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// F-168 — index-tile quick add-to-list popup + toast.
// ─────────────────────────────────────────────────────────────

function QuickAddSheet({
  h,
  onClose,
}: {
  /** The character the popup targets, or null when closed. */
  h: Hanja | null;
  onClose: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [lists, setLists] = useState<ServerVocabList[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [newName, setNewName] = useState('');
  const [tick, setTick] = useState(0);
  const inputId = useId();

  useEffect(() => {
    if (h === null) {
      // Closed — drop everything so the next open starts clean.
      setLists(null);
      setError(null);
      setNewName('');
      return;
    }
    const ctrl = new AbortController();
    fetchHanjaLists(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setLists(rows);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isCanceled(err)) return;
        setError(errorMessageFor(err, "Couldn't load your lists."));
      });
    return () => {
      ctrl.abort();
    };
  }, [h, tick]);

  const addTo = useCallback(
    (list: ServerVocabList): void => {
      if (h === null || busyId !== null) return;
      setBusyId(list.id);
      setError(null);
      void (async (): Promise<void> => {
        try {
          const seeded = await seedHanjaCard(h.ch);
          await addHanjaToList(list.id, [seeded.character_id]);
          toast({ message: `Added ${h.ch} to “${list.name_kr}”.`, tone: 'success' });
          onClose();
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            toast({ message: `${h.ch} is already in “${list.name_kr}”.`, tone: 'info' });
            onClose();
          } else {
            setError(errorMessageFor(err, "Couldn't add to that list. Try again."));
          }
        } finally {
          setBusyId(null);
        }
      })();
    },
    [h, busyId, toast, onClose],
  );

  const createAndAdd = useCallback((): void => {
    const name = newName.trim();
    if (h === null || name === '' || busyId !== null) return;
    setBusyId('new');
    setError(null);
    void (async (): Promise<void> => {
      try {
        const res = await createList({ name_kr: name, kind: 'hanja' });
        const listId = res.list.id;
        const seeded = await seedHanjaCard(h.ch);
        await addHanjaToList(listId, [seeded.character_id]);
        toast({ message: `Created “${name}” and added ${h.ch}.`, tone: 'success' });
        setNewName('');
        onClose();
      } catch (err) {
        setError(errorMessageFor(err, "Couldn't create that list. Try again."));
      } finally {
        setBusyId(null);
      }
    })();
  }, [h, newName, busyId, toast, onClose]);

  return (
    <Sheet open={h !== null} onClose={onClose} ariaLabel="Add to a list">
      {h !== null ? (
        // Fix-pass batch-3 (SF-1, REVIEW_batch3-fidelity.md): this Sheet
        // used to roll its own chrome (`.km-hanja__quickadd` as the OUTER
        // wrapper, no head/close row, raw `.km-btn` buttons) instead of the
        // shared `.km-review__sheet-body`/`__sheet-head` recipe + `<Button>`
        // every other page's Sheet uses (Review/Grammar/Reading) — the SAME
        // "create a list" job read as a different object on this page.
        // `.km-hanja__quickadd` now wraps only the list-specific content
        // BELOW the shared head, unchanged, so none of its own descendant
        // rules (`.km-hanja__quickadd-list`/`-row`/`-name`/`-empty`) needed
        // to move.
        <div className="km-review__sheet-body">
          <div className="km-review__sheet-head">
            <Eyebrow>
              <Bilingual en={`Add ${h.ch} to a list`} kr={`${h.ch} 목록에 추가`} />
            </Eyebrow>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close add-to-list"
            >
              <Icon name="close" size={14} />
            </Button>
          </div>
          <div className="km-hanja__quickadd">
            {error !== null ? (
              <div className="km-hanja__addlist-error">
                <p role="alert" className="km-hanja__inline-error">
                  {error}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setTick((t) => t + 1);
                  }}
                >
                  <Bilingual en="Retry" kr="다시 시도" compact />
                </Button>
              </div>
            ) : null}
            {lists === null && error === null ? (
              <p className="km-hanja__addlist-loading" aria-busy="true">
                <Bilingual en="Loading your lists…" kr="목록을 불러오는 중…" />
              </p>
            ) : null}
            {lists !== null && lists.length > 0 ? (
              <ul className="km-hanja__quickadd-list">
                {lists.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      className="km-hanja__quickadd-row focusring"
                      disabled={busyId !== null}
                      aria-busy={busyId === l.id}
                      onClick={() => {
                        addTo(l);
                      }}
                    >
                      <span className="kr km-hanja__quickadd-name">{l.name_kr}</span>
                      <Icon name={busyId === l.id ? 'check' : 'plus'} size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {lists !== null && lists.length === 0 ? (
              <p className="km-hanja__quickadd-empty">
                <Bilingual
                  en="No lists yet — create one below."
                  kr="아직 목록이 없어요 — 아래에서 만드세요."
                />
              </p>
            ) : null}
            <label htmlFor={inputId} className="km-hanja__label">
              <Bilingual en="New list name" kr="새 목록 이름" compact />
            </label>
            <div className="km-hanja__row">
              <input
                id={inputId}
                className="km-hanja__input focusring"
                value={newName}
                maxLength={120}
                placeholder="e.g. 자주 보는 한자"
                disabled={busyId !== null}
                onChange={(e) => {
                  setNewName(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createAndAdd();
                }}
              />
              <Button
                variant="gold"
                size="sm"
                disabled={busyId !== null || newName.trim() === ''}
                onClick={createAndAdd}
              >
                {busyId === 'new' ? (
                  <Bilingual en="Creating…" kr="만드는 중…" compact />
                ) : (
                  <Bilingual en="Create & add" kr="만들고 추가" compact />
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────
// Study sub-view (F-075 / B-028) — FSRS flashcard drill over due hanja
// cards. F-170: a live SubwayProgress bar now rides alongside the existing
// numeric readout.
// ─────────────────────────────────────────────────────────────

interface SubmitError {
  text: string;
  /** True on a 409 (stale expected_version) — offer a deck refresh. */
  stale: boolean;
}

function StudyView({ onDraw }: { onDraw: (ch: string) => void }): JSX.Element {
  const [cards, setCards] = useState<HanjaDueCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  // When the current card was first shown — feeds `duration_ms`.
  const shownAt = useRef<number>(Date.now());

  useEffect(() => {
    const ctrl = new AbortController();
    fetchHanjaDueCards(STUDY_SESSION_LIMIT, ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setCards(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isCanceled(err)) return;
        setFetchError(
          errorMessageFor(err, "Your hanja deck couldn't be loaded."),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [tick]);

  // Reset the session synchronously in the click handler (not the effect —
  // avoids sync setState-in-effect), then bump the tick to refetch.
  const restart = useCallback((): void => {
    setCards(null);
    setLoading(true);
    setFetchError(null);
    setIdx(0);
    setFlipped(false);
    setSubmitError(null);
    setTick((t) => t + 1);
  }, []);

  const deck = cards ?? [];
  const current: HanjaDueCard | undefined =
    !loading && fetchError === null ? deck[idx] : undefined;

  // Stamp the card's first-shown time whenever the deck position changes.
  useEffect(() => {
    shownAt.current = Date.now();
  }, [idx, cards]);

  // Spacebar reveals — the Review-screen convention. Skipped while ANY
  // interactive element has focus: Space must activate a focused rating
  // button (not cancel it and flip the ratings away), and the flashcard
  // itself handles its own Enter/Space (a second flip here read as a
  // visible no-op).
  useEffect(() => {
    if (current === undefined) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      if (isInteractiveElement(document.activeElement)) return;
      e.preventDefault();
      setFlipped((f) => !f);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [current]);

  // Await-then-advance (not optimistic): the deck only moves once the server
  // confirms the rating, so a failure can never silently drop a review. The
  // rating buttons disable while in flight; a 409 (stale version) offers a
  // deck refresh instead of replaying against a snapshot we know is stale.
  const rate = useCallback(
    (rating: FsrsRating): void => {
      const card = cards?.[idx];
      if (card === undefined || submitPending) return;
      setSubmitPending(true);
      setSubmitError(null);
      void (async (): Promise<void> => {
        try {
          const durationMs = Math.max(
            0,
            Math.min(Date.now() - shownAt.current, INT4_MAX),
          );
          await submitHanjaCardReview(card.id, {
            rating,
            duration_ms: durationMs,
            expected_version: card.version,
          });
          setFlipped(false);
          setIdx((i) => i + 1);
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            // Deliberate trade-off (review SF-3): "Refresh deck" refetches
            // from scratch and restarts at card 1. Already-rated cards are
            // no longer due, so nothing is double-rated; preserving a
            // mid-deck position against a snapshot we KNOW is stale isn't
            // worth the machinery, and the copy states what will happen.
            setSubmitError({
              text: 'This card was rescheduled elsewhere. Refresh the deck to continue.',
              stale: true,
            });
          } else {
            setSubmitError({
              text: errorMessageFor(err, "Couldn't save that rating. Try again."),
              stale: false,
            });
          }
        } finally {
          setSubmitPending(false);
        }
      })();
    },
    [cards, idx, submitPending],
  );

  if (loading) {
    return (
      <Card className="km-hanja__skeleton" aria-busy="true">
        <Eyebrow>
          <Bilingual en="Loading your deck" kr="카드를 불러오는 중" />
        </Eyebrow>
        <div className="km-hanja__skeleton-line" />
        <div className="km-hanja__skeleton-line" />
      </Card>
    );
  }
  if (fetchError !== null) {
    return <ErrorCard message={fetchError} onRetry={restart} />;
  }
  if (deck.length === 0) {
    return (
      <Card className="km-hanja__empty km-giwa km-hangul-watermark" data-glyph="한">
        <Eyebrow>
          <Bilingual en="No hanja cards due" kr="복습할 한자 카드가 없어요" />
        </Eyebrow>
        <p>
          Open a character and tap Drill — or add it to a list — to grow your
          deck. Cards come back here when they&apos;re due.
        </p>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--sm focusring"
          onClick={restart}
        >
          <Bilingual en="Check again" kr="다시 확인" compact />
        </button>
      </Card>
    );
  }
  if (current === undefined) {
    // idx walked past the last card — the session is complete.
    return (
      <Card className="km-hanja__empty">
        <span className="km-hanja__complete-seal">
          <SealStamp char="完" size="md" tone="accent" className="km-najeon" />
        </span>
        <Eyebrow>
          <Bilingual en="Deck clear" kr="오늘 복습 끝" />
        </Eyebrow>
        <p>
          You rated {String(deck.length)} card{deck.length === 1 ? '' : 's'}.
          The next reviews surface when they&apos;re due.
        </p>
        <button
          type="button"
          className="km-btn km-btn--gold km-btn--md focusring"
          onClick={restart}
        >
          <Bilingual en="Check for more" kr="더 확인하기" compact />
        </button>
      </Card>
    );
  }

  return (
    <>
      {/* F-170 — a live SubwayProgress bar over the study session, alongside
          the existing numeric readout (kept for the exact "N / M" reading
          the bar's dots don't spell out in text). */}
      <div className="km-hanja__study-subway">
        <SubwayProgress
          steps={deck.length}
          current={idx}
          tone="accent"
          label="Study progress"
          valueText={`Card ${String(idx + 1)} of ${String(deck.length)}`}
        />
      </div>
      <div className="km-hanja__study-progress">
        <span>
          {String(idx + 1)} / {String(deck.length)}
        </span>
        <span>
          <Bilingual en="due now" kr="지금 복습" compact />
        </span>
      </div>
      <Flashcard
        flipped={flipped}
        onFlip={() => {
          setFlipped((f) => !f);
        }}
        ariaLabel="Hanja flashcard"
        front={
          <div className="km-hanja__study-face">
            <Eyebrow>
              <Bilingual en="Recall the sound & meaning" kr="음과 뜻 떠올리기" />
            </Eyebrow>
            <div className="km-hanja__study-square">
              <TianGrid />
              <span className="hanja km-hanja__study-char">{current.ch}</span>
            </div>
            <span className="km-hanja__study-hint">
              <Bilingual
                en="Tap to reveal · spacebar"
                kr="눌러서 정답 보기 · 스페이스바"
                compact
              />
            </span>
          </div>
        }
        back={
          // Mount the answer face only while flipped (the B-014 pattern) so
          // the next card's answer can't flash through the flip-back sweep
          // and the answer stays out of the a11y tree until revealed.
          flipped ? (
            <div className="km-hanja__study-face">
              <span className="hanja km-hanja__study-backchar">{current.ch}</span>
              <div className="kr kr-display km-hanja__study-gloss">
                <span>{current.gloss}</span>{' '}
                <span className="km-hanja__study-sound">{current.sound}</span>
              </div>
              <div className="km-hanja__study-en">{current.en}</div>
              <div className="km-hanja__study-pills">
                <Pill>
                  <Bilingual
                    en={`${String(current.strokes)} strokes`}
                    kr={`${String(current.strokes)}획`}
                    compact
                  />
                </Pill>
                <Pill>{current.level}</Pill>
              </div>
              <button
                type="button"
                className="km-btn km-btn--ghost km-btn--sm focusring"
                onClick={(e) => {
                  // The flashcard's outer onClick flips — don't.
                  e.stopPropagation();
                  onDraw(current.ch);
                }}
              >
                <Icon name="pen" size={14} />
                <span>
                  <Bilingual en="Practice drawing" kr="쓰기 연습" compact />
                </span>
              </button>
            </div>
          ) : null
        }
      />
      {flipped ? (
        <div className="km-hanja__ratings" role="group" aria-label="Rate your recall">
          {HANJA_RATINGS.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={submitPending}
              aria-busy={submitPending}
              className={`km-hanja__rating focusring ${r.className}`}
              onClick={() => {
                rate(r.id);
              }}
            >
              <Bilingual en={r.label} kr={r.kr} compact />
              <span className="km-hanja__rating-sub">{r.sub}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="km-hanja__study-hintline">
          <Bilingual
            en="Tap the card or press space to reveal."
            kr="카드를 누르거나 스페이스바로 정답을 확인하세요."
          />
        </p>
      )}
      {submitError !== null ? (
        <div role="alert" className="km-hanja__study-error">
          <span>{submitError.text}</span>
          {submitError.stale ? (
            <button
              type="button"
              className="km-btn km-btn--ghost km-btn--sm focusring"
              onClick={restart}
            >
              <Bilingual en="Refresh deck" kr="카드 새로고침" compact />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Lists sub-view (F-075 / F-166) — hanja list index + a Sheet-based create
// popup (mirroring `components/MyVocabLists.tsx`'s pattern).
// ─────────────────────────────────────────────────────────────

function ListsView({
  onOpenList,
}: {
  onOpenList: (id: number) => void;
}): JSX.Element {
  const [lists, setLists] = useState<ServerVocabList[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  // Two-step inline delete confirm (no window.confirm — poor AT support).
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchHanjaLists(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setLists(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isCanceled(err)) return;
        setFetchError(errorMessageFor(err, "Your lists couldn't be loaded."));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [tick]);

  const retry = useCallback((): void => {
    setLists(null);
    setLoading(true);
    setFetchError(null);
    setTick((t) => t + 1);
  }, []);

  const remove = useCallback((id: number): void => {
    setDeletingId(id);
    setRowError(null);
    void (async (): Promise<void> => {
      try {
        await deleteList(id);
        setLists((prev) => (prev ? prev.filter((l) => l.id !== id) : prev));
      } catch (err) {
        setRowError(
          errorMessageFor(err, "Couldn't delete that list. Try again."),
        );
      } finally {
        setDeletingId(null);
        setConfirmingId(null);
      }
    })();
  }, []);

  return (
    <>
      {/* F-166 — "New list" is now a Sheet-triggered popup (the shared
          MyVocabLists create pattern), not an always-visible inline card. */}
      <div className="km-hanja__lists-head">
        <button
          type="button"
          className="km-btn km-btn--gold km-btn--md focusring"
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          <Icon name="plus" size={14} />
          <span>
            <Bilingual en="New list" kr="새 목록" compact />
          </span>
        </button>
      </div>

      {loading ? (
        <Card className="km-hanja__skeleton" aria-busy="true">
          <Eyebrow>
            <Bilingual en="Loading lists" kr="목록을 불러오는 중" />
          </Eyebrow>
          <div className="km-hanja__skeleton-line" />
        </Card>
      ) : fetchError !== null ? (
        <ErrorCard message={fetchError} onRetry={retry} />
      ) : (lists ?? []).length === 0 ? (
        <Card className="km-hanja__empty km-giwa km-hangul-watermark" data-glyph="한">
          <Eyebrow>
            <Bilingual en="No hanja lists yet" kr="아직 한자 목록이 없어요" />
          </Eyebrow>
          <p>Create your first list above, then add characters from any detail sheet.</p>
        </Card>
      ) : (
        <div className="km-hanja__lists-col">
          {(lists ?? []).map((l) => (
            <div key={l.id} className="km-hanja__list-row">
              <button
                type="button"
                className="km-hanja__list-open focusring"
                onClick={() => {
                  onOpenList(l.id);
                }}
              >
                <span className="kr km-hanja__list-name">{l.name_kr}</span>
                {l.name_en !== null && l.name_en !== '' ? (
                  <span className="km-hanja__list-en">{l.name_en}</span>
                ) : null}
                <span className="km-hanja__list-meta">
                  <Bilingual
                    en={`${String(l.entry_count)} characters`}
                    kr={`한자 ${String(l.entry_count)}자`}
                    compact
                  />
                </span>
              </button>
              {confirmingId === l.id ? (
                <div className="km-hanja__list-confirm">
                  <button
                    type="button"
                    className="km-btn km-btn--ghost km-btn--sm focusring km-hanja__danger"
                    disabled={deletingId !== null}
                    onClick={() => {
                      remove(l.id);
                    }}
                  >
                    {deletingId === l.id ? (
                      <Bilingual en="Deleting…" kr="삭제 중…" compact />
                    ) : (
                      <Bilingual en="Delete" kr="삭제" compact />
                    )}
                  </button>
                  <button
                    type="button"
                    className="km-btn km-btn--ghost km-btn--sm focusring"
                    disabled={deletingId !== null}
                    onClick={() => {
                      setConfirmingId(null);
                    }}
                  >
                    <Bilingual en="Keep" kr="유지" compact />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="km-hanja__list-del focusring"
                  aria-label={`Delete list ${l.name_kr}`}
                  onClick={() => {
                    setConfirmingId(l.id);
                    setRowError(null);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
          {rowError !== null ? (
            <p role="alert" className="km-hanja__inline-error">
              {rowError}
            </p>
          ) : null}
        </div>
      )}

      <CreateListSheet
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={(created) => {
          setLists((prev) => (prev ? [created, ...prev] : [created]));
        }}
      />
    </>
  );
}

interface CreateListSheetProps {
  open: boolean;
  onClose: () => void;
  /** Fires with the newly-created list on success. */
  onCreated: (list: ServerVocabList) => void;
}

/**
 * F-166 — the "New list" create popup, mirroring
 * `components/MyVocabLists.tsx`'s `CreateListSheet` (that one isn't
 * exported, and this page is single-kind — hanja only — so there's no kind
 * radiogroup to reproduce, just the name field + Sheet chrome).
 */
function CreateListSheet({
  open,
  onClose,
  onCreated,
}: CreateListSheetProps): JSX.Element {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const create = useCallback((): void => {
    const trimmed = name.trim();
    if (trimmed === '' || creating) return;
    setCreating(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        const res = await createList({ name_kr: trimmed, kind: 'hanja' });
        const created: ServerVocabList = res.list;
        onCreated(created);
        setName('');
        onClose();
      } catch (err) {
        setError(errorMessageFor(err, "Couldn't create that list. Try again."));
      } finally {
        setCreating(false);
      }
    })();
  }, [name, creating, onCreated, onClose]);

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="New hanja list">
      {/* Fix-pass batch-3 (SF-1) — shared `.km-review__sheet-body`/
          `__sheet-head` + `<Button>` Close, matching Review/Grammar/Reading's
          Sheet recipe instead of this page's own bespoke chrome. */}
      <div className="km-review__sheet-body">
        <div className="km-review__sheet-head">
          <Eyebrow>
            <Bilingual en="New list" kr="새 목록" />
          </Eyebrow>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close new list"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>
        <div className="km-hanja__quickadd">
          <label htmlFor={inputId} className="km-hanja__label">
            <Bilingual en="List name" kr="목록 이름" compact />
          </label>
          <div className="km-hanja__row">
            <input
              id={inputId}
              className="km-hanja__input focusring"
              value={name}
              maxLength={120}
              placeholder="e.g. TOPIK II 한자"
              disabled={creating}
              onChange={(e) => {
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
              }}
            />
            <Button
              variant="gold"
              size="md"
              leadingIcon={<Icon name="plus" size={14} />}
              disabled={creating || name.trim() === ''}
              onClick={create}
            >
              {creating ? (
                <Bilingual en="Creating…" kr="만드는 중…" compact />
              ) : (
                <Bilingual en="Create" kr="만들기" compact />
              )}
            </Button>
          </div>
          {error !== null ? (
            <p role="alert" className="km-hanja__inline-error">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────
// List-detail sub-view (F-075 / F-166) — one list's characters + bulk
// add-hanja picker.
// ─────────────────────────────────────────────────────────────

interface SeedStatus {
  kind: 'ok' | 'error';
  text: string;
}

function ListDetailView({
  listId,
  onStudy,
}: {
  listId: number | null;
  onStudy: () => void;
}): JSX.Element {
  const [list, setList] = useState<ServerVocabList | null>(null);
  const [entries, setEntries] = useState<HanjaListEntryRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tick, setTick] = useState(0);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (listId === null) return;
    const ctrl = new AbortController();
    fetchHanjaListDetail(listId, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setList(res.list);
        setEntries(res.entries);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isCanceled(err)) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setFetchError(errorMessageFor(err, "This list couldn't be loaded."));
        }
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [listId, tick]);

  const retry = useCallback((): void => {
    setList(null);
    setEntries(null);
    setLoading(true);
    setFetchError(null);
    setNotFound(false);
    setTick((t) => t + 1);
  }, []);

  const hanjaEntries = useMemo<HanjaListEntryRow[]>(
    () => (entries ?? []).filter((e) => e.item_type === 'hanja'),
    [entries],
  );
  const otherCount = (entries?.length ?? 0) - hanjaEntries.length;
  const pager = usePagination(hanjaEntries, LIST_WINDOW);

  // F-166 — the characters already in this list, so the bulk picker never
  // offers (and never duplicate-adds) one that's already a member.
  const existingChars = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        hanjaEntries
          .map((e) => e.hanja_char)
          .filter((c): c is string => c !== null && c !== ''),
      ),
    [hanjaEntries],
  );

  // Seed a recognition card for every character in the list (sequential —
  // each call is its own idempotent transaction and the created-count math
  // stays trivially correct). Partial failure reports honestly.
  const addAllToDeck = useCallback((): void => {
    if (seedBusy || hanjaEntries.length === 0) return;
    setSeedBusy(true);
    setSeedStatus(null);
    void (async (): Promise<void> => {
      let created = 0;
      let existing = 0;
      try {
        for (const e of hanjaEntries) {
          if (e.hanja_char === null || e.hanja_char === '') continue;
          const res = await seedHanjaCard(e.hanja_char);
          if (res.created) created += 1;
          else existing += 1;
        }
        setSeedStatus({
          kind: 'ok',
          text:
            created > 0
              ? `Added ${String(created)} new card${created === 1 ? '' : 's'} to your deck` +
                (existing > 0 ? ` (${String(existing)} already there).` : '.')
              : 'Every character here is already in your deck.',
        });
      } catch (err) {
        const done = created + existing;
        setSeedStatus({
          kind: 'error',
          text: errorMessageFor(
            err,
            `Stopped after ${String(done)} of ${String(hanjaEntries.length)} characters. Try again.`,
          ),
        });
      } finally {
        setSeedBusy(false);
      }
    })();
  }, [seedBusy, hanjaEntries]);

  const removeEntry = useCallback(
    (characterId: number): void => {
      if (listId === null) return;
      setRemovingId(characterId);
      setRowError(null);
      void (async (): Promise<void> => {
        try {
          await removeHanjaFromList(listId, characterId);
          setEntries((prev) =>
            prev ? prev.filter((e) => !(e.item_type === 'hanja' && e.entry_id === characterId)) : prev,
          );
        } catch (err) {
          setRowError(
            errorMessageFor(err, "Couldn't remove that character. Try again."),
          );
        } finally {
          setRemovingId(null);
          setConfirmingId(null);
        }
      })();
    },
    [listId],
  );

  if (listId === null || notFound) {
    return (
      <Card className="km-hanja__empty">
        <Eyebrow>
          <Bilingual en="List not found" kr="목록을 찾을 수 없어요" />
        </Eyebrow>
        <p>This list doesn&apos;t exist (or was deleted). Head back to your lists.</p>
      </Card>
    );
  }
  if (loading) {
    return (
      <Card className="km-hanja__skeleton" aria-busy="true">
        <Eyebrow>
          <Bilingual en="Loading list" kr="목록을 불러오는 중" />
        </Eyebrow>
        <div className="km-hanja__skeleton-line" />
      </Card>
    );
  }
  if (fetchError !== null || list === null) {
    return (
      <ErrorCard
        message={fetchError ?? "This list couldn't be loaded."}
        onRetry={retry}
      />
    );
  }

  return (
    <>
      <CityCard tone="ochre" rail className="km-hanja__ld-head">
        <Eyebrow>
          <Bilingual en="Hanja list" kr="한자 목록" />
        </Eyebrow>
        <div className="kr kr-display km-hanja__ld-name">{list.name_kr}</div>
        {list.name_en !== null && list.name_en !== '' ? (
          <div className="km-hanja__ld-en">{list.name_en}</div>
        ) : null}
        <div className="km-hanja__ld-meta">
          <Bilingual
            en={`${String(hanjaEntries.length)} characters`}
            kr={`한자 ${String(hanjaEntries.length)}자`}
            compact
          />
        </div>
        <div className="km-hanja__row">
          <button
            type="button"
            className="km-btn km-btn--gold km-btn--md focusring"
            disabled={seedBusy || hanjaEntries.length === 0}
            onClick={addAllToDeck}
          >
            <Icon name="plus" size={14} />
            <span>
              {seedBusy ? (
                <Bilingual en="Adding…" kr="추가 중…" compact />
              ) : (
                <Bilingual en="Add all to deck" kr="모두 덱에 추가" compact />
              )}
            </span>
          </button>
          <button
            type="button"
            className="km-btn km-btn--ghost km-btn--md focusring"
            onClick={onStudy}
          >
            <Icon name="play" size={14} />
            <span>
              <Bilingual en="Study flashcards" kr="플래시카드 연습" compact />
            </span>
          </button>
          {/* F-166 — bulk add-hanja picker: choose WHICH characters join
              this list (the detail sheet's own AddToListTile covers the
              other direction — one character into a chosen list). */}
          <button
            type="button"
            className="km-btn km-btn--ghost km-btn--md focusring"
            onClick={() => {
              setPickerOpen(true);
            }}
          >
            <Icon name="hanja" size={14} />
            <span>
              <Bilingual en="Add hanja" kr="한자 추가" compact />
            </span>
          </button>
        </div>
        {seedStatus !== null ? (
          <p
            role={seedStatus.kind === 'error' ? 'alert' : 'status'}
            className={
              seedStatus.kind === 'error'
                ? 'km-hanja__inline-error'
                : 'km-hanja__inline-status'
            }
          >
            {seedStatus.text}
          </p>
        ) : null}
      </CityCard>

      {hanjaEntries.length === 0 ? (
        <Card className="km-hanja__empty km-giwa km-hangul-watermark" data-glyph="한">
          <Eyebrow>
            <Bilingual en="Empty list" kr="빈 목록" />
          </Eyebrow>
          <p>
            Open any character&apos;s detail sheet and use &ldquo;Add to a
            list&rdquo; — or use &ldquo;Add hanja&rdquo; above — to fill this
            one.
          </p>
        </Card>
      ) : (
        <div className="km-hanja__lists-col">
          {pager.visible.map((e) => (
            <div key={e.entry_id} className="km-hanja__list-row">
              <div className="km-hanja__ld-row">
                <span className="hanja km-hanja__ld-char">{e.hanja_char}</span>
                <span className="km-hanja__ld-rowmeta">
                  <span className="kr km-hanja__ld-sound">{e.hanja_sound}</span>
                  <span className="km-hanja__ld-gloss">{e.hanja_gloss_en}</span>
                </span>
                {e.hanja_level !== null && e.hanja_level !== '' ? (
                  <Pill>{e.hanja_level}</Pill>
                ) : null}
              </div>
              {confirmingId === e.entry_id ? (
                <div className="km-hanja__list-confirm">
                  <button
                    type="button"
                    className="km-btn km-btn--ghost km-btn--sm focusring km-hanja__danger"
                    disabled={removingId !== null}
                    onClick={() => {
                      removeEntry(e.entry_id);
                    }}
                  >
                    {removingId === e.entry_id ? (
                      <Bilingual en="Removing…" kr="빼는 중…" compact />
                    ) : (
                      <Bilingual en="Remove" kr="빼기" compact />
                    )}
                  </button>
                  <button
                    type="button"
                    className="km-btn km-btn--ghost km-btn--sm focusring"
                    disabled={removingId !== null}
                    onClick={() => {
                      setConfirmingId(null);
                    }}
                  >
                    <Bilingual en="Keep" kr="유지" compact />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="km-hanja__list-del focusring"
                  aria-label={`Remove ${e.hanja_char ?? 'character'} from list`}
                  onClick={() => {
                    setConfirmingId(e.entry_id);
                    setRowError(null);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
          <ShowMore
            canShowMore={pager.canShowMore}
            onShowMore={pager.showMore}
            remaining={pager.remaining}
          />
          {rowError !== null ? (
            <p role="alert" className="km-hanja__inline-error">
              {rowError}
            </p>
          ) : null}
        </div>
      )}
      {otherCount > 0 ? (
        <p className="km-hanja__ld-note">
          <Bilingual
            en={`${String(otherCount)} non-hanja item${otherCount === 1 ? '' : 's'} in this list aren't shown here.`}
            kr={`한자가 아닌 항목 ${String(otherCount)}개는 여기에 표시되지 않아요.`}
          />
        </p>
      ) : null}

      <AddHanjaPicker
        open={pickerOpen}
        listId={list.id}
        listName={list.name_kr}
        existing={existingChars}
        onClose={() => {
          setPickerOpen(false);
        }}
        onAdded={retry}
      />
    </>
  );
}

/**
 * F-166 — bulk add-hanja picker: fetches the whole `GET /hanja` pool itself
 * when it opens (the sub-view convention documented at the file top — this
 * page's fixtures are all real, not mocked), lets the user search + toggle
 * a selection, then seeds a card per chosen character and appends them all
 * to the list in one `POST /vocab/lists/:id/entries` call.
 */
function AddHanjaPicker({
  open,
  listId,
  listName,
  existing,
  onClose,
  onAdded,
}: {
  open: boolean;
  listId: number;
  listName: string;
  existing: ReadonlySet<string>;
  onClose: () => void;
  /** Fires once after a successful add so the parent can refetch the list. */
  onAdded: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [pool, setPool] = useState<Hanja[] | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const inputId = useId();

  useEffect(() => {
    if (!open) {
      setPool(null);
      setPoolError(null);
      setQuery('');
      setSelected(new Set());
      setSubmitError(null);
      return;
    }
    const ctrl = new AbortController();
    fetchHanjaList(undefined, ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setPool(rows);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isCanceled(err)) return;
        setPoolError(errorMessageFor(err, "Couldn't load hanja to add."));
      });
    return () => {
      ctrl.abort();
    };
  }, [open, tick]);

  const candidates = useMemo<Hanja[]>(() => {
    if (pool === null) return [];
    const q = query.trim().toLowerCase();
    return pool.filter((h) => {
      if (existing.has(h.ch)) return false;
      if (q === '') return true;
      return (
        h.ch.includes(query.trim()) ||
        h.sound.toLowerCase().includes(q) ||
        h.gloss.toLowerCase().includes(q) ||
        h.en.toLowerCase().includes(q)
      );
    });
  }, [pool, query, existing]);

  const visible = candidates.slice(0, PICKER_RENDER_CAP);

  const toggle = useCallback((ch: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      return next;
    });
  }, []);

  const submit = useCallback((): void => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const targets = Array.from(selected);
    void (async (): Promise<void> => {
      const ids: number[] = [];
      let failed = 0;
      for (const ch of targets) {
        try {
          const seeded = await seedHanjaCard(ch);
          ids.push(seeded.character_id);
        } catch {
          failed += 1;
        }
      }
      try {
        if (ids.length > 0) {
          await addHanjaToList(listId, ids);
        }
        if (ids.length > 0) {
          toast({
            message:
              failed > 0
                ? `Added ${String(ids.length)} of ${String(targets.length)} to “${listName}”.`
                : `Added ${String(ids.length)} hanja to “${listName}”.`,
            tone: failed > 0 ? 'info' : 'success',
          });
          onAdded();
          onClose();
        } else {
          setSubmitError("Couldn't add those characters. Try again.");
        }
      } catch (err) {
        setSubmitError(errorMessageFor(err, "Couldn't add those characters. Try again."));
      } finally {
        setSubmitting(false);
      }
    })();
  }, [selected, submitting, listId, listName, toast, onAdded, onClose]);

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="Add hanja to list">
      {/* Fix-pass batch-3 (SF-1) — shared `.km-review__sheet-body`/
          `__sheet-head` + `<Button>` Close, matching Review/Grammar/Reading's
          Sheet recipe instead of this page's own bespoke chrome. */}
      <div className="km-review__sheet-body">
        <div className="km-review__sheet-head">
          <Eyebrow>
            <Bilingual
              en={`Add hanja to “${listName}”`}
              kr={`“${listName}”에 한자 추가`}
            />
          </Eyebrow>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close add-hanja picker"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>
        <div className="km-hanja__picker">
          <label htmlFor={inputId} className="km-hanja__label">
            <Bilingual en="Search characters" kr="한자 검색" compact />
          </label>
          <div className="km-hanja__picker-search">
            <Icon name="search" size={14} />
            <input
              id={inputId}
              className="km-hanja__input focusring"
              value={query}
              placeholder="음, 뜻, or 한자"
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
          </div>
          {poolError !== null ? (
            <ErrorCard
              message={poolError}
              onRetry={() => {
                setPoolError(null);
                setTick((t) => t + 1);
              }}
            />
          ) : pool === null ? (
            <p className="km-hanja__addlist-loading" aria-busy="true">
              <Bilingual en="Loading hanja…" kr="한자를 불러오는 중…" />
            </p>
          ) : candidates.length === 0 ? (
            <p className="km-hanja__index-empty">
              <Bilingual en="No matching hanja." kr="일치하는 한자가 없어요." />
            </p>
          ) : (
            <>
              <ul className="km-hanja__picker-list">
                {visible.map((h) => {
                  const on = selected.has(h.ch);
                  return (
                    <li key={h.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        // Explicit aria-label (mirrors HanjaCell's own
                        // convention) rather than relying on the button's
                        // implicit child-text concatenation: adjacent JSX
                        // sibling <span>s with only whitespace between them
                        // render with NO space in the DOM, which would glue
                        // the char/sound/gloss together into one unreadable
                        // accessible-name word.
                        aria-label={`${h.ch} ${h.sound} ${h.en}${on ? ' — selected' : ''}`}
                        className={
                          'km-hanja__picker-row focusring' +
                          (on ? ' km-hanja__picker-row--on' : '')
                        }
                        onClick={() => {
                          toggle(h.ch);
                        }}
                      >
                        <span className="hanja km-hanja__picker-char">{h.ch}</span>
                        <span className="kr km-hanja__picker-sound">{h.sound}</span>
                        <span className="km-hanja__picker-gloss">{h.en}</span>
                        <Icon name={on ? 'check' : 'plus'} size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              {candidates.length > PICKER_RENDER_CAP ? (
                <p className="km-hanja__picker-note">
                  <Bilingual
                    en={`Showing ${String(PICKER_RENDER_CAP)} of ${String(candidates.length)} — type to narrow.`}
                    kr={`${String(candidates.length)}개 중 ${String(PICKER_RENDER_CAP)}개 표시 — 검색으로 좁히세요.`}
                    compact
                  />
                </p>
              ) : null}
            </>
          )}
          {submitError !== null ? (
            <p role="alert" className="km-hanja__inline-error">
              {submitError}
            </p>
          ) : null}
          <div className="km-hanja__row">
            <Button
              variant="gold"
              size="md"
              disabled={selected.size === 0 || submitting}
              onClick={submit}
            >
              {submitting ? (
                <Bilingual en="Adding…" kr="추가 중…" compact />
              ) : (
                <Bilingual
                  en={`Add ${String(selected.size)} selected`}
                  kr={`선택한 ${String(selected.size)}개 추가`}
                  compact
                />
              )}
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────
// Drawing drill sub-view (F-076), reworked for F-165 into a real Anki-style
// right/wrong loop over a session queue that feeds the hanja mastery pool
// (`Hanja.state`, the same signal F-167/F-170 read).
// ─────────────────────────────────────────────────────────────

function DrawView({
  chars,
  loading,
  onRetry,
  char,
  onStudy,
  onSetState,
  pendingChar,
  stateError,
}: {
  chars: Hanja[] | null;
  loading: boolean;
  onRetry: () => void;
  char: string | null;
  onStudy: () => void;
  /** F-165 — promotes a character one mastery band (shared with the detail
   *  sheet's bank control; see `promoteState`). */
  onSetState: (ch: string, next: HanjaState) => void;
  /** F-165 — the shared in-flight/error slot from the root (see its own
   *  doc comment); reused here exactly as `HanjaDetail` reuses it, since
   *  the two surfaces never render at the same time. */
  pendingChar: string | null;
  stateError: string | null;
}): JSX.Element {
  const requested =
    char !== null && char !== '' && chars !== null
      ? (chars.find((c) => c.ch === char) ?? null)
      : null;

  // F-165 session queue. `null` = "not yet seeded" (distinct from `[]`,
  // which means the session is genuinely complete). Seeded via the effect
  // below rather than a lazy `useState` initializer, because `chars` can
  // legitimately still be null on first mount (a real, in-flight fetch) —
  // a lazy initializer only ever runs once, so it would freeze the queue at
  // "not seeded" forever if the pool wasn't ready yet at that first tick.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [totalInSession, setTotalInSession] = useState(0);
  const [masteredCount, setMasteredCount] = useState(0);
  // F-115 — Recall (default, the F-165 mastery loop) vs Trace (guided,
  // non-graded). Local UI state, deliberately NOT a search param: the mode
  // is a per-session practice preference, and keeping it out of the URL
  // means a deep link always opens on the canonical recall drill.
  const [mode, setMode] = useState<DrawMode>('recall');
  // Which character the CURRENT queue was seeded for — not just "seeded at
  // all". No UI today re-navigates to a DIFFERENT `?char=` while staying on
  // `?view=draw` (every entry point changes `sub` too, which remounts this
  // component and resets everything for free) — but keying the guard on the
  // real identity, not just non-null, means a future same-sub "next
  // character" entry point can't inherit a stale queue by accident.
  const seededForRef = useRef<string | null>(null);

  useEffect(() => {
    if (chars === null || requested === null) return; // not ready yet
    if (seededForRef.current === requested.ch) return; // already seeded
    seededForRef.current = requested.ch;
    const built = buildDrawQueue(chars, requested.ch);
    // Sync-to-external-system exception (mirrors `MyVocabLists.tsx`'s own
    // mount-fetch effects): this derives the session queue from data that
    // legitimately arrives asynchronously (a real, in-flight `GET /hanja`
    // on first mount) — a lazy `useState` initializer only runs once and
    // would freeze the queue at "not seeded" forever if the pool wasn't
    // ready yet at that first tick, so the derivation has to live here.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setQueue(built);
    setTotalInSession(built.length);
    setMasteredCount(0);
  }, [chars, requested]);

  const currentCh = queue?.[0] ?? null;
  const current = useMemo<Hanja | null>(() => {
    if (currentCh === null || chars === null) return null;
    return chars.find((c) => c.ch === currentCh) ?? null;
  }, [chars, currentCh]);

  const judgeRight = useCallback((): void => {
    if (current === null) return;
    const next = promoteState(current.state);
    // Already banked — a right answer just confirms it; skip the no-op
    // write (the character is already at the top of the pool) AND skip the
    // "mastered" count bump (F-181): the progress label reads "N of M
    // mastered", and a reconfirmation of an already-mastered character is
    // not a new mastery event, so it must not inflate that count even
    // though the character still advances out of the queue below.
    if (next !== current.state) {
      onSetState(current.ch, next);
      setMasteredCount((n) => n + 1);
    }
    setQueue((q) => (q ? q.slice(1) : q));
  }, [current, onSetState]);

  const judgeWrong = useCallback((): void => {
    // F-165: wrong just re-queues — no state write. The character comes
    // back around later in THIS session, same as an Anki lapse.
    setQueue((q) => {
      if (q === null || q.length === 0) return q;
      const [head, ...rest] = q;
      return head === undefined ? q : [...rest, head];
    });
  }, []);

  // F-115 — trace mode's only advance: pop the head, write nothing. Tracing
  // is guided practice, not recall — it must never feed the mastery pool
  // (that's what promoteState/onSetState in the recall loop are for).
  const traceNext = useCallback((): void => {
    setQueue((q) => (q ? q.slice(1) : q));
  }, []);

  if (char === null || char === '') {
    return (
      <Card className="km-hanja__empty">
        <Eyebrow>
          <Bilingual en="No character selected" kr="선택된 한자가 없어요" />
        </Eyebrow>
        <p>Open a character&apos;s detail sheet and choose the drawing drill.</p>
      </Card>
    );
  }
  if (loading) {
    return (
      <Card className="km-hanja__skeleton" aria-busy="true">
        <Eyebrow>
          <Bilingual en="Loading hanja" kr="한자를 불러오는 중" />
        </Eyebrow>
        <div className="km-hanja__skeleton-line" />
      </Card>
    );
  }
  if (chars === null) {
    return (
      <ErrorCard message="The hanja pool couldn't be loaded." onRetry={onRetry} />
    );
  }
  if (requested === null) {
    return (
      <Card className="km-hanja__empty">
        <Eyebrow>
          <Bilingual en="Character not found" kr="한자를 찾을 수 없어요" />
        </Eyebrow>
        <p>That character isn&apos;t in the corpus.</p>
      </Card>
    );
  }
  if (queue === null) {
    return (
      <Card className="km-hanja__skeleton" aria-busy="true">
        <Eyebrow>
          <Bilingual en="Preparing your drill" kr="연습을 준비하는 중" />
        </Eyebrow>
        <div className="km-hanja__skeleton-line" />
      </Card>
    );
  }
  if (queue.length === 0) {
    // F-165/F-170 — session complete. In recall mode every character was
    // marked right at least once (mastery band advanced or reconfirmed);
    // in trace mode (F-115) nothing was graded, so the seal must not claim
    // "Mastered" — it stamps the neutral fact ("Traced") instead, matching
    // the non-graded completion line below.
    return (
      <Card className="km-hanja__empty km-giwa km-hangul-watermark" data-glyph="한">
        <span className="km-hanja__complete-seal">
          <SealStamp
            milestone
            size="md"
            tone="accent"
            label={
              mode === 'trace' ? (
                <Bilingual en="Traced" kr="따라 씀" compact />
              ) : (
                <Bilingual en="Mastered" kr="마스터" compact />
              )
            }
            className="km-najeon"
          />
        </span>
        <Eyebrow>
          <Bilingual en="Drill complete" kr="연습 완료" />
        </Eyebrow>
        <p>
          {mode === 'trace' ? (
            // F-115 — trace sessions are practice, not judged recall; the
            // completion line must not claim correctness.
            <Bilingual
              en={`You traced ${String(totalInSession)} character${totalInSession === 1 ? '' : 's'}.`}
              kr={`${String(totalInSession)}자를 따라 썼어요.`}
            />
          ) : (
            <Bilingual
              en={`You drew ${String(totalInSession)} character${totalInSession === 1 ? '' : 's'} correctly.`}
              kr={`${String(totalInSession)}자를 맞혔어요.`}
            />
          )}
        </p>
        <div className="km-hanja__row">
          <button
            type="button"
            className="km-btn km-btn--gold km-btn--md focusring"
            onClick={onStudy}
          >
            <Icon name="cards" size={14} />
            <span>
              <Bilingual en="Study flashcards" kr="플래시카드 연습" compact />
            </span>
          </button>
        </div>
      </Card>
    );
  }
  if (current === null) {
    // Defensive — the head character vanished from the pool between seed
    // and now. State writes only ever change `state`, never remove a pool
    // entry, so this shouldn't happen; render an honest error rather than
    // crash if it somehow does.
    return (
      <ErrorCard
        message="That character is no longer available."
        onRetry={onRetry}
      />
    );
  }

  const judging = pendingChar === current.ch;
  // F-115 — how far the trace session has advanced (characters popped off
  // the queue). Recall keeps its own masteredCount (F-181 semantics — a
  // banked reconfirmation advances the queue without counting).
  const completed = totalInSession - queue.length;

  return (
    <>
      <CityCard tone="ochre" rail className="km-hanja__draw-prompt">
        <Eyebrow>
          <Bilingual en="Drawing drill" kr="쓰기 연습" />
        </Eyebrow>
        <div className="kr kr-display km-hanja__study-gloss">
          <span>{current.gloss}</span>{' '}
          <span className="km-hanja__study-sound">{current.sound}</span>
        </div>
        <div className="km-hanja__study-en">{current.en}</div>
        <div className="km-hanja__study-pills">
          <Pill>
            <Bilingual
              en={`${String(current.strokes)} strokes`}
              kr={`${String(current.strokes)}획`}
              compact
            />
          </Pill>
          <Pill>{current.level}</Pill>
        </div>
        <p className="km-hanja__draw-note">
          {mode === 'trace' ? (
            <Bilingual
              en="Trace over the faint character on the pad to learn its shape."
              kr="패드의 흐린 글자를 따라 쓰며 모양을 익혀 보세요."
            />
          ) : (
            <Bilingual
              en="Draw the character from memory, then reveal it to compare."
              kr="기억을 떠올려 한자를 쓴 다음, 글자를 확인해 보세요."
            />
          )}
        </p>
      </CityCard>

      {/* F-115 — Recall vs Trace. Same chip VISUALS as the index filter
          toolbar (plain buttons, toggled state on aria-pressed), but
          role="group" rather than role="toolbar" — toolbar conventionally
          implies roving-tabindex arrow-key nav, which these two chips
          don't (and needn't) implement. */}
      <div className="km-hanja__draw-mode" role="group" aria-label="Drill mode">
        {DRAW_MODE_OPTIONS.map((m) => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setMode(m.id);
              }}
              className={
                'km-pill focusring km-hanja__draw-mode-chip' +
                (active ? ' km-pill--gold' : ' km-pill--default')
              }
            >
              <Bilingual en={m.label} kr={m.kr} compact />
            </button>
          );
        })}
      </div>

      {/* F-170 — live progress across the session: in recall mode, stations
          "done" are characters mastered/re-confirmed this session (F-181);
          in trace mode (F-115, nothing judged) they are simply the
          characters traced so far. */}
      <div className="km-hanja__draw-subway">
        <SubwayProgress
          steps={totalInSession}
          current={mode === 'trace' ? completed : masteredCount}
          tone="accent"
          label="Draw drill progress"
          valueText={
            mode === 'trace'
              ? `${String(completed)} of ${String(totalInSession)} traced`
              : `${String(masteredCount)} of ${String(totalInSession)} mastered`
          }
        />
      </div>

      <CollapsibleTile
        title={<Bilingual en="About this drill" kr="안내" />}
        defaultCollapsed
        surface="city"
        tone="ochre"
        className="km-hanja__draw-about"
      >
        <p>
          Freehand practice only — nothing is graded or saved about HOW you
          draw. Recall hides the character so you draw from memory; Trace
          shows it as a faint guide behind the pad so you can draw over it.
          Numbered stroke-order guidance isn&apos;t available: the corpus
          doesn&apos;t carry per-character stroke data.
        </p>
        <p>
          In Recall mode, marking Right/Wrong IS real, though — it writes to
          your hanja mastery pool the same way banking a character does.
          Trace mode writes nothing. Drawing needs a pointer (finger, pen,
          or mouse). If you use a keyboard or screen reader, the flashcard
          drill covers the same recall practice:
        </p>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--sm focusring"
          onClick={onStudy}
        >
          <Icon name="cards" size={14} />
          <span>
            <Bilingual en="Flashcard drill" kr="플래시카드 연습" compact />
          </span>
        </button>
      </CollapsibleTile>

      {/* key includes the mode (F-115): switching Recall ↔ Trace is a
          different exercise over the same character, so the pad resets
          (fresh strokes, reveal state cleared) exactly like advancing to
          the next character does. */}
      <DrawingPad
        key={`${mode}:${current.ch}`}
        ch={current.ch}
        guide={mode === 'trace'}
      />

      {mode === 'trace' ? (
        <>
          {/* F-115 — non-graded: no judgment, no writes; Next just advances
              the session queue. Reuses the judge row's button styling so the
              primary action sits in the same place in both modes. */}
          <div className="km-hanja__draw-judge km-hanja__draw-judge--trace">
            <button
              type="button"
              className="km-hanja__draw-right focusring"
              onClick={traceNext}
            >
              <Icon name="arrow-right" size={16} />
              <span>
                <Bilingual en="Next character" kr="다음 글자" compact />
              </span>
            </button>
          </div>
          <p className="km-hanja__draw-mastery-note">
            <Bilingual
              en="Trace mode is guided practice only — nothing is graded and nothing is written to your mastery pool."
              kr="따라 쓰기는 연습용이에요 — 채점되지 않고 숙련도에도 반영되지 않아요."
            />
          </p>
        </>
      ) : (
        <>
          <div className="km-hanja__draw-judge" role="group" aria-label="Rate your drawing">
            <button
              type="button"
              className="km-hanja__draw-right focusring"
              disabled={judging}
              aria-busy={judging}
              onClick={judgeRight}
            >
              <Icon name="check" size={16} />
              <span>
                {judging ? (
                  <Bilingual en="Saving…" kr="저장 중…" compact />
                ) : (
                  <Bilingual en="Right" kr="맞음" compact />
                )}
              </span>
            </button>
            <button
              type="button"
              className="km-hanja__draw-wrong focusring"
              onClick={judgeWrong}
            >
              <Icon name="close" size={16} />
              <span>
                <Bilingual en="Wrong" kr="틀림" compact />
              </span>
            </button>
          </div>
          <p className="km-hanja__draw-mastery-note">
            <Bilingual
              en="Right or wrong feeds your hanja mastery pool — wrong re-queues the character, right advances it toward mastery."
              kr="맞고 틀림이 한자 숙련도 풀에 반영돼요 — 틀리면 다시 나오고, 맞으면 숙련도가 올라가요."
            />
          </p>
        </>
      )}
      {/* A state-write error can only come from the recall loop (trace never
          writes), so don't let a stale recall failure linger into trace mode;
          the state itself is kept, so switching back to recall — where the
          retry is actionable — shows it again. */}
      {mode === 'recall' && stateError !== null ? (
        <p role="alert" className="km-hanja__study-error">
          {stateError}
        </p>
      ) : null}
    </>
  );
}

interface DrawPoint {
  x: number;
  y: number;
}

/** Fallback logical canvas size when layout hasn't happened (e.g. jsdom). */
const PAD_FALLBACK_PX = 300;

/**
 * DrawingPad — the freehand canvas + its controls. Committed strokes live in
 * state (drives Undo/Clear enablement + the repaint effect); the ACTIVE
 * stroke accrues in a ref and paints incrementally per pointer-move, so
 * drawing never re-renders per event. Pointer capture is deliberately not
 * used — a stroke simply ends when the pointer leaves the pad (simpler, and
 * capture support is spotty in test/embedded environments); pointerdown/
 * move/up/leave/cancel covers mouse, touch, and pen alike.
 *
 * Rendered with `key={mode:ch}` by its caller (F-165/F-115) — a fresh key
 * per queued character (or mode switch) remounts the whole component, which
 * is exactly the reset strokes/reveal state need between drill rounds; no
 * imperative reset API needed.
 *
 * F-115 `guide`: when true (trace mode) the target character renders as a
 * faint template BEHIND the canvas — the same `aria-hidden` ghost glyph the
 * recall reveal uses (the canvas bitmap is transparent, so committed strokes
 * paint over it) — and the Show/Hide reveal toggle is dropped as redundant.
 * Nothing about the strokes is compared against the template: the guide is
 * a visual aid, not a grader (product decision — no stroke dataset).
 */
function DrawingPad({
  ch,
  guide = false,
}: {
  ch: string;
  /** F-115 — always show the character as a faint trace template. */
  guide?: boolean;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dprRef = useRef(1);
  const activeRef = useRef<DrawPoint[] | null>(null);
  const [strokes, setStrokes] = useState<ReadonlyArray<readonly DrawPoint[]>>([]);
  const [revealed, setRevealed] = useState(false);

  // Size the bitmap to the CSS box once on mount, scaled by the device
  // pixel ratio so strokes stay crisp on high-DPI screens.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    dprRef.current = dpr;
    canvas.width = Math.round((rect.width > 0 ? rect.width : PAD_FALLBACK_PX) * dpr);
    canvas.height = Math.round((rect.height > 0 ? rect.height : PAD_FALLBACK_PX) * dpr);
  }, []);

  /** 2d context, styled for stroke drawing; null when unavailable (jsdom —
   *  the stroke MODEL still updates so controls stay honest). */
  const styledCtx = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    // Ink color rides the canvas's computed CSS `color` (tokenized in
    // Hanja.css) so both themes and every accent preset come free.
    const inkColor = getComputedStyle(canvas).color;
    ctx.strokeStyle = inkColor !== '' ? inkColor : '#3a3a3a';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    return ctx;
  }, []);

  // Repaint every committed stroke whenever the model changes (commit /
  // undo / clear). Idempotent full redraw — the incremental segments the
  // active stroke painted are subsumed once it commits.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = styledCtx();
    if (canvas === null || ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dprRef.current, dprRef.current);
    for (const stroke of strokes) {
      const first = stroke[0];
      if (first === undefined) continue;
      if (stroke.length === 1) {
        // A tap is a dot, not an invisible zero-length line.
        ctx.beginPath();
        ctx.arc(first.x, first.y, 3, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.restore();
  }, [strokes, styledCtx]);

  const pointFrom = (e: ReactPointerEvent<HTMLCanvasElement>): DrawPoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    // Only the primary mouse button draws; touch/pen always do.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    activeRef.current = [pointFrom(e)];
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const active = activeRef.current;
    if (active === null) return;
    const prev = active[active.length - 1];
    const next = pointFrom(e);
    active.push(next);
    // Paint the new segment immediately — no per-move re-render.
    const ctx = styledCtx();
    if (ctx !== null && prev !== undefined) {
      ctx.save();
      ctx.scale(dprRef.current, dprRef.current);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
      ctx.restore();
    }
  };

  const endStroke = (): void => {
    const active = activeRef.current;
    if (active === null) return;
    activeRef.current = null;
    setStrokes((prev) => [...prev, active]);
  };

  const undo = (): void => {
    setStrokes((prev) => prev.slice(0, -1));
  };
  const clear = (): void => {
    setStrokes([]);
  };

  return (
    <>
      <div className="km-hanja__draw-stage">
        <TianGrid />
        {guide || revealed ? (
          // Behind the canvas in paint order (the canvas is a later sibling
          // filling the same stage), so strokes always land ON TOP of the
          // template/ghost. `--guide` (F-115) is the slightly stronger trace
          // template; the bare ghost is the recall reveal.
          <span
            className={
              'hanja km-hanja__draw-ghost' +
              (guide ? ' km-hanja__draw-ghost--guide' : '')
            }
            aria-hidden="true"
          >
            {ch}
          </span>
        ) : null}
        <canvas
          ref={canvasRef}
          className="km-hanja__draw-canvas"
          // The pad is pointer-operated; the About tile names the keyboard/
          // AT alternative (flashcard drill). role="img" keeps AT from
          // presenting an operable-but-unusable widget.
          role="img"
          aria-label={
            guide
              ? `Tracing pad for the character ${ch}. Trace the faint guide with a finger, pen, or mouse.`
              : `Drawing pad for the character ${ch}. Draw with a finger, pen, or mouse.`
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          onPointerCancel={endStroke}
        />
      </div>
      <div className="km-hanja__draw-controls">
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--sm focusring"
          disabled={strokes.length === 0}
          onClick={undo}
        >
          <Bilingual en="Undo" kr="되돌리기" compact />
        </button>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--sm focusring"
          disabled={strokes.length === 0}
          onClick={clear}
        >
          <Bilingual en="Clear" kr="지우기" compact />
        </button>
        {guide ? null : (
          // Trace mode (F-115) drops the reveal toggle — the template is
          // already permanently visible, so Show/Hide would be a no-op lie.
          <button
            type="button"
            className="km-btn km-btn--ghost km-btn--sm focusring"
            aria-pressed={revealed}
            onClick={() => {
              setRevealed((r) => !r);
            }}
          >
            {revealed ? (
              <Bilingual en="Hide character" kr="글자 숨기기" compact />
            ) : (
              <Bilingual en="Show character" kr="글자 보기" compact />
            )}
          </button>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail sheet.
// ─────────────────────────────────────────────────────────────

function HanjaDetail({
  h,
  pending,
  error,
  onSetState,
  onNavigate,
}: {
  h: Hanja;
  /** True while this character's `setHanjaState` call is in flight. */
  pending: boolean;
  /** Inline error from the last failed state write, or null. */
  error: string | null;
  onSetState: (ch: string, next: HanjaState) => void;
  /** Close the sheet + route (drill / draw CTAs leave this page). */
  onNavigate: (to: string) => void;
}): JSX.Element {
  // The single mastery control toggles the character between the SRS
  // ("practicing") and mastered ("banked" on the wire) states. A mastered
  // character offers "Practice again"; anything else offers "Mark as
  // mastered" (F-077 reword — was "Bank this hanja").
  const nextState: HanjaState = h.state === 'banked' ? 'practicing' : 'banked';

  // B-028: the Drill CTA seeds this character's recognition card (idempotent
  // — an existing card is returned, not duplicated) so it is immediately
  // due, then enters the flashcard drill. On success we navigate away, so
  // pending is only reset on the failure path.
  const [drillPending, setDrillPending] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);
  const onDrill = useCallback((): void => {
    if (drillPending) return;
    setDrillPending(true);
    setDrillError(null);
    void (async (): Promise<void> => {
      try {
        await seedHanjaCard(h.ch);
        onNavigate(`${HANJA_PATH}?view=study`);
      } catch (err) {
        setDrillError(
          errorMessageFor(err, "Couldn't start the drill. Try again."),
        );
        setDrillPending(false);
      }
    })();
  }, [drillPending, h.ch, onNavigate]);

  return (
    <div className="km-hanja__detail">
      <div className="km-hanja__detail-head">
        <span className="hanja km-hanja__detail-char">{h.ch}</span>
        <div className="km-hanja__detail-meta">
          <div className="kr kr-display km-hanja__detail-gloss">
            <span>{h.gloss}</span>{' '}
            <span className="km-hanja__detail-sound">{h.sound}</span>
          </div>
          <div className="km-hanja__detail-en">{h.en}</div>
          <div className="km-hanja__detail-pills">
            <Pill>
              <Bilingual
                en={`${String(h.strokes)} strokes`}
                kr={`${String(h.strokes)}획`}
                compact
              />
            </Pill>
            <Pill>{h.level}</Pill>
            <Pill tone={STATE_PILL_TONE[h.state]}>
              <Bilingual
                en={STATE_PILL_LABEL[h.state]}
                kr={STATE_PILL_KR[h.state]}
                compact
              />
            </Pill>
          </div>
        </div>
      </div>

      <Eyebrow className="km-hanja__detail-eyebrow">
        <Bilingual en="Etymology" kr="어원" />
      </Eyebrow>
      <p className="km-hanja__detail-note">{h.note}</p>

      <Eyebrow className="km-hanja__detail-eyebrow">
        <Bilingual
          en={`Compound words · ${String(h.compounds.length)}`}
          kr={`복합어 · ${String(h.compounds.length)}개`}
        />
      </Eyebrow>
      <ul className="km-hanja__detail-compounds">
        {h.compounds.map((c, i) => (
          <li key={`${c.kr}-${String(i)}`} className="km-hanja__detail-row">
            <span className="hanja km-hanja__detail-compound-han">
              {Array.from(c.han).map((glyph, gi) => (
                <span
                  key={`${glyph}-${String(gi)}`}
                  className={
                    glyph === h.ch
                      ? 'km-hanja__detail-han km-hanja__detail-han--studied'
                      : 'km-hanja__detail-han'
                  }
                >
                  {glyph}
                </span>
              ))}
            </span>
            <div className="km-hanja__detail-compound-meta">
              <div className="kr km-hanja__detail-compound-reading">{c.kr}</div>
              <div className="km-hanja__detail-compound-en">{c.en}</div>
            </div>
            <span className="km-hanja__detail-compound-with">
              + <span className="hanja">{c.with}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="km-hanja__detail-cta">
        <button
          type="button"
          className="km-btn km-btn--gold km-btn--md focusring km-hanja__detail-drill"
          disabled={drillPending}
          aria-busy={drillPending}
          onClick={onDrill}
        >
          <Icon name="pen" size={14} />
          <span>
            {drillPending ? (
              <Bilingual en="Starting…" kr="시작 중…" />
            ) : (
              <Bilingual en="Drill · recall 음 & 뜻" kr="연습 · 음과 뜻 떠올리기" />
            )}
          </span>
        </button>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--md focusring km-hanja__detail-bank"
          disabled={pending}
          aria-busy={pending}
          onClick={() => {
            onSetState(h.ch, nextState);
          }}
        >
          <Icon name="plus" size={14} />
          <span>
            {pending ? (
              <Bilingual en="Saving…" kr="저장 중…" />
            ) : h.state === 'banked' ? (
              <Bilingual en="Practice again" kr="다시 연습" />
            ) : (
              <Bilingual en="Mark as mastered" kr="숙달로 표시" />
            )}
          </span>
        </button>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--md focusring km-hanja__detail-draw"
          onClick={() => {
            onNavigate(drawPathFor(h.ch));
          }}
        >
          <Icon name="pen" size={14} />
          <span>
            <Bilingual en="Drawing drill" kr="쓰기 연습" />
          </span>
        </button>
      </div>
      {drillError !== null ? (
        <p className="km-hanja__detail-error" role="alert">
          {drillError}
        </p>
      ) : null}
      {error ? (
        <p className="km-hanja__detail-error" role="alert">
          {error}
        </p>
      ) : null}

      <AddToListTile ch={h.ch} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Add-to-list tile (F-075) — inside the detail sheet.
// ─────────────────────────────────────────────────────────────

interface AddStatus {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * AddToListTile — put the open character into a hanja list (or create one).
 *
 * List membership needs the numeric `hanja_characters.id`, which the pool
 * DTO doesn't expose (`Hanja.id` is the char itself) — so both actions
 * first call the idempotent `seedHanjaCard`, whose response carries
 * `character_id`. The side effect (a recognition card lands in the deck)
 * is deliberate and stated in the tile copy: lists ARE study lists here.
 * A duplicate membership (server 409) reads as information, not failure.
 */
function AddToListTile({ ch }: { ch: string }): JSX.Element {
  const [lists, setLists] = useState<ServerVocabList[] | null>(null);
  const [listsError, setListsError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AddStatus | null>(null);
  const inputId = useId();

  useEffect(() => {
    const ctrl = new AbortController();
    fetchHanjaLists(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setLists(rows);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isCanceled(err)) return;
        setListsError(errorMessageFor(err, "Couldn't load your lists."));
      });
    return () => {
      ctrl.abort();
    };
  }, [tick]);

  const retryLists = useCallback((): void => {
    setLists(null);
    setListsError(null);
    setTick((t) => t + 1);
  }, []);

  const addTo = useCallback(
    (listId: number, listName: string): void => {
      if (busy) return;
      setBusy(true);
      setStatus(null);
      void (async (): Promise<void> => {
        try {
          const seeded = await seedHanjaCard(ch);
          await addHanjaToList(listId, [seeded.character_id]);
          setStatus({ kind: 'ok', text: `Added ${ch} to “${listName}”.` });
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            setStatus({
              kind: 'ok',
              text: `${ch} is already in “${listName}”.`,
            });
          } else {
            setStatus({
              kind: 'error',
              text: errorMessageFor(err, "Couldn't add to that list. Try again."),
            });
          }
        } finally {
          setBusy(false);
        }
      })();
    },
    [busy, ch],
  );

  const createAndAdd = useCallback((): void => {
    const name = newName.trim();
    if (name === '' || busy) return;
    setBusy(true);
    setStatus(null);
    void (async (): Promise<void> => {
      // Phase 1 — create the list. Only THIS failure may say "couldn't
      // create": once the list exists (it's already in local state and
      // pre-selected below), repeating that copy would invite a retry via
      // "Create & add" that mints a duplicate, identically-named list.
      let listId: number;
      try {
        const res = await createList({ name_kr: name, kind: 'hanja' });
        listId = res.list.id;
        const created: ServerVocabList = res.list;
        setLists((prev) => (prev ? [created, ...prev] : [created]));
        setSelected(String(listId));
        setNewName('');
      } catch (err) {
        setStatus({
          kind: 'error',
          text: errorMessageFor(err, "Couldn't create that list. Try again."),
        });
        setBusy(false);
        return;
      }
      // Phase 2 — seed the card + write the membership. On failure the
      // status names the real state and points at the safe retry path (the
      // fresh list is pre-selected in the combobox above).
      try {
        const seeded = await seedHanjaCard(ch);
        await addHanjaToList(listId, [seeded.character_id]);
        setStatus({ kind: 'ok', text: `Created “${name}” and added ${ch}.` });
      } catch {
        setStatus({
          kind: 'error',
          text: `Created “${name}”, but ${ch} couldn't be added — it's selected above, press Add to retry.`,
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [newName, busy, ch]);

  const selectedList =
    lists?.find((l) => String(l.id) === selected) ?? null;

  return (
    <CollapsibleTile
      title={<Bilingual en="Add to a list" kr="목록에 추가" />}
      defaultCollapsed
      surface="city"
      tone="ochre"
      className="km-hanja__addlist"
    >
      <p className="km-hanja__addlist-note">
        Lists group characters for focused study. Adding {ch} also puts its
        flashcard in your deck.
      </p>
      {listsError !== null ? (
        <div className="km-hanja__addlist-error">
          <p role="alert" className="km-hanja__inline-error">
            {listsError}
          </p>
          <button
            type="button"
            className="km-btn km-btn--ghost km-btn--sm focusring"
            onClick={retryLists}
          >
            <Bilingual en="Retry" kr="다시 시도" compact />
          </button>
        </div>
      ) : lists === null ? (
        <p className="km-hanja__addlist-loading" aria-busy="true">
          <Bilingual en="Loading lists…" kr="목록을 불러오는 중…" />
        </p>
      ) : (
        <>
          {lists.length > 0 ? (
            <div className="km-hanja__row">
              <FilterSelect
                label="List"
                placeholder="Choose a list"
                options={lists.map((l) => ({
                  value: String(l.id),
                  label: l.name_kr,
                }))}
                value={selected}
                onChange={setSelected}
                disabled={busy}
                className="km-hanja__addlist-select"
              />
              <button
                type="button"
                className="km-btn km-btn--gold km-btn--sm focusring"
                disabled={busy || selectedList === null}
                onClick={() => {
                  if (selectedList !== null) {
                    addTo(selectedList.id, selectedList.name_kr);
                  }
                }}
              >
                {busy ? (
                  <Bilingual en="Adding…" kr="추가 중…" compact />
                ) : (
                  <Bilingual en="Add" kr="추가" compact />
                )}
              </button>
            </div>
          ) : null}
          <label htmlFor={inputId} className="km-hanja__label">
            <Bilingual en="New list name" kr="새 목록 이름" compact />
          </label>
          <div className="km-hanja__row">
            <input
              id={inputId}
              className="km-hanja__input focusring"
              value={newName}
              maxLength={120}
              placeholder="e.g. 자주 틀리는 한자"
              disabled={busy}
              onChange={(e) => {
                setNewName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createAndAdd();
              }}
            />
            <button
              type="button"
              className="km-btn km-btn--ghost km-btn--sm focusring"
              disabled={busy || newName.trim() === ''}
              onClick={createAndAdd}
            >
              <Bilingual en="Create & add" kr="만들고 추가" compact />
            </button>
          </div>
        </>
      )}
      {status !== null ? (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={
            status.kind === 'error'
              ? 'km-hanja__inline-error'
              : 'km-hanja__inline-status'
          }
        >
          {status.text}
        </p>
      ) : null}
    </CollapsibleTile>
  );
}
