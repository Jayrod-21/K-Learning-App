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
 * F-046 — writing review, stubbed. `writing_attempts` rows ARE persisted by
 * POST /grade-writing (migration 038), but the only read is the aggregate
 * GET /writing/series — there is no per-response history endpoint yet
 * (ticket F-106, twin of F-074). The section renders its two designed
 * parts (TOPIK writing responses · generated-prompt responses) as collapsed
 * tiles with an honest "coming soon" body. Nothing is fabricated.
 *
 * F-024 — this is a nested sub-page of the Review library, so it opens with
 * a `BackButton` pinned to the canonical parent route `/review`.
 */
import { useState, type JSX } from 'react';
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
import { fetchMistakes, type Mistake } from '../services/topik';
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
    <li className="km-mistakes__tileWrap">
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
    // previously hand-rolled duplicate rules. `.km-mistakes__sheetBody`/
    // `__sheetHead` ride as EXTRA classes for the one genuinely
    // Mistakes-specific need (the flex-column body layout) — see
    // Mistakes.css.
    <div className="km-review__sheetBody km-mistakes__sheetBody">
      <div className="km-review__sheetHead km-mistakes__sheetHead">
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
 * F-046 — Writing review, two designed parts, both honestly stubbed until a
 * per-response history endpoint exists (ticket F-106; see module note).
 * Static — no fetch happens here, so the section renders regardless of the
 * mistakes load state and can never add an error path of its own.
 */
function WritingReviewSection(): JSX.Element {
  return (
    <section
      className="km-mistakes__writing"
      aria-labelledby="km-mistakes-writing-title"
    >
      <h2 id="km-mistakes-writing-title" className="km-mistakes__section-title">
        <Bilingual en="Writing review" kr="쓰기 복습" />
      </h2>
      <CollapsibleTile
        surface="city"
        tone="plain"
        rail
        defaultCollapsed
        title={<Bilingual en="TOPIK writing responses" kr="TOPIK 쓰기 응답" />}
      >
        <p className="km-mistakes__stub">
          <Bilingual
            en="Your graded TOPIK writing (Q53 · Q54) will appear here with each score out of its maximum — coming soon. New attempts are already being saved."
            kr="채점된 TOPIK 쓰기(53·54번)가 점수와 함께 여기에 표시될 예정이에요. 새 연습은 이미 저장되고 있어요."
          />
        </p>
      </CollapsibleTile>
      <CollapsibleTile
        surface="city"
        tone="plain"
        rail
        defaultCollapsed
        title={<Bilingual en="Generated prompts" kr="생성된 주제" />}
      >
        <p className="km-mistakes__stub">
          <Bilingual
            en="Responses you wrote against Claude-generated prompts will appear here — coming soon."
            kr="Claude가 만든 주제에 쓴 글이 여기에 표시될 예정이에요."
          />
        </p>
      </CollapsibleTile>
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
