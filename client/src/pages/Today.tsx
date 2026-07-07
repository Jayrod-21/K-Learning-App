/**
 * Today screen — the daily ACTION hub (Overhaul P1.2, Slice A).
 *
 * P1.2 rebalanced Today/Progress: every "where am I" surface (the compact
 * SkillsCompare TOPIK-level snapshot and the F-017 per-skill trends
 * carousel) moved to the Progress page; Today keeps only things the user can
 * DO right now. Layout, top to bottom:
 *
 *   1. Topbar: date eyebrow + 오늘 · Today serif title.
 *   2. **Review queue** accent card (lead action) — live "{n} cards due",
 *      FSRS meta → `/learn/vocab` (the flashcards page, re-homed in P1.1).
 *   3. **Today's tasks carousel** — the Reading / Listening / Writing
 *      TaskCards, reshaped from a grid into a `SwipeCarousel` (one task per
 *      page). Real targets: `/learn/listen` (Reading + Listening — the
 *      retired Read screen's content lives there) and `/learn/writing`.
 *      Listening = "Largest gap" (gold). Writing = "Register drill".
 *   4. **Grammar practice** — designed "coming soon" placeholder (the
 *      grammar-due carousel backing is P4).
 *   5. **TOPIK carousel** — page 1 surfaces the F-007 saved mock attempt
 *      when one exists ("Resume exam" → `/learn/topik`, where MockMode's
 *      resume banner takes over); with no attempt it offers the TOPIK page
 *      directly. Page 2 is the recommendation placeholder (heuristic is P4).
 *   6. **Review shortcut** row → `/review/mistakes`.
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
 * honest "no exam in progress" panel instead.
 *
 * Threat model:
 *   Fixture/server text rendered as React children → escaped by React. Pass
 *   3+ wire must keep this contract (text fields, not HTML strings).
 */
import { useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { TaskCard } from '../components/TaskCard';
import { MockBadge } from '../components/MockBadge';
import { Button } from '../components/Button';
import { ErrorCard } from '../components/ErrorCard';
import { SwipeCarousel } from '../components/SwipeCarousel';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import { loadTodayMock } from '../data/mocks/today';
import { mockDelay } from '../data/mocks/_delay';
import { fetchToday } from '../services/plan';
import { fetchAttempt } from '../services/topik';
import type { AttemptState } from '../services/topik';
import type { TodayPlan, TodayTask } from '../types/domain';
import './Today.css';

/** Format the current date in the design's eyebrow style ("Monday, May 28"). */
function formatDateEyebrow(d: Date): string {
  return d.toLocaleDateString('en-US', {
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
 * CTA for an exam that doesn't exist (the same honesty rule as the Progress
 * page's empty history mock). Module scope per the useEndpointOrMock
 * contract.
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

/**
 * TOPIK carousel page 1 — the open-exam entry. With a saved F-007 attempt
 * it reads as a resume CTA (MockMode's own resume banner takes over on
 * arrival); otherwise it offers the TOPIK page directly. A failed lookup
 * degrades to the no-attempt copy (`data` stays null) — the same "no resume
 * banner when offline" behaviour MockMode itself uses, never a fake resume.
 */
function OpenExamPanel({
  attempt,
  onOpen,
}: {
  attempt: UseEndpointOrMockResult<AttemptState | null>;
  onOpen: () => void;
}): JSX.Element {
  if (attempt.loading) {
    return (
      <div className="km-today__examPanel" aria-busy="true">
        <div className="km-today__examMeta">Checking for an exam in progress…</div>
      </div>
    );
  }
  const open = attempt.data;
  if (open !== null) {
    const section = SECTION_LABELS[open.section];
    return (
      <div className="km-today__examPanel">
        <Pill tone="gold">Exam in progress</Pill>
        <div className="km-today__examTitle">
          {section.label} mock{' '}
          <span className="kr km-today__examKr">{section.kr}</span>
        </div>
        <div className="km-today__examMeta">
          {open.answered} answered · picks and timer saved
        </div>
        <Button
          variant="gold"
          size="sm"
          onClick={onOpen}
          trailingIcon={<Icon name="arrow-right" size={14} />}
        >
          Resume exam
        </Button>
      </div>
    );
  }
  return (
    <div className="km-today__examPanel">
      <div className="km-today__examTitle">
        Mock exams <span className="kr km-today__examKr">모의고사</span>
      </div>
      <div className="km-today__examMeta">
        No exam in progress — take a timed reading or listening mock.
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onOpen}
        trailingIcon={<Icon name="arrow-right" size={14} />}
      >
        Open TOPIK practice
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Coming-soon placeholder panel (P1.2 — filled in P4)
// ─────────────────────────────────────────────────────────────

/**
 * Designed placeholder for a P4 feature slot — an intentional empty-state
 * panel (icon + bilingual title + copy + "Coming soon" pill), never a blank
 * or broken card.
 */
function ComingSoonPanel({
  icon,
  title,
  kr,
  copy,
}: {
  icon: IconName;
  title: string;
  kr: string;
  copy: string;
}): JSX.Element {
  return (
    <div className="km-today__soon">
      <span className="km-today__soonIcon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="km-today__soonMeta">
        <span className="km-today__soonTitle">
          {title} <span className="kr km-today__soonKr">{kr}</span>
        </span>
        <span className="km-today__soonCopy">{copy}</span>
      </span>
      <Pill>Coming soon</Pill>
    </div>
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

  const dateStr = formatDateEyebrow(new Date());

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
      // Reading + Listening tiles both land on Listen (`/learn/listen`) —
      // the retired Read screen's content lives there (TTMIK + Iyagi).
      { task: today.data.reading, krTag: '읽기', skill: 'Reading', nav: '/learn/listen' },
      { task: today.data.listening, krTag: '듣기', skill: 'Listening', nav: '/learn/listen' },
      { task: today.data.writing, krTag: '쓰기', skill: 'Writing', nav: '/learn/writing' },
    ];
    for (const c of candidates) {
      if (c.task) taskTiles.push({ task: c.task, krTag: c.krTag, skill: c.skill, nav: c.nav });
    }
  }

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
        eyebrow={dateStr}
      />

      {/* Review queue CTA — the lead action ──────────────────── */}
      {today.loading ? (
        <div style={{ marginBottom: 16 }}>
          <SkeletonCard />
        </div>
      ) : today.data ? (
        <button
          type="button"
          onClick={() => {
            // Vocab-flashcards intent — the FSRS review queue moved to
            // /learn/vocab in P1.1 (/review is the library index now).
            navigate('/learn/vocab');
          }}
          className="km-today__queue focusring"
          aria-label={`Open review — ${String(today.data.reviewCount)} ${today.data.reviewCount === 1 ? 'card' : 'cards'} due`}
        >
          <div>
            <Pill tone="gold">Due now</Pill>
            <div className="km-today__queueCount">
              {today.data.reviewCount}{' '}
              {today.data.reviewCount === 1 ? 'card' : 'cards'} due
            </div>
            {/* No fabricated grammar/vocab split or minute estimate here —
                /plan/today returns only `dueCount`, so any breakdown would
                contradict the live count above (it would always read the
                fixture's "24"). Keep the meta honest to the data we have. */}
            <div className="km-today__queueMeta">
              FSRS scheduling · due for review
            </div>
          </div>
          <Icon name="arrow-right" size={22} />
        </button>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <ErrorCard
            message="Today's plan is unavailable."
            onRetry={retryToday}
          />
        </div>
      )}

      {/* Reading / Listening / Writing carousel ──────────────── */}
      {taskTiles.length > 0 ? (
        <section style={{ marginBottom: 16 }}>
          <Card variant="default" style={{ padding: '20px 22px' }}>
            <div className="km-eyebrow" style={{ marginBottom: 10 }}>
              오늘의 과제 · Today&rsquo;s tasks
            </div>
            <SwipeCarousel ariaLabel="Today's tasks">
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
                </div>
              ))}
            </SwipeCarousel>
          </Card>
        </section>
      ) : null}

      {/* Grammar practice — placeholder (backing lands in P4) ── */}
      <section style={{ marginBottom: 16 }}>
        <Card variant="default" style={{ padding: '20px 22px' }}>
          <div className="km-eyebrow" style={{ marginBottom: 10 }}>
            문법 연습 · Grammar practice
          </div>
          <ComingSoonPanel
            icon="grammar"
            title="Daily grammar drills"
            kr="문법"
            copy="Your due grammar patterns will queue up here for a quick daily drill."
          />
        </Card>
      </section>

      {/* TOPIK — open exam + recommendation carousel ─────────── */}
      <section style={{ marginBottom: 16 }}>
        <Card variant="default" style={{ padding: '20px 22px' }}>
          <div className="km-eyebrow" style={{ marginBottom: 10 }}>
            시험 · TOPIK
          </div>
          <SwipeCarousel ariaLabel="TOPIK exams">
            <OpenExamPanel
              attempt={attempt}
              onOpen={() => {
                navigate('/learn/topik');
              }}
            />
            <ComingSoonPanel
              icon="spark"
              title="Recommended for you"
              kr="추천"
              copy="A mock-exam recommendation based on your recent practice will land here."
            />
          </SwipeCarousel>
        </Card>
      </section>

      {/* Review shortcut ──────────────────────────────────────── */}
      <button
        type="button"
        className="km-today__shortcut focusring"
        onClick={() => {
          navigate('/review/mistakes');
        }}
      >
        <Icon name="history" size={20} />
        <span className="km-today__shortcutMeta">
          <span className="km-today__shortcutLabel">Review mistakes</span>
          <span className="kr km-today__shortcutKr">오답 복습</span>
        </span>
        <Icon name="chevron-right" size={16} />
      </button>
    </section>
  );
}

export default Today;
