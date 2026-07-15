/**
 * Topik — TOPIK Prep. Two modes behind the shared `Tabs` primitive (FU-NF-39,
 * Phase 3C-2):
 *
 *   - **Study** (default): the Pass-6 live shuffled draw from `POST
 *     /topik/study`, one item at a time with the pick→submit→reveal→next
 *     interaction. Study items carry the inline `correct` flag (public
 *     reference data); the screen reveals correctness client-side. On
 *     finishing the draw, a results/grade screen (F-008) tallies the reveals
 *     the learner already saw into the SAME shared `TopikResults` component
 *     Mock mode uses — see `buildStudySummary` below.
 *   - **Mock**: the answer-stripped, server-graded Mock-Test taking flow. A
 *     section-select → exam-chooser → start-page → timed exam → server-graded
 *     results machine (F-079). The exam NEVER receives a `correct` flag —
 *     grading happens on submit (`POST /topik/mock/submit`); explanations are
 *     revealed only post-exam.
 *
 * Phase 3C-2 additions:
 *   - **URL-driven sub-views.** The mode (`?mode=mock`) and the nested views
 *     (`?view=attempts`, and Mock's `?section=`/`?exam=` — see MockMode.tsx)
 *     live in the search params, so `BackButton` (F-024) and browser back
 *     both work deterministically and every nested view is deep-linkable.
 *   - **B-029:** the study draw size is no longer hard-capped at 10 — a
 *     `FilterSelect` offers up to the server max (50), with 10 kept as the
 *     labelled "daily recommended" default (the server's own default limit).
 *   - **F-078:** a session right/wrong tally on the study landing, counted
 *     client-side from the reveals the learner actually saw. FULL-day totals
 *     need the attempt/response history route (`GET /topik/attempts`, ticket
 *     F-104) — until it lands the tile says so honestly instead of faking a
 *     daily number.
 *   - **F-082:** a "Previous attempts" review view (`?view=attempts`),
 *     structured per the design but with the completed-exam data honestly
 *     pending on F-104 — no fabricated grades. The wired part that exists
 *     today is the jump into Review → Mistakes (`/review/mistakes`).
 *
 * F-009: both modes' results screens show a review row's explanation ONLY
 * when the pick was wrong — see `TopikResults` in MockMode.tsx.
 *
 * Threat model:
 *   - **Answer leakage.** Study mode reveals off the inline `correct` flag (by
 *     design — public items). Mock mode is answer-stripped end-to-end: the
 *     `TopikMockItem` type has no `correct`/`explanation`, the exam holds only
 *     the user's own picks, and the key arrives solely in the server's
 *     `MockResult` reveal after submit. A tampered client cannot self-grade.
 *   - **URL params are untrusted input.** `mode`/`view` (and MockMode's
 *     `section`/`exam`) are parsed against closed unions at the read site —
 *     an unrecognised value degrades to the default view, never into a
 *     template or a request path.
 *   - **Rendered text is escaped.** Every Korean string (prompts, choices,
 *     explanations) renders as a React text node — a malicious server payload
 *     becomes literal text, never markup.
 *   - **Failure-safe.** Neither mode can blank the screen: study + mock-fetch
 *     both fall back to a mock fixture (🅂 badge) via `useEndpointOrMock`, and
 *     the exam's submit failure surfaces an inline retry rather than dropping
 *     the user's work.
 *
 * F-128 reskin ("Seoul Day & Night") — the shared `PageHubHeader` (devices
 * #4/#2) replaces the bare `Topbar` on both the landing and the "Previous
 * attempts" nested view; the F-078 session tally and the live study item are
 * `CityCard` signboards/hanji-paper surfaces (device #1) with a leading
 * `DancheongRail` (device #2) — mirroring Grammar's live-drill treatment;
 * the F-082 attempts tiles are `CollapsibleTile surface="city"`; a
 * `SubwayProgress` (device #5) rides alongside the existing "Item N / M"
 * readout for stepping through the study draw; a finished draw gets a
 * milestone `SealStamp` (device #7) ahead of the shared results screen;
 * honest-empty states carry `.km-giwa`/`.km-hangul-watermark` (devices
 * #3/#6); the page root carries the ambient `.km-rain-sheen` (device #8,
 * Night-only per its own CSS gate). MockMode.tsx (a sibling file, out of
 * this pass's edit scope) is UNCHANGED — its own reskin is a separate
 * follow-up.
 *
 * F-159 ("Study vs Mock chooser") — entering the page (a fresh mount with no
 * explicit `?mode=` already in the URL) shows a Study/Mock chooser as a
 * shared `Sheet` popup (`chooserOpen`, seeded once from the URL on mount).
 * `Sheet`'s own backdrop already renders a semi-transparent scrim per the
 * ticket, so no shared CSS changed. The chooser is a GATE, not a content
 * replacement: the Tabs-driven Study/Mock landing renders fully underneath
 * from the first paint, so dismissing the sheet (an explicit pick, Esc, or
 * the backdrop) always lands on a live, already-populated screen — both
 * flows stay fully reachable exactly as before this ticket. A deep link
 * that already names an explicit mode (Today's "Mock" tile, a bookmarked
 * URL) skips the chooser, since the choice was already made elsewhere.
 */
import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AskAboutThisButton } from '../components/AskAboutThisButton';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { CityCard } from '../components/CityCard';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { Button } from '../components/Button';
import { FilterSelect } from '../components/FilterSelect';
import { Pill } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { PageHubHeader } from '../components/PageHubHeader';
import { SealStamp } from '../components/SealStamp';
import { Sheet } from '../components/Sheet';
import { SubwayProgress } from '../components/SubwayProgress';
import { Tabs } from '../components/Tabs';
import { TopikImageNote } from '../components/TopikImageNote';
import { TopikPassage } from '../components/TopikPassage';
import { useChatContext } from '../hooks/useChatContext';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadTopikStudyMock, loadTopikAttemptHistoryMock } from '../data/mocks/topik';
import {
  fetchAttemptHistory,
  fetchStudyDraw,
  recordTopikAnswer,
  type AttemptHistoryResult,
  type TopikAttemptHistoryEntry,
} from '../services/topik';
import { cn } from '../lib/cn';
import { splitImageItem } from '../lib/topikImage';
import { errorMessageFor } from '../lib/errorCopy';
import { SKILL_COLOR } from '../lib/skill-colors';
import {
  buildStudyDrawOptions,
  type SetSize,
} from '../lib/topikStudyDraw';
import type { TopikAnswerResult, TopikItem } from '../types/domain';
import {
  MockMode,
  SKIPPED_PICK,
  TopikResults,
  type ResultsReviewRow,
  type ResultsSummary,
} from './topik/MockMode';
import './Topik.css';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

