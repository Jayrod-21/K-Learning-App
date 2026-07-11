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
 */
import { useCallback, useState, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AskAboutThisButton } from '../components/AskAboutThisButton';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { Button } from '../components/Button';
import { FilterSelect } from '../components/FilterSelect';
import { Pill } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { Tabs } from '../components/Tabs';
import { TopikImageNote } from '../components/TopikImageNote';
import { TopikPassage } from '../components/TopikPassage';
import { useChatContext } from '../hooks/useChatContext';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadTopikStudyMock } from '../data/mocks/topik';
import { fetchStudyDraw, recordTopikAnswer } from '../services/topik';
import { cn } from '../lib/cn';
import { splitImageItem } from '../lib/topikImage';
import { errorMessageFor } from '../lib/errorCopy';
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

/** The two TOPIK Prep modes the segmented toggle switches between. */
type TopikMode = 'study' | 'mock';

const MODES: ReadonlyArray<{ id: TopikMode; label: string; kr: string }> = [
  { id: 'study', label: 'Study', kr: '학습' },
  { id: 'mock', label: 'Mock', kr: '모의' },
];

function Topik(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  // URL params are untrusted input — parse against closed unions and degrade
  // to the default view on anything unrecognised (never interpolated).
  const view = searchParams.get('view') === 'attempts' ? 'attempts' : null;
  const mode: TopikMode = searchParams.get('mode') === 'mock' ? 'mock' : 'study';

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

  // F-082: the "Previous attempts" review view is a landing-level nested
  // sub-view — it replaces the tabbed area entirely and carries its own
  // BackButton (F-024) to the canonical parent route.
  if (view === 'attempts') return <AttemptsReview />;

  return (
    <section className="screen km-topik" aria-labelledby="topik-title">
      {/* P3b: title aligned with nav.ts's headerTitle (모의 · TOPIK) — the
          old 학습 was a pre-P1.1 leftover and collided with "study mode". */}
      <Topbar
        krTitle="모의"
        title="TOPIK"
        titleId="topik-title"
        eyebrow={
          mode === 'mock' ? (
            <Bilingual en="Mock test · timed" kr="모의고사 · 시간 제한" />
          ) : (
            <Bilingual en="Study mode" kr="학습 모드" />
          )
        }
      />

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
        {(activeId) => (activeId === 'mock' ? <MockMode /> : <StudyMode />)}
      </Tabs>
    </section>
  );
}

/**
 * F-078 — the study landing's right/wrong tally. The counts are the SESSION's
 * client-side truth (every reveal the learner actually saw, across sets); the
 * full-day totals genuinely need the attempt/response history route
 * (`GET /topik/attempts`, ticket F-104), so the tile says "session" and marks
 * the daily number as pending rather than fabricating one. The 10-item line
 * keeps B-029's "daily recommended" indicator now that the draw size itself
 * is user-controlled.
 */
function SessionTally({
  right,
  wrong,
}: {
  right: number;
  wrong: number;
}): JSX.Element {
  return (
    <Card
      variant="flat"
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
      <p className="km-topik__tally-note">
        <Bilingual
          en="Daily recommended: 10 items. Full-day totals will appear once attempt history is available."
          kr="하루 권장량은 10문항이에요. 하루 전체 기록은 준비 중이에요."
        />
      </p>
    </Card>
  );
}

/**
 * F-082 — "Previous attempts" review view (`/learn/topik?view=attempts`).
 *
 * Designed structure: a list of completed exams (grade + correct-out-of-total)
 * whose wrong questions render red in the mock review-tile format, each
 * deep-linking to its explanation in Review → Mistakes. The completed-attempt
 * DATA needs `GET /topik/attempts` (ticket F-104) — until it lands the
 * sections render honestly-pending bodies (the Mistakes F-046 convention) and
 * NOTHING is fabricated. The one part that exists today is wired: the jump
 * into Review → Mistakes, where every wrong answer already lives.
 */
