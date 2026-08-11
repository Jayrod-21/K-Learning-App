/**
 * ClozeCard — the F-208 typed cloze presentation of a due vocab card.
 *
 * Sibling of `Flashcard`: the Review study session renders ONE of the two per
 * card appearance (the coin flip lives in `lib/clozePresentation`, decided by
 * the parent). Where Flashcard is a controlled flip surface with parent-owned
 * faces, ClozeCard owns its own attempt/phase state — the two-attempt
 * hint-then-reveal flow is entirely internal, and the parent only hears about
 * the outcomes it must act on:
 *
 *   - `onCommitted(result)` — the server committed an FSRS outcome (correct on
 *     any attempt, wrong on attempt 2, or give-up) and the learner tapped
 *     Continue after seeing the reveal. The grade route ALREADY advanced the
 *     card's schedule — the parent must advance the session WITHOUT calling
 *     `submitReview` (that would double-write FSRS) and adopt
 *     `result.version` as the card's fresh snapshot.
 *   - `onFallback()` — the cloze presentation is unusable for this card
 *     (404 no-prompt/not-found, 409 stale version, or the learner bailed out
 *     of a Kiwi outage); the parent should re-present the card as a normal
 *     flashcard.
 *
 * Answer-leak posture (F-208 CRITICAL): this component receives ONLY the
 * `cloze` object + card identity — never the card's headword or example
 * fields, which the blanked sentence is typically derived from. Until a
 * committing response arrives, the DOM contains the blanked sentence, its
 * English translation, and (after a wrong first attempt) the server's partial
 * hint — nothing else. The answer surface and full sentence render exclusively
 * from the grade response.
 *
 * Threat model:
 *   - Grading is server-owned: the client never sees `answer_surface` before
 *     a committing response, so a DOM-inspecting user can't lift the answer.
 *   - Rendered text (sentence, hint, reveal) goes through React text children
 *     — server-injected markup becomes literal text.
 *   - Error copy is fixed via `errorMessageFor` — server prose never reaches
 *     the DOM.
 *   - The answer input is length-capped client-side to the server schema's
 *     max (200) so an accidental paste can't 400 the request.
 */
import {
  Fragment,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  ClozeGradeCommittedResponse,
  ClozeGradeHint,
  DueCardCloze,
} from '../types/domain';
import { gradeCloze } from '../services/vocab';
import { ApiError } from '../services/api';
import { errorMessageFor } from '../lib/errorCopy';
import { Bilingual } from './Bilingual';
import { Button } from './Button';
import './ClozeCard.css';

/** The blank marker the server substitutes into `blanked` (6 underscores). */
const BLANK_MARKER = '______';

/** Server schema cap on the typed answer (`ClozeGradeBodySchema.max(200)`). */
const ANSWER_MAX_LENGTH = 200;

export interface ClozeCardProps {
  /** The due card's id — the grade route's path segment. */
  cardId: number;
  /**
   * Optimistic-concurrency snapshot echoed as `expected_version`. Only
   * committing grades check/bump it; a stale value 409s → `onFallback`.
   */
  expectedVersion: number;
  /** The cloze presentation from the due card (`DueCard.cloze`). */
  cloze: DueCardCloze;
  /**
   * A committing grade landed AND the learner tapped Continue after the
   * reveal. FSRS is already advanced server-side — advance the session
   * without a second review write.
   */
  onCommitted: (result: ClozeGradeCommittedResponse) => void;
  /** Cloze unusable for this card — re-present it as a normal flashcard. */
  onFallback: () => void;
}

type Phase =
  | { step: 'input'; attempt: 1 | 2; hint: ClozeGradeHint | null }
  | { step: 'revealed'; result: ClozeGradeCommittedResponse };

/** Render the blanked sentence with the `______` span styled as a visible
 *  blank. Split-on-marker (not regex) — the marker is a fixed literal. */
function renderBlanked(blanked: string): ReactNode {
  const parts = blanked.split(BLANK_MARKER);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 ? (
        <span className="km-cloze__blank" aria-label="blank">
          {BLANK_MARKER}
        </span>
      ) : null}
    </Fragment>
  ));
}

/** `{firstChar:'마', length:3}` → `마 ▢ ▢` (first char + length−1 boxes). */
function hintShape(hint: ClozeGradeHint): string {
  const boxes = Math.max(0, hint.length - 1);
  return [hint.firstChar, ...Array.from({ length: boxes }, () => '▢')].join(' ');
}