/** F-078 session right/wrong counts. */
interface Tally {
  right: number;
  wrong: number;
}

/**
 * F-078 — the daily mock-exam total, sourced from `GET /topik/attempts`
 * (F-104). Distinct from the "This session" `Tally` above: the session tally
 * is a client-side count of Study-mode reveals, while this is the PERSISTED
 * aggregate of TODAY's completed mock exams (`topik_attempts.status =
 * 'completed'`) — the two intentionally measure different things, so they
 * render as separate lines rather than one merged (and misleading) number.
 */
type DailyMockTotal =
  | { status: 'loading' }
  | { status: 'error'; onRetry: () => void }
  | { status: 'ready'; right: number; wrong: number };

/** True iff `iso` falls on the same LOCAL calendar day as `ref`. */
function isSameLocalDay(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

/**
 * Sum today's completed-mock right/wrong from an attempt-history page
 * (F-104). A skipped item counts as wrong (`totalItems - correct`), matching
 * how every other TOPIK surface in this app grades a skip. Bounded to
 * whatever page the caller fetched (see `fetchAttemptHistory`'s call site) —
 * a best-effort "today" for a single-user app, not a paginated full scan.
 */
function sumTodaysMockAttempts(
  attempts: readonly TopikAttemptHistoryEntry[],
  ref: Date,
): { right: number; wrong: number } {
  let right = 0;
  let wrong = 0;
  for (const a of attempts) {
    if (!isSameLocalDay(a.completedAt, ref)) continue;
    right += a.correct;
    wrong += Math.max(0, a.totalItems - a.correct);
  }
  return { right, wrong };
}

/** The two TOPIK Prep modes the segmented toggle switches between. */
type TopikMode = 'study' | 'mock';

const MODES: ReadonlyArray<{ id: TopikMode; label: string; kr: string }> = [
  { id: 'study', label: 'Study', kr: '학습' },
  { id: 'mock', label: 'Mock', kr: '모의' },
];

function Topik(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  // F-078: lifted OUT of StudyMode (SF-2) — `Tabs` re-keys its panel per
  // mode, and the `view === 'attempts'` branch below replaces the whole
  // tabbed area, so a tally living inside StudyMode's own state was zeroed
  // by a Study→Mock→Study round trip OR by following the adjacent
  // "Previous attempts" link and coming back. `Topik` itself never
  // unmounts across either navigation, so holding the tally here is what
  // makes "This session" actually mean the session.
  const [tally, setTally] = useState<Tally>({ right: 0, wrong: 0 });

  // URL params are untrusted input — parse against closed unions and degrade
  // to the default view on anything unrecognised (never interpolated).
  const view = searchParams.get('view') === 'attempts' ? 'attempts' : null;
  const mode: TopikMode = searchParams.get('mode') === 'mock' ? 'mock' : 'study';

  // F-159 — the Study/Mock chooser gates a FRESH entry to the page. Lazy
  // initializer: read the URL's `mode` param ONCE, on mount, so a deep link
  // that already names an explicit mode (Today's "Mock" tile, a bookmarked
  // URL) skips the chooser — the choice was already made outside this
  // screen. Seeding once (not deriving every render) is what keeps this a
  // ONE-TIME gate instead of a mode-tracking mirror that would reopen the
  // instant the chooser's own pick rewrites the URL below.
  const [chooserOpen, setChooserOpen] = useState<boolean>(
    () => searchParams.get('mode') === null,
  );

  // Switch modes by rewriting the URL: the mode itself plus any Mock
  // sub-view params (`section`/`exam`) are replaced atomically, so flipping
  // to Study can never leave a stale Mock deep-link in the address bar.
  const selectMode = useCallback(
    (id: string): void => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id === 'mock') next.set('mode', 'mock');
        else next.delete('mode');
        next.delete('section');
        next.delete('exam');
        next.delete('view');
        return next;
      });
    },
    [setSearchParams],
  );

  // F-159: the chooser's pick both dismisses the sheet and drives the mode
  // through the SAME URL-rewrite `selectMode` the header Tabs use below —
  // one mode-selection path, not two, so a chooser pick and a manual tab
  // click are indistinguishable to the rest of the page.
  const chooseMode = useCallback(
    (id: TopikMode): void => {
      setChooserOpen(false);
      selectMode(id);
    },
    [selectMode],
  );

  // F-082: the "Previous attempts" review view is a landing-level nested
  // sub-view — it replaces the tabbed area entirely and carries its own
  // BackButton (F-024) to the canonical parent route.
  if (view === 'attempts') return <AttemptsReview />;

  return (
    <section
      className="screen km-topik km-rain-sheen"
      aria-labelledby="topik-title"
    >
      {/* F-128 devices #4/#2 — the shared hub-header recipe (skyline +
          dancheong rail) replaces the bare Topbar. P3b: title aligned with
          nav.ts's headerTitle (모의 · TOPIK) — the old 학습 was a pre-P1.1
          leftover and collided with "study mode". */}
      <PageHubHeader
        titleId="topik-title"
        eyebrow={
          mode === 'mock' ? (
            <Bilingual en="Mock test · timed" kr="모의고사 · 시간 제한" />
          ) : (
            <Bilingual en="Study mode" kr="학습 모드" />
          )
        }
        heading={<Bilingual en="TOPIK" kr="모의" />}
      />

      {/* F-159 — Study/Mock chooser popup. `Sheet`'s own backdrop
          (`km-sheet__backdrop`, styles/index.css) already renders a
          semi-transparent scrim (`rgba(6,8,12,.55)` + blur) per the ticket —
          no shared CSS change was needed. Both flows stay fully reachable
          underneath: the Tabs switch below is untouched, so dismissing the
          sheet (Esc/backdrop, or an explicit pick) always lands on a live,
          already-populated landing rather than a blank gate.

          Fix-pass batch-4 (REVIEW_batch4-fidelity.md gap-d): a `tone`
          opts this sheet into the Seoul signboard/hanji edge.

          F-191 (fix-pass round 4 follow-up): this used to be the literal
          `tone="accent"` — TOPIK's OWN chrome borrowing the runtime
          accent-preset token, back when TOPIK and Grammar both shared it
          (see `lib/skill-colors.ts`'s BLOCKER-2 history). Now that TOPIK has
          its own dedicated fixed hue (`SKILL_COLOR.topik.tone`, resolving to
          `stone`), every TOPIK-identity surface on this page and
          `MockMode.tsx` — this chooser gate, the session tally, the study/
          exam hero cards, the milestone stamps, the attempts tiles, and the
          shared results score panel — reads that ONE token, so the page's
          own "personality" matches its `stone` honeycomb tile/Today tile
          instead of a leftover mix of the shared accent token and Vocab's
          fixed `blue` (a hue collision the old `tone="blue"` sites had with
          Vocab's own identity — see `CityCard.tsx`'s doc comment on what
          `blue` means). The one deliberate exception is `MockMode.tsx`'s
          `sectionTone()` — that differentiates the mock EXAM's
          reading/listening/writing sections, a different concept from "this
          is TOPIK," and is intentionally left alone (see its own doc
          comment). */}
      <Sheet
        open={chooserOpen}
        onClose={() => {
          setChooserOpen(false);
        }}
        ariaLabel="Choose Study or Mock"
        tone={SKILL_COLOR.topik.tone}
      >
        <div className="km-topik__chooser">
          <Eyebrow>
            <Bilingual en="TOPIK · 기출" kr="기출 · TOPIK" compact />
          </Eyebrow>
          <p className="kr-display km-topik__chooser-title">
            <Bilingual en="How do you want to work?" kr="어떻게 공부할까요?" />
          </p>
          <div className="km-topik__chooser-opts">
            <CityCard tone={SKILL_COLOR.topik.tone} rail className="km-topik__chooser-card">
              <button
                type="button"
                className="km-topik__chooser-opt focusring"
                onClick={() => {
                  chooseMode('study');
                }}
              >
                <span
                  className="kr-display km-topik__chooser-glyph"
                  aria-hidden="true"
                >
                  공부
                </span>
                <span className="km-topik__chooser-label">
                  <Bilingual en="Study" kr="공부" />
                </span>
                <span className="km-topik__chooser-sub">
                  <Bilingual en="Daily questions" kr="일일 문제" compact />
                </span>
              </button>
            </CityCard>
            <CityCard tone={SKILL_COLOR.topik.tone} rail className="km-topik__chooser-card">
              <button
                type="button"
                className="km-topik__chooser-opt focusring"
                onClick={() => {
                  chooseMode('mock');
                }}
              >
                <span
                  className="kr-display km-topik__chooser-glyph"
                  aria-hidden="true"
                >
                  모의
                </span>
                <span className="km-topik__chooser-label">
                  <Bilingual en="Mock" kr="모의" />
                </span>
                <span className="km-topik__chooser-sub">
                  <Bilingual en="Timed exam" kr="시간 제한 시험" compact />
                </span>
              </button>
            </CityCard>
          </div>
        </div>
      </Sheet>

      {/* Study ⇄ Mock via the shared Tabs primitive (W3C tabs pattern; roving
          tabindex + automatic activation come from the component). Controlled:
          the URL owns the selection, so browser back and deep links work. The
          two modes stay sibling components — switching unmounts the other
          subtree (and tears down the exam timer). */}
      <Tabs
        tabs={MODES.map((m) => ({
          id: m.id,
          label: <Bilingual en={m.label} kr={m.kr} compact />,
        }))}
        ariaLabel="Study or Mock test mode"
        active={mode}
        onChange={selectMode}
        className="km-topik__modes-tabs"
      >
        {(activeId) =>
          activeId === 'mock' ? (
            <MockMode />
          ) : (
            <StudyMode tally={tally} setTally={setTally} />
          )
        }
      </Tabs>
    </section>
  );
}

