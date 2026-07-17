/**
 * Mistakes — review recent wrong TOPIK answers (F-021), reworked for the
 * Phase-3B pre-beta redesign (F-044 / F-045 / F-046 / F-024).
 *
 * Data: GET /topik/mistakes via `fetchMistakes` (mock: `loadMistakesMock`) —
 * the user's incorrect answers in the last 30 days, newest first. Each row is
 * a STATIC review of an item the user already attempted, so it carries the
 * answer key: the correct option is marked (green ✓), the user's wrong pick
 * is marked (red "Your answer"), and the explanation is shown beneath. Reads
 * flow through `useEndpointOrMock`, so the dev-only 🅂 badge lights when the
 * fixture is serving.
 *
 * F-044 — session selector + date-divided groups. Sessions are derived
 * CLIENT-SIDE by grouping the wrong-answer log on (local calendar day, mode):
 * the /topik/mistakes DTO does not yet carry the `topik_responses.attempt_id`
 * that migration 046 added, so two mock sittings on the same day merge into
 * one group. Exact per-sitting grouping needs the DTO extension — ticket
 * F-105; the heuristic is honest and self-corrects once the field lands.
 * A `FilterSelect` can additionally scope the page to one session.
 *
 * F-154 (Wave-2) — the old page rendered every miss as a fully-expandable
 * `CollapsibleTile` in one flat list (very long, very cluttered). Now each
 * session renders as its own date-divided group (a `CityCard`, F-128 device
 * #1/#2) holding a GRID of small square question-number tiles — one per
 * missed question, matching the km-final.html Mistakes mock exactly. Tapping
 * a tile opens the shared `Sheet` popup (`MistakeSheetBody`) with the
 * question, the passage, the full answer key (user's wrong pick + the
 * correct option), and a "See explanation" reveal that expands the
 * explanation + the F-020 Ask-about-this handoff in place — there is no
 * separate explanation route to navigate to, so "jump to explanation" is an
 * honest in-sheet reveal, not a fabricated deep link.
 *
 * F-045 — per-exam score. The score (correct / total) of a past mock exam is
 * NOT derivable from a wrong-answers-only log, and no attempt-history route
 * exists yet (migration 046 shipped the schema for F-078/F-082; the
 * GET /topik/attempts route is pending — ticket F-104). Until it lands the
 * page surfaces the stat that IS derivable and honest: the missed count, per
 * session (in the selector labels) and for the visible scope (the live stat
 * line). No fabricated scores.
 *
 * F-046/B-017 — writing review, wired to the real per-response history.
 * `writing_attempts` rows are persisted by POST /grade-writing (migration
 * 038); F-106 shipped `GET /writing/attempts` (server/src/routes/
 * writing.ts:329-401), already consumed the same way on Today.tsx
 * (`today.writingAttempts`). `WritingReviewSection` below fetches the
 * caller's own graded-writing history once (abortable AbortController
 * effect — the VocabBrowse/AddToListSheet pattern, not `useEndpointOrMock`:
 * a single-shot user-scoped history read has no fixture/mock need the way
 * this page's own mistakes feed does) and splits it into the two ALREADY-
 * designed sub-sections by the row's own persisted `rubric` — TOPIK bank
 * prompts (`topik_ii_53`/`topik_ii_54`) vs Claude-generated topics
 * (`free_write`), a real DB-constrained split (migration 038/056), not a
 * client-invented category. The former "coming soon" stub is gone.
 *
 * F-024 — this is a nested sub-page of the Review library, so it opens with
 * a `BackButton` pinned to the canonical parent route `/review`.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { AskAboutThisButton } from '../components/AskAboutThisButton';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { CityCard } from '../components/CityCard';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { FilterSelect } from '../components/FilterSelect';
import { PageHubHeader } from '../components/PageHubHeader';
import { Sheet } from '../components/Sheet';
import { Card } from '../components/Card';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { navItem } from '../lib/nav';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { errorMessageFor } from '../lib/errorCopy';
import { ApiError } from '../services/api';
import { fetchMistakes, type Mistake } from '../services/topik';
import { fetchWritingAttempts, type WritingAttemptDTO } from '../services/writing';
import { loadMistakesMock } from '../data/mocks/mistakes';
import { cn } from '../lib/cn';
import './Mistakes.css';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const MISTAKES_NAV = navItem('mistakes');

/** Parent-tab name source — nav.ts owns the pair (F-043: "Library"). */
const LIBRARY_NAV = navItem('review');

