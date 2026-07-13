/**
 * Today screen — the daily ACTION hub. Wave-2 "Seoul Day & Night" reskin
 * (F-128) + per-page feature set (F-129–F-140; see BUGS_AND_FEATURES.md).
 *
 * Visual contract: DESIGN_SEOUL_DAY_NIGHT.md. This page is one of the first
 * to adopt the foundation components built for the redesign —
 * `SkylineHeader` (device #4, the page hero), `CityCard`/`DancheongRail`
 * (devices #1/#2, every tile's surface + leading edge), `SealStamp` (device
 * #7, an honest "practiced today" milestone — never shown unless a REAL
 * attempt happened today), `CollapsibleTile` (the Writing inline-expand,
 * F-134), plus the `km-rain-sheen` (device #8, Night ambient) and
 * `km-hangul-watermark` (device #6) utilities from `styles/seoul-devices.css`.
 * `SubwayProgress` (device #5) is deliberately NOT used here — every genuine
 * multi-step total this page could show (an in-progress mock exam's item
 * count) is not available client-side without fabricating a denominator or a
 * disproportionate extra fetch; see the F-138 section below and the PR
 * report for the follow-up ticket. Everything real stays real: per-tile
 * "done today" counts come from actual attempt-history endpoints, never a
 * fabricated target or a landing-page-visit counter.
 *
 * Layout, top to bottom:
 *   1. `SkylineHeader` (decorative, aria-hidden) + `Topbar` (real h1: date
 *      eyebrow + 오늘 · Today).
 *   2. **Review & drills carousel** (lead action) — Grammar drills tile
 *      (→ /learn/grammar) and a Hanja study tile (→ /learn/hanja, F-140).
 *      F-139 removes the old vocab/"words" due-count tile entirely — the
 *      Review tab (bottom nav) is its home now; a duplicate CTA here was
 *      redundant.
 *   3. **Suggested learning carousel** (F-136) — Reading / Writing /
 *      Listening / TOPIK in one carousel (folds the old separate "Today's
 *      tasks" + "TOPIK" sections into one IA, F-135). Reading's daily
 *      rotation is real and already server-side (`server/src/routes/plan.ts`
 *      orders the TTMIK pick by `md5(user || date || lesson_id)` — this
 *      screen only has to render whatever `/plan/today` sends, which already
 *      changes day to day). Writing expands INLINE via `CollapsibleTile`
 *      (F-134) instead of navigating away; the Claude topic generator lives
 *      in its body. TOPIK's tile is followed by a compact "Review mistakes"
 *      shortcut (folded in, not its own carousel page) and carries NO
 *      highlight styling (F-137 — its meta line is plain text, never a
 *      glowing bar). A saved F-007 attempt surfaces as the corner resume
 *      banner across the whole carousel.
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
 * history, newest first, and carry no "today only" server filter. Hanja and
 * Reading/Listening have NO attempt-history endpoint today (`services/hanja`
 * only exposes lifetime aggregate bands; `services/reading`/`services/ttmik`
 * expose no per-attempt log at all) — those tiles show their existing
 * server-supplied content with no daily-count claim, which is the honest
 * choice over fabricating one. Noted as a follow-up in the PR report.
 *
 * Threat model:
 *   Fixture/server text rendered as React children → escaped by React. Pass
 *   3+ wire must keep this contract (text fields, not HTML strings). The
 *   F-027 generator's Claude output is handled inside WritingTopicGenerator
 *   (same escaped-text contract). The three new attempt-history fetches are
 *   read-only GETs behind the same auth+session posture as every other
 *   service in this app (see services/grammarDrill.ts, services/writing.ts,
 *   services/topik.ts) — this screen adds no new endpoint, just three more
 *   consumers of ones that already exist for their own history screens.
 */
import { useNavigate } from 'react-router-dom';
import type { JSX, ReactNode } from 'react';
import { Bilingual } from '../components/Bilingual';
import { Eyebrow } from '../components/Eyebrow';
import { Topbar } from '../components/Topbar';
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
import { CollapsibleTile } from '../components/CollapsibleTile';
import { WritingTopicGenerator } from '../components/WritingTopicGenerator';
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
import './Today.css';

