/**
 * PastExams — the dedicated "Past TOPIK exams" library surface (F-103).
 *
 * The Library ("Review") exams shelf previously landed on Mistakes as an
 * honest stub (F-042) because no dedicated past-exams page existed yet — the
 * backend it needs (`GET /topik/attempts`, F-104) shipped in a later wave.
 * This page is that dedicated surface: a list of the caller's completed
 * TOPIK mock sittings (test, level, section, score, date), each row a
 * re-entry point back into that EXACT paper's Mock-Test start page
 * (`/learn/topik?mode=mock&section=…&exam=…&level=…` — the same deep-link
 * shape `topik/MockMode.tsx`'s `ExamChooser` already produces when a specific
 * past paper is picked), so the learner can review the grade or retake it.
 * Per-question wrong-answer review is NOT broken out per exam yet (F-104
 * returns per-attempt aggregates, not per-item picks — see
 * `AttemptsReview` in `pages/Topik.tsx`, the same honest limitation); this
 * page instead links out to Mistakes at the bottom, where every recent wrong
 * answer (across all TOPIK work) already lives — "Mistakes becomes a link
 * inside it" per the ticket.
 *
 * IA placement: lives in the LIBRARY surface (`/review/exams`, reached from
 * `ReviewLibrary`'s "TOPIK exams" shelf) — distinct from the pre-existing
 * `/learn/topik?view=attempts` "Previous attempts" view inside `Topik.tsx`,
 * which is a LEARN-side (doing) quick-check and stays as-is. Per the app's
 * IA rule (LEARN = doing, Review/Library = browsing your own history), a
 * dedicated past-exams BROWSE surface belongs under the Library, not nested
 * inside the LEARN exam-taking flow.
 *
 * Data: `GET /topik/attempts` via `fetchAttemptHistory` (mock:
 * `loadTopikAttemptHistoryMock`, the SAME fixture the LEARN-side
 * `AttemptsReview`/`Topik.tsx` daily-total views already use) — reads flow
 * through `useEndpointOrMock` so the dev-only 🅂 badge lights when the
 * fixture is serving. Newest-first (the server's own contract).
 *
 * F-024: nested Library sub-page → explicit `BackButton` to the canonical
 * parent route `/review`.
 */
