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
 *
 * F-128 reskin ("Seoul Day & Night") — the shared `PageHubHeader` (devices
 * #4 skyline + #2 rail) replaces the bare `Topbar`, matching every other
 * reskinned page's hub-header recipe. The landing's 2-across grid (F-071)
 * now renders each collection as a `CityCard` signboard/hanji-paper tile
 * (device #1) — TTMIK `tone="blue"`, Iyagi `tone="mint"`, fixed regardless
 * of the user's accent pick (the same "always this hue" contract Reading's
 * Resume/Generate CityCards use), matching the design mock's blue-vs-mint
 * square distinction — with a full-bleed `<button>` inside doing the actual
 * navigation (the `CollapsibleTile` "surface=city" idiom: CityCard supplies
 * the signboard chrome, a real `<button>` inside is the sole hit target and
 * accessible name carrier). The detail view's reading surface (Highlights /
 * Transcript / Iyagi transcript) is a `CityCard tone="accent" rail` (device
 * #1/#2) instead of a plain `Card` — this page's primary text-heavy
 * surface, mirroring Reading's chapter-reader treatment — and the
 * persistent player sits in its own `tone="blue"` CityCard (mirrors
 * Reading's blue Resume-callout convention), giving the player a distinct
 * "signboard" identity from the reading surface below it. Every genuine
 * empty state (no lessons/episodes at all, no lesson text at all) carries
 * `.km-giwa`/`.km-hangul-watermark` (devices #3/#6), matching the
 * Reading/Progress/Uploads/Mistakes/ReviewGrammar precedent; per-tab micro-
 * empty-notes ("No highlights yet" when Transcript still has content) do
 * NOT get the watermark — that device is reserved for a view's ONE true
 * empty state, not every small fallback string inside an otherwise-
 * populated screen. The page root carries the ambient `.km-rain-sheen`
 * (device #8, Night-only per its own CSS gate). This page has no natural
 * fit for `SubwayProgress` (no multi-step run) or a `SealStamp` milestone
 * (no completion event to mark) or the najeon shimmer (no single hero CTA
 * to spare it for) — Reading's own reskin likewise adopts a genuine subset
 * of the nine devices rather than forcing all nine onto every page. No
 * shared file needed changing — every device consumed here already exists
 * post-foundation.
 *
 * F-131 (accent-driven hover): the landing tiles' hover wash reads off
 * `--km-tone` (Ttmik.css) — the SAME per-tile CSS variable CityCard/
 * DancheongRail resolve their glow from — so it always matches whichever
 * tone that tile actually rendered in (blue/mint), never a literal color.
 *
 * F-160 investigation (TTMIK/Iyagi "missing audio") — root-caused as a
 * DATA/INGEST gap, not a client bug: `buildAudioSrc`'s allow-list, the
 * persistent-player wiring, and the "no audio mapped" fallback below were
 * all already correct and covered by tests before this pass. Cross-checked
 * live against the deployed stack: the server audio-streaming route and the
 * `CORPUS_AUDIO_DIR` bind-mount both independently PASSED review
 * (`db/docs/REVIEW_F012_AUDIO_SEC.md`, `REVIEW_F012_DATA.md`) with zero
 * blockers, and a live spot-check (`km-db` + `km-server-blue`) confirms a
 * sampled lesson's `audio_path` resolves to a real file inside the running
 * container. The actual gaps are upstream of this page: (1) TTMIK level 9
 * is only 4/14 lessons mapped (10 missing) and Iyagi is only 91/139
 * episodes mapped (48 missing) — genuine, uneven corpus coverage; (2) the
 * ingest loader's filename regex misses a documented `-N` suffix shape
 * (`REVIEW_F012_DATA.md` SHOULD-FIX #1: 3 known real files — TTMIK lesson
 * (3,17), lesson (5,20), Iyagi episode 67 — exist on disk but are stored as
 * `hasAudio: false` because the loader never matched them). Both are
 * backend/ingest fixes, out of this page's scope (`tools/ingest/loaders/
 * load_ttmik_audio.py`, a future re-ingest pass) — filed as a follow-up
 * rather than faked here. The one genuine CLIENT gap found: a `hasAudio:
 * true` unit whose stream request fails at RUNTIME (transient network
 * blip, a stale/mismapped path) previously failed SILENTLY — the native
 * `<audio>` control just sits inert with no explanation. `DetailView` now
 * listens for the element's `error` event and renders a distinct `alert`
 * note ("audio couldn't load") alongside the still-mounted player, so a
 * real playback failure is never confused with — or rendered identically
 * to — the "no audio mapped" `note` state above it.
 *
 * F-161 ("Next page" → show-15) — ALREADY satisfied by this file's
 * existing F-072 windowing (`usePagination`/`ShowMore`, 15-row window, an
 * earlier phase): there was no next-page pager to remove. Verified via the
 * existing "F-072: windows the listing to 15 rows" test coverage below.
 *
 * F-162 (preserve scroll on back) — `useListScrollRestore` below keys off
 * Shell's single scrollable region (`.km-shell__scroll`, an `overflow-y:
 * auto` `<main>` — window itself never scrolls, see `components/Shell.tsx`)
 * rather than `window.scrollY`. `sessionStorage`-backed (not a bare in-
 * memory ref) so a position also survives an accidental hard refresh, keyed
 * per corpus so a TTMIK scroll position can never bleed into the Iyagi
 * listing or vice versa. Every storage access is try/catch-guarded — a
 * browser with storage disabled (private mode, quota) degrades to "always
 * restores to the top," never a crash.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { CityCard, type CityCardTone } from '../components/CityCard';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { FilterSelect } from '../components/FilterSelect';
import { Icon, type IconName } from '../components/Icon';
import { PageHubHeader } from '../components/PageHubHeader';
import { ShowMore } from '../components/ShowMore';
import { Tabs } from '../components/Tabs';
import { Tapword } from '../components/Tapword';
import { WordPopover } from '../components/WordPopover';
import type { WordPopoverData } from '../components/WordPopover';
import { useToast } from '../components/useToast';
import { cn } from '../lib/cn';
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
  /** F-128 device #1 — fixed CityCard tone (mirrors the design mock's
   *  blue-vs-mint square distinction), regardless of the user's accent
   *  pick — the same "always this hue" contract Reading's Resume (blue) /
   *  Generate (mint) CityCards use. */
  tone: CityCardTone;
}> = [
  {
    corpus: 'ttmik',
    en: 'TTMIK Lessons',
    kr: 'TTMIK 레슨',
    subEn: 'Structured lessons by level',
    subKr: '레벨별 구성 레슨',
    icon: 'headphones',
    tone: 'blue',
  },
  {
    corpus: 'iyagi',
    en: 'Iyagi Episodes',
    kr: '이야기 에피소드',
    subEn: 'Natural conversation episodes',
    subKr: '자연스러운 대화 에피소드',
    icon: 'mic',
    tone: 'mint',
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

// ─────────────────────────────────────────────────────────────
// F-162 — preserve a listing's scroll position across a visit to a
// lesson/episode detail and back
// ─────────────────────────────────────────────────────────────

/** The app's ONE scrollable region (Shell.tsx `<main>`) — window itself
 *  never scrolls, so scroll restoration keys off this ancestor. */
const SHELL_SCROLL_SELECTOR = '.km-shell__scroll';

/** One storage key per corpus — a TTMIK scroll position must never bleed
 *  into the Iyagi listing (or vice versa). */
const LISTEN_SCROLL_KEY: Record<Corpus, string> = {
  ttmik: 'km:listen:scroll:ttmik',
  iyagi: 'km:listen:scroll:iyagi',
};

/**
 * F-162 — restores (or resets) the nearest `.km-shell__scroll` ancestor's
 * `scrollTop` once the caller's list is `ready` (loaded), and persists it
 * to `sessionStorage` on every scroll so a later remount of the SAME
 * listing (browse → detail → Back) picks up where the user left off.
 *
 * Deliberately NOT a plain in-memory ref: `TtmikListing`/`IyagiListing`
 * fully UNMOUNT when the URL moves to a detail view (the parent's
 * `view.kind` branch swaps to a different component), so anything held in
 * this component's own state/refs is gone by the time the user comes back
 * — only something OUTSIDE the component's lifetime (session storage)
 * survives that round trip. `sessionStorage` also survives an accidental
 * hard refresh, which a bare in-memory module variable would not.
 *
 * ALWAYS assigns `scrollTop` once ready (restoring the saved value, or
 * explicitly resetting to 0 when none is saved) rather than leaving the
 * shared scroll container at whatever position a DIFFERENT listing left it
 * at — the isolation contract (TTMIK's and Iyagi's positions never mix)
 * would otherwise fail the first time a user opens a never-before-scrolled
 * listing right after scrolling the other one.
 *
 * Every storage access is try/catch-guarded (Bar §1, robust I/O): a
 * browser with storage disabled (private mode, quota exhausted) degrades
 * to "always opens at the top," never a crash.
 */
function useListScrollRestore(
  storageKey: string,
  ready: boolean,
): RefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ready) return;
    const scroller = rootRef.current?.closest<HTMLElement>(
      SHELL_SCROLL_SELECTOR,
    );
    if (scroller == null) return;

    try {
      const saved = window.sessionStorage.getItem(storageKey);
      const restored = saved !== null ? Number(saved) : 0;
      scroller.scrollTop = Number.isFinite(restored) ? restored : 0;
    } catch {
      // Storage read failed (disabled/unavailable) — leave the scroll
      // position wherever it already is rather than throw.
    }

    const onScroll = (): void => {
      try {
        window.sessionStorage.setItem(
          storageKey,
          String(scroller.scrollTop),
        );
      } catch {
        // Storage write failed — next visit just won't restore; never throw.
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [storageKey, ready]);

  return rootRef;
}

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
      className="screen km-ttmik km-rain-sheen"
      aria-labelledby="km-ttmik-title"
    >
      {back}
      <PageHubHeader
        titleId="km-ttmik-title"
        eyebrow={
          <Bilingual en={TTMIK_NAV.eyebrow} kr={TTMIK_NAV.krEyebrow} />
        }
        heading={<Bilingual en="Listen" kr="듣기" />}
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
 * The landing grid. F-128 device #1: each collection is a `CityCard`
 * signboard/hanji-paper tile (`tone` per `COLLECTIONS`, fixed blue/mint —
 * see the file-top doc comment) with a full-bleed real `<button>` inside
 * doing the navigation — the `CollapsibleTile` "surface=city" idiom:
 * CityCard supplies the chrome (glow border/shadow, tokenized both
 * themes), the button inside is the sole keyboard-operable hit target and
 * accessible-name carrier (its content IS the visible bilingual text; the
 * icon is decorative). Layout (2-across squares, flowing down) lives in
 * Ttmik.css on `.km-ttmik__tiles`.
 */
function CollectionTiles(): JSX.Element {
  const navigate = useNavigate();
  return (
    <ul className="km-ttmik__tiles" aria-label="Audio collections">
      {COLLECTIONS.map((c) => (
        <li key={c.corpus}>
          <CityCard tone={c.tone} className="km-ttmik__tile">
            <button
              type="button"
              className="km-ttmik__tile-btn focusring"
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
          </CityCard>
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

  // F-162: restores this listing's scroll position once it has rendered
  // (never while the loading/error branches below are showing — there's
  // nothing to scroll yet). See `useListScrollRestore`'s header comment.
  const scrollRootRef = useListScrollRestore(
    LISTEN_SCROLL_KEY.ttmik,
    !loading,
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
      <p
        className="km-reference__empty km-giwa km-hangul-watermark"
        data-glyph="레슨"
      >
        <Bilingual en="No lessons available yet." kr="아직 레슨이 없어요." />
      </p>
    );
  }

  return (
    <div ref={scrollRootRef}>
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
                    // aria-label REPLACES the button's subtree name, so it
                    // must fold in the AudioPill's state itself — otherwise
                    // "Audio"/"No audio" is visible to sighted users but
                    // never announced to AT (SF-2).
                    aria-label={`Open lesson ${String(lesson.number)}: ${lesson.title} (${lesson.hasAudio ? 'audio' : 'no audio'})`}
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

  // F-162: see the TTMIK listing's identical hook call above.
  const scrollRootRef = useListScrollRestore(
    LISTEN_SCROLL_KEY.iyagi,
    !loading,
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
      <p
        className="km-reference__empty km-giwa km-hangul-watermark"
        data-glyph="이야기"
      >
        <Bilingual
          en="No episodes available yet."
          kr="아직 에피소드가 없어요."
        />
      </p>
    );
  }

  return (
    <div ref={scrollRootRef}>
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
                // Same fold-in as the ttmik row above (SF-2) — the
                // aria-label replaces the subtree name, so the AudioPill's
                // state has to travel inside it or AT never hears it.
                aria-label={`Open episode ${String(episode.number)}: ${episode.title} (${episode.hasAudio ? 'audio' : 'no audio'})`}
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

  // F-160: a `hasAudio: true` unit whose stream request fails at RUNTIME
  // (transient network blip, a stale/mismapped path) previously failed
  // SILENTLY — the native control just sat inert. The element's own
  // `error` event flips this so a genuine playback failure renders a
  // visible, distinct note instead (see the render below) — separate from,
  // and never confused with, the "no audio mapped" `audioSrc === null`
  // state, which is an expected/documented corpus gap, not a failure.
  const [audioError, setAudioError] = useState(false);
  const onAudioError = useCallback((): void => {
    setAudioError(true);
  }, []);

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

  // SF-4: `selection` is a fresh object literal minted by `parseListenView`
  // on every render of the Ttmik root, so depping the effect on the object
  // itself would spuriously re-fire (abort the in-flight/completed fetch
  // and refetch the SAME detail, flashing the skeleton) on any parent
  // re-render that doesn't change the URL — this component is remounted
  // wholesale (via `key={selectionKey(...)}` in the parent) whenever the
  // selection genuinely changes, so within one mounted instance the value
  // never actually changes. Dep on the same primitive string the parent
  // keys the remount with, so identical selections never re-trigger this.
  const detailKey = selectionKey(selection);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference tabs use for their kickoff setState. (No eslint-disable
    // needed here: depping on the primitive `detailKey` rather than the
    // `selection` object, per the SF-4 fix above, reads as a plain
    // reactive effect to the lint rule's analysis.)
    setLoading(true);
    setError(null);
    loadDetail(selection, ctrl.signal)
      .then((detail) => {
        if (ctrl.signal.aborted) return;
        setData(detail);
        setLoading(false);
        // A fresh detail (initial load OR a Retry) gets a fresh player —
        // clear any prior runtime playback failure so the new src gets its
        // own chance rather than staying stuck on the old error note.
        setAudioError(false);
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
    // `selection` intentionally excluded — see `detailKey` comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailKey, reloadTick]);

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
          this inside a per-tab component or add a tab-derived key.
          F-128 device #1/#2 — a `blue`-tone CityCard signboard/hanji-paper
          card, mirroring Reading's blue Resume-callout convention, gives
          the player its own signboard identity distinct from the `accent`
          reading-surface card below it. The CityCard wrapper is itself
          unkeyed/unconditional (same stable position as before), so it
          doesn't touch the `<audio>` element's own identity contract. */}
      <CityCard tone="blue" className="km-ttmik__player">
        {data.audioSrc !== null ? (
          <>
            {/* Real streaming player; the server endpoint supports HTTP
                Range, so seeking works. No timed caption track exists for
                this corpus; the full read-along transcript renders
                directly below (per-line karaoke sync is the documented
                follow-up once timestamps exist), hence the a11y rule
                exemption. F-160: `onError` catches a RUNTIME stream
                failure (the src resolved but the fetch/decode failed) —
                distinct from `audioSrc === null` below, which means no
                audio was ever mapped for this unit. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio
              controls
              preload="metadata"
              src={data.audioSrc}
              aria-label={`Audio for ${data.title}`}
              onError={onAudioError}
              style={{ width: '100%' }}
            />
            {audioError ? (
              <p className="km-ttmik__audio-error" role="alert">
                <Bilingual
                  en="Audio couldn't load — try again later."
                  kr="오디오를 불러올 수 없어요 — 나중에 다시 시도해 주세요."
                />
              </p>
            ) : null}
          </>
        ) : (
          // P3b trim: the scattered "No X for this one." empty-states are
          // consolidated to one terse "No X yet." shape (here + the panels).
          // F-160: this is the EXPECTED "nothing mapped" state (a documented
          // corpus gap) — a `role="note"`, never the `alert` above.
          <p className="km-reference__empty" role="note">
            <Bilingual
              en="No audio yet — read along below."
              kr="아직 오디오가 없어요 — 아래에서 읽어 보세요."
            />
          </p>
        )}
      </CityCard>

      {data.corpus === 'ttmik' ? (
        visibleLessonTabs.length === 0 ? (
          // The lesson's ONE true "nothing here" state (no Highlights AND
          // no Transcript) — carries the giwa/hangul-watermark devices,
          // unlike the per-tab micro-empty-notes inside the panels below
          // (see the file-top doc comment's scope note).
          <p
            className="km-reference__row-en km-giwa km-hangul-watermark"
            style={{ margin: '8px 0' }}
            data-glyph="수업"
          >
            <Bilingual
              en="No lesson text yet."
              kr="아직 수업 내용이 없어요."
            />
          </p>
        ) : (
          // SF-3: mounts the shared `Tabs` primitive (F-032) instead of a
          // hand-rolled tablist — full APG contract (roving tabindex,
          // Arrow/Home/End, a real tabpanel) for free. `Tabs` renders its
          // panel BELOW this point in the tree; the persistent `<audio>`
          // above is a sibling rendered unconditionally before this whole
          // branch, so its DOM position — and therefore its identity
          // across Highlights ↔ Transcript switches — is untouched.
          <Tabs
            tabs={visibleLessonTabs.map((t) => ({
              id: t.id,
              label: <Bilingual en={t.label} kr={t.kr} compact />,
            }))}
            ariaLabel="Lesson content"
            active={effectiveTab}
            onChange={(id) => {
              // `visibleLessonTabs` only ever supplies 'highlights' |
              // 'transcript' ids, so this narrowing is exhaustive.
              setLessonTab(id as LessonTab);
            }}
          >
            {(activeId) =>
              activeId === 'highlights' ? (
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
              )
            }
          </Tabs>
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

/**
 * TTMIK Highlights — the key-phrase layout (the original detail body).
 * F-128 device #1/#2 — a `CityCard tone="accent" rail` (mirrors Reading's
 * chapter-reader treatment of its own primary text-heavy surface) replaces
 * the plain `Card`. The `rows.length === 0` fallback below is defensive
 * only: the parent's `visibleLessonTabs` gating (DetailView) never shows
 * this panel as the active tab unless `hasHighlights` is true, so it is
 * never this view's REAL empty state — no watermark here (see the
 * file-top doc comment's scope note); `SentencesPanel` below is the one
 * that genuinely reaches empty.
 */
function HighlightsPanel({
  rows,
  minedIds,
  onTapWord,
}: PanelProps & { rows: ListenSentence[] }): JSX.Element {
  return (
    <CityCard tone="accent" rail className="km-ttmik__reader-card">
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
    </CityCard>
  );
}

/**
 * Iyagi episode transcript — flat ordered list of spoken rows. Unlike
 * `HighlightsPanel`/`TranscriptPanel` (TTMIK, gated by `visibleLessonTabs`
 * so their internal empty branches are unreachable defense-in-depth), an
 * Iyagi episode has no tab gating — this genuinely IS the whole detail
 * body, so `rows.length === 0` here is a real, reachable "nothing here"
 * state and gets the giwa/hangul-watermark devices.
 */
function SentencesPanel({
  rows,
  minedIds,
  onTapWord,
}: PanelProps & { rows: ListenSentence[] }): JSX.Element {
  return (
    <CityCard
      tone="accent"
      rail
      className={cn(
        'km-ttmik__reader-card',
        rows.length === 0 && 'km-giwa km-hangul-watermark',
      )}
      {...(rows.length === 0 ? { 'data-glyph': '대본' } : {})}
    >
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
    </CityCard>
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
    <CityCard tone="accent" rail className="km-ttmik__reader-card">
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
    </CityCard>
  );
}
