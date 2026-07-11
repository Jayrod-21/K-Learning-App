/**
 * Listen screen (F-012, reworked Phase 3C-2: F-071 / F-072 / F-024) —
 * TTMIK lesson / Iyagi episode audio + read-along.
 *
 * Structure — three URL-addressed views on `/learn/listen` (the same
 * search-param idiom Grammar/Hanja use, so browser Back works and every
 * nested view has a deterministic BackButton parent):
 *
 *   1. LANDING (`/learn/listen`) — F-071: a responsive 2-across grid of
 *      SQUARE collection tiles (TTMIK Lessons, Iyagi Episodes), flowing
 *      down. The grid is data-driven off `COLLECTIONS`, so when more audio
 *      is added a new collection is one more entry — the grid just grows.
 *      No fetch happens on the landing; tiles are pure navigation.
 *   2. LISTING (`?corpus=ttmik` / `?corpus=iyagi`) — F-072: the browse list
 *      windowed to 15 rows via `usePagination` + `ShowMore` (additive
 *      reveal, never loses the user's place). TTMIK adds a level
 *      `FilterSelect`; a filter change collapses the window back to 15.
 *      An `aria-live` stat announces the visible/total counts. F-024: a
 *      `BackButton` to the landing.
 *   3. DETAIL (`…&level=&lesson=` / `…&episode=`) — unchanged F-012 body
 *      (persistent player, Highlights/Transcript sub-tabs, tap-anything
 *      transcript) with an F-024 `BackButton` to the owning listing.
 *
 * Detail view (F-012, unchanged this phase):
 *   1. A REAL `<audio controls>` player that is PERSISTENT across the
 *      lesson sub-tabs. The element is rendered exactly once, ABOVE and
 *      OUTSIDE the tab-switched subtree, and is never keyed on the active
 *      tab — switching Highlights ↔ Transcript changes only the panel
 *      below it, so React reconciliation keeps the same DOM node (same
 *      element type at the same stable position in the child list) and
 *      playback position/state survives every switch. The detail view IS
 *      keyed on the selection, so opening a *different* lesson deliberately
 *      remounts the player (fresh src, position 0 — the desired reset).
 *   2. TTMIK lessons get two sub-tabs UNDER the player: Highlights (key
 *      phrases — the original layout) and Transcript (the full ordered
 *      lesson text; `header` lines as section headings, `pair`/`dialog` as
 *      Korean + English, `prose` as explanation notes). Both arrive in the
 *      one detail response, so switching is instant — no fetch, no spinner,
 *      no audio interruption.
 *   3. CLICKABLE WORDS — every Korean line (highlights, transcript, and the
 *      Iyagi transcript) renders through the Read tab's tap-anything path:
 *      the shared `lib/tapChain.tokeniseKorean` splitter + the same
 *      `Tapword` control, so tapping a word fires the abortable
 *      lemmatize → define → enrich chain (via the shared `useTapWord` hook)
 *      and opens the same `WordPopover` with definition / usage / examples
 *      and Add-to-bank (FU-NF-33 `POST /vocab/mine`, optimistic + rollback).
 *   4. Iyagi episode detail: same persistent player + full clickable
 *      transcript; the hosts line renders from `meta.hosts`, a real
 *      `string[]` on the wire (the old string shape crashed this view).
 *
 * Audio `src` contract: `buildAudioSrc` (services/ttmik.ts) joins the
 * detail's app-relative `audioUrl` onto the SAME API base the axios services
 * use, so the media request is same-origin in prod (empty base → the LB
 * routes it) and same-site in dev (Vite :5173 → API :4000) — either way the
 * `SameSite=Strict` session cookie rides the request with no extra plumbing.
 * `audioUrl === null` / `hasAudio === false` → transcript-only with a small
 * "no audio" note, no player.
 *
 * Threat model:
 *   - Search params are UNTRUSTED user input (deep links, tampered URLs).
 *     `parseListenView` narrows them against a closed corpus set and a
 *     bounded positive-integer parser; anything malformed falls back UP the
 *     hierarchy (bad detail params → listing, unknown corpus → landing) —
 *     never into a request with attacker-shaped path segments.
 *   - All data is server corpus text rendered through React text children —
 *     escaped; no dangerouslySetInnerHTML anywhere on this screen. The tap
 *     chain's popover fields go through the same contract (lib/tapChain).
 *   - The audio src is never free-form: `buildAudioSrc` rejects anything but
 *     the exact allow-listed route shapes, so a tampered response body
 *     cannot point the player at a third-party origin.
 *   - Tap-anything fan-out (lemmatize/define/enrich per tap) mirrors the
 *     Read tab's behavioural-telemetry posture: rate limiting lives
 *     server-side; the client neither batches nor fingerprints. The chain
 *     is popover-scoped and aborted on close / new tap / unmount, so an
 *     abandoned tap cancels its in-flight HTTP work — and it never touches
 *     the `<audio>` element, so a tap (or its abort) cannot stall playback.
 *   - Stale-response races: the detail fetch and the tap chain each key to
 *     their own AbortController; settle handlers check the signal so a slow
 *     response never paints over a newer selection or tap.
 *   - GET-only data surface plus `POST /vocab/mine` on Add — that POST rides
 *     the SameSite=Strict cookie posture owned by services/api.ts (ADR-002),
 *     and its failure path never echoes server text (fixed toast copy).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { FilterSelect } from '../components/FilterSelect';
import { Icon, type IconName } from '../components/Icon';
import { ShowMore } from '../components/ShowMore';
import { Tapword } from '../components/Tapword';
import { Topbar } from '../components/Topbar';
import { WordPopover } from '../components/WordPopover';
import type { WordPopoverData } from '../components/WordPopover';
import { useToast } from '../components/useToast';
import {
  GLOSS_DICTIONARY_ENTRY,
  GLOSS_UNAVAILABLE,
  tokeniseKorean,
} from '../lib/tapChain';
import { ApiError } from '../services/api';
import { useChatContext } from '../hooks/useChatContext';
import { usePagination } from '../hooks/usePagination';
import { useTapWord } from '../hooks/useTapWord';
import { errorMessageFor } from '../lib/errorCopy';
import { navItem } from '../lib/nav';
import {
  buildAudioSrc,
  getIyagiEpisode,
  getIyagiEpisodes,
  getTtmikLesson,
  getTtmikLessons,
} from '../services/ttmik';
import { mineWord } from '../services/vocab';
import type {
  IyagiEpisode,
  ListenSentence,
  TtmikLesson,
  TtmikTranscriptLine,
} from '../types/domain';
import './Ttmik.css';

/** The two audio corpora this screen serves (closed set — parse target). */
type Corpus = 'ttmik' | 'iyagi';

