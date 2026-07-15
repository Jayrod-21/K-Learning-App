/**
 * Today screen — the daily ACTION hub. Wave-2 "Seoul Day & Night" reskin
 * (F-128) + per-page feature set (F-129–F-140; see BUGS_AND_FEATURES.md),
 * restructured into THREE carousels per direct user feedback on the live
 * site (mobile-hardening pass):
 *
 *   1. **Core drills carousel** ("Review & drills") — Grammar · Vocab ·
 *      Hanja, in that DOM order (F-190 put Vocab in the MIDDLE slot — see
 *      `useCenterOnMountRef` below — so the peek slider opens centered on
 *      it, not on Grammar). F-139 had removed the vocab/"words" due-count
 *      tile entirely on the theory that the Review tab (bottom nav) was
 *      its home — that was wrong: it deleted a first-class daily-action
 *      entry point users actually wanted here. RESTORED, exactly at its
 *      pre-F-139 fidelity (live "N cards due" from the plan's real
 *      `reviewCount`, → `/learn/vocab`), alongside Grammar (→
 *      `/learn/grammar`) and Hanja (→ `/learn/hanja`, F-140). Originally a
 *      `SwipeCarousel` (hard one-page-at-a-time snap, F-017/F-029); per a
 *      direct user request on the mobile-hardening pass ("make carousel 1
 *      match carousel 2's feel"), converted to the SAME native-scroll-snap
 *      PEEK SLIDER as #2 below — the identical `.km-today__peek{Outer,
 *      Track,Item}` classes, same 78%/center-snap/peek geometry, same
 *      center-pop + reduced-motion gating, same native-touch scroll (no
 *      loop concept anymore — a continuous scroll rail has no "wrap").
 *      Only the Vocab tile's content swaps between skeleton/real/error (it
 *      alone depends on `today`); Grammar and Hanja are always the same
 *      static tile regardless of the plan's fate. F-189 gives each tile its
 *      own canonical skill color via `CityCard`'s `tone` prop — Vocab=blue
 *      (indigo), Grammar=crimson (fixed, F-189 fix-pass round 4 — see
 *      `lib/skill-colors.ts`), Hanja=ochre (locked) — the SAME
 *      `SKILL_COLOR` map the LEARN honeycomb (`LearnMenu.tsx`) keys its
 *      hexagons off, so a skill reads as one color everywhere, not just
 *      here.
 *   2. **Suggested learning carousel** — Listening · Reading · Writing, in
 *      that DOM order (F-190 put Reading in the MIDDLE slot so the peek
 *      slider opens centered on it, not on Listening), as a horizontal PEEK
 *      SLIDER (the user's own description: "3 tiles side by side, slide
 *      carousel, doesn't switch to a new tile but can see the previous
 *      tile, like a spin table"). This was a genuinely
 *      different interaction model from `SwipeCarousel`'s hard
 *      one-page-at-a-time snap, so it was built as native CSS scroll-snap
 *      (`overflow-x: auto` + `scroll-snap-type: x mandatory`, tiles at
 *      `flex: 0 0 78%` with `scroll-snap-align: center` and peek padding on
 *      the track) so the browser owns the drag/fling/momentum entirely on
 *      touch — no JS gesture code to get wrong. Carousel 1 above now
 *      shares this exact mechanism (same classes) rather than duplicating
 *      it, so the two carousels feel identical to the user. See Today.css
 *      for the full rationale and the progressive-enhancement
 *      center-emphasis animation.
 *      F-134's Writing inline-expand (`CollapsibleTile` + embedded
 *      `WritingTopicGenerator`) does NOT fit this model: a tile that grows
 *      on tap would blow out its neighbors' fixed scroll-snap widths and
 *      fight the centered-peek layout mid-scroll. Per this restructure's
 *      brief, the user's new carousel shape wins — Writing is now a plain
 *      peek tile that NAVIGATES to `/learn/writing` (same as
 *      Reading/Listening), where the exact same F-027
 *      `WritingTopicGenerator` already lives (`Writing.tsx` mounts its own
 *      copy and accepts the identical `location.state.generatedTopic`
 *      handoff) — the generator is preserved, one tap away instead of
 *      inline on Today. Reading's daily rotation stays real and
 *      server-side (`server/src/routes/plan.ts` orders the pick by
 *      `md5(user || date || row_id)` — this screen only renders whatever
 *      `/plan/today` sends, which already changes day to day). Wave 2
 *      (backend batch) re-sourced that pick from the caller's own
 *      `reading_chapters`/`generated_stories` (replacing the old public
 *      TTMIK-lesson pick, which had no relationship to `/learn/reading`'s
 *      actual content) and all three of Reading/Listening/Writing now carry
 *      the ids/keys (`chapterId`/`storyId`, `episodeNumber`, `promptId`)
 *      needed to deep-link to the EXACT item shown, instead of each tile's
 *      bare landing page (`readingHref`/`listeningHref`/`writingHref`
 *      below). F-189: Reading=cyan, Listening=mint (moss), Writing=violet —
 *      the same canonical `SKILL_COLOR` tokens LearnMenu's honeycomb
 *      hexagons use, wired through `CityCard`'s `tone` prop the identical
 *      way Carousel 1 is.
 *   3. **TOPIK carousel** — last, its own `SwipeCarousel` (a single page —
 *      dots/drag naturally no-op below 2 children). Carries the
 *      "Review mistakes" shortcut folded in (not its own page) and NO
 *      highlight styling on its meta line (F-137 — plain text, never a
 *      glowing bar). A saved F-007 attempt surfaces as this carousel's
 *      corner resume banner (it resumes straight back into
 *      `/learn/topik?mode=mock` — the `mode=mock` param skips `Topik.tsx`'s
 *      Study/Mock chooser sheet, which otherwise gates every mode-less
 *      visit, so one tap goes straight back into the in-progress exam
 *      rather than stopping at the chooser first — so this is its natural
 *      home now that it's split from Reading/Listening/Writing).
 *      `SwipeCarousel` is now used ONLY here — a
 *      single hard-paged tile with a corner-slot banner is still the right
 *      tool for that shape; it is not a continuous-scroll rail like #1/#2.
 *      TOPIK's tile reads `SKILL_COLOR.topik.tone` (`stone` — a dedicated
 *      "assessment" hue, F-189 fix-pass round 4, REVIEW_r4-colors.md
 *      BLOCKER-2): it used to share the accent/vermilion family with
 *      Grammar, which fused the two tiles into one shape in LearnMenu's
 *      honeycomb and could 3-way-collide with another skill's fixed hue
 *      under the blue/mint accent presets — see `lib/skill-colors.ts`.
 *
 * Everything real stays real: per-tile "done today" counts come from
 * actual attempt-history endpoints, never a fabricated target or a
 * landing-page-visit counter. `SubwayProgress` (device #5) rides the TOPIK
 * tile once a saved in-progress exam exists (F-173): `GET /topik/attempt`
 * now resolves a real `AttemptState.totalItems` (the exam's served item
 * count, server-computed) alongside the pre-existing `answered`, so the
 * resumed attempt's real position/total is known client-side — no
 * denominator is fabricated. `totalItems` falls back to `answered` itself
 * (a real lower bound, never a guess above what's known) on the rare case
 * the backing corpus paper can't be re-resolved server-side, or on a
 * pre-F-173 fixture that predates the field.
 *
 * Layout, top to bottom:
 *   1. Shared `PageHubHeader` (F-177) — `SkylineHeader` carrying the real h1
 *      in its `title` slot (date eyebrow + 오늘 · Today, overlaid on the
 *      skyline) + a `DancheongRail` divider underneath. This screen used to
 *      carry its own byte-for-byte inline copy of that recipe (predating the
 *      shared component, C-2/C-3 fix, `REVIEW_batch1-fidelity.md`); it now
 *      renders the same `components/PageHubHeader.tsx` every Library page +
 *      Progress already adopted, so the recipe lives in exactly one place.
 *      F-188: this page hides PageHubHeader's own rail-divider glyph (a
 *      Today-scoped Today.css override, not a change to the shared
 *      component) — see Today.css for why.
 *   2. Core drills carousel (Grammar / Vocab / Hanja — Vocab centered, F-190).
 *   3. Suggested learning peek slider (Listening / Reading / Writing —
 *      Reading centered, F-190).
 *   4. TOPIK carousel (F-187: its heading carries a tightened top margin —
 *      see Today.css).
 *
 * Data:
 *   useEndpointOrMock('today', loadTodayMock, { realFn: fetchToday })
 *   useEndpointOrMock('today.attempt', loadOpenAttemptMock, { realFn: fetchAttempt })
 *   useEndpointOrMock('today.grammarAttempts', …, { realFn: listAttempts })
 *   useEndpointOrMock('today.writingAttempts', …, { realFn: fetchWritingAttempts })
 *   useEndpointOrMock('today.topikAttempts', …, { realFn: fetchAttemptHistory })
 *   useEndpointOrMock('today.hanjaAttempts', …, { realFn: fetchHanjaAttempts })
 *   useEndpointOrMock('today.readingAttempts', …, { realFn: listReadingAttempts })
 *   useEndpointOrMock('today.listeningAttempts', …, { realFn: listListeningAttempts })
 *
 * SIX attempt-history fetches back F-138's per-tile "done today" counts
 * (grammar/writing/TOPIK, and — Wave 2 backend batch — Hanja/Reading/
 * Listening, once F-171/F-172 added `GET /hanja/attempts`,
 * `GET /reading/attempts`, `GET /ttmik/attempts`) — filtered client-side to
 * the viewer's local calendar day (`isLocalToday`), since these are the
 * caller's own history, newest first, and carry no "today only" server
 * filter. Vocab still has no attempt-history endpoint (`services/vocab`
 * exposes a live due-count, not a "reviewed today" tally) — that tile shows
 * its existing server-supplied due-count with no daily-count claim, the
 * honest choice over fabricating one.
 *
 * A plan failure (never loading, never mock-fallback data) degrades the
 * Vocab tile (Carousel 1) and the whole Suggested-learning peek slider
 * (Carousel 2) to an honest `ErrorCard` with retry — Grammar/Hanja (no
 * plan dependency) and TOPIK (no plan dependency) keep working regardless.
 *
 * Threat model:
 *   Fixture/server text rendered as React children → escaped by React. Pass
 *   3+ wire must keep this contract (text fields, not HTML strings). All six
 *   attempt-history fetches are read-only GETs behind the same auth+session
 *   posture as every other service in this app (see services/grammarDrill.ts,
 *   services/writing.ts, services/topik.ts, services/hanja.ts,
 *   services/reading.ts, services/ttmik.ts) — this screen adds no new
 *   endpoint, just more consumers of ones that already exist for their own
 *   history screens. The restored Vocab tile adds no new endpoint either —
 *   it reads `reviewCount` off the plan the screen already fetches. The
 *   Reading/Listening/Writing deep-link navigations (Wave 2) build a URL
 *   from server-returned integer ids/enums (`chapterId`/`storyId`/
 *   `episodeNumber`/`promptId`/`corpus`), never free text — no injection
 *   surface in the constructed path/query string.
 */
