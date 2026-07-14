/**
 * Today screen — the daily ACTION hub. Wave-2 "Seoul Day & Night" reskin
 * (F-128) + per-page feature set (F-129–F-140; see BUGS_AND_FEATURES.md),
 * restructured into THREE carousels per direct user feedback on the live
 * site (mobile-hardening pass):
 *
 *   1. **Core drills carousel** ("Review & drills") — Vocab · Grammar ·
 *      Hanja, in that order. F-139 had removed the vocab/"words" due-count
 *      tile entirely on the theory that the Review tab (bottom nav) was
 *      its home — that was wrong: it deleted a first-class daily-action
 *      entry point users actually wanted here. RESTORED, exactly at its
 *      pre-F-139 fidelity (live "N cards due" from the plan's real
 *      `reviewCount`, → `/learn/vocab`), alongside Grammar (→
 *      `/learn/grammar`) and Hanja (→ `/learn/hanja`, F-140). A standard
 *      swipe carousel (`SwipeCarousel`, F-017/F-029, looped).
 *   2. **Suggested learning carousel** — Reading · Listening · Writing, as
 *      a horizontal PEEK SLIDER (the user's own description: "3 tiles
 *      side by side, slide carousel, doesn't switch to a new tile but can
 *      see the previous tile, like a spin table"). This is a genuinely
 *      different interaction model from `SwipeCarousel`'s hard
 *      one-page-at-a-time snap, so it is NOT built on that component —
 *      it's native CSS scroll-snap (`overflow-x: auto` +
 *      `scroll-snap-type: x mandatory`, tiles at `flex: 0 0 78%` with
 *      `scroll-snap-align: center` and peek padding on the track) so the
 *      browser owns the drag/fling/momentum entirely on touch — no JS
 *      gesture code to get wrong. See Today.css for the full rationale
 *      and the progressive-enhancement center-emphasis animation.
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
 *      server-side (`server/src/routes/plan.ts` orders the TTMIK pick by
 *      `md5(user || date || lesson_id)` — this screen only renders
 *      whatever `/plan/today` sends, which already changes day to day).
 *   3. **TOPIK carousel** — last, its own `SwipeCarousel` (a single page —
 *      dots/drag naturally no-op below 2 children). Carries the
 *      "Review mistakes" shortcut folded in (not its own page) and NO
 *      highlight styling on its meta line (F-137 — plain text, never a
 *      glowing bar). A saved F-007 attempt surfaces as this carousel's
 *      corner resume banner (it resumes straight back into `/learn/topik`,
 *      so this is its natural home now that it's split from Reading/
 *      Listening/Writing).
 *
 * Everything real stays real: per-tile "done today" counts come from
 * actual attempt-history endpoints, never a fabricated target or a
 * landing-page-visit counter. `SubwayProgress` (device #5) is deliberately
 * NOT used here for the same reason as before the restructure — no genuine
 * multi-step total this page could show is available client-side without
 * fabricating a denominator; tracked in `BUGS_AND_FEATURES.md`.
 *
 * Layout, top to bottom:
 *   1. `SkylineHeader` carrying the real h1 in its `title` slot (date
 *      eyebrow + 오늘 · Today, overlaid on the skyline) + a `DancheongRail`
 *      divider underneath — the same header recipe Progress uses (C-2/C-3
 *      fix, `REVIEW_batch1-fidelity.md`).
 *   2. Core drills carousel (Vocab / Grammar / Hanja).
 *   3. Suggested learning peek slider (Reading / Listening / Writing).
 *   4. TOPIK carousel.
 *
 * Data:
 *   useEndpointOrMock('today', loadTodayMock, { realFn: fetchToday })
 *   useEndpointOrMock('today.attempt', loadOpenAttemptMock, { realFn: fetchAttempt })
 *   useEndpointOrMock('today.grammarAttempts', …, { realFn: listAttempts })
 *   useEndpointOrMock('today.writingAttempts', …, { realFn: fetchWritingAttempts })
 *   useEndpointOrMock('today.topikAttempts', …, { realFn: fetchAttemptHistory })
 *
 * The three attempt-history fetches back F-138's per-tile "done today"
 * counts (grammar/writing/TOPIK) — filtered client-side to the viewer's
 * local calendar day, since these are the caller's own scored/graded
 * history, newest first, and carry no "today only" server filter. Hanja,
 * Vocab, and Reading/Listening have NO attempt-history endpoint today
 * (`services/hanja` only exposes lifetime aggregate bands; `services/vocab`
 * exposes a live due-count, not a "reviewed today" tally;
 * `services/reading`/`services/ttmik` expose no per-attempt log at all) —
 * those tiles show their existing server-supplied content with no
 * daily-count claim, which is the honest choice over fabricating one.
 * Tracked as durable follow-ups in `BUGS_AND_FEATURES.md` — "Hanja
 * daily-attempt signal" and "Reading/Listening daily-attempt signal" —
 * rather than left as a dangling PR-description note.
 *
 * A plan failure (never loading, never mock-fallback data) degrades the
 * Vocab tile (Carousel 1) and the whole Suggested-learning peek slider
 * (Carousel 2) to an honest `ErrorCard` with retry — Grammar/Hanja (no
 * plan dependency) and TOPIK (no plan dependency) keep working regardless.
 *
 * Threat model:
 *   Fixture/server text rendered as React children → escaped by React. Pass
 *   3+ wire must keep this contract (text fields, not HTML strings). The
 *   three attempt-history fetches are read-only GETs behind the same
 *   auth+session posture as every other service in this app (see
 *   services/grammarDrill.ts, services/writing.ts, services/topik.ts) —
 *   this screen adds no new endpoint, just three more consumers of ones
 *   that already exist for their own history screens. The restored Vocab
 *   tile adds no new endpoint either — it reads `reviewCount` off the
 *   plan the screen already fetches.
 */
