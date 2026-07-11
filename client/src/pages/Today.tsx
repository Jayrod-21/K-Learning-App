/**
 * Today screen — the daily ACTION hub (Overhaul P1.2, Slice A; reworked in
 * P3a for F-026/F-027/F-028/F-029 + B-018).
 *
 * P1.2 rebalanced Today/Progress: every "where am I" surface (the compact
 * SkillsCompare TOPIK-level snapshot and the F-017 per-skill trends
 * carousel) moved to the Progress page; Today keeps only things the user can
 * DO right now. Layout, top to bottom:
 *
 *   1. Topbar: date eyebrow + 오늘 · Today serif title.
 *   2. **Review & drills carousel** (lead action, F-026 + B-018) — a looping
 *      `SwipeCarousel` of two accent tiles: the live "{n} cards due" FSRS
 *      vocab queue → `/learn/vocab`, and the grammar drills tile →
 *      `/learn/grammar` (the REAL Learn → Grammar practice page — the P1.2
 *      "coming soon" grammar placeholder is gone; B-018 folded it into this
 *      carousel as F-026's grammar page).
 *   3. **Today's tasks carousel** — the Reading / Listening / Writing
 *      TaskCards (one task per page). Real targets: `/learn/reading`
 *      (the rebuilt Reading page — B-019, closed in Phase 3C-2),
 *      `/learn/listen` (TTMIK + Iyagi), and `/learn/writing`.
 *      Listening = "Largest gap" (gold).
 *      Writing = "Register drill". The Writing page also mounts the F-027
 *      `WritingTopicGenerator` (Claude authors a fresh topic, TOPIK-style
 *      or free-write, via `POST /writing/generate`).
 *   4. **TOPIK carousel** (F-028) — page 1 is the recommended-study tile →
 *      `/learn/topik` (the Topik screen defaults to STUDY mode); page 2 is
 *      the review-mistakes tile → `/review/mistakes` (the old standalone
 *      shortcut row folded in here). When a saved F-007 mock attempt
 *      exists, a small "Resume exam" banner renders in the carousel's
 *      top-left corner (`cornerSlot` — pinned across BOTH pages) →
 *      `/learn/topik`, where MockMode's resume banner takes over.
 *
 * All three carousels loop (F-029). F-024 (BackButton on nested sub-views)
 * does not apply here — Today is a top-level tab with no nested views.
 *
 * Data:
 *   useEndpointOrMock('today', loadTodayMock, { realFn: fetchToday })          → TodayPlan
 *   useEndpointOrMock('today.attempt', loadOpenAttemptMock, { realFn: fetchAttempt }) → AttemptState | null
 *
 * Two fetches because the plan and the open-exam lookup are independent
 * server concerns (`/plan/today` vs `/topik/attempt`) and each fails
 * independently in the UI. The attempt mock resolves `null` on purpose — a
 * fabricated resumable attempt would paint a resume CTA for an exam that
 * doesn't exist, so the dev fallback (and any prod failure) degrades to the
 * honest "no banner" state instead. A plan failure degrades to an ErrorCard
 * on the vocab page ONLY — the grammar tile has no data dependency and must
 * keep working.
 *
 * Threat model:
 *   Fixture/server text rendered as React children → escaped by React. Pass
 *   3+ wire must keep this contract (text fields, not HTML strings). The
 *   F-027 generator's Claude output is handled inside WritingTopicGenerator
 *   (same escaped-text contract).
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
import { TaskCard } from '../components/TaskCard';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { SwipeCarousel } from '../components/SwipeCarousel';
import { WritingTopicGenerator } from '../components/WritingTopicGenerator';
import { useChatContext } from '../hooks/useChatContext';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadTodayMock } from '../data/mocks/today';
import { mockDelay } from '../data/mocks/_delay';
import { fetchToday } from '../services/plan';
import { fetchAttempt } from '../services/topik';
import type { AttemptState } from '../services/topik';
import type { TodayPlan, TodayTask } from '../types/domain';
import { cn } from '../lib/cn';
import './Today.css';

/**
 * One-line "what Today is showing" for the chat-context store (Slice 3) —
 * the FAB's "Discuss the page you were on?" popup renders this. Mirrors the
 * visible cards: the due-review count plus whichever task tiles resolved.
 */
