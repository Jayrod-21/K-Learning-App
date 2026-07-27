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
  type ChangeEvent,
  type JSX,
  type RefObject,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CityCard, type CityCardTone } from '../components/CityCard';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { FilterSelect } from '../components/FilterSelect';
import { Icon, type IconName } from '../components/Icon';
import { PageHubHeader } from '../components/PageHubHeader';
import { Pill, type PillTone } from '../components/Pill';
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
import { audioUploadErrorMessage, errorMessageFor } from '../lib/errorCopy';
import { navItem } from '../lib/nav';
import {
  checkAudioFile,
  getAudioTrack,
  listMyAudio,
  uploadAudio,
} from '../services/audio';
import {
  buildAudioSrc,
  getIyagiEpisode,
  getIyagiEpisodes,
  getTtmikLesson,
  getTtmikLessons,
  logIyagiAttempt,
  logTtmikAttempt,
} from '../services/ttmik';
import { mineWord } from '../services/vocab';
import type {
  AudioSource,
  AudioTrackDetail,
  AudioTranscriptStatus,
  IyagiEpisode,
  ListenSentence,
  TtmikLesson,
  TtmikTranscriptLine,
} from '../types/domain';
import './Ttmik.css';

/** The audio collections this screen serves (closed set — parse target).
 *  `mine` is the Track A A-4b "My Audio" surface (user uploads + Whisper
 *  transcripts) — a LISTING/DETAIL pair of its own, deliberately outside the
 *  TTMIK/Iyagi-closed `Selection`/`DetailData` machinery below. */
type Corpus = 'ttmik' | 'iyagi' | 'mine';

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
  {
    corpus: 'mine',
    en: 'My Audio',
    kr: '내 오디오',
    subEn: 'Your uploads, transcribed',
    subKr: '업로드한 오디오와 자동 대본',
    icon: 'upload',
    // Violet — blue/mint are taken by TTMIK/Iyagi (and ochre by Hanja);
    // same fixed "always this hue" contract as the other two tiles.
    tone: 'violet',
  },
];

