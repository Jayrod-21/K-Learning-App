/**
 * Topik — TOPIK Prep Study mode (Pass 6, live).
 *
 * Steps a real shuffled draw from `POST /topik/study` (`fetchStudyDraw`), one
 * item at a time, keeping the Pass-2 pick→submit→reveal→next interaction. The
 * draw is a `TopikItem[]`; `idx` selects the current item. When the user steps
 * past the last item the screen shows a "draw complete" state with a "New set"
 * button that refetches a fresh draw and resets to the first item.
 *
 * Study mode reveals correctness client-side off the inline `item.options[].correct`
 * flag — TOPIK items are public reference data, so the answer is served inline
 * by design (the answer-stripped Mock-Test taking flow is FU-NF-39, not built
 * here). On submit the screen ALSO fires `recordTopikAnswer` as fire-and-forget
 * analytics: a failure is swallowed (logged in dev) and never blocks the reveal
 * or breaks the flow.
 *
 * Local state:
 *   - `idx`      — position within the draw. `idx >= data.length` is the
 *                  "draw complete" terminal state.
 *   - `picked`   — choice id the user selected (null before any pick).
 *   - `revealed` — Submit pressed; correctness chrome is visible.
 *   - `answered` — running count of submitted items, for the eyebrow + footer.
 *   - `drawKey`  — bumped on "New set" so `useEndpointOrMock`'s `refetch` runs
 *                  and the per-item reveal-block ids stay unique across draws.
 *
 * Threat model: Korean text comes from the server draw and renders as a React
 * text node. JSX escapes interpolated strings, so a malicious server payload
 * becomes literal text — no unescaped HTML reaches the DOM. The analytics write
 * is fire-and-forget and cannot surface a server error into the UI.
 */
import { useCallback, useState, type JSX } from 'react';
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

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

function Topik(): JSX.Element {
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
    // A network/auth failure here is logged in dev and otherwise swallowed —
    // the reveal is driven off the inline `correct` flag, not this response.
    void recordTopikAnswer(current.id, { picked, mode: 'study' }).catch(
      (err: unknown) => {
        if (import.meta.env.DEV) {
          console.warn('[topik] recordTopikAnswer failed (ignored):', err);
        }
      },
    );
  }, [picked, current]);

  return (
    <section
      className="screen km-topik"
      aria-labelledby="topik-title"
      style={{ position: 'relative' }}
    >
      {isMock ? <MockBadge /> : null}
      <Topbar
        krTitle={<span id="topik-title">학습 · TOPIK</span>}
        eyebrow={
          isComplete
            ? `${String(answered)} answered · set complete`
            : current
              ? `${current.section} · Item ${String(idx + 1)} / ${String(
                  draw.length,
                )}`
              : 'Study mode'
        }
      />

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
    </section>
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