/**
 * One-line "what Today is showing" for the chat-context store (Slice 3) —
 * the FAB's "Discuss the page you were on?" popup renders this. Mirrors the
 * visible cards only (the due-review count no longer has a visible tile
 * since F-139 removed the vocab tile, so it is no longer summarised here).
 */
function chatSummaryForPlan(plan: TodayPlan): string {
  const parts: string[] = [];
  if (plan.reading) parts.push(`Reading: ${plan.reading.title}`);
  if (plan.writing) parts.push(`Writing: ${plan.writing.title}`);
  if (plan.listening) parts.push(`Listening: ${plan.listening.title}`);
  return parts.length > 0 ? parts.join(' · ') : 'No tasks resolved today';
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
 * True when the ISO timestamp `iso` falls on the same LOCAL calendar day as
 * `ref`. Attempt-history endpoints return newest-first history with no
 * "today only" filter, so F-138's per-tile daily counts are derived here —
 * in the viewer's local time (what "today" means to the person looking at
 * the screen), not the server's UTC day boundary. Malformed timestamps
 * resolve false rather than throwing.
 */
function isLocalToday(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
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

async function loadGrammarAttemptsMock(): Promise<DrillAttemptsPage> {
  await mockDelay();
  return { attempts: [], total: 0, limit: 20, offset: 0 };
}

async function loadWritingAttemptsMock(): Promise<
  Awaited<ReturnType<typeof fetchWritingAttempts>>
> {
  await mockDelay();
  return { attempts: [], limit: 20, offset: 0 };
}

async function loadTopikAttemptsMock(): Promise<AttemptHistoryResult> {
  await mockDelay();
  return { attempts: [], total: 0 };
}

// ─────────────────────────────────────────────────────────────
// ActivityTile — the CityCard-based tile every carousel page (Grammar,
// Hanja, Reading, Listening, TOPIK) renders (F-128 device #1/#2). A real
// `<button>` owns all interaction/a11y; `CityCard` is purely the visual
// surface nested inside it (a non-interactive decorative wrapper is valid
// inside a button — it contributes no semantics of its own).
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
  const grammarAttempts = useEndpointOrMock<DrillAttemptsPage>(
    'today.grammarAttempts',
    loadGrammarAttemptsMock,
    { realFn: () => listGrammarAttempts({ limit: 20 }) },
  );
  const writingAttempts = useEndpointOrMock<
    Awaited<ReturnType<typeof fetchWritingAttempts>>
  >('today.writingAttempts', loadWritingAttemptsMock, {
    realFn: () => fetchWritingAttempts({ limit: 20 }),
  });
  const topikAttempts = useEndpointOrMock<AttemptHistoryResult>(
    'today.topikAttempts',
    loadTopikAttemptsMock,
    { realFn: () => fetchAttemptHistory({ limit: 20 }) },
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

  // ── Suggested-learning pages (F-136): Reading / Writing / Listening /
  // TOPIK, in that order. A null server task is simply omitted — never a
  // faked card (empty-corpus contract, unchanged from before the redesign).
  const suggestedPages: ReactNode[] = [];

  // Corner-slot banner (the resume-exam CTA) rides above every page of this
  // carousel — clear space for it uniformly so it never overlaps a tile's
  // icon chip while pages slide underneath it (mirrors the pre-redesign
  // `--banner` padding convention).
  const pagePadding = (): string | false =>
    openAttempt !== null && 'km-today__tilePage--banner';

  if (today.data?.reading) {
    const t = today.data.reading;
    suggestedPages.push(
      <div key="reading" className={cn('km-today__tilePage', pagePadding())}>
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

  if (today.data?.writing) {
    const t = today.data.writing;
    suggestedPages.push(
      <div key="writing" className={cn('km-today__tilePage', pagePadding())}>
        {/* F-134: expands INLINE via CollapsibleTile instead of navigating
            away. DancheongRail (device #2) rides as a standalone sibling —
            CollapsibleTile composes the plain `Card` primitive (out of this
            page's edit scope), so the Night neon-signboard glow is applied
            as a page-scoped override in Today.css (`.km-today__writingTile`)
            using the same token formula CityCard.css uses, rather than
            editing the shared component. */}
        <div className="km-today__writingWrap">
          <DancheongRail tone="accent" />
          <CollapsibleTile
            className="km-today__writingTile"
            defaultCollapsed
            title={
              <span className="km-today__tileTop">
                <span className="km-today__tileIcon" aria-hidden="true">
                  <Icon name="pen" size={20} />
                </span>
                <span className="km-today__tileBody">
                  {renderTag(t.tag, gapTag)}
                  <span className="km-today__tileHeadline kr">{t.title}</span>
                  <span className="km-today__tileMeta">
                    <Bilingual
                      en={`Writing · ${t.level} · ${String(t.mins)} min`}
                      kr={`쓰기 · ${t.level} · ${String(t.mins)}분`}
                    />
                  </span>
                </span>
              </span>
            }
          >
            <WritingTopicGenerator
              onUseTopic={(topic) => {
                navigate('/learn/writing', { state: { generatedTopic: topic } });
              }}
            />
            <DoneTodayRow
              count={writingDoneToday}
              tone="accent"
              labelEn={(n) => (n === 1 ? '1 essay graded today' : `${String(n)} essays graded today`)}
              labelKr={(n) => `오늘 채점된 작문 ${String(n)}개`}
            />
          </CollapsibleTile>
        </div>
      </div>,
    );
  }

  if (today.data?.listening) {
    const t = today.data.listening;
    suggestedPages.push(
      <div key="listening" className={cn('km-today__tilePage', pagePadding())}>
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

  // A real plan failure (never loading, never mock-fallback data) empties
  // every task page above — surface the honest error there instead of a
  // silently-shrunk carousel. `km-giwa` (device #3) textures the ground.
  const planFailed = !today.loading && today.data === null;
  if (planFailed) {
    suggestedPages.unshift(
      <div key="plan-error" className={cn('km-today__tilePage', pagePadding())}>
        <div className="km-today__errorWrap km-giwa">
          <ErrorCard
            message="Today's plan is unavailable."
            onRetry={retryToday}
          />
        </div>
      </div>,
    );
  }

  // TOPIK — always present (F-136); a plain (never highlighted, F-137)
  // "done today" line plus a folded-in "Review mistakes" shortcut.
  suggestedPages.push(
    <div key="topik" className={cn('km-today__tilePage', pagePadding())}>
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
  );

  return (
    <section
      className="screen km-today km-rain-sheen"
      aria-labelledby="today-title"
    >
      {isMock ? <MockBadge /> : null}

      <div className="km-today__hero">
        <SkylineHeader />
      </div>
      <Topbar
        krTitle="오늘"
        title="Today"
        titleId="today-title"
        eyebrow={<Bilingual en={dateEn} kr={dateKr} />}
      />

      {/* Review & drills carousel — Grammar (unchanged target) + Hanja
          (F-140). F-139 removed the vocab/"words" due-count tile — the
          Review tab is its home now, so this carousel no longer depends on
          the plan fetch at all. */}
      <Eyebrow className="km-today__sectionEyebrow">
        <Bilingual en="Review & drills" kr="복습 · 드릴" />
      </Eyebrow>
      <section className="km-today__section">
        <SwipeCarousel ariaLabel="Review and drills" loop>
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
              tone="plain"
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

      {/* Suggested learning carousel — Reading / Writing / Listening /
          TOPIK folded into one IA (F-135/F-136). */}
      <Eyebrow className="km-today__sectionEyebrow km-hangul-watermark" data-glyph="배">
        <Bilingual en="Suggested learning" kr="추천 학습" />
      </Eyebrow>
      {today.loading ? (
        <SkeletonCard />
      ) : (
        <section className="km-today__section">
          <SwipeCarousel ariaLabel="Suggested learning" loop cornerSlot={resumeBanner}>
            {suggestedPages}
          </SwipeCarousel>
        </section>
      )}
    </section>
  );
}

export default Today;