/** Page eyebrow + canonical route — nav.ts owns both (P3b Batch A). */
const TTMIK_NAV = navItem('ttmik');
const LISTEN_PATH = TTMIK_NAV.path;

/**
 * F-071 — the landing grid's data source. One entry per audio collection;
 * adding a future corpus (podcasts, audiobooks, …) is one more entry here
 * plus its listing branch — the square-tile grid grows down on its own.
 */
const COLLECTIONS: ReadonlyArray<{
  corpus: Corpus;
  en: string;
  kr: string;
  subEn: string;
  subKr: string;
  icon: IconName;
}> = [
  {
    corpus: 'ttmik',
    en: 'TTMIK Lessons',
    kr: 'TTMIK 레슨',
    subEn: 'Structured lessons by level',
    subKr: '레벨별 구성 레슨',
    icon: 'headphones',
  },
  {
    corpus: 'iyagi',
    en: 'Iyagi Episodes',
    kr: '이야기 에피소드',
    subEn: 'Natural conversation episodes',
    subKr: '자연스러운 대화 에피소드',
    icon: 'mic',
  },
];

/** Listing labels the detail BackButton reuses ("Back to TTMIK Lessons"). */
const COLLECTION_LABEL: Record<Corpus, string> = {
  ttmik: 'TTMIK Lessons',
  iyagi: 'Iyagi Episodes',
};

/**
 * F-072 — the listing window: 15 rows per "page", additive reveal. `max`
 * is a defensive ceiling far above the corpus sizes (~190 TTMIK lessons,
 * ~170 Iyagi episodes) so every row stays reachable — a cap below the list
 * length would strand rows the user can never scroll to.
 */
const LIST_WINDOW = { initial: 15, step: 15, max: 990 } as const;

/** TTMIK lesson-detail sub-tabs (below the persistent player). */
type LessonTab = 'highlights' | 'transcript';

const LESSON_TABS: ReadonlyArray<{ id: LessonTab; label: string; kr: string }> = [
  { id: 'highlights', label: 'Highlights', kr: '하이라이트' },
  { id: 'transcript', label: 'Transcript', kr: '대본' },
];

/**
 * The open lesson/episode. Discriminated on `corpus` so the detail loader
 * can pick the right endpoint. Derived from search params (untrusted) via
 * `parseListenView` — every field is a validated positive integer.
 */
type Selection =
  | { corpus: 'ttmik'; level: number; number: number }
  | { corpus: 'iyagi'; number: number };

/** Stable identity for a selection — keys the detail view (see DetailView). */
function selectionKey(selection: Selection): string {
  return selection.corpus === 'ttmik'
    ? `ttmik:${String(selection.level)}:${String(selection.number)}`
    : `iyagi:${String(selection.number)}`;
}

/** Which of the three views the URL addresses. */
type ListenView =
  | { kind: 'landing' }
  | { kind: 'list'; corpus: Corpus }
  | { kind: 'detail'; selection: Selection };

/**
 * Bounded positive-int parser for untrusted search params. Digits only
 * (no signs, exponents, whitespace — `Number()` alone accepts all three),
 * capped at 4 digits: corpus identifiers are small ordinals, and the bound
 * keeps a hostile param from minting absurd path segments.
 */
function parsePositiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/**
 * Narrow the (untrusted) search params to a view. Malformed input falls
 * back UP the hierarchy — bad detail numbers land on the listing, an
 * unknown corpus lands on the landing — never into a fetch.
 */
function parseListenView(params: URLSearchParams): ListenView {
  const corpus = params.get('corpus');
  if (corpus === 'ttmik') {
    const level = parsePositiveInt(params.get('level'));
    const lesson = parsePositiveInt(params.get('lesson'));
    if (level !== null && lesson !== null) {
      return {
        kind: 'detail',
        selection: { corpus: 'ttmik', level, number: lesson },
      };
    }
    return { kind: 'list', corpus: 'ttmik' };
  }
  if (corpus === 'iyagi') {
    const episode = parsePositiveInt(params.get('episode'));
    if (episode !== null) {
      return {
        kind: 'detail',
        selection: { corpus: 'iyagi', number: episode },
      };
    }
    return { kind: 'list', corpus: 'iyagi' };
  }
  return { kind: 'landing' };
}

/** Canonical URL builders — the ONLY producers of this page's sub-URLs. */
function listPath(corpus: Corpus): string {
  return `${LISTEN_PATH}?corpus=${corpus}`;
}
function lessonPath(lesson: Pick<TtmikLesson, 'level' | 'number'>): string {
  return `${listPath('ttmik')}&level=${String(lesson.level)}&lesson=${String(lesson.number)}`;
}
function episodePath(number: number): string {
  return `${listPath('iyagi')}&episode=${String(number)}`;
}