/**
 * Explicit fetch cap = the server's maximum (`/topik/mistakes` limit is
 * 1–200, default 100). Riding the silent default truncated a >100-miss
 * window while the stat line still claimed a period TOTAL. At the cap the
 * copy softens to "most recent N" — the real total needs the F-104
 * attempt-history route.
 */
const MISTAKES_FETCH_LIMIT = 200;

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Korean mode label — matches the card meta the F-021 page always showed. */
function modeLabel(mode: string): string {
  return mode === 'mock' ? '모의고사' : '학습';
}

/**
 * Local-calendar-day key for session grouping. LOCAL (not UTC) deliberately:
 * the tile dates the user sees come from `toLocaleDateString`, so the
 * selector must slice on the same boundary — a 11 pm sitting must not land
 * in "tomorrow's" session while its tiles read today's date.
 */
function sessionDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One selectable review session (F-044) — see the module note on the
 *  (local day, mode) heuristic and ticket F-105. */
interface MistakeSession {
  /** FilterSelect option value. Never `''` (reserved for "all sessions"). */
  key: string;
  /** Plain-text option label (native <option> cannot carry markup). */
  label: string;
  mistakes: Mistake[];
}

/**
 * Group the wrong-answer log into sessions. Input is newest-first (server
 * contract) and Map preserves insertion order, so sessions come out
 * newest-first too. Pure — trivially unit-testable through the UI.
 */
