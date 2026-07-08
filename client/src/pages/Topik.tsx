/**
 * Topik — TOPIK Prep. Two modes behind a segmented toggle (FU-NF-39):
 *
 *   - **Study** (default): the Pass-6 live shuffled draw from `POST
 *     /topik/study`, one item at a time with the pick→submit→reveal→next
 *     interaction. Study items carry the inline `correct` flag (public
 *     reference data); the screen reveals correctness client-side. On
 *     finishing the draw, a results/grade screen (F-008) tallies the reveals
 *     the learner already saw into the SAME shared `TopikResults` component
 *     Mock mode uses — see `buildStudySummary` below.
 *   - **Mock**: the answer-stripped, server-graded Mock-Test taking flow. A
 *     section-select → timed exam → server-graded results state machine. The
 *     exam NEVER receives a `correct` flag — grading happens on submit
 *     (`POST /topik/mock/submit`); explanations are revealed only post-exam.
 *
 * F-009: both modes' results screens show a review row's explanation ONLY
 * when the pick was wrong — see `TopikResults` in MockMode.tsx.
 *
 * The mode toggle is a roving-tabindex radiogroup (WAI-ARIA APG) mirroring the
 * Settings ThemeModeControl / SwatchPicker pattern. Study mode and the Mock
 * subtree are sibling components so the two interaction models stay isolated:
 * switching modes unmounts the other subtree (and tears down the exam timer).
 *
 * Threat model:
 *   - **Answer leakage.** Study mode reveals off the inline `correct` flag (by
 *     design — public items). Mock mode is answer-stripped end-to-end: the
 *     `TopikMockItem` type has no `correct`/`explanation`, the exam holds only
 *     the user's own picks, and the key arrives solely in the server's
 *     `MockResult` reveal after submit. A tampered client cannot self-grade.
 *   - **Rendered text is escaped.** Every Korean string (prompts, choices,
 *     explanations) renders as a React text node — a malicious server payload
 *     becomes literal text, never markup.
 *   - **Failure-safe.** Neither mode can blank the screen: study + mock-fetch
 *     both fall back to a mock fixture (🅂 badge) via `useEndpointOrMock`, and
 *     the exam's submit failure surfaces an inline retry rather than dropping
 *     the user's work.
 */
import {
  useCallback,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { AskAboutThisButton } from '../components/AskAboutThisButton';
import { Bilingual } from '../components/Bilingual';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Pill } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
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

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

/** The two TOPIK Prep modes the segmented toggle switches between. */
type TopikMode = 'study' | 'mock';

const MODES: ReadonlyArray<{ id: TopikMode; label: string; kr: string }> = [
  { id: 'study', label: 'Study', kr: '학습' },
  { id: 'mock', label: 'Mock', kr: '모의' },
];

function Topik(): JSX.Element {
  // Default is Study — the unchanged Pass-6 flow.
  const [mode, setMode] = useState<TopikMode>('study');

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

      <ModeToggle mode={mode} onSelect={setMode} />

      <div
        role="tabpanel"
        id={`topik-panel-${mode}`}
        aria-labelledby={`topik-tab-${mode}`}
      >
        {mode === 'study' ? <StudyMode /> : <MockMode />}
      </div>
    </section>
  );
}

/**
 * Study ⇄ Mock segmented control — a `tablist` of two `tab`s implementing the
 * WAI-ARIA APG tabs keyboard contract with a roving tabindex (mirrors the
 * focus mechanics of Settings' ThemeModeControl / SwatchPicker). Selection
 * follows focus: an arrow move IS the commit, since switching modes is cheap
 * and idempotent and that's the behaviour a small two-option segmented control
 * wants.
 *
 * Deliberately a tablist (not a radiogroup): the choice group inside each mode
 * is itself a radiogroup, so modelling the mode switch as tabs keeps the two
 * ARIA roles distinct — a screen reader (and the test suite) never conflates
 * "which mode" with "which answer".
 */
function ModeToggle({
  mode,
  onSelect,
}: {
  mode: TopikMode;
  onSelect: (mode: TopikMode) => void;
}): JSX.Element {
  // Refs by id (not index) so focus management survives a future reorder,
  // matching ThemeModeControl/SwatchPicker.
  const refs = useRef<Map<TopikMode, HTMLButtonElement>>(new Map());
  const selectedIndex = MODES.findIndex((m) => m.id === mode);

  const moveTo = useCallback(
    (nextIndex: number): void => {
      const wrapped = (nextIndex + MODES.length) % MODES.length;
      const next = MODES[wrapped];
      if (!next) return;
      if (next.id !== mode) onSelect(next.id);
      refs.current.get(next.id)?.focus();
    },
    [mode, onSelect],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          moveTo(selectedIndex + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          moveTo(selectedIndex - 1);
          break;
        case 'Home':
          e.preventDefault();
          moveTo(0);
          break;
        case 'End':
          e.preventDefault();
          moveTo(MODES.length - 1);
          break;
        default:
          break;
      }
    },
    [moveTo, selectedIndex],
  );

  return (
    <div
      className="km-topik__modes"
      role="tablist"
      aria-label="Study or Mock test mode"
      // `tabIndex={-1}` makes the interactive-role container focusable WITHOUT
      // entering the Tab order (the roving tabs own Tab entry) — satisfies
      // jsx-a11y's interactive-supports-focus rule, same as the repo's
      // radiogroup containers (SwatchPicker / ThemeModeControl).
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {MODES.map((m) => {
        const selected = m.id === mode;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            id={`topik-tab-${m.id}`}
            aria-selected={selected}
            aria-controls={`topik-panel-${m.id}`}
            // Roving tabindex: only the active tab is a Tab stop, so the
            // tablist exposes a single tab entry and Tab lands on the selected
            // mode (WAI-ARIA APG tabs pattern).
            tabIndex={selected ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(m.id, el);
              else refs.current.delete(m.id);
            }}
            onClick={() => {
              if (!selected) onSelect(m.id);
            }}
            className={cn(
              'km-topik__mode focusring',
              selected && 'km-topik__mode--active',
            )}
          >
            <Bilingual en={m.label} kr={m.kr} compact />
          </button>
        );
      })}
    </div>
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
function StudyMode(): JSX.Element {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [answered, setAnswered] = useState(0);
  // Bumped on "New set" to drive a fresh draw + keep reveal-block ids unique.
  const [drawKey, setDrawKey] = useState(0);
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

  const { data, loading, error, isMock, refetch } = useEndpointOrMock<
    TopikItem[]
  >(`topik-study-${String(drawKey)}`, loadTopikStudyMock, {
    realFn: () => fetchStudyDraw({}),
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
  // while the refetch is in flight, so the loading skeleton reappears.
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
      setReviewLog((log) => [...log, buildReviewRow(item, pick, explanation)]);
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