export function ClozeCard({
  cardId,
  expectedVersion,
  cloze,
  onCommitted,
  onFallback,
}: ClozeCardProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({
    step: 'input',
    attempt: 1,
    hint: null,
  });
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [softError, setSoftError] = useState<string | null>(null);

  const submit = (giveUp: boolean): void => {
    if (busy || phase.step !== 'input') return;
    const trimmed = answer.trim();
    if (!giveUp && trimmed === '') return;
    const attempt = phase.attempt;
    setBusy(true);
    setSoftError(null);
    void (async (): Promise<void> => {
      try {
        const res = await gradeCloze(cardId, {
          // A surrender sends no answer at all (the schema allows its
          // absence ONLY with giveUp) — nothing typed needs grading.
          ...(giveUp ? { giveUp: true } : { answer: trimmed }),
          expected_version: expectedVersion,
          attempt,
        });
        if ('hint' in res) {
          // NON-committing: no FSRS write happened, no version change, no
          // reveal. Keep the typed text for the retry (the learner edits it
          // against the hint rather than retyping from scratch).
          setPhase({ step: 'input', attempt: 2, hint: res.hint });
        } else {
          setPhase({ step: 'revealed', result: res });
        }
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 409)
        ) {
          // 404: card gone or no cloze prompt (we shouldn't have offered a
          // cloze). 409: stale version snapshot — same posture as existing
          // review conflicts. Either way this presentation can't proceed;
          // hand the card back to the flashcard face.
          onFallback();
          return;
        }
        // 502 (Kiwi outage) / network: retryable — the server wrote nothing
        // (no half-state), so the learner can resubmit or bail to flashcard.
        setSoftError(
          errorMessageFor(err, "Couldn't grade your answer — try again."),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    submit(false);
  };

  if (phase.step === 'revealed') {
    const { result } = phase;
    return (
      <div className="km-cloze km-cloze--revealed">
        <div
          className={`km-cloze__verdict ${result.correct ? 'km-cloze__verdict--correct' : 'km-cloze__verdict--wrong'}`}
          role="status"
        >
          {result.correct ? (
            <Bilingual en="✓ Correct" kr="정답" />
          ) : (
            <Bilingual en="Not quite" kr="아쉬워요" />
          )}
        </div>
        <div className="kr-display km-cloze__answer" lang="ko">
          {result.answerSurface}
        </div>
        <div className="kr km-cloze__sentence" lang="ko">
          {result.fullSentence}
        </div>
        {cloze.english !== null && cloze.english !== '' ? (
          <div className="km-cloze__en">{cloze.english}</div>
        ) : null}
        <div className="km-cloze__actions">
          <Button
            variant="gold"
            size="md"
            onClick={() => {
              onCommitted(result);
            }}
          >
            <Bilingual en="Continue" kr="계속" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="km-cloze">
      <div className="km-eyebrow km-cloze__eyebrow">
        <Bilingual en="Fill in the blank" kr="빈칸 채우기" />
      </div>
      <div className="kr km-cloze__sentence" lang="ko">
        {renderBlanked(cloze.blanked)}
      </div>
      {cloze.english !== null && cloze.english !== '' ? (
        <div className="km-cloze__en">{cloze.english}</div>
      ) : null}
      {phase.hint !== null ? (
        <div className="km-cloze__hint" role="status">
          <span className="km-cloze__hint-label">
            <Bilingual en="Hint" kr="힌트" compact />
          </span>
          <span className="kr km-cloze__hint-shape" lang="ko">
            {hintShape(phase.hint)}
          </span>
          <span className="km-cloze__hint-count">
            {phase.hint.length === 1
              ? '1 letter'
              : `${String(phase.hint.length)} letters`}
          </span>
        </div>
      ) : null}
      <form className="km-cloze__form" onSubmit={onSubmit}>
        <input
          type="text"
          value={answer}
          onChange={(e) => {
            setAnswer(e.target.value);
          }}
          className="kr focusring km-cloze__input"
          aria-label="Your answer"
          placeholder={phase.attempt === 1 ? '정답 입력…' : '다시 입력…'}
          maxLength={ANSWER_MAX_LENGTH}
          disabled={busy}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="km-cloze__actions">
          <Button
            type="submit"
            variant="gold"
            size="md"
            disabled={busy || answer.trim() === ''}
          >
            <Bilingual en="Submit" kr="확인" />
          </Button>
          <Button
            variant="ghost"
            size="md"
            disabled={busy}
            onClick={() => {
              submit(true);
            }}
          >
            <Bilingual en="Show answer" kr="정답 보기" />
          </Button>
        </div>
      </form>
      {softError !== null ? (
        <div role="alert" className="km-cloze__error">
          {softError}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onFallback();
            }}
          >
            <Bilingual en="Use flashcard instead" kr="플래시카드로 보기" compact />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