/**
 * F-078 — the study landing's right/wrong tally. The top counts are the
 * SESSION's client-side truth (every Study-mode reveal the learner actually
 * saw, across sets). Below that, `daily` is the PERSISTED total of TODAY's
 * completed mock exams (F-104, `GET /topik/attempts`) — a genuinely different
 * measurement (mock sittings, not Study items), rendered as its own honest
 * line rather than merged into "session" and misrepresented as the same
 * count. The 10-item line keeps B-029's "daily recommended" indicator now
 * that the draw size itself is user-controlled.
 */
function SessionTally({
  right,
  wrong,
  daily,
}: {
  right: number;
  wrong: number;
  daily: DailyMockTotal;
}): JSX.Element {
  return (
    // F-128 device #1/#2 — a stone-tone (TOPIK's own dedicated identity,
    // F-191) CityCard signboard/hanji-paper surface with a leading
    // DancheongRail, replacing the plain flat Card.
    <CityCard
      tone={SKILL_COLOR.topik.tone}
      rail
      className="km-topik__tally"
      role="group"
      aria-label="Session tally"
    >
      <Eyebrow>
        <Bilingual en="This session" kr="이번 세션" />
      </Eyebrow>
      {/* aria-live: the counts re-announce as answers land. */}
      <p className="km-topik__tally-counts" aria-live="polite">
        <span className="km-topik__tally-right">
          <Icon name="check" size={14} />{' '}
          <Bilingual en={`${String(right)} right`} kr={`맞음 ${String(right)}`} compact />
        </span>
        <span className="km-topik__tally-wrong">
          {'✗ '}
          <Bilingual en={`${String(wrong)} wrong`} kr={`틀림 ${String(wrong)}`} compact />
        </span>
      </p>

      {/* F-104: today's completed-mock total — real, persisted data replacing
          the old "coming soon" placeholder. Loading/error+retry/honest-empty,
          never fabricated. */}
      <p className="km-topik__tally-daily" aria-live="polite">
        {daily.status === 'loading' ? (
          <Bilingual en="Loading today's mock total…" kr="오늘 모의고사 기록 불러오는 중…" compact />
        ) : null}
        {daily.status === 'error' ? (
          <span role="alert">
            <Bilingual en="Couldn't load today's mock total." kr="오늘 기록을 불러오지 못했어요." compact />{' '}
            <button
              type="button"
              className="km-topik__tally-retry focusring"
              onClick={daily.onRetry}
            >
              <Bilingual en="Retry" kr="다시 시도" compact />
            </button>
          </span>
        ) : null}
        {daily.status === 'ready' && daily.right + daily.wrong === 0 ? (
          <Bilingual
            en="No mock exams completed today yet."
            kr="오늘 완료한 모의고사가 아직 없어요."
            compact
          />
        ) : null}
        {daily.status === 'ready' && daily.right + daily.wrong > 0 ? (
          <Bilingual
            en={`Today's mock exams: ${String(daily.right)} right · ${String(daily.wrong)} wrong`}
            kr={`오늘 모의고사: 맞음 ${String(daily.right)} · 틀림 ${String(daily.wrong)}`}
            compact
          />
        ) : null}
      </p>

      <p className="km-topik__tally-note">
        <Bilingual en="Daily recommended: 10 items." kr="하루 권장량은 10문항이에요." />
      </p>
    </CityCard>
  );
}

