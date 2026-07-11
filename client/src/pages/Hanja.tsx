/**
 * Hanja screen — 한자 character study.
 *
 * Root views, locally state-toggled:
 *   - `today` — `HanjaFeature` card for the day's featured character,
 *               vermilion 田 grid backdrop, 96px serif glyph, compound
 *               word chips beneath a `GoldRule`.
 *   - `index` — filter chips (All / Banked / Practicing / New) over a
 *               grid of `<HanjaCell>`s, windowed by `usePagination` +
 *               `<ShowMore>` so a large corpus doesn't render at once.
 *
 * Nested sub-views (Phase 3C-1), routed on the `view` search param so each
 * is deep-linkable and gets a real `<BackButton>` (F-024):
 *   - `?view=study`          — FSRS flashcard drill over due hanja cards
 *                              (F-075/B-028). Mirrors the vocab Review
 *                              session: flip, 4 self-ratings, spacebar
 *                              reveal, server-authoritative scheduling.
 *   - `?view=lists`          — hanja list index + creation (F-075). Lists
 *                              ride the shared vocab-lists infra
 *                              (migration 049 multitype membership).
 *   - `?view=list&id=N`      — one list's characters: remove, seed the
 *                              whole list into the deck, paginated rows.
 *   - `?view=draw&char=X`    — freehand drawing drill on a canvas over the
 *                              田 grid (F-076). Practice-only (not graded);
 *                              stroke-order guidance is honestly absent —
 *                              the corpus carries no stroke data.
 *
 * Tapping any cell or the feature card opens a `<Sheet>` with the
 * etymology + compound network + drill / bank / draw / add-to-list CTAs.
 * Per design `screens-c.jsx` HanjaDetailSheet — only the studied character
 * is vermilion inside each compound; the other glyphs stay paper ink.
 *
 * Data:
 *   - `GET /hanja`, `GET /hanja/today`, `GET /hanja/progress` via
 *     `useEndpointOrMock` (dev-only 🅂 badge while a source is on its mock
 *     fallback); `POST /hanja/:char/state` with the optimistic overlay
 *     described at `onSetState`.
 *   - Flashcards (F-075/B-028): `POST /hanja/:char/card` (idempotent seed),
 *     `GET /hanja/cards/due`, `POST /hanja/cards/:cardId/reviews`
 *     (`expected_version` optimistic concurrency; 409 = stale → refresh).
 *   - Lists (F-075): `GET /vocab/lists?kind=hanja`, `POST /vocab/lists`
 *     (kind 'hanja'), `GET /vocab/lists/:id` (049 multitype rows),
 *     `POST /vocab/lists/:id/entries` (typed hanja items; 409 = duplicate),
 *     `DELETE …/entries/:id?type=hanja`, `DELETE /vocab/lists/:id`.
 *   The sub-views fetch directly (abortable AbortController effects with
 *   real error + retry paths) — they have no mock fixtures, so routing them
 *   through `useEndpointOrMock` would only fabricate an empty fallback.
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
 *     are real buttons; the reveal toggle carries `aria-pressed`.
 *   - Nested views carry a `BackButton` with an explicit `to` (F-024) so
 *     deep links can never strand the user.
 *
 * Threat model: reads are GETs (no CSRF surface); every write is a POST /
 * DELETE defended by the `SameSite=Strict` session cookie and user-scoped
 * server-side. No user input flows into HTML outside React's escaping; all
 * error copy is author-controlled via `errorMessageFor` (never server
 * prose). A failed `setHanjaState` applies NO optimistic overlay entry (the
 * overlay is written only after the await resolves). Review scheduling is
 * server-authoritative — the client sends only its rating + the card's
 * `expected_version`, so a tampered client cannot park or rush a card.
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
import { Card } from '../components/Card';
import { Bilingual } from '../components/Bilingual';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { FilterSelect } from '../components/FilterSelect';
import { Flashcard } from '../components/Flashcard';
import { GoldRule } from '../components/GoldRule';
import { HanjaCell } from '../components/HanjaCell';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { Sheet } from '../components/Sheet';
import { ShowMore } from '../components/ShowMore';
import { TianGrid } from '../components/TianGrid';
import { Topbar } from '../components/Topbar';
import {
  loadHanjaMock,
  loadHanjaProgressMock,
  loadHanjaTodayMock,
} from '../data/mocks/hanja';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { usePagination } from '../hooks/usePagination';
import { encounteredBarAria } from '../lib/encounteredBar';
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

const FILTER_OPTIONS: ReadonlyArray<{
  id: FilterMode;
  label: string;
  kr: string;
}> = [
  { id: 'all', label: 'All', kr: '전체' },
  { id: 'banked', label: 'Banked', kr: '담김' },
  { id: 'practicing', label: 'Practicing', kr: '연습 중' },
  { id: 'new', label: 'New', kr: '신규' },
];

const STATE_PILL_LABEL: Record<HanjaState, string> = {
  banked: 'Banked',
  practicing: 'Practicing',
  new: 'New',
};

/** Korean chrome labels for the three hanja states (P3b). `banked` uses the
 *  담기/담김 family (glossary): bare 모음 as a status chip was ambiguous next
 *  to Hanja content (모음 also = "vowel"). */