import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { JSX, ReactNode } from 'react';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { SwipeCarousel } from '../components/SwipeCarousel';
import { PageHubHeader } from '../components/PageHubHeader';
import { CityCard, type CityCardTone } from '../components/CityCard';
import { SealStamp } from '../components/SealStamp';
import { SubwayProgress } from '../components/SubwayProgress';
import { useChatContext } from '../hooks/useChatContext';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadTodayMock } from '../data/mocks/today';
import { mockDelay } from '../data/mocks/_delay';
import { fetchToday } from '../services/plan';
import { fetchAttempt, fetchAttemptHistory } from '../services/topik';
import type { AttemptHistoryResult, AttemptState } from '../services/topik';
import { fetchWritingAttempts } from '../services/writing';
import { listAttempts as listGrammarAttempts } from '../services/grammarDrill';
import { fetchHanjaAttempts } from '../services/hanja';
import { listReadingAttempts } from '../services/reading';
import type { ReadingAttemptsPage } from '../services/reading';
import { listListeningAttempts } from '../services/ttmik';
import type { ListeningAttemptsPage } from '../services/ttmik';
import type { DrillAttemptsPage, TodayPlan, TodayTask } from '../types/domain';
import { cn } from '../lib/cn';
import { isLocalToday } from '../lib/localDay';
import { SKILL_COLOR } from '../lib/skill-colors';
import './Today.css';