function chatSummaryForPlan(plan: TodayPlan): string {
  const parts: string[] = [
    `${String(plan.reviewCount)} review ${
      plan.reviewCount === 1 ? 'card' : 'cards'
    } due`,
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
 * Tone for a Today task tile. The largest-gap modality is painted gold (the
 * design's emphasis); Writing keeps its standing red "register drill" identity
 * when it is NOT the gap; everything else is neutral.
 */
function tileTone(
  tag: TodayTask['tag'],
  gap: TodayTask['tag'],
): 'default' | 'gold' | 'red' {
  if (tag === gap) return 'gold';
  if (tag === 'Writing') return 'red';
  return 'default';
}

/**
 * Pill copy for a Today task tile. The gap tile reads "Largest gap"; Writing's
 * standing identity is "Register drill". A non-gap Reading/Listening tile has
 * no pill. `gap` takes precedence over Writing's default so a writing-is-weakest
 * day shows "Largest gap", not "Register drill".
 */
function tileTag(
  tag: TodayTask['tag'],
  gap: TodayTask['tag'],
): string | undefined {
  if (tag === gap) return 'Largest gap';
  if (tag === 'Writing') return 'Register drill';
  return undefined;
}

/** One Today task tile, paired with its Korean tag, skill label, and route. */
interface TaskTile {
  task: TodayTask;
  krTag: string;
  skill: string;
  nav: string;
}

// ─────────────────────────────────────────────────────────────
// Open-exam lookup (F-007 attempt surfaced on the action hub)
// ─────────────────────────────────────────────────────────────

/**
 * Mock fallback for the open-exam lookup — resolves "no exam in progress".
 * Deliberately null: fabricating a resumable attempt would paint a resume
 * banner for an exam that doesn't exist (the same honesty rule as the
 * Progress page's empty history mock). Module scope per the
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
// ActionTile — the polished accent tile the F-026/F-028 carousels page
// ─────────────────────────────────────────────────────────────

/**
 * One full-width action tile: accent-tinted surface, icon chip, optional
 * pill, headline (+ optional stat treatment), meta line, trailing arrow.
 * The whole tile is the gesture (a real `<button>`, mirroring TaskCard).
 * Local to Today on purpose — it exists to make these carousel pages read
 * as designed surfaces, not bare boxes (F-026's whole complaint); promote
 * it to components/ only when a second page needs it.
 */
function ActionTile({
  accent,
  icon,
  pill,
  headline,
  stat = false,
  meta,
  ariaLabel,
  onClick,
}: {
  accent: 'vermilion' | 'violet' | 'ochre' | 'neutral';
  icon: IconName;
  /** Optional pre-built `<Pill/>` above the headline. */
  pill?: ReactNode;
  headline: ReactNode;
  /** Stat treatment — headline in the display face (e.g. the due count). */
  stat?: boolean;
  meta?: ReactNode;
  /** Explicit accessible name; omit to let the tile's text serve. */
  ariaLabel?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'km-today__tile focusring',
        accent !== 'neutral' && `km-today__tile--${accent}`,
      )}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <span className="km-today__tileIcon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="km-today__tileBody">
        {pill}
        <span
          className={cn(
            'km-today__tileHeadline',
            stat && 'km-today__tileHeadline--stat',
          )}
        >
          {headline}
        </span>
        {meta !== undefined ? (
          <span className="km-today__tileMeta">{meta}</span>
        ) : null}
      </span>
      <Icon name="arrow-right" size={18} />
    </button>
  );
}

/** Render a quick skeleton-shaped card while data loads. */
function SkeletonCard(): JSX.Element {
  // Static height + dimmed paint mimics card-shaped loading per CLAUDE plan.
  // Empty fragment satisfies Card's required `children` without rendering text.
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: 120, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

export function Today(): JSX.Element {
  const navigate = useNavigate();
  // The plan is live as of Pass 5 (`GET /plan/today`); the open-exam lookup
  // is the F-007 `GET /topik/attempt`. Each falls back to its mock loader if
  // the real endpoint rejects in dev (the hook owns that swap), and each
  // fails independently in the UI.
  const today = useEndpointOrMock<TodayPlan>('today', loadTodayMock, {
    realFn: () => fetchToday(),
  });
  const attempt = useEndpointOrMock<AttemptState | null>(
    'today.attempt',
    loadOpenAttemptMock,
    { realFn: () => fetchAttempt() },
  );

  // Publish "what this page is showing" for the chat FAB (Slice 3) once the
  // plan has loaded; nothing is published while loading/failed, so the FAB's
  // discuss-this-page popup simply skips.
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

  // Retry routes through the hook's `refetch()` rather than a brutal
  // `window.location.reload()` — a plan failure retries the plan alone.
  const retryToday = today.refetch;

  // MockBadge tracks realFn-backed sources (the unified Pass-3 semantics).
  // Both fetches are realFn-backed, so either falling back to its mock
  // should trip the dev-only 🅂 badge.
  const isMock = today.isMock || attempt.isMock;

  // Build the visible task tiles. Tasks the server couldn't fill (empty corpus)
  // arrive null and are simply omitted — no faked card. `largestGap` defaults
  // to Listening (the design's emphasis) until the user has a diagnostic run.
  const gapTag: TodayTask['tag'] = today.data?.largestGap ?? 'Listening';
  const taskTiles: TaskTile[] = [];
  if (today.data) {
    const candidates: Array<{ task: TodayTask | null } & Omit<TaskTile, 'task'>> = [
      // B-019 (closed, Phase 3C-2): the Reading tile lands on the rebuilt
      // Reading page — `/learn/reading` is the real F-067–F-070 surface now
      // (typed book sections, AI stories, resume, chapter reader). The
      // Listening tile keeps `/learn/listen` (TTMIK + Iyagi).
      { task: today.data.reading, krTag: '읽기', skill: 'Reading', nav: '/learn/reading' },
      { task: today.data.listening, krTag: '듣기', skill: 'Listening', nav: '/learn/listen' },
      { task: today.data.writing, krTag: '쓰기', skill: 'Writing', nav: '/learn/writing' },
    ];
    for (const c of candidates) {
      if (c.task) taskTiles.push({ task: c.task, krTag: c.krTag, skill: c.skill, nav: c.nav });
    }
  }

  // F-028: the saved F-007 attempt surfaces as a small clickable banner in
  // the TOPIK carousel's top-left corner (SwipeCarousel `cornerSlot` — the
  // overlay is viewport-level, so it is present over BOTH pages). While the
  // lookup is pending or failed there is honestly no attempt to offer, so
  // no banner renders — never a fabricated resume.
  const openAttempt = attempt.data ?? null;
  const resumeBanner =
    openAttempt !== null ? (
      <button
        type="button"
        className="km-today__resume focusring"
        aria-label={`Resume exam — ${SECTION_LABELS[openAttempt.section].label} mock, ${String(openAttempt.answered)} answered`}
        onClick={() => {
          // MockMode's own resume banner takes over on arrival.
          navigate('/learn/topik');
        }}
      >
        <Icon name="play" size={12} />
        <Bilingual en="Resume exam" kr="이어서 하기" compact />
      </button>
    ) : undefined;

  return (
    <section
      className="screen km-today"
      aria-labelledby="today-title"
      style={{ position: 'relative', paddingBottom: 32 }}
    >
      {isMock ? <MockBadge /> : null}

      <Topbar
        krTitle="오늘"
        title="Today"
        titleId="today-title"
        eyebrow={<Bilingual en={dateEn} kr={dateKr} />}
      />

      {/* Review & drills carousel — the lead action (F-026 + B-018) ── */}
      {today.loading ? (
        <div style={{ marginBottom: 16 }}>
          <SkeletonCard />
        </div>
      ) : (
        <section style={{ marginBottom: 16 }}>
          <SwipeCarousel ariaLabel="Review and drills" loop>
            <div className="km-today__tilePage">
              {today.data ? (
                <ActionTile
                  accent="vermilion"
                  icon="cards"
                  stat
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
                    // Vocab-flashcards intent — the FSRS review queue moved
                    // to /learn/vocab in P1.1 (/review is the library now).
                    navigate('/learn/vocab');
                  }}
                />
              ) : (
                // Plan failed: only the vocab count depends on it. The
                // grammar page below keeps working — never a dead carousel.
                <ErrorCard
                  message="Today's plan is unavailable."
                  onRetry={retryToday}
                />
              )}
            </div>
            <div className="km-today__tilePage">
              {/* B-018: the real Learn → Grammar practice page (drill +
                  bank), not a "coming soon" placeholder. No due-count is
                  fabricated here — /plan/today carries only the vocab
                  dueCount (a grammar-due queue is P4). */}
              <ActionTile
                accent="violet"
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
                onClick={() => {
                  navigate('/learn/grammar');
                }}
              />
            </div>
          </SwipeCarousel>
        </section>
      )}

      {/* Reading / Listening / Writing carousel ──────────────── */}
      {/* v2 flatten: no Card around the carousel — TaskCards are themselves
          elevated cards, so they float directly on the page background under
          a bare section eyebrow (a card must never contain another card). */}
      {taskTiles.length > 0 ? (
        <section style={{ marginBottom: 16 }}>
          <Eyebrow style={{ marginBottom: 10 }}>
            <Bilingual en="Today’s tasks" kr="오늘의 과제" />
          </Eyebrow>
          <SwipeCarousel ariaLabel="Today's tasks" loop>
            {taskTiles.map((tile) => (
              <div key={tile.task.tag} className="km-today__taskPage">
                <TaskCard
                  skill={`${tile.skill} · ${tile.task.level}`}
                  krTag={tile.krTag}
                  title={tile.task.title}
                  mins={tile.task.mins}
                  tone={tileTone(tile.task.tag, gapTag)}
                  tag={tileTag(tile.task.tag, gapTag)}
                  onClick={() => {
                    navigate(tile.nav);
                  }}
                />
                {tile.task.tag === 'Writing' ? (
                  // F-027: Claude authors a fresh topic (TOPIK-style or
                  // free-write) right on the writing tile. F-101: "Write this
                  // topic" carries the generated prompt into /learn/writing
                  // via location.state so it can be written against + graded
                  // (the Writing page narrows `state.generatedTopic`).
                  <WritingTopicGenerator
                    onUseTopic={(topic) =>
                      navigate('/learn/writing', {
                        state: { generatedTopic: topic },
                      })
                    }
                  />
                ) : null}
              </div>
            ))}
          </SwipeCarousel>
        </section>
      ) : null}

      {/* TOPIK carousel — recommended study first, mistakes second (F-028);
          the saved-attempt resume banner rides the corner slot. */}
      <section style={{ marginBottom: 16 }}>
        <Eyebrow style={{ marginBottom: 10 }}>
          <Bilingual en="TOPIK" kr="시험" />
        </Eyebrow>
        <SwipeCarousel ariaLabel="TOPIK exams" loop cornerSlot={resumeBanner}>
          <div
            className={cn(
              'km-today__tilePage',
              openAttempt !== null && 'km-today__tilePage--banner',
            )}
          >
            {/* The Topik screen opens in STUDY mode by default, so this
                lands on the study half directly. Copy stays honest to what
                study mode IS (a shuffled past-question draw) — the P4
                personalised-recommendation heuristic doesn't exist yet and
                is not faked here. */}
            <ActionTile
              accent="ochre"
              icon="spark"
              ariaLabel="Open TOPIK study practice"
              pill={
                <Pill tone="ochre">
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
              onClick={() => {
                navigate('/learn/topik');
              }}
            />
          </div>
          <div
            className={cn(
              'km-today__tilePage',
              openAttempt !== null && 'km-today__tilePage--banner',
            )}
          >
            {/* The old standalone review-mistakes shortcut row folded into
                this carousel as page 2 (F-028's ordering). */}
            <ActionTile
              accent="neutral"
              icon="history"
              ariaLabel="Review mistakes"
              headline={<Bilingual en="Review mistakes" kr="오답 복습" />}
              meta={
                <Bilingual
                  en="Revisit questions you missed"
                  kr="틀린 문제 다시 보기"
                />
              }
              onClick={() => {
                navigate('/review/mistakes');
              }}
            />
          </div>
        </SwipeCarousel>
      </section>
    </section>
  );
}

export default Today;