function AttemptsReview(): JSX.Element {
  return (
    <section className="screen km-topik" aria-labelledby="topik-attempts-title">
      {/* F-024: nested sub-view → explicit back to the canonical parent. */}
      <BackButton to="/learn/topik" label="TOPIK" />
      <Topbar
        krTitle="지난 시험"
        title="Previous attempts"
        titleId="topik-attempts-title"
        eyebrow={<Bilingual en="Completed exams · grades" kr="완료한 시험 · 성적" />}
      />

      <CollapsibleTile
        title={
          <span className="km-topik__attempts-tile-title">
            <Bilingual en="Completed exams" kr="완료한 시험" />
          </span>
        }
      >
        {/* Honest pending state — completed-exam history (grade,
            correct-out-of-total, per-question red/green review) requires
            GET /topik/attempts (ticket F-104). Never fabricated. */}
        <p className="km-topik__pending" role="status">
          <Bilingual
            en="Your completed mock exams — grade and correct-out-of-total, with wrong questions marked in red — will appear here once attempt history is available. Coming soon."
            kr="완료한 모의고사의 성적과 정답 수, 빨간색으로 표시된 오답 문제가 곧 여기에 표시될 거예요. 준비 중이에요."
          />
        </p>
      </CollapsibleTile>

      <CollapsibleTile
        title={
          <span className="km-topik__attempts-tile-title">
            <Bilingual en="Wrong-question review" kr="오답 복습" />
          </span>
        }
      >
        <p className="km-topik__pending">
          <Bilingual
            en="Per-exam wrong-question review (your previous answer, then a jump to the full explanation) needs the same attempt history. Your recent misses across all TOPIK work are already reviewable:"
            kr="시험별 오답 복습(내가 고른 답과 해설 보기)도 같은 기록이 필요해요. 최근에 틀린 문제는 지금도 복습할 수 있어요:"
          />
        </p>
        {/* Wired today: the Mistakes page is where wrong answers + full
            explanations already live — the F-082 per-question jump will
            deep-link here once attempts exist. */}
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

/** The set sizes the FilterSelect can emit ('' = server default of 10). */
type SetSize = '' | '20' | '30' | '50';

/** I/O boundary: FilterSelect emits free strings — accept only known sizes. */
function parseSetSize(raw: string): SetSize {
  return raw === '20' || raw === '30' || raw === '50' ? raw : '';
}

function StudyMode(): JSX.Element {
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
  // would just be a subtler fabrication.)
  const [tally, setTally] = useState<{ right: number; wrong: number }>({
    right: 0,
    wrong: 0,
  });
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
    () => fetchStudyDraw(setSize === '' ? {} : { limit: Number(setSize) }),
    [setSize],
  );
  const { data, loading, error, isMock, refetch } = useEndpointOrMock<
    TopikItem[]
  >(`topik-study-${String(drawKey)}-${setSize === '' ? '10' : setSize}`, loadTopikStudyMock, {
    realFn,
  });

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
    [buildReviewRow, effectiveExplanation],
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
      <SessionTally right={tally.right} wrong={tally.wrong} />
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
        // F-008: the same shared results/grade screen Mock mode uses,
        // fed by the client-side tally of reveals shown along the way.
        <TopikResults
          summary={buildStudySummary(reviewLog, answered)}
          onRestart={startNewSet}
          restartLabel={<Bilingual en="New set" kr="새 세트" />}
        />
      ) : null}

      {!loading && !error && draw.length === 0 ? (
        // A successful draw can legitimately be empty (an over-narrow filter or
        // an empty pool returns `{ items: [] }`). Without this branch the screen
        // is a dead-end header with no items and no way forward; offer a fresh
        // pull instead.
        <Card variant="flat" className="km-topik__state" role="status">
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
    <>
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
    </>
  );
}

export default Topik;