/**
 * One-line "what Today is showing" for the chat-context store (Slice 3) —
 * the FAB's "Discuss the page you were on?" popup renders this. Mirrors the
 * visible tiles: the live due-review count (Vocab, restored) plus whichever
 * task tiles resolved.
 */
function chatSummaryForPlan(plan: TodayPlan): string {
  const parts: string[] = [
    `${String(plan.reviewCount)} review ${plan.reviewCount === 1 ? 'card' : 'cards'} due`,
  ];
  if (plan.reading) parts.push(`Reading: ${plan.reading.title}`);
  if (plan.listening) parts.push(`Listening: ${plan.listening.title}`);
  if (plan.writing) parts.push(`Writing: ${plan.writing.title}`);
  return parts.join(' · ');
}

/** Format the current date in the design's eyebrow style ("Monday, May 28" /
 *  "5월 28일 월요일") — one formatter, locale-keyed, so the en/kr pair the
 *  bilingual eyebrow renders can never drift apart. */
function formatDateEyebrow(d: Date, locale: 'en-US' | 'ko-KR'): string {
  return d.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Tone for a suggested-learning task's flag pill. The largest-gap modality
 * is flagged gold; Writing keeps its standing "register drill" identity
 * when it is NOT the gap; everything else carries no flag.
 */
function tileTone(
  tag: TodayTask['tag'],
  gap: TodayTask['tag'],
): 'default' | 'gold' | 'red' {
  if (tag === gap) return 'gold';
  if (tag === 'Writing') return 'red';
  return 'default';
}

/** Pill copy for a suggested-learning task — see `tileTone`'s doc for the
 *  precedence rule (gap beats Writing's default). */
function tileTag(
  tag: TodayTask['tag'],
  gap: TodayTask['tag'],
): string | undefined {
  if (tag === gap) return 'Largest gap';
  if (tag === 'Writing') return 'Register drill';
  return undefined;
}

/** Render a task's optional flag `Pill`, or nothing when it carries none. */
function renderTag(tag: TodayTask['tag'], gap: TodayTask['tag']): ReactNode {
  const tone = tileTone(tag, gap);
  const label = tileTag(tag, gap);
  if (label === undefined) return null;
  return <Pill tone={tone === 'gold' ? 'gold' : 'red'}>{label}</Pill>;
}

// ─────────────────────────────────────────────────────────────
// Wave 2 (backend batch, TODAY_NAV_SCOPING.md B4/B5/B6) — deep-link targets
// for the Suggested-learning tiles, built from server-returned integer
// ids/enums (never free text — no injection surface). Each falls back to the
// existing bare landing-page path when the plan payload lacks the relevant
// field (an older cached fixture, or a genuinely missing id) — never
// fabricates one.
// ─────────────────────────────────────────────────────────────

/** Reading tile target: the exact chapter (`?chapter=<id>`) or generated
 *  story (`?story=<id>`) the tile displays (B4 Option 2 — reading is now
 *  sourced from the caller's own reading_chapters/generated_stories, not the
 *  old public TTMIK-lesson pick). */
function readingHref(t: TodayTask): string {
  if (t.sourceKind === 'story' && t.storyId !== undefined) {
    return `/learn/reading?story=${String(t.storyId)}`;
  }
  if (t.sourceKind === 'chapter' && t.chapterId !== undefined) {
    return `/learn/reading?chapter=${String(t.chapterId)}`;
  }
  return '/learn/reading';
}

/** Listening tile target: the exact Iyagi episode (B5). */
function listeningHref(t: TodayTask): string {
  if (t.corpus !== undefined && t.episodeNumber !== undefined) {
    return `/learn/listen?corpus=${t.corpus}&episode=${String(t.episodeNumber)}`;
  }
  return '/learn/listen';
}

/** Writing tile target: the exact bank prompt, by id (B6) — the target page
 *  requests this prompt instead of drawing a fresh random one. */
function writingHref(t: TodayTask): string {
  return t.promptId !== undefined
    ? `/learn/writing?promptId=${String(t.promptId)}`
    : '/learn/writing';
}

// ─────────────────────────────────────────────────────────────
// Open-exam lookup (F-007 attempt surfaced on the action hub)
// ─────────────────────────────────────────────────────────────

/**
 * Mock fallback for the open-exam lookup — resolves "no exam in progress".
 * Deliberately null: fabricating a resumable attempt would paint a resume
 * banner for an exam that doesn't exist. Module scope per the
 * useEndpointOrMock contract.
 */
async function loadOpenAttemptMock(): Promise<AttemptState | null> {
  await mockDelay();
  return null;
}

/** Bilingual section labels for the saved mock attempt's exam section. */
const SECTION_LABELS: Record<AttemptState['section'], { label: string; kr: string }> = {
  reading: { label: 'Reading', kr: '읽기' },
  listening: { label: 'Listening', kr: '듣기' },
};

// ─────────────────────────────────────────────────────────────
// F-138 — real "done today" signals for the attempt-backed tiles.
// Honest empty defaults (no fabricated activity) for the mock fallback,
// mirroring `loadOpenAttemptMock`'s convention.
// ─────────────────────────────────────────────────────────────

// S2 — the real fetches below request `limit: 100`, the server's own
// validated ceiling for these three routes (`z.coerce.number().max(100)` in
// `server/src/routes/{grammarDrill,writing,topik}.ts`) — comfortably above
// any realistic single-day count of graded drills/essays/mock attempts, so
// the "done today" filter below never silently under-counts a genuinely
// active day the way the old `limit: 20` could. These mock fixtures just
// echo that same bound back (matching what the real endpoint would echo),
// not a claim about how many attempts actually exist.
async function loadGrammarAttemptsMock(): Promise<DrillAttemptsPage> {
  await mockDelay();
  return { attempts: [], total: 0, limit: 100, offset: 0 };
}

async function loadWritingAttemptsMock(): Promise<
  Awaited<ReturnType<typeof fetchWritingAttempts>>
> {
  await mockDelay();
  return { attempts: [], limit: 100, offset: 0 };
}

async function loadTopikAttemptsMock(): Promise<AttemptHistoryResult> {
  await mockDelay();
  return { attempts: [], total: 0 };
}

// Wave 2 (backend batch, F-171/F-172) — same `limit: 100` posture as the
// three fetches above, now that Hanja/Reading/Listening carry their own
// attempt-history routes too.
async function loadHanjaAttemptsMock(): Promise<
  Awaited<ReturnType<typeof fetchHanjaAttempts>>
> {
  await mockDelay();
  return { attempts: [], total: 0, limit: 100, offset: 0 };
}

async function loadReadingAttemptsMock(): Promise<ReadingAttemptsPage> {
  await mockDelay();
  return { attempts: [], total: 0, limit: 100, offset: 0 };
}

async function loadListeningAttemptsMock(): Promise<ListeningAttemptsPage> {
  await mockDelay();
  return { attempts: [], total: 0, limit: 100, offset: 0 };
}

// ─────────────────────────────────────────────────────────────
// ActivityTile — the CityCard-based tile every carousel/tile on this page
// (Vocab, Grammar, Hanja, Reading, Listening, Writing, TOPIK) renders
// (F-128 device #1/#2). A real `<button>` owns all interaction/a11y;
// `CityCard` is purely the visual surface nested inside it (a
// non-interactive decorative wrapper is valid inside a button — it
// contributes no semantics of its own).
// ─────────────────────────────────────────────────────────────

function ActivityTile({
  tone,
  feat = false,
  icon,
  pill,
  headline,
  meta,
  extra,
  ariaLabel,
  onClick,
}: {
  tone: CityCardTone;
  feat?: boolean;
  icon: IconName;
  pill?: ReactNode;
  headline: ReactNode;
  meta?: ReactNode;
  /** Extra content below the meta line (e.g. a "done today" row). */
  extra?: ReactNode;
  ariaLabel?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="km-today__tileBtn focusring"
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <CityCard tone={tone} rail feat={feat} className="km-today__tileCard">
        <span className="km-today__tileTop">
          <span className="km-today__tileIcon" aria-hidden="true">
            <Icon name={icon} size={20} />
          </span>
          <span className="km-today__tileBody">
            {pill}
            <span className="km-today__tileHeadline">{headline}</span>
            {meta !== undefined ? (
              <span className="km-today__tileMeta">{meta}</span>
            ) : null}
          </span>
          <Icon name="arrow-right" size={18} />
        </span>
        {extra}
      </CityCard>
    </button>
  );
}

/** A real, honest "practiced today" milestone (F-128 device #7) — rendered
 *  ONLY when `count` is a positive REAL number from an attempt-history
 *  fetch, never for a fabricated or unknown count. */
function DoneTodayRow({
  count,
  tone,
  labelEn,
  labelKr,
}: {
  count: number | null;
  tone: CityCardTone;
  labelEn: (n: number) => string;
  labelKr: (n: number) => string;
}): JSX.Element | null {
  if (count === null) return null;
  return (
    <span className="km-today__tileProgress">
      <span className="km-today__tileMeta">
        <Bilingual en={labelEn(count)} kr={labelKr(count)} />
      </span>
      {count > 0 ? (
        <SealStamp
          milestone
          tone={tone}
          size="sm"
          label={<Bilingual en="Done today" kr="오늘 완료" compact />}
        />
      ) : null}
    </span>
  );
}

/** Render a quick skeleton-shaped card while data loads. */
function SkeletonCard(): JSX.Element {
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: 100, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

/** The honest "plan unavailable" ErrorCard, wrapped in the same
 *  hanji-textured error surface every failure state on this page uses. */
function PlanErrorCard({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="km-today__errorWrap km-giwa">
      <ErrorCard message="Today's plan is unavailable." onRetry={onRetry} />
    </div>
  );
}

/**
 * F-190 — centers a specific peek-slider tile the moment it mounts, instead
 * of leaving the browser's default scrollLeft:0 (which centers whichever
 * tile happens to be FIRST in DOM order — see `.km-today__peekTrack`'s
 * symmetric 11%-peek padding in Today.css, which is exactly what makes
 * position 0 read as "centered" for a first tile). Both peek sliders are
 * reordered (Carousel 1: Grammar/Vocab/Hanja; Carousel 2: Listening/Reading/
 * Writing) so the desired skill sits in the middle DOM slot, and this ref
 * callback is attached to THAT tile's wrapper to actually land the initial
 * scroll position on it.
 *
 * A ref CALLBACK (not a `useEffect`) is the right tool here: Carousel 2's
 * whole peek slider (and therefore the Reading wrapper) only mounts once
 * `today.data` resolves and at least one task is present — a callback fires
 * whenever React actually attaches that DOM node, on whatever render pass
 * that turns out to be, with no dependency-array bookkeeping or "is it
 * ready yet" flag to keep in sync. The REAL reason later re-renders
 * (attempt-history fetches resolving, etc.) never re-invoke this and yank
 * the view back to center is that `useCallback(..., [])` gives React a
 * stable callback identity — a ref callback whose identity is unchanged
 * only re-fires if its host DOM node is unmounted/remounted, so an
 * unrelated re-render is a no-op here regardless of `firedRef`.
 * `firedRef` is a defense-in-depth belt only, guarding the case where the
 * SAME callback instance somehow runs twice for one mounted node (React
 * does not do this today, but nothing enforces that it never will) — it is
 * NOT what makes ordinary re-renders safe. Fix-pass note
 * (REVIEW_r4-today.md): keep this distinction explicit, because a future
 * "simplification" that removed `firedRef` believing it was merely
 * redundant with the guarantee described here would be safe TODAY but
 * would silently stop being safe the moment anyone gives this callback a
 * non-empty dependency array.
 *
 * `scrollIntoView({ inline: 'center' })` (not hand-rolled pixel math) is the
 * browser's own primitive for this, and it honours `scroll-snap-align:
 * center` (the peek track's own CSS) instead of a client reimplementation
 * that would have to duplicate that snap math. `behavior` is intentionally
 * left at its default (an immediate jump, not a `'smooth'` animation) — an
 * animated slide the instant the page appears would read as an unrequested
 * swipe, not a landing position.
 */
function useCenterOnMountRef(): (el: HTMLDivElement | null) => void {
  const firedRef = useRef(false);
  return useCallback((el: HTMLDivElement | null) => {
    if (el === null || firedRef.current) return;
    firedRef.current = true;
    el.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, []);
}

export function Today(): JSX.Element {
  const navigate = useNavigate();
  // F-190 — Review & drills opens centered on Vocab; Suggested learning
  // opens centered on Reading (both reordered into the middle DOM slot
  // below). See `useCenterOnMountRef`'s doc comment for the mechanism.
  const vocabCenterRef = useCenterOnMountRef();
  const readingCenterRef = useCenterOnMountRef();

  const today = useEndpointOrMock<TodayPlan>('today', loadTodayMock, {
    realFn: () => fetchToday(),
  });
  const attempt = useEndpointOrMock<AttemptState | null>(
    'today.attempt',
    loadOpenAttemptMock,
    { realFn: () => fetchAttempt() },
  );
  // F-138: real per-tile "done today" signals. Independent fetches — a
  // failure/mock-fallback on one never blocks the others or the plan.
  // S2: `limit: 100` is the server's own validated ceiling for all three
  // routes (see the mock-loader comment above) — well above any realistic
  // single-day count, so the client-side "done today" filter below can't
  // silently under-count an active day the way the previous `limit: 20`
  // could for a power user.
  const grammarAttempts = useEndpointOrMock<DrillAttemptsPage>(
    'today.grammarAttempts',
    loadGrammarAttemptsMock,
    { realFn: () => listGrammarAttempts({ limit: 100 }) },
  );
  const writingAttempts = useEndpointOrMock<
    Awaited<ReturnType<typeof fetchWritingAttempts>>
  >('today.writingAttempts', loadWritingAttemptsMock, {
    realFn: () => fetchWritingAttempts({ limit: 100 }),
  });
  const topikAttempts = useEndpointOrMock<AttemptHistoryResult>(
    'today.topikAttempts',
    loadTopikAttemptsMock,
    { realFn: () => fetchAttemptHistory({ limit: 100 }) },
  );
  // Wave 2 (backend batch, F-171/F-172) — the same real "done today" signal,
  // now available for Hanja/Reading/Listening too (previously these three
  // tiles had no attempt-history endpoint at all — see the module header).
  const hanjaAttempts = useEndpointOrMock<
    Awaited<ReturnType<typeof fetchHanjaAttempts>>
  >('today.hanjaAttempts', loadHanjaAttemptsMock, {
    realFn: () => fetchHanjaAttempts({ limit: 100 }),
  });
  const readingAttempts = useEndpointOrMock<ReadingAttemptsPage>(
    'today.readingAttempts',
    loadReadingAttemptsMock,
    { realFn: () => listReadingAttempts({ limit: 100 }) },
  );
  const listeningAttempts = useEndpointOrMock<ListeningAttemptsPage>(
    'today.listeningAttempts',
    loadListeningAttemptsMock,
    { realFn: () => listListeningAttempts({ limit: 100 }) },
  );

  useChatContext(
    today.data
      ? {
          pageLabel: 'Today · 오늘',
          summary: chatSummaryForPlan(today.data),
        }
      : null,
  );

  const now = new Date();
  const dateEn = formatDateEyebrow(now, 'en-US');
  const dateKr = formatDateEyebrow(now, 'ko-KR');

  const retryToday = today.refetch;
  const isMock =
    today.isMock || attempt.isMock || grammarAttempts.isMock ||
    writingAttempts.isMock || topikAttempts.isMock ||
    hanjaAttempts.isMock || readingAttempts.isMock || listeningAttempts.isMock;

  // `null` while loading/errored (unknown — never presented as a confirmed
  // zero); a real non-negative count once the fetch resolves.
  const grammarDoneToday =
    grammarAttempts.data && !grammarAttempts.loading
      ? grammarAttempts.data.attempts.filter((a) => isLocalToday(a.scored_at, now)).length
      : null;
  const writingDoneToday =
    writingAttempts.data && !writingAttempts.loading
      ? writingAttempts.data.attempts.filter((a) => isLocalToday(a.gradedAt, now)).length
      : null;
  const hanjaDoneToday =
    hanjaAttempts.data && !hanjaAttempts.loading
      ? hanjaAttempts.data.attempts.filter((a) => isLocalToday(a.createdAt, now)).length
      : null;
  const readingDoneToday =
    readingAttempts.data && !readingAttempts.loading
      ? readingAttempts.data.attempts.filter((a) => isLocalToday(a.completedAt, now)).length
      : null;
  const listeningDoneToday =
    listeningAttempts.data && !listeningAttempts.loading
      ? listeningAttempts.data.attempts.filter((a) => isLocalToday(a.completedAt, now)).length
      : null;
  const topikDoneToday =
    topikAttempts.data && !topikAttempts.loading
      ? topikAttempts.data.attempts.filter((a) => isLocalToday(a.completedAt, now)).length
      : null;

  const gapTag: TodayTask['tag'] = today.data?.largestGap ?? 'Listening';

  const openAttempt = attempt.data ?? null;
  // F-173 — the exam's real served item count. Falls back to `answered`
  // itself (a real lower bound the server already computed) rather than
  // fabricating a total above what's actually known — same posture as the
  // server's own `resolveServedTotal` fallback (topik.ts).
  const resumeTotalItems = openAttempt?.totalItems ?? openAttempt?.answered ?? 0;
  // F-173 fix-pass SHOULD-FIX #1 — `hasRealTotal` distinguishes a REAL
  // server-resolved `totalItems` from the `?? answered` fallback above. The
  // wire contract can't (yet) tell "the exam truly has exactly N items"
  // apart from "we don't know the total, here's a lower bound" once
  // `totalItems` is present (that's a server-side gap, out of scope for this
  // client-only diff — see REVIEW_phaseA-today.md SHOULD-FIX #2) — but when
  // `totalItems` is altogether ABSENT (pre-F-173 fixture data), we know for
  // certain we're in the fallback, and must not render "of N" / a ~100%-full
  // bar next to the "Resume exam" CTA, which would read as "exam complete."
  const hasRealTotal = openAttempt?.totalItems !== undefined;
  const resumeAnsweredEn =
    openAttempt === null
      ? ''
      : hasRealTotal
        ? `${String(openAttempt.answered)} of ${String(resumeTotalItems)} answered`
        : `${String(openAttempt.answered)} answered`;
  const resumeAnsweredKr =
    openAttempt === null
      ? ''
      : hasRealTotal
        ? `${String(resumeTotalItems)}문항 중 ${String(openAttempt.answered)}개 답변함`
        : `${String(openAttempt.answered)}개 답변함`;
  const resumeBanner =
    openAttempt !== null ? (
      <button
        type="button"
        className="km-today__resume focusring"
        aria-label={`Resume exam — ${SECTION_LABELS[openAttempt.section].label} mock, ${resumeAnsweredEn}`}
        onClick={() => {
          // `?mode=mock` skips Topik.tsx's Study/Mock chooser sheet
          // (chooserOpen is seeded from `searchParams.get('mode') === null`)
          // so this one tap lands directly back in MockMode, whose own
          // mount-time fetchAttempt/resumeAttempt then restores the saved
          // in-progress exam. A bare navigate would hit the chooser first.
          navigate('/learn/topik?mode=mock');
        }}
      >
        <Icon name="play" size={12} />
        <Bilingual en="Resume exam" kr="이어서 하기" compact />
      </button>
    ) : undefined;

  // ── Suggested-learning peek-slider items (Listening / Reading / Writing —
  // F-190 reorders Reading into the MIDDLE slot so it's the one the peek
  // slider opens centered on; see `readingCenterRef` below). A null server
  // task is simply omitted — never a faked card (empty-corpus contract,
  // unchanged from before the redesign).
  const peekItems: ReactNode[] = [];

  if (today.data?.listening) {
    const t = today.data.listening;
    peekItems.push(
      <div key="listening" className="km-today__peekItem">
        <ActivityTile
          tone={SKILL_COLOR.ttmik.tone}
          icon="headphones"
          ariaLabel={`Open listening — ${t.title}`}
          pill={renderTag(t.tag, gapTag)}
          headline={<span className="kr">{t.title}</span>}
          meta={
            <Bilingual
              en={`Listening · ${t.level} · ${String(t.mins)} min`}
              kr={`듣기 · ${t.level} · ${String(t.mins)}분`}
            />
          }
          extra={
            <DoneTodayRow
              count={listeningDoneToday}
              tone={SKILL_COLOR.ttmik.tone}
              labelEn={(n) => (n === 1 ? '1 episode finished today' : `${String(n)} episodes finished today`)}
              labelKr={(n) => `오늘 완료한 듣기 ${String(n)}개`}
            />
          }
          onClick={() => {
            // Wave 2 (B5): deep-links to the exact Iyagi episode shown.
            navigate(listeningHref(t));
          }}
        />
      </div>,
    );
  }

  if (today.data?.reading) {
    const t = today.data.reading;
    peekItems.push(
      <div key="reading" className="km-today__peekItem" ref={readingCenterRef}>
        <ActivityTile
          tone={SKILL_COLOR.reading.tone}
          icon="book"
          ariaLabel={`Open reading — ${t.title}`}
          pill={renderTag(t.tag, gapTag)}
          headline={<span className="kr">{t.title}</span>}
          meta={
            <Bilingual
              en={`Reading · ${t.level} · ${String(t.mins)} min`}
              kr={`읽기 · ${t.level} · ${String(t.mins)}분`}
            />
          }
          extra={
            <DoneTodayRow
              count={readingDoneToday}
              tone={SKILL_COLOR.reading.tone}
              labelEn={(n) => (n === 1 ? '1 reading finished today' : `${String(n)} readings finished today`)}
              labelKr={(n) => `오늘 완료한 읽기 ${String(n)}개`}
            />
          }
          onClick={() => {
            // Wave 2 (B4): deep-links to the exact chapter/story shown —
            // reading is now sourced from the caller's own library, not the
            // old public TTMIK-lesson pick.
            navigate(readingHref(t));
          }}
        />
      </div>,
    );
  }

  if (today.data?.writing) {
    const t = today.data.writing;
    peekItems.push(
      <div key="writing" className="km-today__peekItem">
        {/* F-134's inline CollapsibleTile expand does not fit the peek
            slider's fixed-width, center-snap layout (see the module header
            comment) — Writing is a plain ActivityTile that deep-links to
            /learn/writing?promptId=<id> (Wave 2, B6), same shape as
            Reading/Listening. The "done today" count rides in `extra`, same
            convention as Grammar/TOPIK. */}
        <ActivityTile
          tone={SKILL_COLOR.writing.tone}
          icon="pen"
          ariaLabel={`Open writing — ${t.title}`}
          pill={renderTag(t.tag, gapTag)}
          headline={<span className="kr">{t.title}</span>}
          meta={
            <Bilingual
              en={`Writing · ${t.level} · ${String(t.mins)} min`}
              kr={`쓰기 · ${t.level} · ${String(t.mins)}분`}
            />
          }
          extra={
            <DoneTodayRow
              count={writingDoneToday}
              tone={SKILL_COLOR.writing.tone}
              labelEn={(n) => (n === 1 ? '1 essay graded today' : `${String(n)} essays graded today`)}
              labelKr={(n) => `오늘 채점된 작문 ${String(n)}개`}
            />
          }
          onClick={() => {
            // Wave 2 (B6): deep-links to this exact bank prompt by id.
            navigate(writingHref(t));
          }}
        />
      </div>,
    );
  }

  // A real plan failure (never loading, never mock-fallback data) empties
  // the peek slider (every task above is gated on `today.data`) and the
  // Vocab tile below — both degrade to an honest ErrorCard rather than a
  // silently-shrunk carousel. Grammar/Hanja/TOPIK have no plan dependency
  // and keep working regardless (checked below).
  const planFailed = !today.loading && today.data === null;

  return (
    <section
      className="screen km-today km-rain-sheen"
      aria-labelledby="today-title"
    >
      {isMock ? <MockBadge /> : null}

      {/* F-128 devices #4/#2 — the shared hub-header recipe (F-177): a
          SkylineHeader carrying the real <h1> overlaid on it + a
          DancheongRail divider underneath, via the same `PageHubHeader` every
          Library page + Progress already render — Today used to carry its
          own inline copy of this recipe (it originated it, C-2 fix,
          REVIEW_batch1-fidelity.md), now migrated so it can't drift from the
          shared version. `km-today__hub` only restores this page's own extra
          14px of title/rail gap (`.km-today__title` used to carry `margin:
          4px 0 14px`, one step more than the shared recipe's `4px 0 0`) —
          same fix Progress.tsx got, so the migration is byte-for-byte
          visually, not just structurally. */}
      <PageHubHeader
        className="km-today__hub"
        titleId="today-title"
        eyebrow={<Bilingual en={dateEn} kr={dateKr} />}
        heading={<Bilingual kr="오늘" en="Today" />}
      />

      {/* Carousel 1 — Review & drills: Grammar / Vocab / Hanja, as the SAME
          native-scroll-snap peek slider as Carousel 2 below (direct user
          request — see the module header comment and Today.css's
          `.km-today__peekTrack` block for the shared mechanism). F-190
          reorders Vocab into the MIDDLE slot (was first) so the peek slider
          opens centered on it — `vocabCenterRef` lands the initial scroll
          position there on mount. Vocab (restored, reversing F-139) reads a
          real live due-count off the plan, so it alone among these three
          tiles depends on `today` — only its `km-today__peekItem` swaps
          between skeleton/tile/error; Grammar and Hanja never depended on
          the plan and are always the same static tile regardless of its
          fate. Deliberately a plain labeled `<section>` (implicit `region`),
          not `aria-roledescription="carousel"` — same reasoning as
          Carousel 2: every tile is simultaneously real and focusable, the
          honest a11y shape for a continuous scroll rail. */}
      <h2 className="km-today__sectionTitle">
        <Bilingual en="Review & drills" kr="복습 · 드릴" />
      </h2>
      <section className="km-today__section" aria-label="Review and drills">
        <div className="km-today__peekOuter">
          <div className="km-today__peekTrack">
            <div className="km-today__peekItem">
              <ActivityTile
                tone={SKILL_COLOR.grammar.tone}
                icon="grammar"
                ariaLabel="Open grammar drills"
                pill={
                  <Pill tone="red">
                    <Bilingual en="Drill" kr="드릴" />
                  </Pill>
                }
                headline={<Bilingual en="Grammar drills" kr="문법 드릴" />}
                meta={
                  <Bilingual
                    en="Production practice on banked patterns"
                    kr="저장한 문형으로 생산 연습"
                  />
                }
                extra={
                  <DoneTodayRow
                    count={grammarDoneToday}
                    tone={SKILL_COLOR.grammar.tone}
                    labelEn={(n) => (n === 1 ? '1 drill today' : `${String(n)} drills today`)}
                    labelKr={(n) => `오늘 완료한 드릴 ${String(n)}개`}
                  />
                }
                onClick={() => {
                  navigate('/learn/grammar');
                }}
              />
            </div>
            <div className="km-today__peekItem" ref={vocabCenterRef}>
              {today.loading ? (
                <SkeletonCard />
              ) : today.data ? (
                <ActivityTile
                  tone={SKILL_COLOR.flashcards.tone}
                  icon="cards"
                  ariaLabel={`Open review — ${String(today.data.reviewCount)} ${today.data.reviewCount === 1 ? 'card' : 'cards'} due`}
                  pill={
                    <Pill tone="gold">
                      <Bilingual en="Due now" kr="지금 복습" />
                    </Pill>
                  }
                  headline={
                    <Bilingual
                      en={`${String(today.data.reviewCount)} ${
                        today.data.reviewCount === 1 ? 'card' : 'cards'
                      } due`}
                      kr={`복습할 카드 ${String(today.data.reviewCount)}장`}
                    />
                  }
                  meta={
                    <Bilingual
                      en="FSRS scheduling · due for review"
                      kr="FSRS 스케줄링 · 복습 예정"
                    />
                  }
                  onClick={() => {
                    // Vocab-flashcards intent — the FSRS due-review session
                    // lives at /learn/vocab?study=due (Review.tsx's
                    // `study === 'due'` branch), NOT bare /learn/vocab
                    // (which is the lists-first landing and would cost the
                    // learner an extra tap to reach the same session).
                    navigate('/learn/vocab?study=due');
                  }}
                />
              ) : (
                <PlanErrorCard onRetry={retryToday} />
              )}
            </div>
            <div className="km-today__peekItem">
              <ActivityTile
                tone={SKILL_COLOR.hanja.tone}
                icon="hanja"
                ariaLabel="Open Hanja study"
                pill={
                  <Pill tone="ochre">
                    <Bilingual en="Practice" kr="연습" />
                  </Pill>
                }
                headline={<Bilingual en="Hanja study" kr="한자 학습" />}
                meta={
                  <Bilingual
                    en="Character drills & compounds"
                    kr="한자 드릴과 단어"
                  />
                }
                extra={
                  <DoneTodayRow
                    count={hanjaDoneToday}
                    tone={SKILL_COLOR.hanja.tone}
                    labelEn={(n) => (n === 1 ? '1 character reviewed today' : `${String(n)} characters reviewed today`)}
                    labelKr={(n) => `오늘 복습한 한자 ${String(n)}자`}
                  />
                }
                onClick={() => {
                  navigate('/learn/hanja');
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Carousel 2 — Suggested learning: Listening / Reading / Writing as
          a native-scroll-snap PEEK SLIDER (see the module header comment
          for why this is not a SwipeCarousel — Carousel 1 above now shares
          this exact mechanism/classes too). F-190 reorders Reading into the
          MIDDLE slot (was first) so the peek slider opens centered on it —
          `readingCenterRef` (attached to the Reading `peekItems` entry
          above) lands the initial scroll position there on mount.
          Deliberately a plain labeled <section> (implicit `region`), not
          `aria-roledescription="carousel"` — every tile is simultaneously
          real and focusable (no aria-hidden/inert paging), which is the
          honest a11y shape for a continuous scroll rail. */}
      <h2 className="km-today__sectionTitle km-hangul-watermark" data-glyph="배">
        <Bilingual en="Suggested learning" kr="추천 학습" />
      </h2>
      <section className="km-today__section" aria-label="Suggested learning">
        {today.loading ? (
          <SkeletonCard />
        ) : planFailed ? (
          <PlanErrorCard onRetry={retryToday} />
        ) : peekItems.length > 0 ? (
          <div className="km-today__peekOuter">
            <div className="km-today__peekTrack">{peekItems}</div>
          </div>
        ) : (
          <p className="km-today__peekEmpty">
            <Bilingual
              en="No suggested content right now"
              kr="지금은 추천 학습이 없습니다"
            />
          </p>
        )}
      </section>

      {/* Carousel 3 — TOPIK, last. A single-page SwipeCarousel (dots/drag
          naturally no-op below 2 children) carrying the folded-in
          "Review mistakes" shortcut and the F-007 resume-exam corner
          banner — TOPIK is what a saved attempt resumes back into, so this
          is its natural home now that it's split from Reading/Listening/
          Writing. No highlight styling on the meta line (F-137).
          F-187 — direct user feedback: the Suggested-learning → TOPIK
          boundary specifically read as too much empty space on a real
          phone even after an earlier general tightening pass (see
          `.km-today__section`/`.km-today__sectionTitle` in Today.css). The
          `--topik` modifier below trims JUST this header's own top margin
          (Today.css) rather than touching the shared rule every section
          title reads, so the Review&drills → Suggested-learning gap (which
          reads fine) is untouched. */}
      <h2 className="km-today__sectionTitle km-today__sectionTitle--topik">
        <Bilingual en="TOPIK" kr="토픽" />
      </h2>
      <section className="km-today__section">
        {/* `SwipeCarousel.children` is typed `ReactNode[]` (multiple pages
            by contract) — this carousel genuinely has only one page, so the
            single child is wrapped in an explicit array literal to satisfy
            that type rather than loosening the shared component's prop. */}
        <SwipeCarousel ariaLabel="TOPIK" cornerSlot={resumeBanner}>
          {[
          <div
            key="topik"
            className={cn(
              'km-today__tilePage',
              openAttempt !== null && 'km-today__tilePage--banner',
            )}
          >
            <ActivityTile
              tone={SKILL_COLOR.topik.tone}
              feat
              icon="spark"
              ariaLabel="Open TOPIK study practice"
              pill={
                <Pill tone="gold">
                  <Bilingual en="Recommended" kr="추천" />
                </Pill>
              }
              headline={<Bilingual en="TOPIK study practice" kr="토픽 학습" />}
              meta={
                <Bilingual
                  en="Shuffled past questions, one at a time"
                  kr="기출 문제를 한 문항씩 랜덤으로"
                />
              }
              extra={
                <DoneTodayRow
                  count={topikDoneToday}
                  tone={SKILL_COLOR.topik.tone}
                  labelEn={(n) => (n === 1 ? '1 mock attempt today' : `${String(n)} mock attempts today`)}
                  labelKr={(n) => `오늘 완료한 모의고사 ${String(n)}회`}
                />
              }
              onClick={() => {
                navigate('/learn/topik');
              }}
            />
            {/* F-173 — the resumed attempt's real "X of N" position, once
                `GET /topik/attempt` resolved a saved in-progress exam. Bar +
                numeric readout (same pairing as Hanja.tsx's F-170 study-drill
                bar) — the dots alone don't spell out the exact count once a
                paper's item count exceeds SubwayProgress's dot-render cap.
                F-173 fix-pass SHOULD-FIX #1 — this "X of N" + bar treatment
                is ONLY honest when `totalItems` is a real server value
                (`hasRealTotal`); the `?? answered` fallback renders a plain
                "N answered" line instead, with no "of N" and no bar (a bar
                built from `totalItems ?? answered` always fills ~100%,
                which reads as "exam complete" beside the "Resume exam" CTA
                — see the `hasRealTotal` comment above). */}
            {openAttempt !== null ? (
              <div className="km-today__resumeProgress">
                {hasRealTotal ? (
                  <>
                    <SubwayProgress
                      steps={resumeTotalItems}
                      current={openAttempt.answered}
                      tone={SKILL_COLOR.topik.tone}
                      label="Resumed exam progress"
                      valueText={resumeAnsweredEn}
                    />
                    <div className="km-today__resumeProgressCount">
                      <Bilingual en={resumeAnsweredEn} kr={resumeAnsweredKr} />
                    </div>
                  </>
                ) : (
                  <div className="km-today__resumeProgressCount">
                    <Bilingual en={resumeAnsweredEn} kr={resumeAnsweredKr} />
                  </div>
                )}
              </div>
            ) : null}
            <div className="km-today__topikExtra">
              <button
                type="button"
                className="km-today__linkBtn focusring"
                onClick={() => {
                  navigate('/review/mistakes');
                }}
              >
                <Icon name="history" size={14} />
                <Bilingual en="Review mistakes" kr="오답 복습" />
              </button>
            </div>
          </div>,
          ]}
        </SwipeCarousel>
      </section>
    </section>
  );
}

export default Today;