export default function Ttmik(): JSX.Element {
  const [searchParams] = useSearchParams();
  const view = parseListenView(searchParams);

  // F-024: every nested view carries an explicit-parent BackButton (the
  // Grammar/Hanja idiom) — a deep link straight into a lesson must go back
  // to its listing, never history-back out of the PWA.
  let back: JSX.Element | null = null;
  if (view.kind === 'list') {
    back = <BackButton to={LISTEN_PATH} label={TTMIK_NAV.label} />;
  } else if (view.kind === 'detail') {
    const corpus = view.selection.corpus;
    back = (
      <BackButton to={listPath(corpus)} label={COLLECTION_LABEL[corpus]} />
    );
  }

  return (
    <section
      className="screen km-ttmik"
      aria-labelledby="km-ttmik-title"
      style={{ padding: '0 18px 32px' }}
    >
      {back !== null ? <div className="km-ttmik__nav">{back}</div> : null}
      <Topbar
        krTitle="듣기"
        title="Listen"
        titleId="km-ttmik-title"
        eyebrow={
          <Bilingual en={TTMIK_NAV.eyebrow} kr={TTMIK_NAV.krEyebrow} />
        }
      />
      {view.kind === 'landing' ? <CollectionTiles /> : null}
      {view.kind === 'list' && view.corpus === 'ttmik' ? (
        <TtmikListing />
      ) : null}
      {view.kind === 'list' && view.corpus === 'iyagi' ? (
        <IyagiListing />
      ) : null}
      {view.kind === 'detail' ? (
        // Keyed on the selection: opening a DIFFERENT unit remounts the
        // detail (fresh sub-tab, fresh player, fresh popover state), while
        // everything within one unit — including the <audio> element —
        // keeps its identity across every re-render.
        <DetailView
          key={selectionKey(view.selection)}
          selection={view.selection}
        />
      ) : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// F-071 — landing: square collection tiles, 2 across
// ─────────────────────────────────────────────────────────────

/**
 * The landing grid. Real `<button>`s (keyboard-operable for free, the
 * page's row/quick-nav idiom) whose accessible name is their visible
 * bilingual content; the icon is decorative. Layout (2-across squares,
 * flowing down) lives in Ttmik.css on `.km-ttmik__tiles`.
 */
function CollectionTiles(): JSX.Element {
  const navigate = useNavigate();
  return (
    <ul className="km-ttmik__tiles" aria-label="Audio collections">
      {COLLECTIONS.map((c) => (
        <li key={c.corpus}>
          <button
            type="button"
            className="km-ttmik__tile focusring"
            onClick={() => {
              void navigate(listPath(c.corpus));
            }}
          >
            <Icon name={c.icon} size={24} />
            <span className="km-ttmik__tile-meta">
              <span className="km-ttmik__tile-title">
                <Bilingual en={c.en} kr={c.kr} compact />
              </span>
              <span className="km-ttmik__tile-sub">
                <Bilingual en={c.subEn} kr={c.subKr} compact />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared browse-row bits
// ─────────────────────────────────────────────────────────────

/** Audio indicator pill — never conveys the state by iconography alone. */
function AudioPill({ hasAudio }: { hasAudio: boolean }): JSX.Element {
  return (
    <span className="km-pill km-pill--default">
      {hasAudio ? (
        <>
          <Icon name="headphones" size={12} />{' '}
          <Bilingual en="Audio" kr="오디오" compact />
        </>
      ) : (
        <Bilingual en="No audio" kr="오디오 없음" compact />
      )}
    </span>
  );
}

/**
 * F-072 — the "Showing X of Y" line above a windowed listing. `aria-live`
 * so AT hears the count change when a filter narrows the list or Show more
 * reveals a window (the Mistakes F-045 stat idiom).
 */
function ListingStat({
  shown,
  total,
}: {
  shown: number;
  total: number;
}): JSX.Element {
  return (
    <p className="km-ttmik__stat" aria-live="polite">
      <Bilingual
        en={`Showing ${String(shown)} of ${String(total)}`}
        kr={`전체 ${String(total)}개 중 ${String(shown)}개 표시`}
      />
    </p>
  );
}

// ─────────────────────────────────────────────────────────────
// TTMIK listing — level filter + 15-row window, grouped by level
// ─────────────────────────────────────────────────────────────

function TtmikListing(): JSX.Element {
  const navigate = useNavigate();
  const [lessons, setLessons] = useState<TtmikLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so Retry re-runs the fetch effect.
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    getTtmikLessons(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setLessons(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load the lessons.'),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Canonical order: (level, number) ascending. The server already orders
  // this way; the sort is defensive so a reordering regression upstream
  // never scrambles the window.
  const ordered = useMemo(
    () =>
      [...lessons].sort((a, b) => a.level - b.level || a.number - b.number),
    [lessons],
  );

  // Level filter (FilterSelect; '' = all levels — its reserved placeholder
  // value). Derived `activeLevel` guards against a stale selection after a
  // refetch reshapes the list — an orphaned level silently falls back to
  // "all" instead of filtering everything out.
  const [levelFilter, setLevelFilter] = useState<string>('');
  const levels = useMemo(
    () => [...new Set(ordered.map((l) => l.level))],
    [ordered],
  );
  const activeLevel = levels.some((l) => String(l) === levelFilter)
    ? levelFilter
    : '';
  const filtered = useMemo(
    () =>
      activeLevel === ''
        ? ordered
        : ordered.filter((l) => String(l.level) === activeLevel),
    [ordered, activeLevel],
  );

  // F-072: 15-row window over the filtered list.
  const { visible, canShowMore, showMore, reset, remaining } = usePagination(
    filtered,
    LIST_WINDOW,
  );

  const onLevelChange = useCallback(
    (value: string): void => {
      setLevelFilter(value);
      // A new filter is a new list — collapse the window back to page one
      // so the user isn't dropped mid-way down the previous expansion.
      reset();
    },
    [reset],
  );

  // Group the VISIBLE window by level for the eyebrow headers. Input is
  // already (level, number)-sorted, so one linear pass suffices.
  const groups = useMemo(() => {
    const out: { level: number; lessons: TtmikLesson[] }[] = [];
    for (const lesson of visible) {
      const last = out[out.length - 1];
      if (last !== undefined && last.level === lesson.level) {
        last.lessons.push(lesson);
      } else {
        out.push({ level: lesson.level, lessons: [lesson] });
      }
    }
    return out;
  }, [visible]);

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        <Bilingual en="Loading lessons…" kr="레슨을 불러오는 중…" />
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }
  if (ordered.length === 0) {
    return (
      <p className="km-reference__empty">
        <Bilingual en="No lessons available yet." kr="아직 레슨이 없어요." />
      </p>
    );
  }

  return (
    <div>
      <div className="km-ttmik__controls">
        {levels.length > 1 ? (
          <FilterSelect
            label="Level · 레벨"
            placeholder="All levels · 전체"
            options={levels.map((l) => ({
              value: String(l),
              label: `Level ${String(l)}`,
            }))}
            value={activeLevel}
            onChange={onLevelChange}
          />
        ) : null}
        <ListingStat shown={visible.length} total={filtered.length} />
      </div>
      {groups.map((group) => (
        <div key={`level:${String(group.level)}`} style={{ marginBottom: 18 }}>
          <Eyebrow>
            <Bilingual
              en={`Level ${String(group.level)}`}
              kr={`레벨 ${String(group.level)}`}
            />
          </Eyebrow>
          <Card className="km-reference__list" variant="flat">
            <ul>
              {group.lessons.map((lesson) => (
                <li
                  key={`ttmik:${String(lesson.level)}:${String(lesson.number)}`}
                  className="km-reference__row"
                >
                  <button
                    type="button"
                    className="km-resources__list-open focusring"
                    onClick={() => {
                      void navigate(lessonPath(lesson));
                    }}
                    aria-label={`Open lesson ${String(lesson.number)}: ${lesson.title}`}
                  >
                    <span className="km-reference__row-en">
                      {lesson.number}.
                    </span>
                    <span className="kr km-reference__row-kr">
                      {lesson.title}
                    </span>
                    <AudioPill hasAudio={lesson.hasAudio} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ))}
      <div className="km-ttmik__pager">
        <ShowMore
          canShowMore={canShowMore}
          onShowMore={showMore}
          remaining={remaining}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Iyagi listing — numbered list, 15-row window
// ─────────────────────────────────────────────────────────────

function IyagiListing(): JSX.Element {
  const navigate = useNavigate();
  const [episodes, setEpisodes] = useState<IyagiEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    getIyagiEpisodes(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setEpisodes(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load the episodes.'),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Defensive order — the server already sorts by episode number.
  const ordered = useMemo(
    () => [...episodes].sort((a, b) => a.number - b.number),
    [episodes],
  );

  // F-072: 15-row window.
  const { visible, canShowMore, showMore, remaining } = usePagination(
    ordered,
    LIST_WINDOW,
  );

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        <Bilingual en="Loading episodes…" kr="에피소드를 불러오는 중…" />
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }
  if (ordered.length === 0) {
    return (
      <p className="km-reference__empty">
        <Bilingual
          en="No episodes available yet."
          kr="아직 에피소드가 없어요."
        />
      </p>
    );
  }

  return (
    <div>
      <div className="km-ttmik__controls">
        <ListingStat shown={visible.length} total={ordered.length} />
      </div>
      <Card className="km-reference__list" variant="flat">
        <ul>
          {visible.map((episode) => (
            <li
              key={`iyagi:${String(episode.number)}`}
              className="km-reference__row"
            >
              <button
                type="button"
                className="km-resources__list-open focusring"
                onClick={() => {
                  void navigate(episodePath(episode.number));
                }}
                aria-label={`Open episode ${String(episode.number)}: ${episode.title}`}
              >
                <span className="km-reference__row-en">#{episode.number}</span>
                <span className="kr km-reference__row-kr">{episode.title}</span>
                <AudioPill hasAudio={episode.hasAudio} />
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <div className="km-ttmik__pager">
        <ShowMore
          canShowMore={canShowMore}
          onShowMore={showMore}
          remaining={remaining}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail view — persistent player + sub-tabs + clickable read-along
// ─────────────────────────────────────────────────────────────

/** Skeleton placeholder while a transcript loads (mirrors Reading's). */
function SkeletonCard(): JSX.Element {
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: 240, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

/**
 * Everything the detail view renders. Discriminated on `corpus`: TTMIK
 * lessons carry the highlights/transcript pair behind sub-tabs; Iyagi
 * episodes carry one flat transcript plus the hosts line.
 */
type DetailData =
  | {
      corpus: 'ttmik';
      /** Context line above the title, e.g. `Level 2 · Lesson 21`. */
      eyebrow: string;
      /** Korean counterpart of `eyebrow` — rendered via `<Bilingual/>`. */
      krEyebrow: string;
      title: string;
      /** Fully-resolved `<audio src>`; null → transcript-only. */
      audioSrc: string | null;
      highlights: ListenSentence[];
      transcript: TtmikTranscriptLine[];
    }
  | {
      corpus: 'iyagi';
      eyebrow: string;
      krEyebrow: string;
      title: string;
      /** Hosts line; null when the episode has no hosts listed. */
      subtitle: string | null;
      audioSrc: string | null;
      sentences: ListenSentence[];
    };

/** Fetch the selected unit's detail, normalised into `DetailData`. */
async function loadDetail(
  selection: Selection,
  signal: AbortSignal,
): Promise<DetailData> {
  if (selection.corpus === 'ttmik') {
    const detail = await getTtmikLesson(
      selection.level,
      selection.number,
      signal,
    );
    return {
      corpus: 'ttmik',
      eyebrow: `Level ${String(detail.meta.level)} · Lesson ${String(detail.meta.number)}`,
      krEyebrow: `레벨 ${String(detail.meta.level)} · ${String(detail.meta.number)}과`,
      title: detail.meta.title,
      audioSrc: buildAudioSrc(detail.audioUrl),
      highlights: detail.highlights,
      transcript: detail.transcript,
    };
  }
  const detail = await getIyagiEpisode(selection.number, signal);
  return {
    corpus: 'iyagi',
    eyebrow: `Iyagi · Episode ${String(detail.meta.number)}`,
    krEyebrow: `이야기 · ${String(detail.meta.number)}화`,
    title: detail.meta.title,
    subtitle:
      detail.meta.hosts.length > 0 ? detail.meta.hosts.join(' · ') : null,
    audioSrc: buildAudioSrc(detail.audioUrl),
    sentences: detail.sentences,
  };
}

/** Signature every tap surface funnels into: raw word + its sentence. */
type TapWordHandler = (raw: string, sentenceText: string) => void;

function DetailView({ selection }: { selection: Selection }): JSX.Element {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // Lesson sub-tab (TTMIK only). Lives here — NOT in a per-tab component —
  // so flipping it re-renders this view in place without remounting it,
  // which is what keeps the <audio> element's identity stable.
  const [lessonTab, setLessonTab] = useState<LessonTab>('highlights');

  // Publish the open lesson/episode for the chat FAB's discuss-this-page
  // popup (Slice 3). Selections come from the URL (no title), so publish
  // once the detail lands — `null` while loading skips the publish, and
  // unmount (back to browse) retracts it.
  useChatContext(
    data !== null
      ? {
          pageLabel: 'Listen · 듣기',
          summary:
            selection.corpus === 'ttmik'
              ? `TTMIK Level ${String(selection.level)} Lesson ${String(
                  selection.number,
                )} — ${data.title}`
              : `Iyagi Episode ${String(selection.number)} — ${data.title}`,
        }
      : null,
  );

  // Add-to-bank state — page-local (see `useTapWord`'s header for why the
  // hook deliberately doesn't own it).
  const [minedIds, setMinedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Tap-anything popover machine — the shared `useTapWord` hook (U3c). Same
  // contract as before: tap opens the popover with a loading stub, runs the
  // abortable lemmatize → define → enrich chain, and aborts it on close /
  // new tap / unmount. The chain never touches the <audio> element, so
  // playback is unaffected by taps, resolutions, or aborts.
  const isMined = useCallback(
    (word: string) => minedIds.has(word),
    [minedIds],
  );
  const { popData, popLoading, onTapWord, onClose } = useTapWord({ isMined });

  // Add-to-bank request controller — page-local, mirroring `Reading.tsx`'s
  // `addCtrlRef` (`useTapWord` deliberately doesn't expose its internal
  // controller): aborted on popover close (`handleClose` below) and on
  // unmount, so a closed popover / left screen can never land a late
  // `setMinedIds`/`toast` from a still-in-flight "Add to bank" POST.
  const addCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      addCtrlRef.current?.abort();
    },
    [],
  );

  const { toast } = useToast();

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    loadDetail(selection, ctrl.signal)
      .then((detail) => {
        if (ctrl.signal.aborted) return;
        setData(detail);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load the transcript.'),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [selection, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  /** Close the popover AND abort any in-flight "Add to bank" request. */
  const handleClose = useCallback((): void => {
    addCtrlRef.current?.abort();
    addCtrlRef.current = null;
    onClose();
  }, [onClose]);

  /**
   * Add-to-bank (FU-NF-33) — same optimistic-flip + rollback + fixed-copy
   * toast contract as Reading's vocab branch: the underline lands
   * instantly, a real failure rolls it back and surfaces a non-blocking
   * toast (never server text), a close-aborted request is swallowed.
   */
  const handleAdd = useCallback(
    (d: WordPopoverData): void | Promise<void> => {
      const lemma = d.kr;
      setMinedIds((prev) => {
        const next = new Set(prev);
        next.add(lemma);
        return next;
      });

      addCtrlRef.current?.abort();
      const ctrl = new AbortController();
      addCtrlRef.current = ctrl;

      return mineWord(
        {
          lemma,
          ...(d.en && d.en !== GLOSS_DICTIONARY_ENTRY && d.en !== GLOSS_UNAVAILABLE
            ? { english: d.en }
            : {}),
          ...(d.pos && d.pos !== 'word' ? { pos: d.pos } : {}),
          ...(d.krdictEntryId !== undefined
            ? { krdictEntryId: d.krdictEntryId }
            : {}),
        },
        ctrl.signal,
      ).then(
        () => undefined,
        (err: unknown) => {
          if (err instanceof ApiError && err.code === 'canceled') return;
          setMinedIds((prev) => {
            if (!prev.has(lemma)) return prev;
            const next = new Set(prev);
            next.delete(lemma);
            return next;
          });
          toast({ message: "Couldn't bank — try again", tone: 'error' });
          // Re-throw so WordPopover rolls its "Added" button back too.
          throw err instanceof Error ? err : new Error('bank failed');
        },
      );
    },
    [toast],
  );

  // Render in ordinal order regardless of wire order (defensive sorts — the
  // server already orders by ordinal).
  const orderedHighlights = useMemo(
    () =>
      data?.corpus === 'ttmik'
        ? [...data.highlights].sort((a, b) => a.ordinal - b.ordinal)
        : [],
    [data],
  );
  const orderedTranscript = useMemo(
    () =>
      data?.corpus === 'ttmik'
        ? [...data.transcript].sort((a, b) => a.ordinal - b.ordinal)
        : [],
    [data],
  );
  const orderedSentences = useMemo(
    () =>
      data?.corpus === 'iyagi'
        ? [...data.sentences].sort((a, b) => a.ordinal - b.ordinal)
        : [],
    [data],
  );

  if (loading) return <SkeletonCard />;
  if (error !== null || data === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load the transcript.'}
        onRetry={refetch}
      />
    );
  }

  // Derive the shown sub-tab during render (never set state in an effect): if the
  // selected tab has no content, fall back to the other. Covers the ~14% of TTMIK
  // lessons with a transcript but no highlights — they open on Transcript instead
  // of an empty default tab, with no post-render flash.
  const hasHighlights = orderedHighlights.length > 0;
  const hasTranscript = orderedTranscript.length > 0;
  const effectiveTab: LessonTab =
    lessonTab === 'highlights' && !hasHighlights
      ? 'transcript'
      : lessonTab === 'transcript' && !hasTranscript
        ? 'highlights'
        : lessonTab;
  const visibleLessonTabs = LESSON_TABS.filter((t) =>
    t.id === 'highlights' ? hasHighlights : hasTranscript,
  );

  return (
    <div>
      <Eyebrow>
        <Bilingual en={data.eyebrow} kr={data.krEyebrow} />
      </Eyebrow>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {data.title}
      </h2>
      {data.corpus === 'iyagi' && data.subtitle !== null ? (
        <p className="km-reference__row-en" style={{ margin: '0 0 12px' }}>
          {data.subtitle}
        </p>
      ) : null}

      {/* PERSISTENT PLAYER — rendered exactly once, at a stable position
          ABOVE the sub-tab subtree and never keyed on the active tab.
          React reconciliation therefore reuses this exact DOM node across
          Highlights ↔ Transcript switches (only the panel below swaps),
          so playback position and play/pause state survive. Do NOT move
          this inside a per-tab component or add a tab-derived key. */}
      <div style={{ margin: '12px 0 18px' }}>
        {data.audioSrc !== null ? (
          // Real streaming player; the server endpoint supports HTTP Range,
          // so seeking works. No timed caption track exists for this corpus;
          // the full read-along transcript renders directly below (per-line
          // karaoke sync is the documented follow-up once timestamps
          // exist), hence the a11y rule exemption.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio
            controls
            preload="metadata"
            src={data.audioSrc}
            aria-label={`Audio for ${data.title}`}
            style={{ width: '100%' }}
          />
        ) : (
          // P3b trim: the scattered "No X for this one." empty-states are
          // consolidated to one terse "No X yet." shape (here + the panels).
          <p className="km-reference__empty" role="note">
            <Bilingual
              en="No audio yet — read along below."
              kr="아직 오디오가 없어요 — 아래에서 읽어 보세요."
            />
          </p>
        )}
      </div>

      {data.corpus === 'ttmik' ? (
        visibleLessonTabs.length === 0 ? (
          <p className="km-reference__row-en" style={{ margin: '8px 0' }}>
            <Bilingual
              en="No lesson text yet."
              kr="아직 수업 내용이 없어요."
            />
          </p>
        ) : (
          <>
            <div
              className="km-review__tabs"
              role="tablist"
              aria-label="Lesson content"
            >
              {visibleLessonTabs.map((t) => {
                const selected = effectiveTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
                    onClick={() => {
                      setLessonTab(t.id);
                    }}
                  >
                    <Bilingual en={t.label} kr={t.kr} compact />
                  </button>
                );
              })}
            </div>

            {effectiveTab === 'highlights' ? (
              <HighlightsPanel
                rows={orderedHighlights}
                minedIds={minedIds}
                onTapWord={onTapWord}
              />
            ) : (
              <TranscriptPanel
                lines={orderedTranscript}
                minedIds={minedIds}
                onTapWord={onTapWord}
              />
            )}
          </>
        )
      ) : (
        <SentencesPanel
          rows={orderedSentences}
          minedIds={minedIds}
          onTapWord={onTapWord}
        />
      )}

      {popData ? (
        <WordPopover
          data={popData}
          onClose={handleClose}
          onAdd={handleAdd}
          isLoading={popLoading}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Clickable Korean text — the Read tab's tap path, inline
// ─────────────────────────────────────────────────────────────

/**
 * Render a Korean string through the shared tokeniser (`tokeniseKorean` —
 * the exact splitter the Read tab feeds KoreanPassage with) as inline
 * `Tapword`s, so every word is the same tap-anything control as on Read.
 * Spaces render as bare spans; all text goes through React children
 * (escaped).
 */
function TapKorean({
  text,
  minedIds,
  onTapWord,
}: {
  text: string | null;
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
}): JSX.Element {
  const tokens = useMemo(() => tokeniseKorean(text), [text]);
  return (
    <>
      {tokens.map((tk, i) =>
        tk.gloss ? (
          <Tapword
            // Position within one immutable line — stable for this text.
            key={`${String(i)}:${tk.w}`}
            mined={minedIds.has(tk.w)}
            onTap={() => {
              // `text` is non-null whenever a token exists (null tokenises to []),
              // so this is only for the type — the '' branch is never reached.
              onTapWord(tk.w, text ?? '');
            }}
          >
            {tk.w}
          </Tapword>
        ) : (
          <span key={`${String(i)}:sp`}>{tk.w}</span>
        ),
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail panels
// ─────────────────────────────────────────────────────────────

interface PanelProps {
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
}

/**
 * One spoken row — Korean prominent (clickable), English + romanization
 * secondary, speaker label on dialog turns. Shared by the TTMIK Highlights
 * panel and the Iyagi transcript.
 */
function SentenceRow({
  sentence,
  minedIds,
  onTapWord,
}: PanelProps & { sentence: ListenSentence }): JSX.Element {
  const speaker = sentence.speaker ?? null;
  return (
    <li className="km-reference__row" style={{ padding: '10px 0' }}>
      {sentence.is_dialog && speaker !== null && speaker !== '' ? (
        <div className="km-eyebrow" style={{ marginBottom: 2 }}>
          {speaker}
        </div>
      ) : null}
      <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
        <TapKorean
          text={sentence.korean}
          minedIds={minedIds}
          onTapWord={onTapWord}
        />
      </p>
      {sentence.english !== null && sentence.english !== '' ? (
        <p className="km-reference__row-en" style={{ margin: '2px 0 0' }}>
          {sentence.english}
        </p>
      ) : null}
    </li>
  );
}

/** TTMIK Highlights — the key-phrase layout (the original detail body). */
function HighlightsPanel({
  rows,
  minedIds,
  onTapWord,
}: PanelProps & { rows: ListenSentence[] }): JSX.Element {
  return (
    <Card variant="default" style={{ padding: '20px 22px' }}>
      <ol
        aria-label="Highlights"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {rows.map((sentence) => (
          <SentenceRow
            key={sentence.ordinal}
            sentence={sentence}
            minedIds={minedIds}
            onTapWord={onTapWord}
          />
        ))}
      </ol>
      {rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual en="No highlights yet." kr="아직 하이라이트가 없어요." />
        </p>
      ) : null}
    </Card>
  );
}

/** Iyagi episode transcript — flat ordered list of spoken rows. */
function SentencesPanel({
  rows,
  minedIds,
  onTapWord,
}: PanelProps & { rows: ListenSentence[] }): JSX.Element {
  return (
    <Card variant="default" style={{ padding: '20px 22px' }}>
      <ol
        aria-label="Transcript"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {rows.map((sentence) => (
          <SentenceRow
            key={sentence.ordinal}
            sentence={sentence}
            minedIds={minedIds}
            onTapWord={onTapWord}
          />
        ))}
      </ol>
      {rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual en="No transcript yet." kr="아직 대본이 없어요." />
        </p>
      ) : null}
    </Card>
  );
}

/**
 * One line of the full TTMIK transcript, rendered by `kind`:
 *   - `header`       → section heading (Korean text, English fallback).
 *   - `pair`/`dialog`→ clickable Korean + English below.
 *   - `prose`        → explanation note (clickable Korean when present,
 *                      English in the note style).
 *   - `romanization` → dropped (user directive: no romanization anywhere).
 */
function TranscriptLineItem({
  line,
  minedIds,
  onTapWord,
}: PanelProps & { line: TtmikTranscriptLine }): JSX.Element {
  switch (line.kind) {
    case 'header':
      return (
        <li style={{ padding: '14px 0 2px' }}>
          <h3 className="km-eyebrow" style={{ margin: 0 }}>
            {line.korean != null && line.korean !== ''
              ? line.korean
              : line.english ?? ''}
          </h3>
        </li>
      );
    case 'romanization':
      // No romanization anywhere (user directive). The loader drops these lines,
      // so this is defensive — render nothing if one ever slips through.
      return <></>;
    case 'prose':
      return (
        <li className="km-reference__row" style={{ padding: '8px 0' }}>
          {line.korean != null && line.korean !== '' ? (
            <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
              <TapKorean
                text={line.korean}
                minedIds={minedIds}
                onTapWord={onTapWord}
              />
            </p>
          ) : null}
          {line.english !== null && line.english !== '' ? (
            <p
              className="km-reference__row-en"
              style={{ margin: '2px 0 0' }}
              role="note"
            >
              {line.english}
            </p>
          ) : null}
        </li>
      );
    case 'pair':
    case 'dialog':
      return (
        <li className="km-reference__row" style={{ padding: '10px 0' }}>
          {line.korean != null && line.korean !== '' ? (
            <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
              <TapKorean
                text={line.korean}
                minedIds={minedIds}
                onTapWord={onTapWord}
              />
            </p>
          ) : null}
          {line.english !== null && line.english !== '' ? (
            <p className="km-reference__row-en" style={{ margin: '2px 0 0' }}>
              {line.english}
            </p>
          ) : null}
        </li>
      );
    default: {
      // Exhaustiveness guard — a new wire kind fails the type-check here
      // instead of silently dropping lines at runtime.
      const exhausted: never = line.kind;
      return <li style={{ display: 'none' }}>{exhausted}</li>;
    }
  }
}

/** TTMIK full transcript — ordered lines rendered by kind. */
function TranscriptPanel({
  lines,
  minedIds,
  onTapWord,
}: PanelProps & { lines: TtmikTranscriptLine[] }): JSX.Element {
  return (
    <Card variant="default" style={{ padding: '20px 22px' }}>
      <ol
        aria-label="Transcript"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {lines.map((line) => (
          <TranscriptLineItem
            key={line.ordinal}
            line={line}
            minedIds={minedIds}
            onTapWord={onTapWord}
          />
        ))}
      </ol>
      {lines.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual en="No transcript yet." kr="아직 대본이 없어요." />
        </p>
      ) : null}
    </Card>
  );
}