/** Listing labels the detail BackButton reuses ("Back to TTMIK Lessons"). */
const COLLECTION_LABEL: Record<Corpus, string> = {
  ttmik: 'TTMIK Lessons',
  iyagi: 'Iyagi Episodes',
  mine: 'My Audio',
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
  mine: 'km:listen:scroll:mine',
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

/** Which view the URL addresses. `detail` stays TTMIK/Iyagi-closed (its
 *  `Selection`/`DetailData` machinery is corpus-specific); the My Audio
 *  track detail is its own kind, keyed by a validated DB track id. */
type ListenView =
  | { kind: 'landing' }
  | { kind: 'list'; corpus: Corpus }
  | { kind: 'detail'; selection: Selection }
  | { kind: 'mineSource'; sourceId: number }
  | { kind: 'mineTrack'; trackId: number; sourceId: number | null };

/**
 * Bounded positive-int parser for untrusted search params. Digits only
 * (no signs, exponents, whitespace — `Number()` alone accepts all three),
 * capped at 4 digits: corpus identifiers are small ordinals, and the bound
 * keeps a hostile param from minting absurd path segments. Shared across
 * TTMIK lesson numbers (`level`/`lesson`) and Iyagi episode numbers
 * (`episode`) — the 4-digit cap is intentionally generous for both rather
 * than tuned to either corpus's current size (~170 Iyagi episodes today);
 * revisit only if a corpus ever approaches 9999.
 */
function parsePositiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/**
 * DB-identity variant of `parsePositiveInt` for the My Audio `track` param:
 * `audio_tracks` ids are BIGINT IDENTITY values, not small corpus ordinals,
 * so the 4-digit ordinal cap would strand any track past id 9999. 15 digits
 * keeps every accepted value comfortably inside `Number.MAX_SAFE_INTEGER`
 * (16 digits can exceed it) while still bounding a hostile param.
 */
function parsePositiveId(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
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
  if (corpus === 'mine') {
    // Same fall-back-UP-the-hierarchy contract: a malformed `track`/`source`
    // lands on the My Audio listing, never in a fetch with an attacker-shaped
    // id. `track` is the DEEPER view so it wins when both are present; its
    // (optional, may be malformed→null) `source` rides along ONLY so the
    // track detail's "back" can return to that source's track list.
    const track = parsePositiveId(params.get('track'));
    const source = parsePositiveId(params.get('source'));
    if (track !== null) {
      return { kind: 'mineTrack', trackId: track, sourceId: source };
    }
    if (source !== null) {
      return { kind: 'mineSource', sourceId: source };
    }
    return { kind: 'list', corpus: 'mine' };
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
function myAudioSourcePath(sourceId: number): string {
  return `${listPath('mine')}&source=${String(sourceId)}`;
}
/** Track detail URL. When `sourceId` is given (navigation came THROUGH a
 *  source's track list) it rides along so the detail's "back" can return to
 *  that list — the track-detail payload carries no source id of its own. A
 *  bare form (upload / deep link) omits it and "back" goes to the listing. */
function myAudioTrackPath(trackId: number, sourceId?: number): string {
  const base = listPath('mine');
  return sourceId !== undefined
    ? `${base}&source=${String(sourceId)}&track=${String(trackId)}`
    : `${base}&track=${String(trackId)}`;
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
  } else if (view.kind === 'mineSource') {
    back = <BackButton to={listPath('mine')} label={COLLECTION_LABEL.mine} />;
  } else if (view.kind === 'mineTrack') {
    // Back to the source's track list when we arrived through one (the URL
    // carried a well-formed `source`); otherwise — a bare deep link or an
    // in-app upload — back to the My Audio listing.
    back =
      view.sourceId !== null ? (
        <BackButton
          to={myAudioSourcePath(view.sourceId)}
          label={COLLECTION_LABEL.mine}
        />
      ) : (
        <BackButton to={listPath('mine')} label={COLLECTION_LABEL.mine} />
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
      {view.kind === 'list' && view.corpus === 'mine' ? (
        <MyAudioListing />
      ) : null}
      {view.kind === 'mineSource' ? (
        // Keyed on the source id — opening a different set remounts fresh
        // (fresh fetch, fresh poll), mirroring the track detail's contract.
        <MyAudioSourceDetail
          key={`mineSource:${String(view.sourceId)}`}
          sourceId={view.sourceId}
        />
      ) : null}
      {view.kind === 'mineTrack' ? (
        // Keyed on the track id — a different track remounts fresh (fresh
        // player, fresh poll), mirroring DetailView's selectionKey contract.
        <MyAudioDetail
          key={`mine:${String(view.trackId)}`}
          trackId={view.trackId}
        />
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
    <ul
      className="km-ttmik__tiles"
      aria-label="Audio collections"
      data-tour="listen-collections"
    >
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

// ─────────────────────────────────────────────────────────────
// Mark-as-listened (F-172 — listening_attempts, migration 061)
// ─────────────────────────────────────────────────────────────

/**
 * The completion-log POST's lifecycle (mirrors Reading.tsx's own
 * `MarkReadState`, duplicated here rather than cross-imported — same
 * page-local-duplication posture this file already takes for `TapKorean`/
 * `SkeletonCard`). No 'idle' → 'saving' → 'done' loop back: once logged, the
 * button stays done for the rest of this detail view's mount (re-opening a
 * DIFFERENT lesson/episode remounts fresh via the parent's
 * `key={selectionKey(...)}`).
 */
type MarkListenedState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

/** Fixed fallback copy for a failed completion-log POST (errorCopy contract). */
const MARK_LISTENED_FAILED_COPY = "Couldn't save — try again.";

/**
 * The explicit "I finished this" affordance — the same completion signal the
 * `<audio>` `ended` event fires automatically (see `DetailView` below), also
 * offered as a button so a unit with no mapped audio (`audioSrc === null`) or
 * a listen that didn't play to the very end still has a way to log it.
 * `aria-disabled` (not `disabled`) while saving/done — the hard attribute
 * would drop keyboard focus to `<body>` mid-request.
 */
function MarkListenedButton({
  state,
  onMark,
}: {
  state: MarkListenedState;
  onMark: () => void;
}): JSX.Element {
  const busy = state.phase === 'saving';
  const done = state.phase === 'done';
  return (
    <div style={{ margin: '12px 0' }}>
      <Button
        variant={done ? 'ghost' : 'gold'}
        size="sm"
        leadingIcon={<Icon name="check" size={14} />}
        aria-disabled={busy || done || undefined}
        onClick={() => {
          if (busy || done) return; // aria-disabled doesn't block clicks — we do.
          onMark();
        }}
      >
        {done ? (
          <Bilingual en="Marked as listened" kr="들음으로 표시됨" compact />
        ) : busy ? (
          <Bilingual en="Saving…" kr="저장 중…" compact />
        ) : (
          <Bilingual en="Mark as listened" kr="들음으로 표시" compact />
        )}
      </Button>
      {state.phase === 'error' ? (
        <span role="alert" style={{ marginLeft: 8 }}>
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

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

  // F-172 — "Mark as listened" (listening_attempts, migration 061). Fired
  // either automatically (the `<audio>` element's `ended` event, wired below)
  // or explicitly via `MarkListenedButton` — the only completion signal this
  // screen had NONE of before (routes/ttmik.ts was pure read-only corpus
  // serving; see that route's own header). Guarded against re-entry (a replay
  // reaching `ended` again, or a second click) by checking `markState.phase`
  // at the top rather than only in the button's own click handler, since the
  // audio `ended` path doesn't go through that handler. Aborted on unmount /
  // selection change so a closed or superseded detail view never lands a late
  // setState.
  const [markState, setMarkState] = useState<MarkListenedState>({ phase: 'idle' });
  const markCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      markCtrlRef.current?.abort();
    },
    // Empty deps: this whole component remounts fresh per selection (the
    // parent keys DetailView on `selectionKey(...)`), so unmount-only cleanup
    // is exactly what's needed — no dependency on `detailKey` (declared later
    // in this function; depping on it here would also be a use-before-define).
    [],
  );
  const markListened = useCallback((): void => {
    setMarkState((prev) => {
      if (prev.phase === 'saving' || prev.phase === 'done') return prev;
      markCtrlRef.current?.abort();
      const ctrl = new AbortController();
      markCtrlRef.current = ctrl;
      const call =
        selection.corpus === 'ttmik'
          ? logTtmikAttempt(selection.level, selection.number, ctrl.signal)
          : logIyagiAttempt(selection.number, ctrl.signal);
      call.then(
        () => {
          if (ctrl.signal.aborted) return;
          setMarkState({ phase: 'done' });
        },
        (err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          setMarkState({
            phase: 'error',
            message: errorMessageFor(err, MARK_LISTENED_FAILED_COPY),
          });
        },
      );
      return { phase: 'saving' };
    });
  }, [selection]);
  const onAudioEnded = useCallback((): void => {
    markListened();
  }, [markListened]);

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
              // F-172: reaching the end of the audio IS a completion signal —
              // logs a listening_attempts row automatically. `markListened`
              // no-ops if already saving/done, so a replay past `ended` again
              // (or a click on the explicit button below) can't double-log.
              onEnded={onAudioEnded}
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

      {/* F-172: explicit fallback trigger — covers a unit with no mapped
          audio (audioSrc === null, so `ended` can never fire) and a listen
          that didn't play all the way through. */}
      <MarkListenedButton state={markState} onMark={markListened} />

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

// ─────────────────────────────────────────────────────────────
// My Audio (Track A A-4b) — user uploads + transcript polling
// ─────────────────────────────────────────────────────────────
//
// A SEPARATE listing/detail pair from the TTMIK/Iyagi machinery above: the
// `Selection`/`DetailData` union, the F-172 MarkListenedButton plumbing and
// the tap-word chain all stay corpus-closed (per their own docs); My Audio
// reuses only the page's genuinely shared devices (CityCard player card,
// reader card, giwa empty state, `useListScrollRestore`, the fixed-copy
// error contract). Threat model additions over the page header's:
//   - The `track` search param is untrusted — `parsePositiveId` bounds it
//     (digits only, ≤15) before it can shape a request path.
//   - The player src goes through `buildAudioSrc`'s strict allow-list, so a
//     tampered `streamUrl` can never point the media element off-origin.
//   - Upload failures render fixed copy (`audioUploadErrorMessage` /
//     `checkAudioFile`) — server prose is never echoed; a 404 on the track
//     detail renders one uniform "not found" state (the server never
//     distinguishes deleted vs not-yours, and neither do we).
//   - POLLING (the app's first): a bounded `setInterval` re-fetch that runs
//     ONLY while a transcription is actually unsettled (pending/running),
//     stops itself the moment everything settles, and is cleared — with its
//     in-flight request aborted — on unmount/navigation. A transient poll
//     failure keeps the last good data and lets the next tick retry; it
//     never tears down the visible list. Each tick aborts the previous
//     tick's request before fetching (the abort-before-fetch house pattern,
//     SF-1/SF-2), a per-lifecycle attempt ceiling bounds a never-settling
//     job's churn against the rate-limited GET, and a mid-poll 404 on the
//     detail stops that poll outright (SF-3) — see the per-effect comments.

/** How often the listing/detail re-check an unsettled transcription (ms).
 *  Whisper runs take tens of seconds to minutes — 4 s keeps the UI honest
 *  without hammering the cheap-limited GET. */
const MY_AUDIO_POLL_MS = 4000;

/**
 * Hard ceiling on poll attempts per poller lifecycle (SF-3): 225 ticks ×
 * 4 s = 15 minutes — generous against real Whisper runtimes (tens of
 * seconds to minutes), but a bound so a job stuck 'pending' forever (a dead
 * worker) can never churn the rate-limited GET unbounded. The budget resets
 * whenever the poll effect restarts: a fresh upload (the listing's
 * `pollEpoch` bump), a remount (corpus switch / navigation), or the
 * unsettled boolean flipping false→true again.
 */
const MY_AUDIO_POLL_MAX_TICKS = 225;

/** Status pill meta — pending/running read as "in progress" (default tone),
 *  done/failed get the green/red pill tones (Uploads' STATUS_META idiom). */
const TRANSCRIPT_STATUS_META: Record<
  AudioTranscriptStatus,
  { en: string; kr: string; tone: PillTone }
> = {
  pending: { en: 'Queued', kr: '대기 중', tone: 'default' },
  running: { en: 'Transcribing', kr: '전사 중', tone: 'default' },
  done: { en: 'Ready', kr: '완료', tone: 'green' },
  failed: { en: 'Failed', kr: '실패', tone: 'red' },
};

/** True while a track's transcription is still in progress — the polling
 *  predicate for both the listing and the detail view. */
function isUnsettled(status: AudioTranscriptStatus): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * Source-level status rollup for the listing pill. Upload sources always
 * have exactly one track, so this is normally just `tracks[0]`'s status;
 * for a (corpus-loaded) multi-track source: any unsettled track keeps the
 * whole source "in progress", else any failure marks it failed, else done.
 * A trackless source (corpus edge case) rolls up as done — its row renders
 * non-navigable below, so the pill is cosmetic there.
 */
function sourceStatus(source: AudioSource): AudioTranscriptStatus {
  if (source.tracks.some((t) => isUnsettled(t.transcriptStatus))) {
    return source.tracks.some((t) => t.transcriptStatus === 'running')
      ? 'running'
      : 'pending';
  }
  if (source.tracks.some((t) => t.transcriptStatus === 'failed')) {
    return 'failed';
  }
  return 'done';
}

/** Filename minus its audio extension — the default upload title (mirrors
 *  UploadTypeModal's `titleFromFilename`), bounded to the server's 500-char
 *  title cap. May be '' (e.g. a bare `.mp3`) — the caller then omits the
 *  title field and the server derives its own date-based fallback. */
function titleFromAudioFilename(name: string): string {
  return name.replace(/\.(mp3|m4a)$/i, '').trim().slice(0, 500);
}

/** Short display date for a source row (Uploads' formatDate posture —
 *  page-local duplication rather than a cross-page import). */
function formatAudioDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * The My Audio listing: an upload control + this user's audio sources with
 * live transcript-status pills. Polls `GET /audio` every `MY_AUDIO_POLL_MS`
 * while any track is pending/running (see the section header's polling
 * note); a successful upload splices the fresh source in optimistically
 * (Uploads' `onUploaded` posture) and the next poll tick reconciles it with
 * server truth.
 */
function MyAudioListing(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the listings above use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    listMyAudio(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setSources(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load your audio.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // ── Polling (the app's first — see the section header) ──
  // Runs ONLY while some track is genuinely unsettled. The effect deps on
  // the derived BOOLEAN (not `sources` itself), so a poll response that
  // replaces the array without settling anything does NOT tear down and
  // recreate the interval; the moment everything settles the boolean flips
  // and the cleanup clears it.
  //
  // STOP CONDITIONS (SF-3 — every way this poll ends):
  //   1. Everything settles → `hasUnsettled` flips false → cleanup clears
  //      the interval and aborts the in-flight tick.
  //   2. Unmount / corpus switch → same cleanup — no leak, no late setState.
  //   3. The attempt ceiling (`MY_AUDIO_POLL_MAX_TICKS`) trips — a job stuck
  //      'pending' forever must not churn the rate-limited GET unbounded.
  //      Rows keep their last known status; a fresh upload (`pollEpoch`
  //      bump) or a revisit restarts the budget.
  // Genuinely TRANSIENT failures (network blip, 5xx) do NOT stop it — the
  // next tick retries with the last good list still on screen.
  //
  // RACE SAFETY (SF-1/SF-2 — the file's abort-before-fetch house pattern,
  // applied PER TICK): each tick aborts the previous tick's request before
  // fetching, so a slow stale snapshot can never land over a newer one; the
  // upload-success handler aborts the in-flight tick before splicing, so a
  // snapshot taken before the POST landed can never erase the fresh row.
  const hasUnsettled = sources.some((s) =>
    s.tracks.some((t) => isUnsettled(t.transcriptStatus)),
  );
  // Bumped on upload success: restarts the poll effect so the fresh job gets
  // a full first interval AND a full attempt budget of its own.
  const [pollEpoch, setPollEpoch] = useState(0);
  const pollTickCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (loading || error !== null || !hasUnsettled) return;
    let ticks = 0; // effect-local — every (re)start gets a fresh budget
    const id = window.setInterval(() => {
      ticks += 1;
      if (ticks > MY_AUDIO_POLL_MAX_TICKS) {
        // Ceiling: a never-settling job — stop churning (stop condition 3).
        window.clearInterval(id);
        return;
      }
      // Abort-before-fetch, per tick: the previous tick either settled
      // (abort is a no-op) or is stale-in-flight (must never land later).
      pollTickCtrlRef.current?.abort();
      const ctrl = new AbortController();
      pollTickCtrlRef.current = ctrl;
      listMyAudio(ctrl.signal)
        .then((rows) => {
          if (ctrl.signal.aborted) return;
          setSources(rows);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          // Transient poll failure — keep the last good list on screen and
          // let the next tick retry; a background refresh must never replace
          // visible data with an error card.
        });
    }, MY_AUDIO_POLL_MS);
    return () => {
      window.clearInterval(id);
      pollTickCtrlRef.current?.abort();
      pollTickCtrlRef.current = null;
    };
  }, [loading, error, hasUnsettled, pollEpoch]);

  // ── Upload control ──
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadCtrlRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(
    () => () => {
      uploadCtrlRef.current?.abort();
    },
    [],
  );

  const onFilePicked = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      const picked = e.target.files?.[0] ?? null;
      // Reset the input so picking the SAME file again still fires `change`.
      e.target.value = '';
      if (!picked) return;
      const precheck = checkAudioFile(picked);
      if (precheck !== null) {
        setUploadError(precheck);
        return;
      }

      uploadCtrlRef.current?.abort();
      const ctrl = new AbortController();
      uploadCtrlRef.current = ctrl;
      setUploading(true);
      // Stays null (bare "Uploading…") until the first REAL progress tick —
      // UploadTypeModal's exact stance.
      setUploadProgress(null);
      setUploadError(null);
      const title = titleFromAudioFilename(picked.name);
      uploadAudio(picked, {
        ...(title !== '' ? { title } : {}),
        signal: ctrl.signal,
        onProgress: (percent) => {
          if (ctrl.signal.aborted) return;
          setUploadProgress(percent);
        },
      })
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setUploading(false);
          setUploadProgress(null);
          // SF-2: a poll tick whose snapshot predates this POST may be in
          // flight RIGHT NOW — abort it BEFORE splicing so its stale rows
          // can never land afterwards and erase the fresh source below.
          pollTickCtrlRef.current?.abort();
          pollTickCtrlRef.current = null;
          // Splice the fresh source in (Uploads' onUploaded posture). Built
          // from what we KNOW locally — the poll effect wakes on the pending
          // track and reconciles with server truth on its first tick.
          setSources((prev) => [
            {
              id: res.sourceId,
              title: title !== '' ? title : 'Audio upload',
              kind: 'standalone_listening',
              createdAt: new Date().toISOString(),
              tracks: [
                {
                  id: res.trackId,
                  trackNumber: 1,
                  title: title !== '' ? title : null,
                  byteSize: picked.size,
                  durationMs: null,
                  transcriptStatus: res.transcriptStatus,
                },
              ],
            },
            ...prev.filter((s) => s.id !== res.sourceId),
          ]);
          // Re-wake the poller with a fresh interval and a fresh attempt
          // budget for the new job (also recovers a ceiling-exhausted poll).
          setPollEpoch((e) => e + 1);
          toast({
            message: 'Uploaded — transcription started.',
            tone: 'success',
          });
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          setUploading(false);
          setUploadProgress(null);
          // Fixed copy only — never the server's prose (errorCopy contract).
          setUploadError(audioUploadErrorMessage(err));
        });
    },
    [toast],
  );

  // F-162: same per-corpus scroll restore as the listings above.
  const scrollRootRef = useListScrollRestore(LISTEN_SCROLL_KEY.mine, !loading);

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        <Bilingual en="Loading your audio…" kr="오디오를 불러오는 중…" />
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }

  return (
    <div ref={scrollRootRef}>
      <div style={{ margin: '0 0 14px' }}>
        <Button
          variant="gold"
          size="md"
          fullWidth
          leadingIcon={<Icon name="upload" size={14} />}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-busy={uploading}
        >
          {/* role=status/aria-live announces upload progress to AT — the
              UploadTypeModal progress-label recipe, real bytes not a ramp. */}
          <span role="status" aria-live="polite">
            {uploading ? (
              <Bilingual
                en={
                  uploadProgress !== null
                    ? `Uploading… ${String(uploadProgress)}%`
                    : 'Uploading…'
                }
                kr={
                  uploadProgress !== null
                    ? `업로드 중… ${String(uploadProgress)}%`
                    : '업로드 중…'
                }
                compact
              />
            ) : (
              <Bilingual en="Upload audio" kr="오디오 업로드" compact />
            )}
          </span>
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a"
          hidden
          aria-label="Audio file"
          onChange={onFilePicked}
        />
        {uploadError !== null ? <ErrorCard message={uploadError} /> : null}
      </div>

      {sources.length === 0 ? (
        <p
          className="km-reference__empty km-giwa km-hangul-watermark"
          data-glyph="오디오"
        >
          <Bilingual
            en="No audio yet. Upload an MP3 or M4A to get a Korean transcript."
            kr="아직 오디오가 없어요. MP3나 M4A를 업로드하면 대본을 만들어 드려요."
          />
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul aria-label="Your audio">
            {sources.map((source) => {
              const trackCount = source.tracks.length;
              const firstTrack = source.tracks[0];
              // Multi-track sources are corpus-loaded sets (a TTMIK level, a
              // TOPIK mock test, a folktale collection); every in-app upload
              // is single-track. Single-track opens the player directly (no
              // needless one-row middle list — the pre-existing upload UX);
              // multi-track opens its track list first. Trackless (a corpus
              // edge case) stays non-navigable.
              const isSet = trackCount > 1;
              const status = TRANSCRIPT_STATUS_META[sourceStatus(source)];
              return (
                <li
                  key={`mine:${String(source.id)}`}
                  className="km-reference__row"
                >
                  <button
                    type="button"
                    className="km-resources__list-open focusring"
                    onClick={() => {
                      if (isSet) {
                        void navigate(myAudioSourcePath(source.id));
                      } else if (firstTrack !== undefined) {
                        void navigate(myAudioTrackPath(firstTrack.id));
                      }
                    }}
                    disabled={firstTrack === undefined}
                    // aria-label replaces the subtree name, so the status
                    // pill's state must travel inside it (the SF-2 fold-in
                    // the corpus rows above use). A set announces its track
                    // count so AT distinguishes "opens a list" from "plays".
                    aria-label={
                      isSet
                        ? `Open audio set: ${source.title}, ${String(trackCount)} tracks (${status.en})`
                        : `Open audio: ${source.title} (${status.en})`
                    }
                  >
                    <span className="kr km-reference__row-kr">
                      {source.title}
                    </span>
                    <Pill tone={status.tone}>
                      <Bilingual en={status.en} kr={status.kr} compact />
                    </Pill>
                    <span className="km-resources__pager-count">
                      {isSet
                        ? `${String(trackCount)} tracks`
                        : formatAudioDate(source.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * One audio SOURCE's track list — the middle level between the My Audio
 * listing and a single track's player. Corpus-loaded sources hold many
 * tracks (a TTMIK level, a TOPIK mock test, a folktale collection); this
 * view lists them in play order with live per-track status pills, each row
 * opening that track's player + transcript. In-app uploads are single-track
 * and skip this level (the listing opens their player directly).
 *
 * Data comes from the SAME `GET /audio` the listing uses, narrowed to this
 * source id — there is no single-source endpoint, and the source set is
 * small (server caps it at 50) so re-fetching all of it is cheap and keeps
 * the view deep-linkable (a bookmarked `?corpus=mine&source=<id>` resolves
 * without router state). Corollary of that cap: a deep-linked source that
 * exists but has aged beyond the server's most-recent-50 window reads as
 * not-found here — the same invisibility it has in the listing; a
 * `GET /audio/sources/:id` endpoint is the fix if source counts ever grow
 * past the cap. Polls while any of THIS source's tracks is
 * unsettled, with the listing's stop/cleanup/abort-before-fetch contract; a
 * source that vanishes resolves to the uniform not-found state (terminal,
 * like the track detail's mid-poll 404).
 */
function MyAudioSourceDetail({
  sourceId,
}: {
  sourceId: number;
}): JSX.Element {
  const navigate = useNavigate();
  const [source, setSource] = useState<AudioSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // as every other kickoff setState on this page.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    setNotFound(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    listMyAudio(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        const found = rows.find((s) => s.id === sourceId) ?? null;
        setSource(found);
        // A well-formed id that is not among the user's sources reads as the
        // uniform not-found (deleted, or never theirs) — never an error card.
        setNotFound(found === null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load this audio set.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [sourceId, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Poll while any of THIS source's tracks is unsettled — the listing's poll
  // contract (STOP CONDITIONS: settle / unmount / attempt ceiling), plus the
  // track detail's terminal-not-found: a source gone mid-poll stops NOW and
  // shows not-found rather than hammering a list that no longer holds it.
  const unsettled =
    source !== null &&
    source.tracks.some((t) => isUnsettled(t.transcriptStatus));
  const pollTickCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!unsettled || error !== null || notFound) return;
    let ticks = 0; // effect-local — every (re)start gets a fresh budget
    const id = window.setInterval(() => {
      ticks += 1;
      if (ticks > MY_AUDIO_POLL_MAX_TICKS) {
        window.clearInterval(id);
        return;
      }
      pollTickCtrlRef.current?.abort();
      const ctrl = new AbortController();
      pollTickCtrlRef.current = ctrl;
      listMyAudio(ctrl.signal)
        .then((rows) => {
          if (ctrl.signal.aborted) return;
          const found = rows.find((s) => s.id === sourceId) ?? null;
          if (found === null) {
            // Source gone mid-poll — terminal (mirror the track detail).
            window.clearInterval(id);
            setNotFound(true);
            return;
          }
          setSource(found);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          // Transient poll failure — keep the list on screen, next tick
          // retries; a background refresh never replaces it with an error.
        });
    }, MY_AUDIO_POLL_MS);
    return () => {
      window.clearInterval(id);
      pollTickCtrlRef.current?.abort();
      pollTickCtrlRef.current = null;
    };
  }, [unsettled, sourceId, error, notFound]);

  // F-162: same scroll restore as the listings, keyed per-source so
  // different sets don't cross-bleed positions.
  const scrollRootRef = useListScrollRestore(
    `${LISTEN_SCROLL_KEY.mine}:src:${String(sourceId)}`,
    !loading,
  );

  // Defensive ordinal sort (the page's list stance — the server already
  // orders tracks by track_number).
  const orderedTracks = useMemo(
    () =>
      source !== null
        ? [...source.tracks].sort((a, b) => a.trackNumber - b.trackNumber)
        : [],
    [source],
  );

  if (loading) return <SkeletonCard />;
  if (notFound) {
    return (
      <p
        className="km-reference__empty km-giwa km-hangul-watermark"
        data-glyph="오디오"
      >
        <Bilingual
          en="That audio set couldn't be found."
          kr="해당 오디오 모음을 찾을 수 없어요."
        />
      </p>
    );
  }
  if (error !== null || source === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load this audio set.'}
        onRetry={refetch}
      />
    );
  }

  return (
    <div ref={scrollRootRef}>
      <Eyebrow>
        <Bilingual en="My Audio" kr="내 오디오" />
      </Eyebrow>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {source.title}
      </h2>
      {orderedTracks.length === 0 ? (
        <p
          className="km-reference__empty km-giwa km-hangul-watermark"
          data-glyph="오디오"
        >
          <Bilingual
            en="This set has no tracks yet."
            kr="이 모음에는 아직 트랙이 없어요."
          />
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ol
            aria-label={`Tracks in ${source.title}`}
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {orderedTracks.map((track) => {
              const status = TRANSCRIPT_STATUS_META[track.transcriptStatus];
              const label =
                track.title ?? `Track ${String(track.trackNumber)}`;
              return (
                <li
                  key={`track:${String(track.id)}`}
                  className="km-reference__row"
                >
                  <button
                    type="button"
                    className="km-resources__list-open focusring"
                    onClick={() => {
                      // Carry the source so the track detail's "back" returns
                      // here, not to the flat listing.
                      void navigate(myAudioTrackPath(track.id, source.id));
                    }}
                    // Status folded into the label (the SF-2 fold-in idiom).
                    aria-label={`Open track ${String(track.trackNumber)}: ${label} (${status.en})`}
                  >
                    <span
                      className="km-resources__pager-count"
                      style={{ minWidth: '2.25em' }}
                    >
                      {String(track.trackNumber)}
                    </span>
                    <span className="kr km-reference__row-kr">{label}</span>
                    <Pill tone={status.tone}>
                      <Bilingual en={status.en} kr={status.kr} compact />
                    </Pill>
                  </button>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}

/**
 * One uploaded track: the real `<audio controls>` player (mirrors the
 * corpus DetailView's persistent-player recipe, `buildAudioSrc`-resolved
 * src, `onError` → visible alert) above the transcript. A track is PLAYABLE
 * in every transcript state — `streamUrl` serves bytes whether or not
 * Whisper has settled — so the player renders unconditionally while the
 * transcript panel below branches on `transcriptStatus` (transcribing /
 * failed / done). Polls `GET /audio/tracks/:id` while unsettled, with the
 * same stop/cleanup contract as the listing's poll.
 */
function MyAudioDetail({ trackId }: { trackId: number }): JSX.Element {
  const [data, setData] = useState<AudioTrackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // Runtime playback failure (the F-160 device) — distinct from a fetch
  // error: the element stays mounted, an alert renders alongside it.
  const [audioError, setAudioError] = useState(false);
  const onAudioError = useCallback((): void => {
    setAudioError(true);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // as every other kickoff setState on this page.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    setNotFound(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    getAudioTrack(trackId, ctrl.signal)
      .then((detail) => {
        if (ctrl.signal.aborted) return;
        setData(detail);
        setLoading(false);
        // A fresh load (or Retry) gives the player a fresh chance.
        setAudioError(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        if (err instanceof ApiError && err.status === 404) {
          // UNIFORM not-found: the server never distinguishes "deleted"
          // from "not yours", and neither does this copy.
          setNotFound(true);
          setLoading(false);
          return;
        }
        setError(errorMessageFor(err, 'Could not load this audio.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [trackId, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Poll while this track's transcription is unsettled — same posture,
  // per-tick abort-before-fetch, and STOP CONDITIONS as the listing's poll
  // (see its SF-3 header comment): settle / unmount / attempt ceiling, PLUS
  // one of its own — a mid-poll 404 (the track vanished server-side:
  // deleted, or no longer this user's) is TERMINAL, not transient, so it
  // stops the poll immediately and surfaces the uniform not-found state
  // rather than hammering a route that can only 404 again. The `error` and
  // `notFound` gates mirror the listing's `error` gate (never poll behind
  // an error or not-found surface).
  const unsettled = data !== null && isUnsettled(data.track.transcriptStatus);
  const pollTickCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!unsettled || error !== null || notFound) return;
    let ticks = 0; // effect-local — every (re)start gets a fresh budget
    const id = window.setInterval(() => {
      ticks += 1;
      if (ticks > MY_AUDIO_POLL_MAX_TICKS) {
        // Ceiling: a never-settling job — stop churning; the last known
        // status stays on screen and a revisit restarts the budget.
        window.clearInterval(id);
        return;
      }
      pollTickCtrlRef.current?.abort();
      const ctrl = new AbortController();
      pollTickCtrlRef.current = ctrl;
      getAudioTrack(trackId, ctrl.signal)
        .then((detail) => {
          if (ctrl.signal.aborted) return;
          setData(detail);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          if (err instanceof ApiError && err.status === 404) {
            // Track gone mid-poll — terminal: stop NOW (don't wait for the
            // effect teardown) and show the uniform not-found state.
            window.clearInterval(id);
            setNotFound(true);
            return;
          }
          // Transient poll failure — next tick retries; never tear down the
          // visible detail over a background refresh.
        });
    }, MY_AUDIO_POLL_MS);
    return () => {
      window.clearInterval(id);
      pollTickCtrlRef.current?.abort();
      pollTickCtrlRef.current = null;
    };
  }, [unsettled, trackId, error, notFound]);

  // Defensive ordinal sort (the page's transcript-panel stance — the server
  // already orders by segment_number).
  const orderedSegments = useMemo(
    () =>
      data !== null
        ? [...data.segments].sort((a, b) => a.segmentNumber - b.segmentNumber)
        : [],
    [data],
  );

  if (loading) return <SkeletonCard />;
  if (notFound) {
    return (
      <p
        className="km-reference__empty km-giwa km-hangul-watermark"
        data-glyph="오디오"
      >
        <Bilingual
          en="That audio couldn't be found."
          kr="해당 오디오를 찾을 수 없어요."
        />
      </p>
    );
  }
  if (error !== null || data === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load this audio.'}
        onRetry={refetch}
      />
    );
  }

  const status = TRANSCRIPT_STATUS_META[data.track.transcriptStatus];
  // The strict allow-list resolver — the ONLY path to the <audio> src. A
  // tampered streamUrl resolves to null and the player simply doesn't render.
  const audioSrc = buildAudioSrc(data.track.streamUrl);
  const title = data.track.title ?? 'My audio';

  return (
    <div>
      <Eyebrow>
        <Bilingual en="My Audio" kr="내 오디오" />
      </Eyebrow>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {title}
      </h2>
      <p style={{ margin: '0 0 12px' }}>
        <Pill tone={status.tone}>
          <Bilingual en={status.en} kr={status.kr} compact />
        </Pill>
      </p>

      {/* Same blue-signboard player card as the corpus DetailView. */}
      <CityCard tone="blue" className="km-ttmik__player">
        {audioSrc !== null ? (
          <>
            {/* Real streaming player (HTTP Range server-side, so seeking
                works). No timed caption track exists for user uploads; the
                transcript renders directly below — same a11y exemption as
                the corpus player. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio
              controls
              preload="metadata"
              src={audioSrc}
              aria-label={`Audio for ${title}`}
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
          // Defensive only: streamUrl is always present and allow-listed —
          // reachable solely if a tampered value was rejected upstream.
          <p className="km-reference__empty" role="note">
            <Bilingual
              en="No audio yet — check back soon."
              kr="아직 오디오가 없어요 — 잠시 후 다시 확인해 주세요."
            />
          </p>
        )}
      </CityCard>

      {data.track.transcriptStatus === 'done' ? (
        <CityCard
          tone="accent"
          rail
          className={cn(
            'km-ttmik__reader-card',
            orderedSegments.length === 0 && 'km-giwa km-hangul-watermark',
          )}
          {...(orderedSegments.length === 0 ? { 'data-glyph': '대본' } : {})}
        >
          <ol
            aria-label="Transcript"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {orderedSegments.map((seg) => (
              <li
                key={seg.segmentNumber}
                className="km-reference__row"
                style={{ padding: '8px 0' }}
              >
                {/* Whisper output rendered through React text children
                    (escaped) — same contract as every transcript above. */}
                <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
                  {seg.body}
                </p>
              </li>
            ))}
          </ol>
          {orderedSegments.length === 0 ? (
            <p className="km-reference__empty">
              <Bilingual en="No transcript yet." kr="아직 대본이 없어요." />
            </p>
          ) : null}
        </CityCard>
      ) : data.track.transcriptStatus === 'failed' ? (
        <CityCard tone="accent" rail className="km-ttmik__reader-card">
          {/* A settled failure — fixed copy, never the job's server-side
              error prose (which this client deliberately never receives). */}
          <p className="km-reference__empty" role="note">
            <Bilingual
              en="Transcription failed for this audio. You can still listen above."
              kr="이 오디오의 대본 만들기에 실패했어요. 위에서 듣기는 가능해요."
            />
          </p>
        </CityCard>
      ) : (
        <CityCard tone="accent" rail className="km-ttmik__reader-card">
          {/* pending/running — the poll above will land the transcript the
              moment the worker settles it. role=status so AT hears the
              eventual flip via the re-render, not an unlabeled swap. */}
          <p className="km-reference__empty" role="status">
            <Bilingual
              en="Transcribing… the transcript will appear here when it's ready."
              kr="대본을 만드는 중이에요… 준비되면 여기에 나타나요."
            />
          </p>
        </CityCard>
      )}
    </div>
  );
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