/** Section badge label — Korean wire label already; kept as-is for display. */
function formatAttemptHeadline(a: TopikAttemptHistoryEntry): string {
  const levelPart = a.topikLevel !== null ? `${a.topikLevel} · ` : '';
  return `${levelPart}${a.section} · Test ${String(a.sourceTest)}`;
}

/** One completed-exam row (F-082) — grade + correct/total + date. */
function AttemptHistoryRow({ a }: { a: TopikAttemptHistoryEntry }): JSX.Element {
  const percentage =
    a.totalItems > 0 ? Math.round((a.correct / a.totalItems) * 1000) / 10 : 0;
  const band = bandForPercentage(percentage);
  const date = new Date(a.completedAt);
  return (
    <li className="km-topik__attempt-row">
      <span className="km-topik__attempt-row-head">{formatAttemptHeadline(a)}</span>
      <span className="km-topik__attempt-row-grade">
        <Bilingual
          en={`${String(a.correct)}/${String(a.totalItems)} · ${String(percentage)}% · ${band}`}
          kr={`${String(a.correct)}/${String(a.totalItems)} · ${String(percentage)}%`}
          compact
        />
      </span>
      <span className="km-topik__attempt-row-date">
        {Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()}
      </span>
    </li>
  );
}

/**
 * F-082 — "Previous attempts" review view (`/learn/topik?view=attempts`).
 *
 * The "Completed exams" tile is now populated from `GET /topik/attempts`
 * (F-104): a list of completed exams, newest first, each with its grade and
 * correct-out-of-total. Per-question red/green review WITHIN an exam still
 * needs per-response linkage F-104 doesn't carry (it returns per-attempt
 * aggregates, not per-item picks) — so the "Wrong-question review" tile
 * keeps its jump into Review → Mistakes, where every wrong answer (across
 * all TOPIK work) already lives, rather than fabricating a per-exam
 * breakdown the data can't support yet.
 */
function AttemptsReview(): JSX.Element {
  const realFn = useCallback(() => fetchAttemptHistory({ limit: 50 }), []);
  const { data, loading, error, refetch } = useEndpointOrMock<AttemptHistoryResult>(
    'topik-attempts-review',
    loadTopikAttemptHistoryMock,
    { realFn },
  );
  const attempts = data?.attempts ?? [];

  return (
    <section
      className="screen km-topik km-rain-sheen"
      aria-labelledby="topik-attempts-title"
    >
      {/* F-024: nested sub-view → explicit back to the canonical parent. */}
      <BackButton to="/learn/topik" label="TOPIK" />
      {/* F-128 devices #4/#2 — the shared hub-header recipe replaces the
          bare Topbar, matching the parent Topik landing. */}
      <PageHubHeader
        titleId="topik-attempts-title"
        eyebrow={<Bilingual en="Completed exams · grades" kr="완료한 시험 · 성적" />}
        heading={<Bilingual en="Previous attempts" kr="지난 시험" />}
      />

      {/* F-128 device #1/#2 — each group is a CityCard signboard/hanji-paper
          tile with a leading DancheongRail, replacing the plain Card the
          default-surface CollapsibleTile used before this pass. */}
      <CollapsibleTile
        surface="city"
        tone={SKILL_COLOR.topik.tone}
        rail
        title={
          <span className="km-topik__attempts-tile-title">
            <Bilingual en="Completed exams" kr="완료한 시험" />
          </span>
        }
      >
        {loading ? (
          <p className="km-topik__pending" role="status">
            <Bilingual en="Loading your completed exams…" kr="완료한 시험을 불러오는 중…" />
          </p>
        ) : null}

        {!loading && error && attempts.length === 0 ? (
          <div className="km-topik__pending" role="alert">
            <Bilingual
              en="Couldn't load your completed exams."
              kr="완료한 시험을 불러오지 못했어요."
            />{' '}
            {errorMessageFor(error, 'Try again in a moment.')}
            <div className="km-topik__footer">
              <Button variant="gold" onClick={refetch}>
                <Bilingual en="Try again" kr="다시 시도" />
              </Button>
            </div>
          </div>
        ) : null}

        {!loading && !error && attempts.length === 0 ? (
          // Honest empty state — a real absence, never fabricated. Devices
          // #3/#6 (giwa texture + hangul watermark) mark it as genuinely
          // empty rather than pending.
          <p
            className="km-topik__pending km-giwa km-hangul-watermark"
            data-glyph="시험"
            role="status"
          >
            <Bilingual
              en="You haven't completed a mock exam yet. Finish one in Mock mode and it will show up here."
              kr="아직 완료한 모의고사가 없어요. 모의 모드에서 시험을 완료하면 여기에 표시돼요."
            />
          </p>
        ) : null}

        {attempts.length > 0 ? (
          <ul className="km-topik__attempt-list">
            {attempts.map((a) => (
              <AttemptHistoryRow key={a.attemptId} a={a} />
            ))}
          </ul>
        ) : null}
      </CollapsibleTile>

      <CollapsibleTile
        surface="city"
        tone={SKILL_COLOR.topik.tone}
        rail
        title={
          <span className="km-topik__attempts-tile-title">
            <Bilingual en="Wrong-question review" kr="오답 복습" />
          </span>
        }
      >
        <p
          className="km-topik__pending km-giwa km-hangul-watermark"
          data-glyph="복습"
        >
          <Bilingual
            en="Per-exam wrong-question review (which question, in which exam) isn't broken out yet — but every recent miss across all TOPIK work is already reviewable:"
            kr="시험별 오답 복습(어느 시험의 몇 번 문제인지)은 아직 준비 중이에요 — 최근에 틀린 문제는 지금도 복습할 수 있어요:"
          />
        </p>
        {/* Wired: the Mistakes page is where wrong answers + full
            explanations already live. */}
        <Link to="/review/mistakes" className="km-topik__attempts-link focusring">
          <Bilingual en="Review your mistakes" kr="틀린 문제 복습" />{' '}
          <Icon name="arrow-right" size={13} />
        </Link>
      </CollapsibleTile>
    </section>
  );
}

