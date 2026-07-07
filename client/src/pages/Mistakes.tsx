/**
 * Mistakes — review recent wrong TOPIK answers (F-021).
 *
 * Reads GET /topik/mistakes via `fetchMistakes` (mock: `loadMistakesMock`) — the
 * user's incorrect answers in the last 30 days, newest first. Each row is a
 * STATIC review of an item the user already attempted, so it carries the answer
 * key: the correct option is marked (green ✓), the user's wrong pick is marked
 * (red "Your answer"), and the explanation is shown beneath. Reuses the global
 * `km-topik__choice` option styling. Reads flow through `useEndpointOrMock`, so
 * the dev-only 🅂 badge lights when the fixture is serving.
 */
import { type JSX } from 'react';
import { AskAboutThisButton } from '../components/AskAboutThisButton';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { fetchMistakes, type Mistake } from '../services/topik';
import { loadMistakesMock } from '../data/mocks/mistakes';
import { cn } from '../lib/cn';
import './Mistakes.css';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function MistakeCard({ mistake }: { mistake: Mistake }): JSX.Element {
  const { item, picked } = mistake;
  const correct = item.options.find((o) => o.correct);
  const pickedOpt = item.options.find((o) => o.id === picked);
  const when = whenLabel(mistake.answeredAt);
  return (
    <Card className="km-mistakes__card">
      <div className="km-mistakes__meta">
        <Eyebrow>
          {item.section} · {item.number}번 ·{' '}
          {mistake.mode === 'mock' ? '모의고사' : '학습'}
        </Eyebrow>
        {when !== '' ? <span className="km-mistakes__when">{when}</span> : null}
      </div>

      {item.prompt !== '' ? (
        <p className="kr km-mistakes__prompt">{item.prompt}</p>
      ) : null}
      {item.passage ? (
        <p className="kr km-mistakes__passage">{item.passage}</p>
      ) : null}

      <div className="km-topik__choices" role="list" aria-label="Answer choices">
        {item.options.map((o, i) => {
          const isPicked = o.id === picked;
          const isCorrect = o.correct;
          return (
            <div
              key={o.id}
              role="listitem"
              className={cn(
                'km-topik__choice',
                isCorrect && 'km-topik__choice--correct',
                isPicked && !isCorrect && 'km-topik__choice--wrong',
              )}
            >
              <span className="km-topik__marker">{CHOICE_MARKERS[i]}</span>
              <span className="km-topik__choice-body">
                <span className="kr km-topik__choice-kr">{o.kr}</span>
              </span>
              {isCorrect ? <Icon name="check" size={16} /> : null}
              {isPicked && !isCorrect ? (
                <span className="km-mistakes__tag">Your answer</span>
              ) : null}
            </div>
          );
        })}
      </div>

      {item.explanation !== '' ? (
        <Card variant="flat" className="km-mistakes__explain">
          {correct !== undefined ? (
            <p className="km-mistakes__answer">
              Correct answer: <span className="kr">{correct.kr}</span>
            </p>
          ) : null}
          <p className="km-mistakes__explain-text">{item.explanation}</p>
        </Card>
      ) : null}

      {/* F-020: hand this miss to the Chat tutor for an AI follow-up. */}
      <div style={{ marginTop: 10 }}>
        <AskAboutThisButton
          prompt={item.prompt}
          correctText={correct?.kr ?? ''}
          passage={item.passage}
          explanation={item.explanation}
          userPick={pickedOpt?.kr}
        />
      </div>
    </Card>
  );
}

export default function Mistakes(): JSX.Element {
  const { data, loading, error, isMock, refetch } = useEndpointOrMock<Mistake[]>(
    'topik.mistakes',
    loadMistakesMock,
    { realFn: () => fetchMistakes() },
  );
  const mistakes = data ?? [];

  return (
    <section className="screen km-mistakes" aria-labelledby="km-mistakes-title">
      {isMock ? <MockBadge /> : null}
      <Topbar
        krTitle="틀린 문제"
        title="Mistakes"
        titleId="km-mistakes-title"
        eyebrow="what you missed, in one place"
      />

      {loading ? (
        <Card className="km-mistakes__state" aria-busy="true">
          <Eyebrow>Loading your mistakes</Eyebrow>
          <div className="km-mistakes__skeleton-line" />
          <div className="km-mistakes__skeleton-line" />
        </Card>
      ) : error ? (
        <ErrorCard
          message="We couldn't load your mistakes right now."
          onRetry={refetch}
        />
      ) : mistakes.length === 0 ? (
        <Card className="km-mistakes__state km-mistakes__empty">
          <Icon name="check" size={22} />
          <p>No mistakes in the last 30 days — nice work.</p>
          <p className="km-mistakes__empty-sub">
            Missed TOPIK questions collect here so you can review why.
          </p>
        </Card>
      ) : (
        <div className="km-mistakes__list">
          {mistakes.map((m) => (
            <MistakeCard key={m.responseId} mistake={m} />
          ))}
        </div>
      )}
    </section>
  );
}
