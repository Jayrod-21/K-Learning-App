/**
 * Topik — TOPIK Prep. Two modes behind a segmented toggle (FU-NF-39):
 *
 *   - **Study** (default, unchanged): the Pass-6 live shuffled draw from
 *     `POST /topik/study`, one item at a time with the pick→submit→reveal→next
 *     interaction. Study items carry the inline `correct` flag (public
 *     reference data); the screen reveals correctness client-side.
 *   - **Mock**: the answer-stripped, server-graded Mock-Test taking flow. A
 *     section-select → timed exam → server-graded results state machine. The
 *     exam NEVER receives a `correct` flag — grading happens on submit
 *     (`POST /topik/mock/submit`); explanations are revealed only post-exam.
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
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Pill } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadTopikStudyMock } from '../data/mocks/topik';
import { fetchStudyDraw, recordTopikAnswer } from '../services/topik';
import { cn } from '../lib/cn';
import type { TopikItem } from '../types/domain';
import { MockMode } from './topik/MockMode';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

/** The two TOPIK Prep modes the segmented toggle switches between. */
type TopikMode = 'study' | 'mock';

const MODES: ReadonlyArray<{ id: TopikMode; label: string }> = [
  { id: 'study', label: 'Study' },
  { id: 'mock', label: 'Mock' },
];

function Topik(): JSX.Element {
  // Default is Study — the unchanged Pass-6 flow.
  const [mode, setMode] = useState<TopikMode>('study');

  return (
    <section className="screen km-topik" aria-labelledby="topik-title">
      <Topbar
        krTitle={<span id="topik-title">학습 · TOPIK</span>}
        eyebrow={mode === 'mock' ? 'Mock test · timed' : 'Study mode'}
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
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Study mode — the Pass-6 live flow, untouched. Owns its own draw, stepping
 * state, and reveal interaction. Extracted from the page root verbatim so the
 * Mock toggle can render it as a sibling without entangling the two modes.
 */
function StudyMode(): JSX.Element {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [answered, setAnswered] = useState(0);
  // Bumped on "New set" to drive a fresh draw + keep reveal-block ids unique.
  const [drawKey, setDrawKey] = useState(0);

  const { data, loading, error, isMock, refetch } = useEndpointOrMock<
    TopikItem[]
  >(`topik-study-${String(drawKey)}`, loadTopikStudyMock, {
    realFn: () => fetchStudyDraw({}),
  });

  const draw = data ?? [];
  const current: TopikItem | undefined = draw[idx];
  const isComplete = draw.length > 0 && idx >= draw.length;

  // Step to the next item, clearing the per-item interaction state. Walking
  // `idx` past the last item lands on the "draw complete" terminal state.
  const advance = useCallback(() => {
    setPicked(null);
    setRevealed(false);
    setIdx((i) => i + 1);
  }, []);

  // Fetch a fresh draw and reset to the first item. The hook resets `data`
  // while the refetch is in flight, so the loading skeleton reappears.
  const startNewSet = useCallback(() => {
    setIdx(0);
    setPicked(null);
    setRevealed(false);
    setAnswered(0);
    setDrawKey((k) => k + 1);
    refetch();
  }, [refetch]);

  const handleSubmit = useCallback(() => {
    if (picked === null || current === undefined) return;
    setRevealed(true);
    setAnswered((n) => n + 1);
    // Fire-and-forget analytics: never block the reveal, never break the UI.
    // The reveal is driven off the inline `correct` flag, not this response,
    // so a failure here is genuinely ignorable. We deliberately do NOT surface
    // it through the Toast system: a transient analytics miss is not worth a
    // notification mid-quiz (it would nag the user during a test for an outcome
    // that has zero effect on what they see), and the component's threat model
    // already commits to never surfacing a server error from this write into
    // the UI. The empty `.catch` exists only to keep the rejection handled so
    // it never becomes an unhandled promise rejection.
    void recordTopikAnswer(current.id, { picked, mode: 'study' }).catch(
      () => {},
    );
  }, [picked, current]);

  return (
    <div style={{ position: 'relative' }}>
      {isMock ? <MockBadge /> : null}

      {!loading && current ? (
        <div className="km-topik__substate" role="status">
          <Eyebrow>
            {`${current.section} · Item ${String(idx + 1)} / ${String(
              draw.length,
            )}`}
          </Eyebrow>
        </div>
      ) : null}

      {loading ? (
        <div className="km-topik__state" role="status">
          Loading items…
        </div>
      ) : null}

      {!loading && error && draw.length === 0 ? (
        <div className="km-topik__state km-topik__state--error" role="alert">
          Couldn’t load study items. {error.message}
          <div className="km-topik__footer">
            <Button variant="gold" onClick={startNewSet}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {!loading && isComplete ? (
        <Card variant="flat" className="km-topik__state" role="status">
          <Eyebrow>Set complete</Eyebrow>
          <p className="km-topik__explain">
            You worked through {String(draw.length)} item
            {draw.length === 1 ? '' : 's'}. Pull a fresh set to keep going.
          </p>
          <div className="km-topik__footer">
            <Button
              variant="gold"
              onClick={startNewSet}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              New set
            </Button>
          </div>
        </Card>
      ) : null}

      {!loading && !error && draw.length === 0 ? (
        // A successful draw can legitimately be empty (an over-narrow filter or
        // an empty pool returns `{ items: [] }`). Without this branch the screen
        // is a dead-end header with no items and no way forward; offer a fresh
        // pull instead.
        <Card variant="flat" className="km-topik__state" role="status">
          <Eyebrow>No items</Eyebrow>
          <p className="km-topik__explain">
            No items match right now. Pull a fresh set to try again.
          </p>
          <div className="km-topik__footer">
            <Button
              variant="gold"
              onClick={startNewSet}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              New set
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
          onPick={(id) => {
            if (!revealed) setPicked(id);
          }}
          onSubmit={handleSubmit}
          onSkip={advance}
          onNext={advance}
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
  onPick,
  onSubmit,
  onSkip,
  onNext,
}: TopikBodyProps): JSX.Element {
  const correctChoice = item.options.find((o) => o.correct);
  const isCorrect =
    revealed && picked !== null && picked === correctChoice?.id;
  // Unique per draw + position so two draws never collide on the same id.
  const revealBlockId = `topik-reveal-${String(drawKey)}-${String(idx)}`;
  const hasExplanation = item.explanation.trim().length > 0;
  // Only point choices at the reveal block when it actually renders, so the
  // aria-describedby never dangles to a missing node.
  const describedBy = revealed && hasExplanation ? revealBlockId : undefined;

  return (
    <>
      <div className="km-topik__meta">
        <Pill tone="gold">
          {item.section} · L{String(item.level)}
        </Pill>
        <span className="km-topik__num">No. {String(item.number)}</span>
      </div>

      <p className="kr km-topik__prompt">{item.prompt}</p>

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
          <Eyebrow>{isCorrect ? 'Correct' : 'Not quite'}</Eyebrow>
          {hasExplanation ? (
            <p className="km-topik__explain">{item.explanation}</p>
          ) : null}
        </Card>
      ) : null}

      <div className="km-topik__footer">
        {!revealed ? (
          <>
            <Button variant="ghost" onClick={onSkip}>
              Skip
            </Button>
            <Button
              variant="gold"
              onClick={onSubmit}
              disabled={picked === null}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              Submit
            </Button>
          </>
        ) : (
          <>
            <span className="km-topik__count">
              {String(answered)} answered
            </span>
            <Button
              variant="gold"
              onClick={onNext}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              Next
            </Button>
          </>
        )}
      </div>
    </>
  );
}

export default Topik;