import { useNavigate } from 'react-router-dom';
import type { JSX, ReactNode } from 'react';
import { Bilingual } from '../components/Bilingual';
import { Eyebrow } from '../components/Eyebrow';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { SwipeCarousel } from '../components/SwipeCarousel';
import { SkylineHeader } from '../components/SkylineHeader';
import { CityCard, type CityCardTone } from '../components/CityCard';
import { DancheongRail } from '../components/DancheongRail';
import { SealStamp } from '../components/SealStamp';
import { useChatContext } from '../hooks/useChatContext';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadTodayMock } from '../data/mocks/today';
import { mockDelay } from '../data/mocks/_delay';
import { fetchToday } from '../services/plan';
import { fetchAttempt, fetchAttemptHistory } from '../services/topik';
import type { AttemptHistoryResult, AttemptState } from '../services/topik';
import { fetchWritingAttempts } from '../services/writing';
import { listAttempts as listGrammarAttempts } from '../services/grammarDrill';
import type { DrillAttemptsPage, TodayPlan, TodayTask } from '../types/domain';
import { cn } from '../lib/cn';
import { isLocalToday } from '../lib/localDay';
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

export function Today(): JSX.Element {
  const navigate = useNavigate();

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
    writingAttempts.isMock || topikAttempts.isMock;

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
  const topikDoneToday =
    topikAttempts.data && !topikAttempts.loading
      ? topikAttempts.data.attempts.filter((a) => isLocalToday(a.completedAt, now)).length
      : null;

  const gapTag: TodayTask['tag'] = today.data?.largestGap ?? 'Listening';

  const openAttempt = attempt.data ?? null;
  const resumeBanner =
    openAttempt !== null ? (
      <button
        type="button"
        className="km-today__resume focusring"
        aria-label={`Resume exam — ${SECTION_LABELS[openAttempt.section].label} mock, ${String(openAttempt.answered)} answered`}
        onClick={() => {
          navigate('/learn/topik');
        }}
      >
        <Icon name="play" size={12} />
        <Bilingual en="Resume exam" kr="이어서 하기" compact />
      </button>
    ) : undefined;

  // ── Suggested-learning peek-slider items (Reading / Listening / Writing).
  // A null server task is simply omitted — never a faked card (empty-corpus
  // contract, unchanged from before the redesign).
  const peekItems: ReactNode[] = [];

  if (today.data?.reading) {
    const t = today.data.reading;
    peekItems.push(
      <div key="reading" className="km-today__peekItem">
        <ActivityTile
          tone="blue"
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
          onClick={() => {
            navigate('/learn/reading');
          }}
        />
      </div>,
    );
  }

  if (today.data?.listening) {
    const t = today.data.listening;
    peekItems.push(
      <div key="listening" className="km-today__peekItem">
        <ActivityTile
          tone="mint"
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
          onClick={() => {
            navigate('/learn/listen');
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
            comment) — Writing is a plain ActivityTile that navigates to
            /learn/writing, same as Reading/Listening. The "done today"
            count rides in `extra`, same convention as Grammar/TOPIK. */}
        <ActivityTile
          tone="accent"
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
              tone="accent"
              labelEn={(n) => (n === 1 ? '1 essay graded today' : `${String(n)} essays graded today`)}
              labelKr={(n) => `오늘 채점된 작문 ${String(n)}개`}
            />
          }
          onClick={() => {
            navigate('/learn/writing');
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

      {/* F-128 device #4 — the skyline strip carries the real <h1> overlaid
          on it (C-2 fix, REVIEW_batch1-fidelity.md: Today used to render a
          bare skyline strip plus a separate `Topbar` heading BELOW it, while
          Progress overlaid its heading in SkylineHeader's own `title` slot —
          two different header treatments for the app's two hub pages). Both
          hubs now share one recipe. */}
      <SkylineHeader
        className="km-today__skyline"
        title={
          <>
            <Eyebrow>
              <Bilingual en={dateEn} kr={dateKr} />
            </Eyebrow>
            <h1 id="today-title" className="kr-display km-today__title">
              <Bilingual kr="오늘" en="Today" />
            </h1>
          </>
        }
      />

      {/* C-3 — the same dancheong-rail divider Progress renders under its
          header (folded into the C-2 header-unification fix), so both hub
          headers share one consistent stack rather than Today having none. */}
      <div className="km-today__rail-divider">
        <DancheongRail tone="accent" />
      </div>

      {/* Carousel 1 — Core drills: Vocab / Grammar / Hanja. Vocab (restored,
          reversing F-139) reads a real live due-count off the plan, so it
          alone among this carousel's pages depends on `today`; Grammar and
          Hanja never did and must keep working regardless of the plan's
          fate. */}
      <Eyebrow className="km-today__sectionEyebrow">
        <Bilingual en="Review & drills" kr="복습 · 드릴" />
      </Eyebrow>
      <section className="km-today__section">
        <SwipeCarousel ariaLabel="Review and drills" loop>
          <div className="km-today__tilePage">
            {today.loading ? (
              <SkeletonCard />
            ) : today.data ? (
              <ActivityTile
                tone="blue"
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
                  // Vocab-flashcards intent — the FSRS review queue lives at
                  // /learn/vocab (/review is the library index).
                  navigate('/learn/vocab');
                }}
              />
            ) : (
              <PlanErrorCard onRetry={retryToday} />
            )}
          </div>
          <div className="km-today__tilePage">
            <ActivityTile
              tone="blue"
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
                  tone="blue"
                  labelEn={(n) => (n === 1 ? '1 drill today' : `${String(n)} drills today`)}
                  labelKr={(n) => `오늘 완료한 드릴 ${String(n)}개`}
                />
              }
              onClick={() => {
                navigate('/learn/grammar');
              }}
            />
          </div>
          <div className="km-today__tilePage">
            <ActivityTile
              tone="ochre"
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
              onClick={() => {
                navigate('/learn/hanja');
              }}
            />
          </div>
        </SwipeCarousel>
      </section>

      {/* Carousel 2 — Suggested learning: Reading / Listening / Writing as
          a native-scroll-snap PEEK SLIDER (see the module header comment
          for why this is not a SwipeCarousel). Deliberately a plain
          labeled <section> (implicit `region`), not
          `aria-roledescription="carousel"` — every tile is simultaneously
          real and focusable (no aria-hidden/inert paging), which is the
          honest a11y shape for a continuous scroll rail. */}
      <Eyebrow className="km-today__sectionEyebrow km-hangul-watermark" data-glyph="배">
        <Bilingual en="Suggested learning" kr="추천 학습" />
      </Eyebrow>
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
          Writing. No highlight styling on the meta line (F-137). */}
      <Eyebrow className="km-today__sectionEyebrow">
        <Bilingual en="TOPIK" kr="토픽" />
      </Eyebrow>
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
              tone="accent"
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
                  tone="accent"
                  labelEn={(n) => (n === 1 ? '1 mock attempt today' : `${String(n)} mock attempts today`)}
                  labelKr={(n) => `오늘 완료한 모의고사 ${String(n)}회`}
                />
              }
              onClick={() => {
                navigate('/learn/topik');
              }}
            />
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