/**
 * Percentage → readiness band headline. Mirrors the server's Mock-mode
 * `bandForPercentage` (server/src/routes/topik.ts) so Study's client-tallied
 * results screen (F-008) reads consistently with Mock's server-computed one.
 * Duplicated rather than imported: Study's tally is a client-side summary of
 * reveals the learner already saw (no server round trip), and the two
 * scoring paths are already independent (inline vs DB-graded) — this is
 * presentation parity, not a shared grading contract.
 */
function bandForPercentage(percentage: number): string {
  if (percentage >= 80) return 'On track for L5+';
  if (percentage >= 60) return 'L4 range';
  if (percentage >= 40) return 'L3 range';
  return 'Below L3';
}

/**
 * Tally Study mode's client-side review log into the shared `ResultsSummary`
 * (F-008) — mirrors MockMode.tsx's `buildMockResultsSummary`, but the rows
 * are already-normalized reveals from the draw rather than a server grade.
 */
function buildStudySummary(
  rows: ResultsReviewRow[],
  answered: number,
): ResultsSummary {
  const totalItems = rows.length;
  const correct = rows.filter((r) => r.isCorrect).length;
  const percentage =
    totalItems > 0 ? Math.round((correct / totalItems) * 1000) / 10 : 0;
  return {
    percentage,
    band: bandForPercentage(percentage),
    correct,
    totalItems,
    answered,
    rows,
  };
}

/**
 * Study mode — the Pass-6 live flow. Owns its own draw, stepping state, and
 * reveal interaction. On completing the draw it renders the shared
 * `TopikResults` grade screen (F-008), fed by a client-side tally of the
 * reveals shown along the way (`reviewLog` below) rather than a second
 * grading pass — Study items already carry the inline answer, so there is
 * nothing left to ask the server.
 */
/**
 * B-029: selectable draw sizes beyond the server's default of 10. `''` is the
 * FilterSelect placeholder slot = "let the server default apply" (10 — the
 * daily recommended amount, said so in the label). 50 is the server's schema
 * max (`StudyBodySchema.limit.max(50)`), so every option is a value the
 * boundary accepts.
 */
const SET_SIZE_OPTIONS = [
  { value: '20', label: '20 items · 20문항' },
  { value: '30', label: '30 items · 30문항' },
  { value: '50', label: '50 items · 50문항 (max)' },
] as const;

/** I/O boundary: FilterSelect emits free strings — accept only known sizes. */
function parseSetSize(raw: string): SetSize {
  return raw === '20' || raw === '30' || raw === '50' ? raw : '';
}