const STATE_PILL_KR: Record<HanjaState, string> = {
  banked: '담김',
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

  // Recompute the progress band from the overlay deltas so the Banked /
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
  // its skeleton.
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
      />
    );
  }

  return (
    <section
      className="screen km-hanja"
      style={{ position: 'relative' }}
      aria-labelledby="km-hanja-title"
    >
      {isMock && sub === null ? <MockBadge /> : null}
      {sub !== null ? (
        <BackButton to={backTo} label={backLabel} className="km-hanja__back" />
      ) : null}
      <Topbar
        krTitle="한자"
        title="Hanja"
        titleId="km-hanja-title"
        // P3b trim — adopts nav.ts's terse pair (was the flowery
        // "the bones inside the words").
        eyebrow={<Bilingual en={HANJA_NAV.eyebrow} kr={HANJA_NAV.krEyebrow} />}
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
                <Card className="km-hanja__empty">
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
              />
            )}
          </>
        ) : (
          <Card className="km-hanja__empty">
            <Eyebrow>
              <Bilingual en="No hanja yet" kr="아직 한자가 없어요" />
            </Eyebrow>
            <p>Read a passage to start encountering 한자.</p>
          </Card>
        ))}

      {sub === null ? (
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
  return (
    <Card className="km-hanja__band">
      <Eyebrow>
        <Bilingual
          en={`Encountered · ${String(progress.encountered)} of ~${String(progress.targetL4)} at L4`}
          kr={`접한 한자 · ${String(progress.encountered)} / 약 ${String(progress.targetL4)} (L4 기준)`}
        />
      </Eyebrow>
      <div className="km-hanja__chips">
        <StateChip label="Banked" kr="담김" count={progress.banked} tone="moss" />
        <StateChip
          label="Practicing"
          kr="연습 중"
          count={progress.practicing}
          tone="vermilion"
        />
        <StateChip label="New" kr="신규" count={progress.new} tone="mute" />
      </div>
      {/* Clamped/degenerate-safe ARIA — shared with the Progress page's
          Hanja mastery tab via lib/encounteredBar. */}
      <div
        className="km-hanja__bar"
        {...encounteredBarAria(progress.encountered, progress.targetL4)}
      >
        <div
          className="km-hanja__bar-fill"
          style={{ width: `${pct.toFixed(1)}%` }}
        />
      </div>
      <p className="km-hanja__note">{progress.note}</p>
    </Card>
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
  tone: 'moss' | 'vermilion' | 'mute';
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
    <div className="km-hanja__viewtoggle" role="tablist" aria-label="Hanja view">
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
    <button
      type="button"
      onClick={onOpen}
      className="km-hanja__feature focusring"
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
  );
}

function IndexView({
  chars,
  filter,
  onFilter,
  onOpen,
}: {
  chars: Hanja[];
  filter: FilterMode;
  onFilter: (next: FilterMode) => void;
  onOpen: (id: string) => void;
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
              <HanjaCell
                key={h.id}
                char={h.ch}
                sound={h.sound}
                gloss={h.gloss}
                state={h.state}
                onClick={() => {
                  onOpen(h.id);
                }}
              />
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
// Study sub-view (F-075 / B-028) — FSRS drill over due hanja cards.
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
      <Card className="km-hanja__empty">
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
          <SealStamp char="完" size="md" />
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
// Lists sub-view (F-075) — hanja list index + creation.
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
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Two-step inline delete confirm (no window.confirm — poor AT support).
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const inputId = useId();

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

  const create = useCallback((): void => {
    const trimmed = name.trim();
    if (trimmed === '' || creating) return;
    setCreating(true);
    setCreateError(null);
    void (async (): Promise<void> => {
      try {
        const res = await createList({ name_kr: trimmed, kind: 'hanja' });
        // BIGINT id may arrive as a JSON string — coerce before local use.
        const created: ServerVocabList = { ...res.list, id: Number(res.list.id) };
        setLists((prev) => (prev ? [created, ...prev] : [created]));
        setName('');
      } catch (err) {
        setCreateError(
          errorMessageFor(err, "Couldn't create that list. Try again."),
        );
      } finally {
        setCreating(false);
      }
    })();
  }, [name, creating]);

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
      <Card className="km-hanja__lists-create">
        <Eyebrow>
          <Bilingual en="New list" kr="새 목록" />
        </Eyebrow>
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
          <button
            type="button"
            className="km-btn km-btn--gold km-btn--md focusring"
            disabled={creating || name.trim() === ''}
            onClick={create}
          >
            <Icon name="plus" size={14} />
            <span>
              {creating ? (
                <Bilingual en="Creating…" kr="만드는 중…" compact />
              ) : (
                <Bilingual en="Create" kr="만들기" compact />
              )}
            </span>
          </button>
        </div>
        {createError !== null ? (
          <p role="alert" className="km-hanja__inline-error">
            {createError}
          </p>
        ) : null}
      </Card>

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
        <Card className="km-hanja__empty">
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
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// List-detail sub-view (F-075) — one list's characters.
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
      <Card className="km-hanja__ld-head">
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
      </Card>

      {hanjaEntries.length === 0 ? (
        <Card className="km-hanja__empty">
          <Eyebrow>
            <Bilingual en="Empty list" kr="빈 목록" />
          </Eyebrow>
          <p>
            Open any character&apos;s detail sheet and use &ldquo;Add to a
            list&rdquo; to fill this one.
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
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Drawing drill sub-view (F-076).
// ─────────────────────────────────────────────────────────────

function DrawView({
  chars,
  loading,
  onRetry,
  char,
  onStudy,
}: {
  chars: Hanja[] | null;
  loading: boolean;
  onRetry: () => void;
  char: string | null;
  onStudy: () => void;
}): JSX.Element {
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
  const h = chars.find((c) => c.ch === char) ?? null;
  if (h === null) {
    return (
      <Card className="km-hanja__empty">
        <Eyebrow>
          <Bilingual en="Character not found" kr="한자를 찾을 수 없어요" />
        </Eyebrow>
        <p>That character isn&apos;t in the corpus.</p>
      </Card>
    );
  }

  return (
    <>
      <Card className="km-hanja__draw-prompt">
        <Eyebrow>
          <Bilingual en="Drawing drill" kr="쓰기 연습" />
        </Eyebrow>
        <div className="kr kr-display km-hanja__study-gloss">
          <span>{h.gloss}</span>{' '}
          <span className="km-hanja__study-sound">{h.sound}</span>
        </div>
        <div className="km-hanja__study-en">{h.en}</div>
        <div className="km-hanja__study-pills">
          <Pill>
            <Bilingual
              en={`${String(h.strokes)} strokes`}
              kr={`${String(h.strokes)}획`}
              compact
            />
          </Pill>
          <Pill>{h.level}</Pill>
        </div>
        <p className="km-hanja__draw-note">
          <Bilingual
            en="Draw the character from memory, then reveal it to compare."
            kr="기억을 떠올려 한자를 쓴 다음, 글자를 확인해 보세요."
          />
        </p>
      </Card>

      <CollapsibleTile
        title={<Bilingual en="About this drill" kr="안내" />}
        defaultCollapsed
        className="km-hanja__draw-about"
      >
        <p>
          Freehand practice only — nothing is graded or saved. Stroke-order
          guidance isn&apos;t available yet: the corpus doesn&apos;t carry
          per-character stroke data.
        </p>
        <p>
          Drawing needs a pointer (finger, pen, or mouse). If you use a
          keyboard or screen reader, the flashcard drill covers the same
          recall practice:
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

      <DrawingPad ch={h.ch} />
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
 */
function DrawingPad({ ch }: { ch: string }): JSX.Element {
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
        {revealed ? (
          <span className="hanja km-hanja__draw-ghost" aria-hidden="true">
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
          aria-label={`Drawing pad for the character ${ch}. Draw with a finger, pen, or mouse.`}
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
  // The single bank/practice control toggles the character between the SRS
  // ("practicing") and mastered ("banked") states. A banked character offers
  // "Practice again"; anything else offers "Bank this hanja".
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
              <Bilingual en="Bank this hanja" kr="이 한자 담기" />
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
        listId = Number(res.list.id);
        const created: ServerVocabList = { ...res.list, id: listId };
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