import { useCallback, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { PageHubHeader } from '../components/PageHubHeader';
import { Pill } from '../components/Pill';
import { navItem } from '../lib/nav';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { errorMessageFor } from '../lib/errorCopy';
import {
  fetchAttemptHistory,
  type AttemptHistoryResult,
  type TopikAttemptHistoryEntry,
} from '../services/topik';
import { loadTopikAttemptHistoryMock } from '../data/mocks/topik';
import type { MockSection } from '../types/domain';
import './PastExams.css';

/** Page eyebrow/title source — nav.ts owns the en/kr pair. */
const PAST_EXAMS_NAV = navItem('review-exams');

/** Parent-tab name source — nav.ts owns the pair (F-043: "Library"). */
const LIBRARY_NAV = navItem('review');

/** Fetch cap — a personal single-user app's whole exam history comfortably
 *  fits under the server's own paging max (`AttemptsQuerySchema.limit.max(100)`). */
const PAST_EXAMS_FETCH_LIMIT = 100;

/** `TopikAttemptHistoryEntry.section` is the Korean wire label — map back to
 *  the English `MockSection` the Mock-Test flow's URL params expect. */
function mockSectionFromKr(section: TopikAttemptHistoryEntry['section']): MockSection {
  return section === '듣기' ? 'listening' : 'reading';
}

/**
 * The deep link back into MockMode's start page for this EXACT paper —
 * mirrors `ExamChooser`'s own `onPickExam` → `goToView` URL shape
 * (`topik/MockMode.tsx`). Omits `level` when the attempt's level couldn't be
 * resolved (a pre-F-122 legacy row, migration 066) — the server's own
 * `resolveMockTest` tie-break then applies, same as picking the "Recommended
 * exam" path; never a fabricated level.
 */
function reEnterHref(a: TopikAttemptHistoryEntry): string {
  const params = new URLSearchParams({
    mode: 'mock',
    section: mockSectionFromKr(a.section),
    exam: String(a.sourceTest),
  });
  if (a.topikLevel !== null) params.set('level', a.topikLevel);
  return `/learn/topik?${params.toString()}`;
}

/** Percentage → readiness band headline — mirrors `Topik.tsx`'s own
 *  presentation-only copy (each screen owns its own band function; this is
 *  not a shared grading contract, just consistent wording). */
function bandForPercentage(percentage: number): string {
  if (percentage >= 80) return 'On track for L5+';
  if (percentage >= 60) return 'L4 range';
  if (percentage >= 40) return 'L3 range';
  return 'Below L3';
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/** One completed-exam row — the whole row is the re-enter link (F-103). */
function PastExamRow({ a }: { a: TopikAttemptHistoryEntry }): JSX.Element {
  const percentage =
    a.totalItems > 0 ? Math.round((a.correct / a.totalItems) * 1000) / 10 : 0;
  const band = bandForPercentage(percentage);
  const when = whenLabel(a.completedAt);
  const levelText = a.topikLevel ?? 'TOPIK';
  const scoreText = `${String(a.correct)}/${String(a.totalItems)} · ${String(percentage)}%`;

  return (
    <li className="km-reference__row">
      <Link
        to={reEnterHref(a)}
        className="km-pastexams__row-btn focusring"
        aria-label={`${levelText} test ${String(a.sourceTest)}, ${a.section}, ${scoreText}${when !== '' ? `, ${when}` : ''} — tap to re-enter`}
      >
        <span className="km-pastexams__row-main">
          <span className="km-pastexams__row-title">
            {levelText} · {a.section} {String(a.sourceTest)}회
          </span>
          <span className="km-pastexams__row-meta">
            {when !== '' ? <>{when} · </> : null}
            {band}
          </span>
        </span>
        <Pill className="km-pastexams__row-score">{scoreText}</Pill>
        <span className="km-pastexams__row-action" aria-hidden="true">
          <Icon name="play" size={14} />
        </span>
      </Link>
    </li>
  );
}

export default function PastExams(): JSX.Element {
  const realFn = useCallback(
    () => fetchAttemptHistory({ limit: PAST_EXAMS_FETCH_LIMIT }),
    [],
  );
  const { data, loading, error, isMock, refetch } = useEndpointOrMock<AttemptHistoryResult>(
    'topik.pastExams',
    loadTopikAttemptHistoryMock,
    { realFn },
  );
  const attempts = data?.attempts ?? [];

  return (
    <section
      className="screen km-pastexams km-rain-sheen"
      aria-labelledby="km-pastexams-title"
    >
      {isMock ? <MockBadge /> : null}
      {/* F-024: nested Library sub-page → explicit back to the canonical parent. */}
      <div className="km-pastexams__nav">
        <BackButton to="/review" label={LIBRARY_NAV.label} />
      </div>
      <PageHubHeader
        titleId="km-pastexams-title"
        eyebrow={
          <Bilingual en={PAST_EXAMS_NAV.eyebrow} kr={PAST_EXAMS_NAV.krEyebrow} />
        }
        heading={<Bilingual en={PAST_EXAMS_NAV.label} kr={PAST_EXAMS_NAV.kr} />}
      />

      {loading ? (
        <Card className="km-pastexams__state" aria-busy="true">
          <p>
            <Bilingual en="Loading your past exams" kr="지난 시험을 불러오는 중" />
          </p>
        </Card>
      ) : error !== null && attempts.length === 0 ? (
        <ErrorCard
          message={errorMessageFor(error, "Couldn't load your past exams.")}
          onRetry={refetch}
        />
      ) : attempts.length === 0 ? (
        // Honest empty state — a real absence, never fabricated.
        <Card
          className="km-pastexams__state km-pastexams__empty km-giwa km-hangul-watermark"
          data-glyph="시험"
        >
          <p>
            <Bilingual
              en="You haven't completed a mock exam yet. Finish one in TOPIK → Mock and it will show up here."
              kr="아직 완료한 모의고사가 없어요. TOPIK → 모의고사에서 시험을 완료하면 여기에 표시돼요."
            />
          </p>
        </Card>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul aria-label="Past TOPIK exams">
            {attempts.map((a) => (
              <PastExamRow key={a.attemptId} a={a} />
            ))}
          </ul>
        </Card>
      )}

      {/* F-103: "Mistakes becomes a link inside it" — per-exam wrong-question
          review isn't broken out (F-104 is per-attempt aggregates, not
          per-item picks — the same honest limitation `AttemptsReview` in
          `pages/Topik.tsx` discloses); every recent miss across all TOPIK
          work is reviewable from the Mistakes page, wired here. */}
      <Card variant="flat" className="km-pastexams__mistakesLink">
        <p>
          <Bilingual
            en="Want to review what you got wrong? Every recent miss across all TOPIK work lives in Mistakes."
            kr="틀린 문제를 복습하고 싶으신가요? 최근에 틀린 모든 TOPIK 문제는 Mistakes에서 볼 수 있어요."
          />
        </p>
        <Link to="/review/mistakes" className="km-pastexams__mistakesCta focusring">
          <Bilingual en="Review your mistakes" kr="틀린 문제 복습" />{' '}
          <Icon name="arrow-right" size={13} />
        </Link>
      </Card>
    </section>
  );
}