function StudyMode({
  tally,
  setTally,
}: {
  tally: Tally;
  setTally: Dispatch<SetStateAction<Tally>>;
}): JSX.Element {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [answered, setAnswered] = useState(0);
  // Bumped on "New set" to drive a fresh draw + keep reveal-block ids unique.
  const [drawKey, setDrawKey] = useState(0);
  // B-029: how many items the next draw requests ('' = server default 10).
  const [setSize, setSetSize] = useState<SetSize>('');
  // F-078: cumulative right/wrong across the whole session — appended in
  // commitReview and NEVER reset by "New set" or a size change, so the tally
  // survives multiple draws. (Deliberately not persisted: the true daily
  // number needs the F-104 history route; a half-persisted client count
  // would just be a subtler fabrication.) SF-2: `tally`/`setTally` are now
  // props lifted to the `Topik` root — see the prop-drilling comment there —
  // so the count also survives a mode switch or a trip to "Previous
  // attempts" and back, neither of which unmounts `Topik` itself.
  // The server's grade for the CURRENT item's submit, keyed by item id so a
  // late-resolving response for a previous item can never populate the next
  // item's reveal. Used only to backfill a missing inline explanation — the
  // reveal itself never waits on it (see handleSubmit).
  const [serverReveal, setServerReveal] = useState<{
    itemId: string;
    result: TopikAnswerResult;
  } | null>(null);
  // Client-side tally of every item's outcome (F-008), appended once per item
  // as the learner leaves it (Next after reveal, or Skip) — never mutated
  // after append, so a stale re-render can't rewrite history. Feeds the
  // shared `TopikResults` screen once the draw completes.
  const [reviewLog, setReviewLog] = useState<ResultsReviewRow[]>([]);

  // B-029: forward the chosen size; '' omits `limit` so the server default
  // (10, the daily recommended amount) applies. The hook stores realFn in a
  // ref (latest closure), and the key carries BOTH the draw key and the size,
  // so a size change is a real refetch — never a stale-limit rerun.
  const realFn = useCallback(
    () => fetchStudyDraw(buildStudyDrawOptions(setSize)),
    [setSize],
  );
  const { data, loading, error, isMock, refetch } = useEndpointOrMock<
    TopikItem[]
  >(`topik-study-${String(drawKey)}-${setSize === '' ? '10' : setSize}`, loadTopikStudyMock, {
    realFn,
  });

  // F-078/F-104: today's completed-mock total — a SEPARATE hook call (own
  // key, own mock loader) from the study draw above, so the two never
  // collide on `useEndpointOrMock`'s key-scoped state. Bounded to the most
  // recent 100 completed attempts (the server's paging max) — a best-effort
  // "today" scan appropriate for this app's personal, single-user scale
  // (see project_korean_master_personal_scope).
  const dailyRealFn = useCallback(() => fetchAttemptHistory({ limit: 100 }), []);
  const {
    data: dailyHistory,
    loading: dailyLoading,
    error: dailyError,
    refetch: refetchDaily,
  } = useEndpointOrMock<AttemptHistoryResult>(
    'topik-daily-total',
    loadTopikAttemptHistoryMock,
    { realFn: dailyRealFn },
  );
  const daily: DailyMockTotal = useMemo(() => {
    if (dailyLoading) return { status: 'loading' };
    if (dailyError !== null) return { status: 'error', onRetry: refetchDaily };
    const { right, wrong } = sumTodaysMockAttempts(
      dailyHistory?.attempts ?? [],
      new Date(),
    );
    return { status: 'ready', right, wrong };
  }, [dailyLoading, dailyError, dailyHistory, refetchDaily]);

  const draw = data ?? [];
  const current: TopikItem | undefined = draw[idx];
  const isComplete = draw.length > 0 && idx >= draw.length;

  // Publish the CURRENT study item for the chat FAB's discuss-this-page
  // popup (Slice 3). Study mode only — MockMode never publishes (the FAB is
  // hidden during a timed exam anyway), and the completed/terminal state
  // has no single item to discuss.
  useChatContext(
    current !== undefined && !isComplete
      ? {
          pageLabel: 'TOPIK study · TOPIK 학습',
          summary: `Question ${String(current.number)} (Level ${String(
            current.level,
          )}): ${current.prompt}`,
        }
      : null,
  );

  // Step to the next item, clearing the per-item interaction state. Walking
  // `idx` past the last item lands on the "draw complete" terminal state.
  const advance = useCallback(() => {
    setPicked(null);
    setRevealed(false);
    setServerReveal(null);
    setIdx((i) => i + 1);
  }, []);

  // Fetch a fresh draw and reset to the first item. The hook resets `data`
  // while the refetch is in flight, so the loading skeleton reappears. The
  // session tally (F-078) deliberately survives — it counts the session, not
  // the set.
  const startNewSet = useCallback(() => {
    setIdx(0);
    setPicked(null);
    setRevealed(false);
    setServerReveal(null);
    setAnswered(0);
    setReviewLog([]);
    setDrawKey((k) => k + 1);
    refetch();
  }, [refetch]);

  // B-029: a size change is a new draw. The drawKey bump changes the hook key
  // together with the size, which triggers the refetch by itself — no
  // explicit refetch() needed (and calling it too would double-fetch).
  const handleSizeChange = useCallback((raw: string) => {
    setSetSize(parseSetSize(raw));
    setIdx(0);
    setPicked(null);
    setRevealed(false);
    setServerReveal(null);
    setAnswered(0);
    setReviewLog([]);
    setDrawKey((k) => k + 1);
  }, []);

  // The explanation text to tally for THIS item's review row: the inline one
  // when present, else the server grade's — same fallback TopikBody applies
  // to its live reveal (backfills the live pool, which currently ships no
  // inline explanations), keyed by item id so a stale response for a
  // different item can never leak into this row.
  const effectiveExplanation = useCallback(
    (item: TopikItem): string => {
      const inline = item.explanation.trim();
      if (inline !== '') return inline;
      if (serverReveal !== null && serverReveal.itemId === item.id) {
        return serverReveal.result.explanation.trim();
      }
      return '';
    },
    [serverReveal],
  );

  // Normalize one item's outcome into the shared review-row shape (F-008) —
  // `pick === null` records a skip (graded as a miss, matching Mock mode's
  // treatment of an unanswered item).
  const buildReviewRow = useCallback(
    (item: TopikItem, pick: string | null, explanation: string): ResultsReviewRow => {
      const correctIdx = item.options.findIndex((o) => o.correct);
      const correctOpt = correctIdx >= 0 ? item.options[correctIdx] : undefined;
      const pickedOpt =
        pick !== null ? item.options.find((o) => o.id === pick) : undefined;
      const isCorrect =
        pick !== null && correctOpt !== undefined && pick === correctOpt.id;
      return {
        key: item.id,
        number: item.number,
        prompt: item.prompt,
        ...(item.passage !== undefined ? { passage: item.passage } : {}),
        isCorrect,
        pickedText: pickedOpt ? pickedOpt.kr : SKIPPED_PICK,
        correctText: correctOpt ? correctOpt.kr : '—',
        explanation,
      };
    },
    [],
  );

  const commitReview = useCallback(
    (item: TopikItem, pick: string | null): void => {
      const explanation = effectiveExplanation(item);
      const row = buildReviewRow(item, pick, explanation);
      setReviewLog((log) => [...log, row]);
      // F-078: the session tally counts every committed outcome (a skip is a
      // miss, matching the results summary's grading).
      setTally((t) =>
        row.isCorrect
          ? { right: t.right + 1, wrong: t.wrong }
          : { right: t.right, wrong: t.wrong + 1 },
      );
    },
    // `setTally` is a prop now (SF-2 lifted the tally to `Topik`), not a
    // locally-`useState`d setter — the compiler can't assume its identity
    // is stable at this component's boundary, so it belongs in the deps
    // even though a React `useState` setter never actually changes.
    [buildReviewRow, effectiveExplanation, setTally],
  );

  // Skip: leave the item unanswered — tallied as a miss (F-008) — then
  // advance. Reads `current` BEFORE `advance()` clears per-item state.
  const handleSkip = useCallback(() => {
    if (current !== undefined) commitReview(current, null);
    advance();
  }, [current, commitReview, advance]);

  // Next (after reveal): tally the item's outcome with the learner's actual
  // pick, then advance. Reads `picked`/`current` BEFORE `advance()` clears them.
  const handleNext = useCallback(() => {
    if (current !== undefined && picked !== null) commitReview(current, picked);
    advance();
  }, [current, picked, commitReview, advance]);

  const handleSubmit = useCallback(() => {
    if (picked === null || current === undefined) return;
    setRevealed(true);
    setAnswered((n) => n + 1);
    // Record the answer WITHOUT blocking the reveal: correctness is driven off
    // the inline `correct` flag, so the reveal renders instantly and a failure
    // here can never break the study flow. The server's grade IS consumed when
    // it resolves, though — its `explanation` backfills items whose inline
    // explanation is empty (the live pool currently has none inline), keyed by
    // item id so a stale response can't leak onto the next item. Failures stay
    // silent by design: a transient miss on this write changes nothing the
    // user needs mid-quiz, and the threat model commits to never surfacing a
    // server error from it. The `.catch` keeps the rejection handled so it
    // never becomes an unhandled promise rejection.
    const itemId = current.id;
    void recordTopikAnswer(itemId, { picked, mode: 'study' })
      .then((result) => {
        setServerReveal({ itemId, result });
      })
      .catch(() => {});
  }, [picked, current]);

  return (
    <div style={{ position: 'relative' }}>
      {isMock ? <MockBadge /> : null}

      {/* F-078 session tally + B-029 draw-size control + the F-082 entry.
          Rendered above the flow in every study state so the landing always
          carries them (they are landing chrome, not per-item state). */}
      <SessionTally right={tally.right} wrong={tally.wrong} daily={daily} />
      <div className="km-topik__controls">
        <FilterSelect
          label="Set size · 세트 크기"
          placeholder="10 · recommended · 권장"
          options={SET_SIZE_OPTIONS}
          value={setSize}
          onChange={handleSizeChange}
        />
        <Link
          to="/learn/topik?view=attempts"
          className="km-topik__attempts-link focusring"
        >
          <Bilingual en="Previous attempts" kr="지난 시험 기록" compact />{' '}
          <Icon name="arrow-right" size={13} />
        </Link>
      </div>

      {!loading && current ? (
        <>
          {/* F-128 device #5 — the signature subway-line progress metaphor
              for stepping through the draw, alongside the existing numeric
              readout (kept for the exact "N / M" reading the dots don't
              spell out in text). */}
          <div className="km-topik__subwaywrap">
            <SubwayProgress
              steps={draw.length}
              current={idx}
              tone={SKILL_COLOR.topik.tone}
              label="Study progress"
              valueText={`Item ${String(idx + 1)} of ${String(draw.length)}`}
            />
          </div>
          <div className="km-topik__substate" role="status">
            <Eyebrow>
              {current.section}
              {' · '}
              <Bilingual
                en={`Item ${String(idx + 1)} / ${String(draw.length)}`}
                kr={`문제 ${String(idx + 1)} / ${String(draw.length)}`}
              />
            </Eyebrow>
          </div>
        </>
      ) : null}

      {loading ? (
        <div className="km-topik__state" role="status">
          <Bilingual en="Loading items…" kr="문제를 불러오는 중…" />
        </div>
      ) : null}

      {!loading && error && draw.length === 0 ? (
        <div className="km-topik__state km-topik__state--error" role="alert">
          Couldn’t load study items.{' '}
          {errorMessageFor(error, 'Try again in a moment.')}
          <div className="km-topik__footer">
            <Button variant="gold" onClick={startNewSet}>
              <Bilingual en="Try again" kr="다시 시도" />
            </Button>
          </div>
        </div>
      ) : null}

      {!loading && isComplete ? (
        <>
          {/* F-128 device #7 — a milestone 도장 stamp marking the finished
              draw, ahead of the shared results/grade screen Mock mode also
              uses (F-008), fed by the client-side tally of reveals shown
              along the way. */}
          <div className="km-topik__milestone">
            <SealStamp
              milestone
              tone={SKILL_COLOR.topik.tone}
              label={<Bilingual en="Set complete" kr="세트 완료" compact />}
            />
          </div>
          <TopikResults
            summary={buildStudySummary(reviewLog, answered)}
            onRestart={startNewSet}
            restartLabel={<Bilingual en="New set" kr="새 세트" />}
          />
        </>
      ) : null}

      {!loading && !error && draw.length === 0 ? (
        // A successful draw can legitimately be empty (an over-narrow filter or
        // an empty pool returns `{ items: [] }`). Without this branch the screen
        // is a dead-end header with no items and no way forward; offer a fresh
        // pull instead. Devices #3/#6 (giwa texture + hangul watermark) mark
        // it as genuinely empty rather than pending.
        <Card
          variant="flat"
          className="km-topik__state km-giwa km-hangul-watermark"
          data-glyph="문제"
          role="status"
        >
          <Eyebrow>
            <Bilingual en="No items" kr="문제 없음" />
          </Eyebrow>
          <p className="km-topik__explain">
            <Bilingual
              en="No items match right now. Pull a fresh set to try again."
              kr="지금은 맞는 문제가 없어요. 새 세트를 뽑아 보세요."
            />
          </p>
          <div className="km-topik__footer">
            <Button
              variant="gold"
              onClick={startNewSet}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              <Bilingual en="New set" kr="새 세트" />
            </Button>
          </div>
        </Card>
      ) : null}

      {!loading && current ? (
        <TopikBody
          item={current}
          idx={idx}
          drawKey={drawKey}
          answered={answered}
          picked={picked}
          revealed={revealed}
          serverReveal={
            serverReveal !== null && serverReveal.itemId === current.id
              ? serverReveal.result
              : null
          }
          onPick={(id) => {
            if (!revealed) setPicked(id);
          }}
          onSubmit={handleSubmit}
          onSkip={handleSkip}
          onNext={handleNext}
        />
      ) : null}
    </div>
  );
}