function groupSessions(mistakes: Mistake[]): MistakeSession[] {
  const byKey = new Map<string, Mistake[]>();
  for (const m of mistakes) {
    const key = `${sessionDayKey(m.answeredAt)}|${m.mode}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [m]);
    } else {
      bucket.push(m);
    }
  }
  return [...byKey.entries()].map(([key, group]) => {
    const first = group[0] as Mistake; // groups are never empty by construction
    const day = whenLabel(first.answeredAt);
    const dayLabel = day === '' ? 'Unknown date' : day;
    // F-045: missed count is the honest per-session stat available today —
    // correct/total needs GET /topik/attempts (ticket F-104).
    const label = `${dayLabel} · ${modeLabel(first.mode)} · ${String(group.length)} missed`;
    return { key, label, mistakes: group };
  });
}

/**
 * F-154 — one small square question-number tile in the grid. Every row on
 * this page is, by definition, a WRONG answer, so the tile always carries
 * the danger/critical tone (co-located CSS) — there is no "correct" state to
 * distinguish it from. `aria-label` carries the full identity (section ·
 * number · mode) since the visible glyph is just the question number.
 */
function MistakeQuestionTile({
  mistake,
  onOpen,
}: {
  mistake: Mistake;
  onOpen: (mistake: Mistake) => void;
}): JSX.Element {
  const { item } = mistake;
  return (
    <li className="km-mistakes__tile-wrap">
      <button
        type="button"
        className="km-mistakes__qtile focusring"
        onClick={() => {
          onOpen(mistake);
        }}
        aria-label={`Question ${String(item.number)}, ${item.section}, ${modeLabel(mistake.mode)} — tap to review`}
      >
        {item.number}
      </button>
    </li>
  );
}

/**
 * F-154 — one date/session-divided group: a divider line (reusing the F-044
 * session label — day · mode · missed count) followed by the square-tile
 * grid, the whole thing riding on a `CityCard` (F-128 device #1, `rail` for
 * device #2) so the grouping itself reads as a signboard/paper section, not
 * a flat token reskin.
 */
function MistakeSessionGroup({
  session,
  onOpen,
}: {
  session: MistakeSession;
  onOpen: (mistake: Mistake) => void;
}): JSX.Element {
  return (
    <CityCard
      tone="plain"
      rail
      className="km-mistakes__group"
      aria-labelledby={`km-mistakes-divider-${session.key}`}
    >
      <p id={`km-mistakes-divider-${session.key}`} className="km-mistakes__divider">
        {session.label}
      </p>
      <ul className="km-mistakes__grid" aria-label={session.label}>
        {session.mistakes.map((m) => (
          <MistakeQuestionTile key={m.responseId} mistake={m} onOpen={onOpen} />
        ))}
      </ul>
    </CityCard>
  );
}

/**
 * F-154 — the tap-a-tile popup: the shared `Sheet`. Shows the question (+
 * passage), the full answer key (the user's wrong pick tagged, the correct
 * option marked), and a "See explanation" reveal that expands the
 * explanation + the F-020 Ask-about-this handoff in place. Keyed by
 * `mistake.responseId` at the call site so the reveal state resets between
 * two different tiles opened back to back.
 */
function MistakeSheetBody({
  mistake,
  onClose,
}: {
  mistake: Mistake;
  onClose: () => void;
}): JSX.Element {
  const [showExplanation, setShowExplanation] = useState(false);
  const { item, picked } = mistake;
  const correct = item.options.find((o) => o.correct);
  const pickedOpt = item.options.find((o) => o.id === picked);
  const when = whenLabel(mistake.answeredAt);

  return (
    // Batch-2 fix-pass (S2, `REVIEW_batch2-fidelity.md`) — the shared
    // `.km-review__sheet*` classes (ReviewGrammar/ReviewVocab's own popups)
    // now drive padding/head layout here too, instead of this page's
    // previously hand-rolled duplicate rules. `.km-mistakes__sheet-body`/
    // `__sheet-head` ride as EXTRA classes for the one genuinely
    // Mistakes-specific need (the flex-column body layout) — see
    // Mistakes.css.
    <div className="km-review__sheet-body km-mistakes__sheet-body">
      <div className="km-review__sheet-head km-mistakes__sheet-head">
        <div>
          <Eyebrow>
            {item.section} · {item.number}번 · {modeLabel(mistake.mode)}
          </Eyebrow>
          {when !== '' ? (
            <p className="km-mistakes__when">{when}</p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close question detail"
        >
          <Icon name="close" size={14} />
        </Button>
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
                <span className="km-mistakes__tag">
                  <Bilingual en="Your answer" kr="내 답" compact />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* F-154 "jump to explanation" — an honest in-sheet reveal: this app
          has no separate explanation route to deep-link to, so the reveal
          expands the explanation (+ the F-020 Ask handoff) in place rather
          than fabricating a jump target. */}
      {item.explanation !== '' ? (
        !showExplanation ? (
          <Button
            variant="gold"
            fullWidth
            onClick={() => {
              setShowExplanation(true);
            }}
            trailingIcon={<Icon name="arrow-right" size={14} />}
          >
            <Bilingual en="See explanation" kr="설명 보기" />
          </Button>
        ) : (
          <div className="km-mistakes__explain">
            {correct !== undefined ? (
              <p className="km-mistakes__answer">
                <Bilingual en="Correct answer" kr="정답" />:{' '}
                <span className="kr">{correct.kr}</span>
              </p>
            ) : null}
            <p className="km-mistakes__explain-text">{item.explanation}</p>
            {/* F-020: hand this miss to the Chat tutor for an AI follow-up. */}
            <AskAboutThisButton
              prompt={item.prompt}
              correctText={correct?.kr ?? ''}
              passage={item.passage}
              explanation={item.explanation}
              userPick={pickedOpt?.kr}
            />
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Server-validated fetch cap for the writing-review section, matching the
 * `GET /writing/attempts` ceiling (`AttemptsQuerySchema.limit.max(100)`,
 * server/src/routes/writing.ts) — same convention as the page's own
 * `MISTAKES_FETCH_LIMIT` above.
 */
const WRITING_ATTEMPTS_FETCH_LIMIT = 100;

/**
 * Rubric → short bilingual label for one history row. Exhaustive `switch`
 * (matches `Diagnostic.tsx`'s `sectionLabel` / `Ttmik.tsx`'s
 * `TranscriptPanel` idiom) — B-017 fix-pass: a widened
 * `ck_writing_attempts_rubric` CHECK (migration 056+) that adds a 4th
 * `WritingRubric` value must fail this file at compile time, not fall
 * through to a mislabeled default.
 */
function writingRubricLabel(
  rubric: WritingAttemptDTO['rubric'],
): { en: string; kr: string } {
  switch (rubric) {
    case 'topik_ii_53':
      return { en: 'Q53', kr: '53번' };
    case 'topik_ii_54':
      return { en: 'Q54', kr: '54번' };
    case 'free_write':
      return { en: 'Free write', kr: '자유 작문' };
    default: {
      // Exhaustiveness guard — a new WritingRubric member must update this switch.
      const exhausted: never = rubric;
      throw new Error(`writingRubricLabel: unhandled WritingRubric ${String(exhausted)}`);
    }
  }
}

/**
 * Which writing-review sub-section a rubric's attempts belong in — exhaustive
 * `switch` over the closed `WritingRubric` type, same idiom as
 * `writingRubricLabel` above. B-017 fix-pass: the previous two-way
 * `filter`/`filter` split (`a.rubric !== 'free_write'` /
 * `a.rubric === 'free_write'`) would silently land any future 4th rubric
 * value in the TOPIK bucket instead of surfacing it. A `never`-typed default
 * makes that a compile error the moment `WritingRubric` (or the DB CHECK it
 * mirrors, migration 056) is widened without updating this file, and throws
 * loudly if an unrecognized value somehow still reaches runtime (e.g. a
 * server/client version skew).
 */
function writingRubricBucket(
  rubric: WritingAttemptDTO['rubric'],
): 'topik' | 'generated' {
  switch (rubric) {
    case 'topik_ii_53':
    case 'topik_ii_54':
      return 'topik';
    case 'free_write':
      return 'generated';
    default: {
      // Exhaustiveness guard — a new WritingRubric member must update this switch.
      const exhausted: never = rubric;
      throw new Error(`writingRubricBucket: unhandled WritingRubric ${String(exhausted)}`);
    }
  }
}

/**
 * One graded-writing history row — rides the shared `.km-reference__row`
 * list styling the rest of the Review library uses (ReviewVocab.tsx's
 * Browse list). Read-only: there is no per-attempt detail route to open, so
 * unlike the mistakes tiles above, a row is not a button.
 */
function WritingAttemptRow({
  attempt,
}: {
  attempt: WritingAttemptDTO;
}): JSX.Element {
  const when = whenLabel(attempt.gradedAt);
  const rubric = writingRubricLabel(attempt.rubric);
  return (
    <li className="km-reference__row">
      <div className="km-mistakes__writing-row">
        <div className="km-mistakes__writing-row-main">
          <span className="kr km-mistakes__writing-row-prompt">
            {attempt.promptKr}
          </span>
          <span className="km-mistakes__writing-row-meta">
            <Bilingual en={rubric.en} kr={rubric.kr} />
            {when !== '' ? <> · {when}</> : null}
            {attempt.estimatedLevel !== null ? (
              <> · {attempt.estimatedLevel}</>
            ) : null}
          </span>
        </div>
        <span className="km-pill km-pill--default km-mistakes__writing-row-score">
          {attempt.totalScore}/{attempt.maxTotal}
        </span>
      </div>
    </li>
  );
}

/** The list-or-empty-state body for one writing-review sub-section. */
function WritingAttemptList({
  attempts,
  emptyEn,
  emptyKr,
}: {
  attempts: WritingAttemptDTO[];
  emptyEn: string;
  emptyKr: string;
}): JSX.Element {
  if (attempts.length === 0) {
    return (
      <p className="km-reference__empty">
        <Bilingual en={emptyEn} kr={emptyKr} />
      </p>
    );
  }
  return (
    <Card className="km-reference__list" variant="flat">
      <ul>
        {attempts.map((a) => (
          <WritingAttemptRow key={a.id} attempt={a} />
        ))}
      </ul>
    </Card>
  );
}

/**
 * F-046/B-017 — Writing review: the caller's own graded-writing history via
 * `GET /writing/attempts` (F-106), replacing the former "coming soon" stub.
 * One abortable fetch on mount (AbortController — VocabBrowse's pattern, not
 * `useEndpointOrMock`: a single-shot user-scoped history read has no
 * fixture/mock need the way the page's own mistakes feed does), then split
 * client-side into the two ALREADY-designed sub-sections by the row's own
 * persisted `rubric` (a real DB-constrained taxonomy, migration 038/056 —
 * never a fabricated category).
 */
function WritingReviewSection(): JSX.Element {
  const [attempts, setAttempts] = useState<WritingAttemptDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so ErrorCard's Retry re-runs the fetch effect
  // without needing a second piece of state (mirrors VocabBrowse's
  // `reloadTick`).
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (a network fetch) — the same exception
    // useEndpointOrMock/VocabBrowse document for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */

    fetchWritingAttempts({ limit: WRITING_ATTEMPTS_FETCH_LIMIT }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setAttempts(res.attempts);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load your writing history.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // The DB's own CHECK constraint (migration 038/056) is the ONLY taxonomy
  // here: `free_write` is a Claude-generated topic; the other two are
  // TOPIK-bank prompts. No client-invented bucketing. `writingRubricBucket`
  // is an exhaustive switch (see above) rather than a two-way filter, so a
  // future 4th rubric value fails to compile instead of silently misfiling.
  const topikAttempts = attempts.filter(
    (a) => writingRubricBucket(a.rubric) === 'topik',
  );
  const generatedAttempts = attempts.filter(
    (a) => writingRubricBucket(a.rubric) === 'generated',
  );

  return (
    <section
      className="km-mistakes__writing"
      aria-labelledby="km-mistakes-writing-title"
    >
      <h2 id="km-mistakes-writing-title" className="km-mistakes__section-title">
        <Bilingual en="Writing review" kr="쓰기 복습" />
      </h2>

      {loading ? (
        <Card className="km-mistakes__state" aria-busy="true">
          <Eyebrow>
            <Bilingual
              en="Loading your writing history"
              kr="쓰기 기록을 불러오는 중"
            />
          </Eyebrow>
          <div className="km-mistakes__skeleton-line" />
          <div className="km-mistakes__skeleton-line" />
        </Card>
      ) : error !== null ? (
        <ErrorCard message={error} onRetry={refetch} />
      ) : (
        <>
          <CollapsibleTile
            surface="city"
            tone="plain"
            rail
            defaultCollapsed
            title={<Bilingual en="TOPIK writing responses" kr="TOPIK 쓰기 응답" />}
          >
            <WritingAttemptList
              attempts={topikAttempts}
              emptyEn="No graded TOPIK writing yet — your next Q53/Q54 grade will appear here."
              emptyKr="아직 채점된 TOPIK 쓰기가 없어요 — 다음 53·54번 채점이 여기에 표시돼요."
            />
          </CollapsibleTile>
          <CollapsibleTile
            surface="city"
            tone="plain"
            rail
            defaultCollapsed
            title={<Bilingual en="Generated prompts" kr="생성된 주제" />}
          >
            <WritingAttemptList
              attempts={generatedAttempts}
              emptyEn="No responses to a generated prompt yet."
              emptyKr="아직 생성된 주제에 쓴 글이 없어요."
            />
          </CollapsibleTile>
        </>
      )}
    </section>
  );
}

export default function Mistakes(): JSX.Element {
  const { data, loading, error, isMock, refetch } = useEndpointOrMock<Mistake[]>(
    'topik.mistakes',
    loadMistakesMock,
    { realFn: () => fetchMistakes({ limit: MISTAKES_FETCH_LIMIT }) },
  );
  const mistakes = data ?? [];
  // Log filled the fetch cap → the window may hold MORE than we fetched, so
  // the all-sessions stat must not claim a period total (see the constant).
  const atFetchLimit = mistakes.length >= MISTAKES_FETCH_LIMIT;

  // F-044 session filter. `''` = all sessions (FilterSelect's reserved
  // placeholder value). Derived `active` guards against a stale key after a
  // refetch reshapes the log — an orphaned selection silently falls back to
  // "all" instead of filtering everything out.
  const [sessionKey, setSessionKey] = useState<string>('');
  const sessions = groupSessions(mistakes);
  const activeSession = sessions.find((s) => s.key === sessionKey);
  const active = activeSession !== undefined ? sessionKey : '';
  // F-154 — the visible SCOPE is one or more whole session groups (each its
  // own date-divided tile grid), not a flattened list: "all sessions" shows
  // every group stacked (newest first, matching groupSessions' own order);
  // picking one session narrows to that single group.
  const visibleSessions = activeSession !== undefined ? [activeSession] : sessions;
  const visibleCount = visibleSessions.reduce(
    (sum, s) => sum + s.mistakes.length,
    0,
  );

  // F-154 tap-a-tile popup state. Page-level (not per-group) so a tile
  // tapped in ANY visible group opens the same Sheet.
  const [openMistake, setOpenMistake] = useState<Mistake | null>(null);

  return (
    <section
      className="screen km-mistakes km-rain-sheen"
      aria-labelledby="km-mistakes-title"
    >
      {isMock ? <MockBadge /> : null}
      {/* F-024: nested Review-library sub-page → explicit back control with a
          deterministic parent route (deep links never exit the PWA). */}
      <div className="km-mistakes__nav">
        <BackButton to="/review" label={LIBRARY_NAV.label} />
      </div>
      {/* F-128 devices #4/#2 — the shared hub-header recipe (batch-2
          fix-pass BLOCKER-2, components/PageHubHeader.tsx) instead of a bare
          `Topbar`. This page was one of two Library pages that missed the
          recipe entirely (`REVIEW_batch2-fidelity.md` B1). */}
      <PageHubHeader
        titleId="km-mistakes-title"
        eyebrow={
          <Bilingual en={MISTAKES_NAV.eyebrow} kr={MISTAKES_NAV.krEyebrow} />
        }
        heading={<Bilingual en="Mistakes" kr="틀린 문제" />}
      />

      {loading ? (
        <Card className="km-mistakes__state" aria-busy="true">
          <Eyebrow>
            <Bilingual en="Loading your mistakes" kr="틀린 문제를 불러오는 중" />
          </Eyebrow>
          <div className="km-mistakes__skeleton-line" />
          <div className="km-mistakes__skeleton-line" />
        </Card>
      ) : error ? (
        <ErrorCard
          message="We couldn't load your mistakes right now."
          onRetry={refetch}
        />
      ) : mistakes.length === 0 ? (
        // F-128 devices #3/#6 — a faint giwa texture + a giant "복습" hangul
        // watermark behind the empty state, matching Progress's precedent.
        <Card
          className="km-mistakes__state km-mistakes__empty km-giwa km-hangul-watermark"
          data-glyph="복습"
        >
          <Icon name="check" size={22} />
          {/* P3b trim: one line — the old second sub-line restated the page. */}
          <p>
            <Bilingual
              en="No mistakes in the last 30 days — nice work."
              kr="최근 30일간 틀린 문제가 없어요 — 잘하고 있어요."
            />
          </p>
        </Card>
      ) : (
        <>
          <div className="km-mistakes__controls">
            <FilterSelect
              label="Session · 세션"
              placeholder="All sessions · 전체"
              options={sessions.map((s) => ({ value: s.key, label: s.label }))}
              value={active}
              onChange={setSessionKey}
            />
            {/* aria-live: the count re-announces when the filter changes.
                F-045: missed count only — a real correct/total score needs
                GET /topik/attempts (ticket F-104), never fabricated. */}
            <p className="km-mistakes__stat" aria-live="polite">
              {active === '' ? (
                atFetchLimit ? (
                  // At the cap "N in the last 30 days" would present a
                  // truncated fetch as a period total — say what we KNOW.
                  <Bilingual
                    en={`Your most recent ${String(visibleCount)} missed`}
                    kr={`최근에 틀린 ${String(visibleCount)}문제`}
                  />
                ) : (
                  <Bilingual
                    en={`${String(visibleCount)} missed in the last 30 days`}
                    kr={`최근 30일간 ${String(visibleCount)}문제 틀렸어요`}
                  />
                )
              ) : (
                <Bilingual
                  en={`${String(visibleCount)} missed in this session`}
                  kr={`이 세션에서 ${String(visibleCount)}문제 틀렸어요`}
                />
              )}
            </p>
          </div>
          {/* F-154 — square question-number tiles, divided by session/date. */}
          <div className="km-mistakes__groups">
            {visibleSessions.map((s) => (
              <MistakeSessionGroup
                key={s.key}
                session={s}
                onOpen={setOpenMistake}
              />
            ))}
          </div>
        </>
      )}

      <Sheet
        open={openMistake !== null}
        onClose={() => {
          setOpenMistake(null);
        }}
        ariaLabel="Question detail"
      >
        {openMistake ? (
          <MistakeSheetBody
            key={openMistake.responseId}
            mistake={openMistake}
            onClose={() => {
              setOpenMistake(null);
            }}
          />
        ) : null}
      </Sheet>

      <WritingReviewSection />
    </section>
  );
}