interface TopikBodyProps {
  item: TopikItem;
  idx: number;
  drawKey: number;
  answered: number;
  picked: string | null;
  revealed: boolean;
  /** The server's grade for THIS item's submit (null until it resolves). */
  serverReveal: TopikAnswerResult | null;
  onPick: (id: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onNext: () => void;
}

function TopikBody({
  item,
  idx,
  drawKey,
  answered,
  picked,
  revealed,
  serverReveal,
  onPick,
  onSubmit,
  onSkip,
  onNext,
}: TopikBodyProps): JSX.Element {
  const correctIndex = item.options.findIndex((o) => o.correct);
  const correctChoice =
    correctIndex >= 0 ? item.options[correctIndex] : undefined;
  // The learner's picked option — feeds the "Ask about this" seed (F-020)
  // so a wrong pick travels to Chat as "My answer: … (incorrect)".
  const pickedChoice =
    picked !== null ? item.options.find((o) => o.id === picked) : undefined;
  const isCorrect =
    revealed && picked !== null && picked === correctChoice?.id;
  // Unique per draw + position so two draws never collide on the same id.
  const revealBlockId = `topik-reveal-${String(drawKey)}-${String(idx)}`;
  // The explanation to show: the inline one when present, else the server
  // grade's (backfills the live pool, whose items carry no inline explanation
  // yet — POST /topik/:itemId/answer returns the same field). Both empty →
  // the paragraph is omitted; the reveal still names the correct answer.
  const inlineExplanation = item.explanation.trim();
  const serverExplanation = serverReveal?.explanation.trim() ?? '';
  const explanation =
    inlineExplanation !== '' ? inlineExplanation : serverExplanation;
  // The reveal block always has content once revealed (verdict + the correct
  // answer), so the choices can always point at it — never a dangling ref.
  const describedBy = revealed ? revealBlockId : undefined;
  // Image-dependent item (no stored asset): feature the bracketed text
  // description in a labelled block instead of leaving it buried in the
  // prompt. Non-image items render their prompt untouched.
  const imageSplit =
    item.hasImage === true
      ? splitImageItem(item.prompt, item.imageText)
      : null;

  return (
    // F-128 device #1/#2 — the live study item is the page's actual hero
    // surface, mirroring Grammar's live-drill treatment: a CityCard
    // signboard/hanji-paper card with a leading DancheongRail, not a bare
    // fragment riding on the page's own padding.
    <CityCard rail tone={SKILL_COLOR.topik.tone} className="km-topik__card">
      <div className="km-topik__meta">
        <Pill tone="gold">
          {item.section} · L{String(item.level)}
        </Pill>
        <span className="km-topik__num">
          <Bilingual
            en={`No. ${String(item.number)}`}
            kr={`${String(item.number)}번`}
            compact
          />
        </span>
      </div>

      {imageSplit === null ? (
        <p className="kr km-topik__prompt">{item.prompt}</p>
      ) : (
        <>
          {imageSplit.body !== '' ? (
            <p className="kr km-topik__prompt">{imageSplit.body}</p>
          ) : null}
          <TopikImageNote description={imageSplit.description} />
        </>
      )}

      {/* Shared reading passage (B-008) — the text the question is about,
          rendered before the choices so the item is answerable. */}
      {item.passage ? <TopikPassage text={item.passage} /> : null}

      <div
        className="km-topik__choices"
        role="radiogroup"
        aria-label="Answer choices"
      >
        {item.options.map((o, i) => {
          const isPicked = picked === o.id;
          const showCorrect = revealed && o.correct;
          const showWrong = revealed && isPicked && !o.correct;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              // `aria-checked` is the radio contract; `aria-pressed` is for
              // toggle buttons. Carrying both confuses some AT pipelines (they
              // branch on whichever they encounter first), so only aria-checked
              // is set here — matching Diagnostic.tsx and every other repo
              // radiogroup.
              aria-checked={isPicked}
              aria-describedby={describedBy}
              disabled={revealed}
              className={cn(
                'km-topik__choice focusring',
                isPicked && !revealed && 'km-topik__choice--picked',
                showCorrect && 'km-topik__choice--correct',
                showWrong && 'km-topik__choice--wrong',
              )}
              onClick={() => {
                onPick(o.id);
              }}
            >
              <span className="km-topik__marker">{CHOICE_MARKERS[i]}</span>
              <span className="km-topik__choice-body">
                <span className="kr km-topik__choice-kr">{o.kr}</span>
                <span className="km-topik__choice-en">{o.en}</span>
              </span>
              {showCorrect ? <Icon name="check" size={16} /> : null}
            </button>
          );
        })}
      </div>

      {revealed ? (
        <Card variant="flat" className="km-topik__reveal" id={revealBlockId}>
          <Eyebrow>
            {isCorrect ? (
              <Bilingual en="Correct" kr="맞았어요" />
            ) : (
              <Bilingual en="Not quite" kr="틀렸어요" />
            )}
          </Eyebrow>
          {correctChoice !== undefined ? (
            // Name the correct answer in text (not just the green highlight
            // above) so a wrong answer is never a dead-end "Not quite" — the
            // reveal always says what the right answer was.
            <p className="km-topik__answer">
              <Bilingual en="Correct answer" kr="정답" />:{' '}
              <span className="kr">
                {CHOICE_MARKERS[correctIndex] ?? ''} {correctChoice.kr}
              </span>
            </p>
          ) : null}
          {explanation !== '' ? (
            <p className="km-topik__explain">{explanation}</p>
          ) : null}
          {/* F-020: hand the just-revealed item to the Chat tutor. Only
              rendered inside the reveal block, so there is always content
              (verdict + correct answer) to ask about. */}
          <div style={{ marginTop: 10 }}>
            <AskAboutThisButton
              prompt={item.prompt}
              correctText={correctChoice?.kr ?? ''}
              passage={item.passage}
              explanation={explanation !== '' ? explanation : undefined}
              userPick={!isCorrect ? pickedChoice?.kr : undefined}
            />
          </div>
        </Card>
      ) : null}

      <div className="km-topik__footer">
        {!revealed ? (
          <>
            <Button variant="ghost" onClick={onSkip}>
              <Bilingual en="Skip" kr="건너뛰기" />
            </Button>
            <Button
              variant="gold"
              onClick={onSubmit}
              disabled={picked === null}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              <Bilingual en="Submit" kr="제출" />
            </Button>
          </>
        ) : (
          <>
            <span className="km-topik__count">
              <Bilingual
                en={`${String(answered)} answered`}
                kr={`답변 ${String(answered)}개`}
                compact
              />
            </span>
            <Button
              variant="gold"
              onClick={onNext}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              <Bilingual en="Next" kr="다음" />
            </Button>
          </>
        )}
      </div>
    </CityCard>
  );
}

export default Topik;
