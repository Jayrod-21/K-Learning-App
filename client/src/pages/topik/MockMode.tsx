/**
 * MockMode — the TOPIK answer-stripped, server-graded Mock-Test flow (FU-NF-39).
 *
 * A three-phase state machine, with the pre-exam navigation URL-driven
 * (Phase 3C-2 / F-079):
 *
 *   select  → the pre-exam screens, chosen by the `section`/`exam` search
 *             params (untrusted input — parsed against closed unions):
 *               (no section)      section cards (Reading 50/~70min, Listening
 *                                 50/~60min; Writing disabled "coming soon" →
 *                                 FU-NF-47). Tapping a section NAVIGATES to
 *                                 the exam chooser — it no longer starts the
 *                                 timer under the user's finger.
 *               ?section=…        the exam chooser (F-079). Today it offers
 *                                 ONE wired entry — the server-picked exam
 *                                 (`POST /topik/mock` with no sourceTest) —
 *                                 plus an honestly-pending note where the
 *                                 per-exam list with completion checkmarks
 *                                 will render (needs an exam-list route,
 *                                 F-118, + attempt history F-104).
 *               ?section=…&exam=  the start page (F-079): exam meta + rules,
 *                                 a previous-attempts block (honestly pending
 *                                 on F-104 — never fabricated), and the
 *                                 explicit Start button that actually fetches
 *                                 the exam and arms the timer.
 *             Every nested screen carries a BackButton (F-024) whose `to` is
 *             the canonical parent URL, so browser back works identically.
 *   exam    → a wall-clock countdown (deadline = start + the section's allotted
 *             minutes, or + the saved remaining when resuming (F-007); a ~1s
 *             interval only re-samples the clock; auto-submits at 0), one item
 *             at a time with a question
 *             palette, Prev/Next, hidden-answer choices, picks held in a Map.
 *             "Submit test" (confirm) grades server-side and enters `results`.
 *   results → percentage + band headline, correct/total, a per-item review
 *             list with each pick vs the now-revealed correct answer, and
 *             "New mock" back to `select`. Rendered by the exported
 *             `TopikResults` (F-008) — Study mode (Topik.tsx) reuses the SAME
 *             component for its own end-of-set summary rather than
 *             duplicating the score/review markup; both modes normalize their
 *             outcome into the shared `ResultsSummary` shape defined here.
 *
 * F-009: a review row's explanation renders ONLY when the pick was wrong
 * (`!row.isCorrect`) — a correct pick needs no "here's why" callout. See
 * `TopikResults` below.
 *
 * SECURITY (answer-tampering defense — mirrors the Diagnostic taking flow):
 * the exam receives `TopikMockItem`s that carry NO `correct` flag and NO
 * `explanation`. The screen holds only the user's own picks; the answer key
 * surfaces solely in the server's `MockResult` reveal after submit. There is
 * no client-side grading path to tamper with, and a regression cannot leak the
 * key because the wire type has no field to carry it. Skipped items are graded
 * incorrect server-side.
 *
 * Failure-safe: a fetch failure falls back to an offline answer-stripped
 * fixture (🅂 badge) so the exam still opens; a submit failure surfaces an
 * inline retry that re-sends the SAME in-memory picks rather than dropping the
 * user's work. Neither path can blank the screen.
 *
 * React-19 discipline: the countdown is driven by a wall-clock DEADLINE, not a
 * decrementing tick counter — a backgrounded/throttled tab (browsers clamp
 * `setInterval` in inactive tabs, and it drifts over a 70-min run) can neither
 * drift nor be handed extra exam time, because the interval only samples
 * `Date.now()` against the fixed deadline and is a render trigger, not the
 * source of truth. The interval is owned by an effect with cleanup (cleared on
 * unmount, exit, and submit); `Date.now()`/`Math.random()` run only in
 * effects/handlers, never in render; per-item time is stamped into a ref. The
 * network flow manages its own AbortController and aborts on unmount.
 *
 * F-183 reskin ("Seoul Day & Night") — MockMode is nested UNDER Topik.tsx's
 * own `PageHubHeader` (it renders inside the shared `Tabs` panel, not as its
 * own top-level `screen`), so it does not carry a second header — it adopts
 * the SAME character-device treatment Topik.tsx's Study flow already does,
 * matching its sibling exactly: the section-select / exam-chooser / start-
 * page cards and the live exam item are `CityCard` signboards/hanji-paper
 * surfaces (device #1) with a leading `DancheongRail` (device #2); a
 * `SubwayProgress` (device #5) rides alongside the existing question
 * palette + "N / M" readout so the exam run reads consistently with Study's
 * per-item stepping; a finished exam gets a milestone `SealStamp` (device
 * #7) ahead of the shared `TopikResults` screen (now itself a `CityCard`
 * hero, mirroring the "milestone panel" treatment); the honest-empty past-
 * papers list and "no previous attempts" panel carry `.km-giwa`/
 * `.km-hangul-watermark` (devices #3/#6); the ambient `.km-rain-sheen`
 * (device #8, Night-only per its own CSS gate) is NOT re-applied here —
 * `Topik.tsx`'s outer `.screen.km-topik` wrapper already carries it for the
 * whole Study/Mock tab panel, and doubling it on this inner root would only
 * double the overlay opacity over the same shared subtree (fix-pass batch5).
 * Every exam-flow behavior (timer, palette jump, Prev/Next, pick, submit,
 * resume, scoring) is unchanged — this pass only reskins the surfaces
 * around it.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { AskAboutThisButton } from '../../components/AskAboutThisButton';
import { BackButton } from '../../components/BackButton';
import { Bilingual } from '../../components/Bilingual';
import { Card } from '../../components/Card';
import { CityCard, type CityCardTone } from '../../components/CityCard';
import { Button } from '../../components/Button';
import { Pill } from '../../components/Pill';
import { Eyebrow } from '../../components/Eyebrow';
import { Icon } from '../../components/Icon';
import { ErrorCard } from '../../components/ErrorCard';
import { MockBadge } from '../../components/MockBadge';
import { SealStamp } from '../../components/SealStamp';
import { SubwayProgress } from '../../components/SubwayProgress';
import { TopikImageNote } from '../../components/TopikImageNote';
import { TopikPassage } from '../../components/TopikPassage';
import { cn } from '../../lib/cn';
import { splitImageItem } from '../../lib/topikImage';
import { useExamActive } from '../../hooks/useExamActive';
import { useModalA11y } from '../../hooks/useModalA11y';
import { errorMessageFor } from '../../lib/errorCopy';
import {
  fetchMockTest,
  submitMockTest,
  fetchAttempt,
  saveAttempt,
  clearAttempt,
  fetchAvailableTests,
  fetchAttemptHistory,
  type AttemptState,
  type TopikTestSummary,
  type TopikAttemptHistoryEntry,
} from '../../services/topik';
import {
  loadTopikMockTest,
  submitTopikMockTestMock,
} from '../../data/mocks/topik';
import type {
  ChoiceId,
  MockResult,
  MockSection,
  MockSubmitAnswer,
  MockSubmitBody,
  MockTest,
  TopikLevel,
  TopikMockItem,
} from '../../types/domain';
import './MockMode.css';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

/**
 * Parse the `section` search param (untrusted input) against the closed
 * MockSection union — anything unrecognised degrades to "no section chosen"
 * rather than reaching a request path or a template.
 */
function parseSectionParam(raw: string | null): MockSection | null {
  return raw === 'reading' || raw === 'listening' ? raw : null;
}

/**
 * Parse the `exam` search param: `'auto'` = the server-picked exam
 * (`fetchMockTest` with no `sourceTest`), or a positive integer = a SPECIFIC
 * past paper's `test_number` picked from the F-118 exam list. Bounded to
 * INT4_MAX (the server's `topik_tests.test_number` column is `INTEGER`) so a
 * malformed URL degrades to the chooser rather than reaching a request path
 * with a value the server would 400 on anyway. Unknown/malformed values
 * degrade to `null` (no exam chosen — shows the chooser).
 */
const INT4_MAX = 2_147_483_647;
function parseExamParam(raw: string | null): 'auto' | number | null {
  if (raw === 'auto') return 'auto';
  if (raw !== null && /^[1-9][0-9]*$/.test(raw)) {
    const n = Number(raw);
    if (n <= INT4_MAX) return n;
  }
  return null;
}

/**
 * Parse the `level` search param (untrusted input) against the closed
 * `TopikLevel` union — anything unrecognised degrades to "no level known"
 * (fix-pass S-1 / D-1). Only meaningful alongside a numeric `exam` (a
 * SPECIFIC past paper picked from the F-118 list); `goToView` clears it
 * whenever `exam` isn't a specific test_number, so it never outlives the
 * `exam` param it discriminates.
 */
function parseLevelParam(raw: string | null): TopikLevel | null {
  return raw === 'TOPIK I' || raw === 'TOPIK II' ? raw : null;
}

/** Section card metadata — drives the select screen + the exam's timer budget. */
interface SectionMeta {
  id: MockSection | 'writing';
  kr: string;
  en: string;
  items: number;
  /** Allotted minutes → the exam countdown's starting value. */
  mins: number;
  /** True for the deferred Writing section (FU-NF-47) — renders disabled. */
  disabled?: boolean;
}

const SECTIONS: readonly SectionMeta[] = [
  { id: 'reading', kr: '읽기', en: 'Reading', items: 50, mins: 70 },
  { id: 'listening', kr: '듣기', en: 'Listening', items: 50, mins: 60 },
  { id: 'writing', kr: '쓰기', en: 'Writing', items: 4, mins: 50, disabled: true },
];

/**
 * F-183 — the `CityCard` tone each section reads as, mirroring Topik's own
 * blue/accent split (Study tally = blue, the live study item = accent).
 * Fixed per section identity (not the user's accent pick) for Listening, so
 * Reading/Listening stay visually distinct from each other regardless of
 * which accent is active; the deferred Writing card gets the quiet `plain`
 * edge (no glow) to read as inert alongside its disabled state.
 */
function sectionTone(id: SectionMeta['id']): CityCardTone {
  if (id === 'listening') return 'blue';
  if (id === 'writing') return 'plain';
  return 'accent';
}

/** Allotted minutes per section — the countdown's starting seconds = mins×60. */
const SECTION_MINUTES: Record<MockSection, number> = {
  reading: 70,
  listening: 60,
};

/**
 * Server-side cap on per-item `timeMs` (`routes/topik.ts`
 * `MockSubmitAnswerSchema.timeMs.max(3600000)`). Per-item time here is raw
 * wall-clock deltas — a laptop sleep / suspended tab mid-exam can exceed an
 * hour on one item, and ONE over-cap value 400s the WHOLE submit body (zod
 * `.strict()`), leaving the exam ungradeable (`submittedRef` is latched, no
 * retry). Clamp at the boundary: the timing is best-effort analytics, the
 * grade must never be hostage to it.
 */
const MAX_ITEM_TIME_MS = 3_600_000;

/**
 * Normalise a thrown value to user-facing FIXED copy (F-UP-018). Previously
 * echoed `ApiError.message` — server prose — into the ErrorCard; now
 * delegates to the app-wide fixed-copy lookup, so only author-controlled
 * text (plus the structured retry_after number) ever renders.
 */
function toMessage(err: unknown, fallback: string): string {
  return errorMessageFor(err, fallback);
}

/** Phase of the in-flight network call (orthogonal to the exam phase machine). */
type NetPhase = 'idle' | 'loading' | 'submitting' | 'error';

/** What the network error refers to — drives which retry the ErrorCard wires. */
type NetErrorKind = 'fetch' | 'submit';

export function MockMode(): JSX.Element {
  // URL-driven pre-exam navigation (F-079/F-024): which of the three pre-exam
  // screens shows is owned by the search params, so BackButton and browser
  // back are the same deterministic operation.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSection = parseSectionParam(searchParams.get('section'));
  // The exam param is only meaningful under a valid section.
  const urlExam =
    urlSection !== null ? parseExamParam(searchParams.get('exam')) : null;
  // The level param (D-1 / fix-pass S-1) is only meaningful alongside a
  // SPECIFIC picked paper (a numeric `exam`, never `'auto'` or absent) — the
  // "recommended exam" path lets the server resolve the level itself.
  const urlLevel =
    urlSection !== null && typeof urlExam === 'number'
      ? parseLevelParam(searchParams.get('level'))
      : null;

  // Rewrite ONLY this component's params (section/exam/level), preserving
  // the parent's (`mode`, owned by Topik.tsx) — MockMode never navigates the
  // whole page, it moves within its own sub-views.
  const goToView = useCallback(
    (
      section: MockSection | null,
      exam: 'auto' | number | null,
      level?: TopikLevel,
    ): void => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (section === null) next.delete('section');
        else next.set('section', section);
        if (section === null || exam === null) next.delete('exam');
        else next.set('exam', String(exam));
        // `level` only makes sense alongside a SPECIFIC picked paper (a
        // positive test_number) — clearing it whenever `exam` isn't one
        // keeps `level` from ever outliving the `exam` it discriminates
        // (fix-pass S-1: a stale level surviving a switch to the
        // server-picked "recommended" path could wrongly pin a resolver
        // request that should be left to resolve freely).
        if (section === null || exam === null || typeof exam !== 'number' || level === undefined) {
          next.delete('level');
        } else {
          next.set('level', level);
        }
        return next;
      });
    },
    [setSearchParams],
  );

  // Exam phase machine.
  const [phase, setPhase] = useState<'select' | 'exam' | 'results'>('select');
  // The loaded answer-stripped exam (null until a section is fetched).
  const [test, setTest] = useState<MockTest | null>(null);
  // The graded result (null until submitted).
  const [result, setResult] = useState<MockResult | null>(null);
  // True when the loaded test / result came from the offline fixture, so the
  // 🅂 badge fires (consistent with the rest of the app).
  const [isMock, setIsMock] = useState(false);

  // Network status + the last error (kind tells the ErrorCard which retry).
  const [net, setNet] = useState<NetPhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<NetErrorKind>('fetch');

  // F-007 resume: a saved in-progress attempt found on mount (drives the resume
  // banner on the select screen), and the state to hydrate ExamRunner with when
  // resuming. Both null in the fresh-start path.
  const [resumable, setResumable] = useState<AttemptState | null>(null);
  // F-UP-015: a resume attempt whose exam re-fetch failed. Drives a brief
  // "couldn't resume" notice on the select screen instead of the banner just
  // vanishing silently. Cleared when a fresh section starts.
  const [resumeFailed, setResumeFailed] = useState(false);
  const [initialExam, setInitialExam] = useState<{
    idx: number;
    picks: Map<number, ChoiceId>;
    remainingSec: number;
  } | null>(null);

  // One controller per in-flight call; aborts the previous and on unmount.
  const ctrlRef = useRef<AbortController | null>(null);
  // The submit payload is stashed so a submit-retry re-sends the SAME picks
  // without re-deriving them from a now-unmounted exam subtree.
  const pendingSubmitRef = useRef<MockSubmitBody | null>(null);

  // Abort any in-flight network call on unmount.
  useEffect(() => {
    return () => {
      ctrlRef.current?.abort();
    };
  }, []);

  // Overhaul P1.1: publish "exam in progress" to the shared context so the
  // shell chrome (ChatFab) can hide during a timed run. Derived straight
  // from the phase machine — true on entering `exam` (fresh start OR F-007
  // resume), false on submit/results/new-mock, and the cleanup guarantees
  // false on unmount (leaving mid-exam). Deliberately independent of the
  // wall-clock timer — this effect only mirrors `phase`.
  const { setExamActive } = useExamActive();
  useEffect(() => {
    setExamActive(phase === 'exam');
    return () => {
      setExamActive(false);
    };
  }, [phase, setExamActive]);

  const beginCall = useCallback((): AbortController => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    return ctrl;
  }, []);

  // F-024: leaving an in-flight exam (or the results screen) via BackButton /
  // browser back regresses the URL below `?section=…&exam=…` — this effect
  // notices and tears the phase machine back down to the URL-driven `select`
  // state. The ExamRunner's unmount cleanup flushes a final progress save
  // (F-007), so a mid-exam exit is resumable, never lost. The in-flight
  // fetch/submit controller is aborted so a late resolve can't flip the phase
  // back after the user left. (Set-state in an effect is the deliberate
  // sync-to-external-system case here: the external system is the URL.)
  //
  // `examUrlBoundRef` guards a real race: RESUME enters the exam phase from
  // the bare select URL and syncs the params via setSearchParams — which
  // react-router applies inside a transition, one tick LATER than the phase
  // flip. Tearing down on the first `exam-phase + no params` render would
  // kill every resumed exam instantly; instead the teardown arms only after
  // this effect has seen the exam bound to its URL once.
  const examUrlBoundRef = useRef(false);
  useEffect(() => {
    if (phase === 'select') {
      examUrlBoundRef.current = false;
      return;
    }
    if (urlSection !== null && urlExam !== null) {
      examUrlBoundRef.current = true;
      return;
    }
    if (!examUrlBoundRef.current) return; // URL not yet caught up (resume)
    examUrlBoundRef.current = false;
    ctrlRef.current?.abort();
    pendingSubmitRef.current = null;
    /* eslint-disable react-hooks/set-state-in-effect */
    setTest(null);
    setResult(null);
    setErrorMsg(null);
    setIsMock(false);
    setNet('idle');
    setInitialExam(null);
    setPhase('select');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [phase, urlSection, urlExam]);

  // On mount, look for a saved in-progress attempt to offer resuming (F-007).
  // A missing/failed fetch simply means no banner — it never blocks the screen.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchAttempt(ctrl.signal)
      .then((a) => {
        if (!ctrl.signal.aborted) setResumable(a);
      })
      .catch(() => {
        /* no attempt or offline — no resume banner */
      });
    return () => {
      ctrl.abort();
    };
  }, []);

  // Persist the exam's in-progress state (F-007). Fire-and-forget: a failed save
  // just means this exam can't be resumed, which must never break the exam.
  const handleSaveProgress = useCallback(
    (state: ExamSaveState, signal?: AbortSignal): void => {
      if (test === null) return;
      const picks: Record<string, ChoiceId> = {};
      for (const [itemId, choice] of state.picks) picks[String(itemId)] = choice;
      void saveAttempt(
        {
          section: test.section,
          sourceTest: test.sourceTest,
          currentIdx: state.currentIdx,
          picks,
          remainingMs: state.remainingSec * 1000,
        },
        signal,
      ).catch(() => {
        /* ignore — best-effort persistence (incl. deliberate abort on submit) */
      });
    },
    [test],
  );

  // Resume a saved attempt: re-fetch the SAME deterministic exam (by its stored
  // source_test) and hydrate ExamRunner with the saved picks / index / timer.
  const resumeAttempt = useCallback(
    (attempt: AttemptState): void => {
      const ctrl = beginCall();
      setNet('loading');
      setErrorMsg(null);
      setResult(null);
      setResumeFailed(false);
      fetchMockTest(attempt.section, ctrl.signal, attempt.sourceTest)
        .then((real) => {
          if (ctrl.signal.aborted) return;
          const picks = new Map<number, ChoiceId>();
          for (const [k, v] of Object.entries(attempt.picks)) {
            picks.set(Number(k), v);
          }
          setInitialExam({
            idx: attempt.currentIdx,
            picks,
            remainingSec: Math.round(attempt.remainingMs / 1000),
          });
          setTest(real);
          setIsMock(false);
          setNet('idle');
          setResumable(null);
          // Sync the URL to the resumed exam so the back-guard effect above
          // sees a consistent `?section=…&exam=auto` and doesn't immediately
          // tear the resumed exam down.
          goToView(attempt.section, 'auto');
          setPhase('exam');
        })
        .catch(() => {
          // The exact exam couldn't be re-fetched — drop the (now stale)
          // banner and stay on select rather than block. The attempt row is
          // harmless. F-UP-015: tell the user WHY the banner vanished — the
          // old code dropped it silently.
          if (ctrl.signal.aborted) return;
          setResumable(null);
          setResumeFailed(true);
          setNet('idle');
        });
    },
    [beginCall, goToView],
  );

  // Start a section: fetch the answer-stripped exam, falling back to the
  // offline fixture so the exam always opens (failure-safe). `sourceTest`
  // (+ `topikLevel`) are supplied when the learner picked a SPECIFIC past
  // paper from the F-118 exam list (`ExamChooser`); omitted for the
  // "Recommended exam" card, which lets the server pick (`resolveMockTest`,
  // unchanged).
  const startSection = useCallback(
    (section: MockSection, sourceTest?: number, topikLevel?: TopikLevel): void => {
      const ctrl = beginCall();
      setNet('loading');
      setErrorMsg(null);
      setResult(null);
      // Fresh start: no hydration, and dismiss any resume banner/notice. The
      // exam's first save will upsert-replace any prior in-progress attempt.
      setInitialExam(null);
      setResumable(null);
      setResumeFailed(false);
      // Omit the 3rd/4th args entirely for the "recommended" path (rather
      // than passing an explicit `undefined`) — keeps this call's shape
      // identical to before F-118, and matches `POST /topik/mock`'s own
      // contract where `sourceTest`/`topikLevel` are OMITTED (not null) to
      // let the server pick. `topikLevel` is only ever sent alongside a
      // known `sourceTest` (fix-pass S-1 / D-1) — a level with no paper to
      // pin it to has nothing to discriminate.
      (sourceTest !== undefined && topikLevel !== undefined
        ? fetchMockTest(section, ctrl.signal, sourceTest, topikLevel)
        : sourceTest !== undefined
          ? fetchMockTest(section, ctrl.signal, sourceTest)
          : fetchMockTest(section, ctrl.signal)
      )
        .then((real) => {
          if (ctrl.signal.aborted) return;
          setTest(real);
          setIsMock(false);
          setNet('idle');
          setPhase('exam');
        })
        .catch((realErr: unknown) => {
          if (ctrl.signal.aborted) return;
          // PROD: no fixture substitution — an exam of fabricated items with
          // MockBadge suppressed would read as a real mock test (the same
          // fake-data-as-real failure mode useEndpointOrMock guards). Show
          // the retryable error instead.
          if (import.meta.env.PROD) {
            setErrorKind('fetch');
            setErrorMsg(toMessage(realErr, 'Could not load the mock test.'));
            setNet('error');
            return;
          }
          // DEV failure-safe: fall back to the offline fixture rather than
          // blank the screen. The 🅂 badge fires so a dev sees it's not the
          // server.
          loadTopikMockTest(section)
            .then((mock) => {
              if (ctrl.signal.aborted) return;
              setTest(mock);
              setIsMock(true);
              setNet('idle');
              setPhase('exam');
            })
            .catch(() => {
              if (ctrl.signal.aborted) return;
              // Both real + mock failed — surface a retryable error.
              setErrorKind('fetch');
              setErrorMsg(
                toMessage(realErr, 'Could not load the mock test.'),
              );
              setNet('error');
            });
        });
    },
    [beginCall],
  );

  // Grade a finished exam server-side. `body` carries the user's picks +
  // timings. Falls back to the offline grader when the real submit fails so
  // the user always reaches a results screen.
  const runSubmit = useCallback(
    (body: MockSubmitBody): void => {
      pendingSubmitRef.current = body;
      const ctrl = beginCall();
      setNet('submitting');
      setErrorMsg(null);
      submitMockTest(body, ctrl.signal)
        .then((real) => {
          if (ctrl.signal.aborted) return;
          setResult(real);
          setIsMock(false);
          setNet('idle');
          setPhase('results');
          // Mop-up (F-007): /mock/submit already cleared the attempt in its tx,
          // but a progress save that raced the DELETE could have re-created it.
          // Only on a REAL submit — an offline-graded fallback never reached the
          // server, so its attempt legitimately remains for a retry.
          void clearAttempt().catch(() => {
            /* best-effort */
          });
        })
        .catch((realErr: unknown) => {
          if (ctrl.signal.aborted) return;
          // PROD: never substitute the offline pseudo-grader ('b' is always
          // "correct") for a failed real submit — the user would read a
          // fabricated score as their result, with the 🅂 badge suppressed.
          // Surface the retryable error; pendingSubmitRef re-sends the SAME
          // picks, so no work is lost.
          if (import.meta.env.PROD) {
            setErrorKind('submit');
            setErrorMsg(toMessage(realErr, 'Could not submit the test.'));
            setNet('error');
            return;
          }
          submitTopikMockTestMock(body)
            .then((mock) => {
              if (ctrl.signal.aborted) return;
              setResult(mock);
              setIsMock(true);
              setNet('idle');
              setPhase('results');
            })
            .catch(() => {
              if (ctrl.signal.aborted) return;
              setErrorKind('submit');
              setErrorMsg(toMessage(realErr, 'Could not submit the test.'));
              setNet('error');
            });
        });
    },
    [beginCall],
  );

  const retrySubmit = useCallback((): void => {
    const body = pendingSubmitRef.current;
    if (body) runSubmit(body);
  }, [runSubmit]);

  // Return to the section select for a fresh mock.
  const newMock = useCallback((): void => {
    ctrlRef.current?.abort();
    pendingSubmitRef.current = null;
    setTest(null);
    setResult(null);
    setErrorMsg(null);
    setIsMock(false);
    setNet('idle');
    // The just-finished section's attempt was cleared server-side on submit; a
    // fresh select shows no resume banner (and no stale resume-fail notice).
    setInitialExam(null);
    setResumable(null);
    setResumeFailed(false);
    setPhase('select');
    // Drop the nested-view params so the URL agrees with the section select.
    goToView(null, null);
  }, [goToView]);

  return (
    // F-183 fix-pass (batch5): NOT `km-rain-sheen` here — `Topik.tsx`'s outer
    // `.screen.km-topik` wrapper (this component's parent, Topik.tsx:264/526)
    // already applies device #8 to the whole Study/Mock tab panel, so
    // MockMode adding its own copy on this inner root doubled the effective
    // overlay opacity over the shared subtree for no visual gain. The
    // `position: relative` stays — MockBadge's absolute positioning still
    // relies on it.
    <div className="km-mock" style={{ position: 'relative' }}>
      {isMock && (phase === 'exam' || phase === 'results') ? (
        <MockBadge />
      ) : null}

      {net === 'loading' ? (
        <div className="km-topik__state" role="status">
          <Bilingual
            en="Loading mock test…"
            kr="모의고사를 불러오는 중…"
          />
        </div>
      ) : null}

      {net === 'submitting' ? (
        <div className="km-topik__state" role="status">
          <Bilingual en="Grading your test…" kr="채점 중…" />
        </div>
      ) : null}

      {net === 'error' && errorMsg !== null ? (
        <ErrorCard
          message={errorMsg}
          onRetry={errorKind === 'submit' ? retrySubmit : newMock}
          retryLabel={errorKind === 'submit' ? 'Retry submit' : 'Back'}
        />
      ) : null}

      {net !== 'loading' && net !== 'submitting' && net !== 'error' ? (
        <>
          {phase === 'select' && urlSection === null ? (
            <>
              {resumable !== null ? (
                <ResumeBanner
                  attempt={resumable}
                  onResume={() => {
                    resumeAttempt(resumable);
                  }}
                  onDismiss={() => {
                    setResumable(null);
                  }}
                />
              ) : null}
              {resumeFailed ? (
                // F-UP-015: the resume re-fetch failed — say so briefly
                // instead of silently dropping the banner. Fixed copy, no
                // server prose. role="status" so it's announced politely.
                <p
                  className="km-mock__resume-failed"
                  role="status"
                  style={{ marginBottom: 16, color: 'var(--paper-mute)' }}
                >
                  <Bilingual
                    en="Couldn't resume your saved test — start a fresh one below."
                    kr="저장된 시험을 이어서 하지 못했어요 — 아래에서 새로 시작해 주세요."
                  />
                </p>
              ) : null}
              <SectionSelect
                onChoose={(section) => {
                  goToView(section, null);
                }}
              />
            </>
          ) : null}

          {phase === 'select' && urlSection !== null && urlExam === null ? (
            // F-079: the exam chooser for the picked section.
            <ExamChooser
              section={urlSection}
              onPickServerExam={() => {
                goToView(urlSection, 'auto');
              }}
              onPickExam={(testNumber, topikLevel) => {
                // D-1 / fix-pass S-1: carry the EXACT level the picked row
                // named, not just its test_number — a test_number alone
                // names TWO exams (TOPIK I and TOPIK II share every
                // test_number).
                goToView(urlSection, testNumber, topikLevel);
              }}
            />
          ) : null}

          {phase === 'select' && urlSection !== null && urlExam !== null ? (
            // F-079: the start page — the exam only fetches (and the timer
            // only arms) on the explicit Start click. `sourceTest`/`topikLevel`
            // are known only when a SPECIFIC past paper was picked from the
            // F-118 list (urlExam is its test_number, not the 'auto' literal).
            <StartPage
              section={urlSection}
              sourceTest={typeof urlExam === 'number' ? urlExam : undefined}
              topikLevel={typeof urlExam === 'number' ? (urlLevel ?? undefined) : undefined}
              onStart={() => {
                startSection(
                  urlSection,
                  typeof urlExam === 'number' ? urlExam : undefined,
                  typeof urlExam === 'number' ? (urlLevel ?? undefined) : undefined,
                );
              }}
            />
          ) : null}

          {phase === 'exam' && test !== null ? (
            <ExamRunner
              test={test}
              onSubmit={runSubmit}
              initial={initialExam ?? undefined}
              onSave={handleSaveProgress}
            />
          ) : null}

          {phase === 'results' && result !== null ? (
            <>
              {/* F-183 device #7 — a milestone 도장 stamp marking the
                  finished exam, ahead of the shared results/grade screen
                  (F-008), mirroring Study mode's "set complete" treatment in
                  Topik.tsx exactly. */}
              <div className="km-mock__milestone">
                <SealStamp
                  milestone
                  tone="accent"
                  label={<Bilingual en="Test complete" kr="시험 완료" compact />}
                />
              </div>
              <TopikResults
                summary={buildMockResultsSummary(result, test?.items ?? [])}
                onRestart={newMock}
                restartLabel={<Bilingual en="New mock" kr="새 모의고사" />}
              />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Phase: select
// ─────────────────────────────────────────────────────────────

interface SectionSelectProps {
  /** Navigate to the section's exam chooser (F-079) — does NOT start a test. */
  onChoose: (section: MockSection) => void;
}

function SectionSelect({ onChoose }: SectionSelectProps): JSX.Element {
  return (
    <div className="km-mock__select">
      <p className="km-mock__lead">
        <Bilingual
          en="Pick a section to take a timed, scored mock. Answers are graded after you submit — no peeking mid-exam."
          kr="영역을 골라 시간 제한 모의고사를 풀어 보세요. 답은 제출한 뒤에 채점돼요 — 시험 중에는 정답을 볼 수 없어요."
        />
      </p>
      <div className="km-mock__sections">
        {SECTIONS.map((s) => {
          const disabled = s.disabled === true;
          return (
            // F-183 device #1/#2 — each section is a CityCard signboard/
            // hanji-paper surface with a leading DancheongRail, replacing the
            // old flat `.km-mock__section` card. The disabled Writing card
            // gets no rail (nothing to glow) — it reads as inert chrome.
            <CityCard
              key={s.id}
              tone={sectionTone(s.id)}
              rail={!disabled}
              className={cn(
                'km-mock__section-card',
                disabled && 'km-mock__section-card--disabled',
              )}
            >
              <button
                type="button"
                disabled={disabled}
                aria-label={
                  disabled
                    ? `${s.en} mock test, coming soon`
                    : // F-079: the card OPENS the section's exam chooser (it no
                      // longer starts a timed exam under the tap) — the name
                      // says so, and the meta still sets expectations.
                      `${s.en} mock exams, ${String(s.items)} items, about ${String(s.mins)} minutes`
                }
                className="km-mock__section-btn focusring"
                onClick={() => {
                  // Writing is deferred (FU-NF-47); the card is disabled so this
                  // never fires for it, but the union-narrowing guard keeps the
                  // call type-safe (`onChoose` accepts only MockSection).
                  if (!disabled && s.id !== 'writing') onChoose(s.id);
                }}
              >
                {/* P3b: title + meta are chrome — the section NAME pair renders
                    through <Bilingual>, and the items/minutes meta gets its own
                    pair (문항/분 counters per the glossary). */}
                <span className="km-mock__section-en">
                  <Bilingual en={s.en} kr={s.kr} />
                </span>
                <span className="km-mock__section-kr">
                  <Bilingual
                    en={`${String(s.items)} items · ${String(s.mins)} min`}
                    kr={`${String(s.items)}문항 · ${String(s.mins)}분`}
                    compact
                  />
                </span>
                {disabled ? (
                  <span className="km-mock__section-soon">
                    <Pill tone="default">
                      <Bilingual en="Coming soon" kr="준비 중" compact />
                    </Pill>
                  </span>
                ) : (
                  <span className="km-mock__section-go">
                    <Bilingual en="Choose" kr="선택" compact />{' '}
                    <Icon name="arrow-right" size={13} />
                  </span>
                )}
              </button>
            </CityCard>
          );
        })}
      </div>
    </div>
  );
}

/** Section display names — shared by the chooser / start page / exam head. */
function sectionNames(section: MockSection): { en: string; kr: string } {
  return section === 'reading'
    ? { en: 'Reading', kr: '읽기' }
    : { en: 'Listening', kr: '듣기' };
}

/**
 * F-079 — the exam chooser for one section.
 *
 * Wired: the per-paper list is `GET /topik/tests` (F-118), scoped to this
 * section — an abortable fetch with its own error+retry (a primary surface
 * of this screen). The green completion checkmark per paper is `GET
 * /topik/attempts` (F-104) — a best-effort ANNOTATION on that list: a failed
 * fetch here degrades SILENTLY (no checkmarks, no error UI), mirroring this
 * file's own resume-banner fetch ("a missing/failed fetch simply means no
 * banner — it never blocks the screen"). NO exam is ever shown as
 * "completed" from fabricated data — the checkmark only appears when F-104
 * genuinely reports a completed attempt for that (section, test_number).
 */
function ExamChooser({
  section,
  onPickServerExam,
  onPickExam,
}: {
  section: MockSection;
  onPickServerExam: () => void;
  /** `topikLevel` (D-1 / fix-pass S-1) is the SAME paper's level the row
   *  displayed — passing it through lets the caller pin the exact exam the
   *  user clicked, rather than leaving the server's resolver to tie-break. */
  onPickExam: (sourceTest: number, topikLevel: TopikLevel) => void;
}): JSX.Element {
  const names = sectionNames(section);

  const [testsNet, setTestsNet] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tests, setTests] = useState<TopikTestSummary[]>([]);
  const [testsErrorMsg, setTestsErrorMsg] = useState<string | null>(null);
  const [testsTick, setTestsTick] = useState(0);
  // Best-effort annotation set — see the doc above. Starts empty (no
  // checkmarks) and stays that way if the history fetch fails.
  const [doneTestNumbers, setDoneTestNumbers] = useState<ReadonlySet<number>>(
    new Set(),
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setTestsNet('loading');
    setTestsErrorMsg(null);
    fetchAvailableTests({ section }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setTests(res.tests);
        setTestsNet('ready');
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setTestsErrorMsg(toMessage(err, 'Could not load past papers.'));
        setTestsNet('error');
      });
    fetchAttemptHistory({ limit: 100 }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        const done = new Set<number>();
        for (const a of res.attempts) {
          if (a.section === names.kr) done.add(a.sourceTest);
        }
        setDoneTestNumbers(done);
      })
      .catch(() => {
        /* best-effort annotation only — no checkmarks, never an error UI */
      });
    return () => {
      ctrl.abort();
    };
    // `names.kr` is a pure function of `section`, not independent state — the
    // real dependency is `section` itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, testsTick]);

  return (
    <div className="km-mock__chooser">
      {/* F-024: back to the section select. */}
      <BackButton to="/learn/topik?mode=mock" label="Sections" />
      <Eyebrow className="km-mock__chooser-head">
        <Bilingual en={`${names.en} · mock exams`} kr={`${names.kr} · 모의고사`} />
      </Eyebrow>

      {/* F-183 device #1/#2 — the recommended entry is the chooser's own
          hero tile: a feat CityCard signboard/hanji-paper surface. */}
      <CityCard tone="accent" rail feat className="km-mock__chooser-card">
        <button
          type="button"
          className="km-mock__section-btn focusring"
          aria-label={`Recommended ${names.en} exam, server-picked`}
          onClick={onPickServerExam}
        >
          <span className="km-mock__section-en">
            <Bilingual en="Recommended exam" kr="추천 시험" />
          </span>
          <span className="km-mock__section-kr">
            <Bilingual
              en="A full past paper, picked for you"
              kr="기출 시험지 한 세트를 골라 드려요"
              compact
            />
          </span>
          <span className="km-mock__section-go">
            <Bilingual en="Choose" kr="선택" compact />{' '}
            <Icon name="arrow-right" size={13} />
          </span>
        </button>
      </CityCard>

      <Eyebrow className="km-mock__chooser-head">
        <Bilingual en="Past papers" kr="기출 시험지" />
      </Eyebrow>

      {testsNet === 'loading' ? (
        <p className="km-mock__pending-copy" role="status">
          <Bilingual en="Loading past papers…" kr="기출 시험지를 불러오는 중…" />
        </p>
      ) : null}

      {testsNet === 'error' ? (
        <Card variant="flat" className="km-mock__pending" role="alert">
          <p className="km-mock__pending-copy">{testsErrorMsg}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTestsTick((n) => n + 1);
            }}
          >
            <Bilingual en="Try again" kr="다시 시도" />
          </Button>
        </Card>
      ) : null}

      {testsNet === 'ready' && tests.length === 0 ? (
        // Honest empty state — a real absence (no papers indexed for this
        // section yet), never fabricated. Devices #3/#6 (giwa texture +
        // hangul watermark) mark it as genuinely empty rather than pending,
        // matching Topik.tsx's own honest-empty treatment.
        <Card
          variant="flat"
          className="km-mock__pending km-giwa km-hangul-watermark"
          data-glyph="기출"
          role="status"
        >
          <p className="km-mock__pending-copy">
            <Bilingual
              en="No past papers are available for this section yet."
              kr="이 영역에는 아직 이용 가능한 기출 시험지가 없어요."
            />
          </p>
        </Card>
      ) : null}

      {testsNet === 'ready' && tests.length > 0 ? (
        <ul className="km-mock__exam-list">
          {tests.map((test) => {
            const done = doneTestNumbers.has(test.testNumber);
            return (
              <li key={`${test.topikLevel}-${String(test.testNumber)}`}>
                {/* F-183 device #1/#2 — each past paper is its own CityCard
                    tile (blue tone: past papers are the secondary picker,
                    distinct from the accent-toned recommended hero above). */}
                <CityCard tone="blue" rail className="km-mock__chooser-card">
                  <button
                    type="button"
                    className="km-mock__section-btn focusring"
                    aria-label={`${test.topikLevel} test ${String(test.testNumber)}, ${String(test.itemCount)} items${done ? ', completed' : ''}`}
                    onClick={() => {
                      onPickExam(test.testNumber, test.topikLevel);
                    }}
                  >
                    <span className="km-mock__section-en">
                      {done ? <Icon name="check" size={14} /> : null}{' '}
                      <Bilingual
                        en={`Test ${String(test.testNumber)}`}
                        kr={`${String(test.testNumber)}회`}
                      />
                    </span>
                    <span className="km-mock__section-kr">
                      <Bilingual
                        en={`${test.topikLevel} · ${String(test.itemCount)} items`}
                        kr={`${test.topikLevel} · ${String(test.itemCount)}문항`}
                        compact
                      />
                    </span>
                    <span className="km-mock__section-go">
                      <Bilingual en="Choose" kr="선택" compact />{' '}
                      <Icon name="arrow-right" size={13} />
                    </span>
                  </button>
                </CityCard>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * F-079 — the start page. The exam is fetched (and the countdown armed) ONLY
 * on the explicit Start click, never by navigation.
 *
 * The previous-attempts block (grade + when, for a repeat sitting) is wired
 * from `GET /topik/attempts` (F-104) — but ONLY when `sourceTest` is known:
 * a SPECIFIC past paper picked from the F-118 `ExamChooser` list. The
 * "Recommended exam" path (`sourceTest` undefined) genuinely cannot look
 * this up yet — the server doesn't resolve WHICH test_number it will pick
 * until the Start click's `fetchMockTest` call returns — so that path shows
 * an honest note instead of a fetch with nothing to filter by.
 *
 * F-080: for Listening, the audio data gap is disclosed BEFORE the timer
 * starts — items are served as transcripts; the raw section MP3s are not
 * ingested or segmented per question (see the exam-head note / ticket F-119).
 */
function StartPage({
  section,
  sourceTest,
  topikLevel,
  onStart,
}: {
  section: MockSection;
  /** A SPECIFIC past paper's test_number, when one was picked (F-118). */
  sourceTest?: number;
  /**
   * The SAME paper's TOPIK level (D-1 / fix-pass S-1) — surfaced here so a
   * mismatch between what was picked and what gets served would at least be
   * visible, never silently swallowed.
   */
  topikLevel?: TopikLevel;
  onStart: () => void;
}): JSX.Element {
  const names = sectionNames(section);
  const mins = SECTION_MINUTES[section];

  const [attemptsNet, setAttemptsNet] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [priorAttempts, setPriorAttempts] = useState<TopikAttemptHistoryEntry[]>([]);
  const [attemptsErrorMsg, setAttemptsErrorMsg] = useState<string | null>(null);
  const [attemptsTick, setAttemptsTick] = useState(0);

  useEffect(() => {
    if (sourceTest === undefined) return undefined;
    const ctrl = new AbortController();
    setAttemptsNet('loading');
    setAttemptsErrorMsg(null);
    fetchAttemptHistory({ limit: 100 }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setPriorAttempts(
          res.attempts.filter(
            (a) => a.section === names.kr && a.sourceTest === sourceTest,
          ),
        );
        setAttemptsNet('ready');
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setAttemptsErrorMsg(toMessage(err, 'Could not load previous attempts.'));
        setAttemptsNet('error');
      });
    return () => {
      ctrl.abort();
    };
    // `names.kr` is a pure function of `section` — the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceTest, section, attemptsTick]);

  // F-183: genuinely nothing-to-show on the previous-attempts panel — either
  // the recommended path can't look anything up yet, or a specific paper's
  // history resolved empty. Drives the honest-empty devices (#3/#6) on that
  // card; never applied while a real fetch is loading/erroring/populated.
  const attemptsEmpty =
    sourceTest === undefined ||
    (attemptsNet === 'ready' && priorAttempts.length === 0);

  return (
    <div className="km-mock__start">
      {/* F-024: back to this section's exam chooser. */}
      <BackButton
        to={`/learn/topik?mode=mock&section=${section}`}
        label={`${names.en} exams`}
      />

      {/* F-183 device #1/#2 — the exam's identity card is a CityCard
          signboard/hanji-paper hero, mirroring Topik's own meta treatment. */}
      <CityCard tone="accent" rail className="km-mock__start-meta">
        <Eyebrow>
          <Bilingual
            en={
              sourceTest !== undefined
                ? `${names.en} · test ${String(sourceTest)}`
                : `${names.en} · recommended exam`
            }
            kr={
              sourceTest !== undefined
                ? `${names.kr} · ${String(sourceTest)}회`
                : `${names.kr} · 추천 시험`
            }
          />
        </Eyebrow>
        {sourceTest !== undefined && topikLevel !== undefined ? (
          // Fix-pass S-1: surface the EXACT level this start page will fetch
          // — a test_number alone names two exams (D-1), so this is the
          // reader-visible confirmation that a mismatch, if one ever slips
          // through, would not go silently unnoticed.
          <p className="km-mock__start-level" role="note">
            <Bilingual en={`${topikLevel} paper`} kr={`${topikLevel} 시험지`} compact />
          </p>
        ) : null}
        <p className="km-mock__start-rules">
          <Bilingual
            en={`50 items · ${String(mins)} minutes, timed. Answers are graded after you submit; unanswered items count as incorrect. The test auto-submits when time runs out.`}
            kr={`50문항 · ${String(mins)}분, 시간 제한이 있어요. 답은 제출한 뒤에 채점되고, 답하지 않은 문제는 오답으로 처리돼요. 시간이 다 되면 자동으로 제출돼요.`}
          />
        </p>
        {section === 'listening' ? (
          <p className="km-mock__audio-note" role="note">
            <Bilingual
              en="Audio isn't available yet — each question shows its transcript instead."
              kr="아직 듣기 음원이 없어요 — 각 문제는 대본으로 표시돼요."
            />
          </p>
        ) : null}
      </CityCard>

      {/* F-104: previous attempts on THIS exam — wired when a specific paper
          is known; an honest note otherwise (see the doc above). F-183
          device #1/#2: a blue-tone CityCard (secondary info, distinct from
          the accent hero above); devices #3/#6 (giwa + watermark) mark it as
          genuinely empty rather than pending, only when it truly is. */}
      <CityCard
        tone="blue"
        rail
        className={cn(
          'km-mock__pending',
          attemptsEmpty && 'km-giwa km-hangul-watermark',
        )}
        data-glyph={attemptsEmpty ? '기록' : undefined}
        role="status"
      >
        <Eyebrow>
          <Bilingual en="Previous attempts" kr="지난 응시 기록" />
        </Eyebrow>

        {sourceTest === undefined ? (
          <p className="km-mock__pending-copy">
            <Bilingual
              en="Pick a specific past paper from the exam list to see your previous attempts on it."
              kr="특정 기출 시험지를 고르면 이전 응시 기록을 볼 수 있어요."
            />
          </p>
        ) : null}

        {sourceTest !== undefined && attemptsNet === 'loading' ? (
          <p className="km-mock__pending-copy">
            <Bilingual en="Loading previous attempts…" kr="지난 기록을 불러오는 중…" />
          </p>
        ) : null}

        {sourceTest !== undefined && attemptsNet === 'error' ? (
          <>
            <p className="km-mock__pending-copy" role="alert">
              {attemptsErrorMsg}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAttemptsTick((n) => n + 1);
              }}
            >
              <Bilingual en="Try again" kr="다시 시도" />
            </Button>
          </>
        ) : null}

        {sourceTest !== undefined &&
        attemptsNet === 'ready' &&
        priorAttempts.length === 0 ? (
          <p className="km-mock__pending-copy">
            <Bilingual
              en="You haven't taken this exam before."
              kr="이 시험을 본 적이 없어요."
            />
          </p>
        ) : null}

        {sourceTest !== undefined && attemptsNet === 'ready' && priorAttempts.length > 0 ? (
          <ul className="km-mock__prior-attempts">
            {priorAttempts.map((a) => {
              const pct =
                a.totalItems > 0 ? Math.round((a.correct / a.totalItems) * 1000) / 10 : 0;
              return (
                <li key={a.attemptId}>
                  <Bilingual
                    en={`${new Date(a.completedAt).toLocaleDateString()} · ${String(a.correct)}/${String(a.totalItems)} (${String(pct)}%)`}
                    kr={`${new Date(a.completedAt).toLocaleDateString()} · ${String(a.correct)}/${String(a.totalItems)} (${String(pct)}%)`}
                    compact
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </CityCard>

      <div className="km-mock__start-row">
        <Button
          variant="gold"
          onClick={onStart}
          trailingIcon={<Icon name="arrow-right" size={14} />}
        >
          <Bilingual en="Start test" kr="시험 시작" />
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Phase: exam
// ─────────────────────────────────────────────────────────────

/**
 * Resume banner (F-007) — shown atop the section-select screen when a saved
 * in-progress mock is found. Dismissible; "Resume" re-fetches the same exam and
 * restores the saved picks / index / timer.
 */
function ResumeBanner({
  attempt,
  onResume,
  onDismiss,
}: {
  attempt: AttemptState;
  onResume: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const sectionKr = attempt.section === 'reading' ? '읽기' : '듣기';
  const sectionEn = attempt.section === 'reading' ? 'Reading' : 'Listening';
  const remainingSec = Math.round(attempt.remainingMs / 1000);
  return (
    <div
      className="km-mock__resume"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 16,
        padding: '12px 16px',
        borderRadius: 12,
        // F-183 fix-pass (batch5): was a literal `rgba(127,127,127,0.25)` —
        // DESIGN_SEOUL_DAY_NIGHT.md §8 bars hardcoded colors app-wide.
        // `--line` is the shared hairline-divider token (index.css), already
        // used for this exact "thin neutral border" role elsewhere in the
        // app, and resolves correctly in both Day/Night themes.
        border: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <strong>
          <Bilingual
            en={`Resume your ${sectionEn} test`}
            kr={`${sectionKr} 시험 이어서 하기`}
          />
        </strong>
        <span style={{ fontSize: '0.85rem', color: 'var(--paper-mute)' }}>
          <Bilingual
            en={`${String(attempt.answered)} answered · ${formatClock(remainingSec)} left`}
            kr={`답변 ${String(attempt.answered)}개 · ${formatClock(remainingSec)} 남음`}
            compact
          />
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="km-btn km-btn--sm focusring"
          onClick={onResume}
        >
          <Bilingual en="Resume" kr="이어서 하기" compact />
        </button>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--sm focusring"
          onClick={onDismiss}
          aria-label="Dismiss resume banner"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** In-progress exam state persisted for resume (F-007). */
interface ExamSaveState {
  currentIdx: number;
  picks: Map<number, ChoiceId>;
  remainingSec: number;
}

interface ExamRunnerProps {
  test: MockTest;
  onSubmit: (body: MockSubmitBody) => void;
  /** When RESUMING a saved attempt: the state to hydrate into (F-007). */
  initial?: { idx: number; picks: Map<number, ChoiceId>; remainingSec: number };
  /** Persist the in-progress state — called on each pick/nav, every 15s, and on
   *  unmount, so the mock survives a reload / leaving the screen (F-007). The
   *  optional signal lets the caller cancel an in-flight save (on submit, so a
   *  late PUT can't resurrect the attempt the submit just cleared). */
  onSave: (state: ExamSaveState, signal?: AbortSignal) => void;
}

/**
 * Format whole seconds as a live countdown — `h:mm:ss` at an hour or more,
 * `mm:ss` below — so every one-second tick is visible. (The original HH:MM
 * format rendered the 70-minute Reading budget as "01:10", which read as
 * 1 min 10 s and only changed once per minute — the timer looked frozen even
 * though the interval was ticking correctly.)
 */
function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function ExamRunner({
  test,
  onSubmit,
  initial,
  onSave,
}: ExamRunnerProps): JSX.Element {
  const items = test.items;
  const total = items.length;
  const [idx, setIdx] = useState(initial?.idx ?? 0);
  // Picks held in memory: itemId(number) → chosen ChoiceId. Render state (not
  // a ref) because the palette marking, the current pick highlight, and the
  // answered count are all render inputs. Switching items preserves picks; we
  // replace the Map immutably on each pick so React sees a new reference. The
  // map is small (≤ section size), so the per-pick copy is negligible.
  const [picks, setPicks] = useState<Map<number, ChoiceId>>(
    () => initial?.picks ?? new Map(),
  );
  // Whether the confirm-submit dialog is showing.
  const [confirming, setConfirming] = useState(false);
  // Guard so an auto-submit + a manual submit can't both fire.
  const submittedRef = useRef(false);
  // One AbortController per in-flight progress save (F-007), so a newer save —
  // or submit — cancels the previous one. Prevents out-of-order PUTs and,
  // critically, stops a save in flight at submit time from re-INSERTing the
  // attempt that /mock/submit just deleted.
  const saveCtrlRef = useRef<AbortController | null>(null);
  // Container for the submit-confirm alertdialog — focus-trapped via
  // useModalA11y so it meets the same modal a11y bar as Sheet / WordPopover
  // (initial focus in, Esc to dismiss, focus restored on close).
  const confirmRef = useRef<HTMLDivElement>(null);
  useModalA11y({
    open: confirming,
    onClose: () => {
      setConfirming(false);
    },
    containerRef: confirmRef,
  });

  const current: TopikMockItem | undefined = items[idx];

  // ── Per-item time tracking (no Date.now() in render) ──────────────────
  // Wall-clock stamp of when the current item became visible, and the running
  // accumulated time per item. Both live in refs and are stamped only in
  // effects/handlers. `Date.now()` never runs during render.
  const itemShownAtRef = useRef<number>(0);
  const accumMsRef = useRef<Map<number, number>>(new Map());
  // Wall-clock stamp of when the exam started, for the best-effort durationMs.
  const examStartRef = useRef<number>(0);
  // Absolute wall-clock instant the exam must auto-submit at. The countdown is
  // derived from this (deadline − now), never from counting interval ticks, so
  // a throttled/backgrounded tab can't drift or gain extra time. 0 until the
  // mount effect below establishes it.
  const deadlineRef = useRef<number>(0);

  // Stamp the start time + the auto-submit deadline once, on mount. A RESUMED
  // exam (F-007) budgets only its saved remaining seconds, not the full section
  // allotment — and since `remaining` is re-derived from this deadline, the
  // persisted value the 15s save loop writes is the true wall-clock remaining,
  // so a resume can no longer inherit interval drift from the previous session.
  useEffect(() => {
    // One-shot by construction: once the deadline is armed, never restamp it.
    // The deps are referentially stable for the life of an exam today, but if a
    // future parent change ever re-created `initial` per render, a restamp here
    // would silently hand out a fresh time budget mid-exam.
    if (deadlineRef.current !== 0) return;
    const now = Date.now();
    examStartRef.current = now;
    itemShownAtRef.current = now;
    deadlineRef.current =
      now + (initial?.remainingSec ?? SECTION_MINUTES[test.section] * 60) * 1000;
  }, [initial, test.section]);

  // Flush the time spent on the item we're leaving into the accumulator, then
  // stamp the freshly-shown item. Called from the navigation handlers (NOT in
  // render) so the wall-clock read is handler-driven.
  const flushItemTime = useCallback((leavingItemId: number): void => {
    const now = Date.now();
    const spent = Math.max(0, now - itemShownAtRef.current);
    accumMsRef.current.set(
      leavingItemId,
      (accumMsRef.current.get(leavingItemId) ?? 0) + spent,
    );
    itemShownAtRef.current = now;
  }, []);

  // ── Countdown timer ────────────────────────────────────────────────────
  // Remaining whole seconds in render state, RE-DERIVED from the wall-clock
  // deadline by the interval below (not decremented). Seeded from the resumed
  // remaining (F-007) or the section budget so the very first paint (before the
  // first interval fire) is correct; render itself never reads the clock.
  const [remaining, setRemaining] = useState<number>(
    () => initial?.remainingSec ?? SECTION_MINUTES[test.section] * 60,
  );

  // Build the submit body from the picks state + per-item timings. Reads the
  // `picks` state (a render input) and stamps wall-clock only here in a
  // handler-invoked callback — never during render.
  const buildBody = useCallback((): MockSubmitBody => {
    // Fold the current item's elapsed time in before reading the accumulator.
    if (current !== undefined) flushItemTime(Number(current.id));
    const answers: MockSubmitAnswer[] = [];
    for (const [itemId, picked] of picks.entries()) {
      const rawTimeMs = accumMsRef.current.get(itemId);
      // Clamp to the server's schema cap — an unclamped sleep-gap delta
      // would 400 the entire submit (see MAX_ITEM_TIME_MS).
      const timeMs =
        rawTimeMs !== undefined
          ? Math.min(rawTimeMs, MAX_ITEM_TIME_MS)
          : undefined;
      answers.push(
        timeMs !== undefined ? { itemId, picked, timeMs } : { itemId, picked },
      );
    }
    const durationMs = Math.max(0, Date.now() - examStartRef.current);
    return {
      sourceTest: test.sourceTest,
      // Fix-pass S-1 / D-1: echo the SAME level the fetch resolved so the
      // shared server-side resolver grades the EXACT paper that was served,
      // never a re-resolved DIFFERENT paper (a test_number alone names two
      // exams — TOPIK I and TOPIK II share every test_number).
      topikLevel: test.topikLevel,
      section: test.section,
      answers,
      durationMs,
    };
  }, [current, flushItemTime, picks, test.sourceTest, test.topikLevel, test.section]);

  // Submit guard — fires once. Shared by the confirm button and auto-submit.
  const doSubmit = useCallback((): void => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    // Cancel any in-flight progress save so it can't land after the submit's
    // DELETE and resurrect the attempt (F-007).
    saveCtrlRef.current?.abort();
    setConfirming(false);
    onSubmit(buildBody());
  }, [buildBody, onSubmit]);

  // The countdown interval. Once/sec it RE-SAMPLES the wall clock and derives
  // `remaining` from `deadline − now` (ceil to whole seconds, floored at 0) —
  // it is a render trigger, not the source of truth. A tab that was throttled
  // or suspended and skipped fires still lands on the correct remaining the next
  // time it ticks, and can never be handed extra exam time by a drifting tick
  // counter. No side effects / no parent set-state here — the auto-submit is a
  // separate effect keyed on `remaining` reaching 0 — and the setState lives
  // only in the interval callback (never synchronously in the effect body).
  // Cleared on unmount/leave via the effect cleanup.
  useEffect(() => {
    const id = setInterval(() => {
      // Guard the window before the mount effect established the deadline, so a
      // stray early fire can't read 0 and auto-submit the exam instantly.
      if (deadlineRef.current === 0) return;
      setRemaining(
        Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)),
      );
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);

  // Auto-submit when the clock hits 0 (submits whatever is answered). The
  // submittedRef guard inside doSubmit ensures a manual submit that already
  // fired wins and this can't double-fire. This is the sync-to-external-system
  // case — the timer reaching 0 must kick the grade network call (via the
  // parent's onSubmit) and flip phase, exactly like Diagnostic's mount-start
  // effect; the resulting set-state is intentional, not a render cascade.
  useEffect(() => {
    if (remaining <= 0 && !submittedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      doSubmit();
    }
  }, [remaining, doSubmit]);

  const goTo = useCallback(
    (nextIdx: number): void => {
      if (current !== undefined) flushItemTime(Number(current.id));
      const clamped = Math.min(Math.max(0, nextIdx), Math.max(0, total - 1));
      setIdx(clamped);
    },
    [current, flushItemTime, total],
  );

  const pick = useCallback((itemId: number, choice: ChoiceId): void => {
    setPicks((prev) => {
      const next = new Map(prev);
      next.set(itemId, choice);
      return next;
    });
  }, []);

  // ── Resume persistence (F-007) ──────────────────────────────────────────
  // Mirror the live state in a ref so the interval + unmount saves read the
  // LATEST values (their closures would otherwise capture stale state). Writing
  // a ref during render is the standard "latest value" pattern — it's not
  // reactive state and triggers no re-render.
  const stateRef = useRef<ExamSaveState>({
    currentIdx: idx,
    picks,
    remainingSec: remaining,
  });
  // Keep the ref current via an effect (writing a ref during render is
  // disallowed). Declared BEFORE the save effects so the ref is up-to-date when
  // they read it. Runs each tick — a cheap assignment, no re-render.
  useEffect(() => {
    stateRef.current = { currentIdx: idx, picks, remainingSec: remaining };
  }, [idx, picks, remaining]);

  // Persist the current in-progress state. No-op once submitted — the server
  // clears the attempt on submit, so a late save must not resurrect it.
  const saveProgress = useCallback((): void => {
    if (submittedRef.current) return;
    saveCtrlRef.current?.abort();
    const ctrl = new AbortController();
    saveCtrlRef.current = ctrl;
    // Persist a FRESH deadline sample, not the interval-derived `remainingSec`
    // state: in a heavily throttled background tab the countdown interval can
    // go ~a minute between fires, so the state can be that much stale-generous
    // and a save→resume from such a tab would inherit the surplus. Before the
    // mount effect arms the deadline (=== 0) fall back to the seeded state.
    // This is a handler/interval context, so reading the clock here keeps the
    // no-`Date.now()`-in-render discipline intact.
    const remainingSec =
      deadlineRef.current === 0
        ? stateRef.current.remainingSec
        : Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
    onSave({ ...stateRef.current, remainingSec }, ctrl.signal);
  }, [onSave]);

  // Save on each pick / navigation (captures every answer) + once on mount.
  useEffect(() => {
    saveProgress();
  }, [idx, picks, saveProgress]);

  // Save periodically so the countdown's progress survives an idle close, plus a
  // final flush on unmount (leaving the screen mid-exam).
  useEffect(() => {
    const id = setInterval(saveProgress, 15000);
    return () => {
      clearInterval(id);
      saveProgress();
    };
  }, [saveProgress]);

  // Coarse screen-reader cue — deliberately NOT per-second. A `role="timer"`
  // whose text changes every second, in a live region, narrates near-
  // continuously; so the visible clock is aria-live="off" and spoken cues come
  // only at meaningful marks (each of the final five one-minute boundaries, a
  // 30-second warning, and time-up) via the separate polite sr-only region in
  // the exam head. Between marks this is '' so nothing is queued (no per-tick
  // announcement spam). Declared before the early return below so the hook
  // order is unconditional (Rules of Hooks).
  const timerAnnouncement = useMemo<string>(() => {
    if (remaining <= 0) return 'Time is up. Submitting your test.';
    if (remaining === 30) return '30 seconds remaining.';
    if (remaining <= 300 && remaining % 60 === 0) {
      const mins = remaining / 60;
      return `${String(mins)} ${mins === 1 ? 'minute' : 'minutes'} remaining.`;
    }
    return '';
  }, [remaining]);

  if (current === undefined) {
    // Defensive: an empty exam can't be taken. Offer a way out rather than
    // blanking. (The select path won't reach here for a non-empty section.)
    return (
      <ErrorCard
        message="This mock test has no items."
        onRetry={() => {
          doSubmit();
        }}
        retryLabel="Finish"
      />
    );
  }

  const currentId = Number(current.id);
  const pickedHere = picks.get(currentId) ?? null;
  const answeredCount = picks.size;
  const sectionLabel = test.section === 'reading' ? 'Reading' : 'Listening';
  const sectionLabelKr = test.section === 'reading' ? '읽기' : '듣기';
  // Image-dependent item (no stored asset — see lib/topikImage.ts): feature
  // the bracketed text description in a labelled block, same as Study mode.
  const imageSplit =
    current.hasImage === true
      ? splitImageItem(current.prompt, current.imageText)
      : null;

  return (
    <div className="km-mock__exam">
      {/* F-024: an explicit way out of a running exam. Leaving unmounts the
          runner, whose cleanup flushes a final progress save (F-007), so the
          attempt is resumable from the banner — nothing is lost. The `to`
          URL drops the `exam` param; MockMode's back-guard effect exits the
          exam phase. */}
      <BackButton
        to={`/learn/topik?mode=mock&section=${test.section}`}
        label={`${sectionLabel} exams`}
      />

      {test.section === 'listening' ? (
        // F-080 (honest stub): per-question audio is not servable today. The
        // raw corpus DOES hold one whole-section MP3 per paper (e.g.
        // `60th-TOPIK-II-Listening-Audio.mp3`), but nothing is ingested —
        // there is no audio column/DTO field, no serving route, and no
        // per-question timestamps to cut clips from. A play control per item
        // needs that ingest + segmentation + route — data-gap ticket F-119.
        // Until then, say so once, up front, instead of faking a player.
        <p className="km-mock__audio-note" role="note">
          <Bilingual
            en="Audio isn't available yet — each question shows its transcript instead."
            kr="아직 듣기 음원이 없어요 — 각 문제는 대본으로 표시돼요."
          />
        </p>
      ) : null}

      <div className="km-mock__exam-head">
        <Pill tone="red">
          <Bilingual en="Timed · live" kr="실전 · 시간 제한" compact />
        </Pill>
        <span
          className="km-mock__timer"
          role="timer"
          // aria-live OFF on the ticking value: a role="timer" whose text
          // changes every second queues a screen-reader announcement per tick
          // (polite still enqueues — it only defers). Coarse spoken cues come
          // from the sr-only polite region below instead.
          aria-live="off"
          aria-label={`Time remaining ${formatClock(remaining)}`}
        >
          <Icon name="timer" size={16} />
          <span className="km-mock__timer-val">{formatClock(remaining)}</span>
        </span>
        <span className="km-sr-only" aria-live="polite">
          {timerAnnouncement}
        </span>
      </div>

      <div className="km-mock__progress">
        <Bilingual
          en={`${sectionLabel} · ${String(idx + 1)} / ${String(total)}`}
          kr={`${sectionLabelKr} · ${String(idx + 1)} / ${String(total)}`}
          compact
        />
      </div>

      {/* F-183 device #5 — the signature subway-line progress metaphor
          alongside the existing "N / M" readout, mirroring Study mode's
          per-item stepping. The jump-grid `QuestionPalette` below keeps its
          richer per-item answered/current state and free-jump navigation —
          the subway line is a supplementary at-a-glance progress read, not a
          replacement for it. */}
      <div className="km-mock__subwaywrap">
        <SubwayProgress
          steps={total}
          current={idx}
          tone={sectionTone(test.section)}
          label={`${sectionLabel} progress`}
          valueText={`Item ${String(idx + 1)} of ${String(total)}`}
        />
      </div>

      <QuestionPalette
        items={items}
        currentIdx={idx}
        picks={picks}
        onJump={goTo}
      />

      {/* F-183 device #1/#2 — the live exam item is the runner's hero
          surface, mirroring Study mode's `TopikBody` CityCard treatment
          exactly: a signboard/hanji-paper card with a leading DancheongRail
          around the meta/prompt/passage/choices/nav/submit. */}
      <CityCard rail tone={sectionTone(test.section)} className="km-mock__examcard">
        <div className="km-mock__meta">
          <Pill tone="gold">
            {current.section} · L{String(current.level)}
          </Pill>
          <span className="km-topik__num">No. {String(current.number)}</span>
        </div>

        {imageSplit === null ? (
          <p className="kr km-topik__prompt">{current.prompt}</p>
        ) : (
          <>
            {imageSplit.body !== '' ? (
              <p className="kr km-topik__prompt">{imageSplit.body}</p>
            ) : null}
            <TopikImageNote description={imageSplit.description} />
          </>
        )}

        {/* Shared reading passage (B-008): question content the server keeps on
            the answer-stripped wire — without it the item is unanswerable. */}
        {current.passage ? <TopikPassage text={current.passage} /> : null}

        <ChoiceGroup
          item={current}
          picked={pickedHere}
          onPick={(choice) => {
            pick(currentId, choice);
          }}
        />

        <div className="km-mock__nav">
          <Button
            variant="ghost"
            disabled={idx === 0}
            onClick={() => {
              goTo(idx - 1);
            }}
          >
            <Bilingual en="Prev" kr="이전" />
          </Button>
          <span className="km-topik__count">
            <Bilingual
              en={`${String(answeredCount)} / ${String(total)} answered`}
              kr={`답변 ${String(answeredCount)} / ${String(total)}`}
              compact
            />
          </span>
          <Button
            variant="ghost"
            disabled={idx >= total - 1}
            onClick={() => {
              goTo(idx + 1);
            }}
            trailingIcon={<Icon name="arrow-right" size={14} />}
          >
            <Bilingual en="Next" kr="다음" />
          </Button>
        </div>

        <div className="km-mock__submit-row">
          <Button
            variant="gold"
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Bilingual en="Submit test" kr="시험 제출" />
          </Button>
        </div>
      </CityCard>

      {confirming ? (
        // Card/CityCard don't forward refs, so the focus-trap container is
        // this div, which also carries the alertdialog role + label
        // (useModalA11y above). F-183 fix-pass (batch5): reskinned onto the
        // Seoul kit's CityCard (tone matches the exam's own sectionTone, same
        // as the exam card/SubwayProgress above) — this dialog is the one
        // surface in the flow the earlier pass left on the flat `Card`. The
        // alertdialog role/focus-trap/Esc/backdrop-free contract is
        // unchanged; only the surface styling changes.
        <div ref={confirmRef} role="alertdialog" aria-label="Confirm submit">
          <CityCard
            tone={sectionTone(test.section)}
            rail
            className="km-mock__confirm"
          >
            <Eyebrow>
              <Bilingual en="Submit test?" kr="시험을 제출할까요?" />
            </Eyebrow>
            <p className="km-topik__explain">
              <Bilingual
                en={`You’ve answered ${String(answeredCount)} of ${String(total)}. Unanswered items are marked incorrect. This can’t be undone.`}
                kr={`전체 ${String(total)}문항 중 ${String(answeredCount)}문항에 답했어요. 답하지 않은 문제는 오답으로 처리돼요. 제출하면 되돌릴 수 없어요.`}
              />
            </p>
            <div className="km-topik__footer">
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                <Bilingual en="Keep going" kr="계속 풀기" />
              </Button>
              <Button
                variant="gold"
                onClick={doSubmit}
                trailingIcon={<Icon name="arrow-right" size={14} />}
              >
                <Bilingual en="Submit" kr="제출" />
              </Button>
            </div>
          </CityCard>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Question palette — jump grid marking answered / unanswered / current
// ─────────────────────────────────────────────────────────────

interface QuestionPaletteProps {
  items: TopikMockItem[];
  currentIdx: number;
  picks: Map<number, ChoiceId>;
  onJump: (idx: number) => void;
}

function QuestionPalette({
  items,
  currentIdx,
  picks,
  onJump,
}: QuestionPaletteProps): JSX.Element {
  return (
    <div
      className="km-mock__palette"
      role="group"
      aria-label="Question navigator"
    >
      {items.map((it, i) => {
        const answered = picks.has(Number(it.id));
        const isCurrent = i === currentIdx;
        return (
          <button
            key={it.id}
            type="button"
            aria-current={isCurrent ? 'true' : undefined}
            aria-label={`Question ${String(i + 1)}${
              answered ? ', answered' : ', not answered'
            }${isCurrent ? ', current' : ''}`}
            className={cn(
              'km-mock__palette-cell focusring',
              isCurrent && 'km-mock__palette-cell--current',
              answered && !isCurrent && 'km-mock__palette-cell--answered',
            )}
            onClick={() => {
              onJump(i);
            }}
          >
            {String(i + 1)}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Choice group — roving-tabindex radiogroup (WAI-ARIA APG)
// ─────────────────────────────────────────────────────────────

interface ChoiceGroupProps {
  item: TopikMockItem;
  picked: ChoiceId | null;
  onPick: (choice: ChoiceId) => void;
}

/**
 * The exam answer choices as a radiogroup implementing the WAI-ARIA APG
 * separated-focus keyboard contract (mirrors SwatchPicker): arrows move focus
 * only, Space/Enter (or click) commits the focused choice as the pick. There
 * is NO reveal — the answer is server-side, so no choice is ever marked
 * correct/wrong here.
 */
function ChoiceGroup({ item, picked, onPick }: ChoiceGroupProps): JSX.Element {
  const options = item.options;
  const ids = options.map((o) => o.id);
  const refs = useRef<Map<ChoiceId, HTMLButtonElement>>(new Map());

  // Focused id is separate from the pick (separated-focus APG variant), so an
  // arrow-sweep doesn't commit a pick on every keypress. Anchored on the pick
  // (or the first choice) so Tab into the group lands sensibly.
  const [focusedId, setFocusedId] = useState<ChoiceId>(picked ?? ids[0] ?? 'a');

  // Resync the roving anchor when the item changes (a new question's picked
  // value, or its first choice). Without this the anchor would drift to a
  // choice id that may not exist on the new item.
  useEffect(() => {
    setFocusedId(picked ?? ids[0] ?? 'a');
    // Intentionally keyed on the item id only: re-running on every `picked`
    // change would yank focus back to the pick after the user arrows away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const moveFocus = useCallback(
    (nextIndex: number): void => {
      const wrapped = (nextIndex + ids.length) % ids.length;
      const nextId = ids[wrapped];
      if (nextId === undefined) return;
      setFocusedId(nextId);
      refs.current.get(nextId)?.focus();
    },
    [ids],
  );

  const focusedIndex = ids.indexOf(focusedId);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(focusedIndex + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(focusedIndex - 1);
          break;
        case 'Home':
          e.preventDefault();
          moveFocus(0);
          break;
        case 'End':
          e.preventDefault();
          moveFocus(ids.length - 1);
          break;
        case ' ':
        case 'Spacebar':
        case 'Enter':
          e.preventDefault();
          onPick(focusedId);
          break;
        default:
          break;
      }
    },
    [focusedIndex, ids.length, moveFocus, onPick, focusedId],
  );

  return (
    <div
      className="km-topik__choices"
      role="radiogroup"
      aria-label="Answer choices"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => {
        const isPicked = picked === o.id;
        const isFocused = focusedId === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={isPicked}
            // Roving tabindex anchored on focus so Tab lands on the last-looked
            // choice (separated-focus APG pattern, like SwatchPicker).
            tabIndex={isFocused ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(o.id, el);
              else refs.current.delete(o.id);
            }}
            onFocus={() => {
              if (o.id !== focusedId) setFocusedId(o.id);
            }}
            className={cn(
              'km-topik__choice focusring',
              isPicked && 'km-topik__choice--picked',
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
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Phase: results — SHARED between Mock (server-graded) and Study
// (client-tallied) via `TopikResults` (F-008). Neither mode duplicates the
// score/review markup: each normalizes its own outcome data into the
// mode-agnostic `ResultsSummary` shape below and hands it to one renderer.
// ─────────────────────────────────────────────────────────────

/**
 * Sentinel `pickedText` for an item the learner left unanswered. Shared by
 * BOTH producers (mock rows in `buildMockResultsSummary` below, study rows in
 * Topik.tsx `buildReviewRow`) and the F-020 seed gate that must never label a
 * skip as a wrong "My answer" — one constant so a copy tweak can't silently
 * desynchronize them.
 */
export const SKIPPED_PICK = 'skipped';

/**
 * One row in the shared results review list (F-008). Mock mode derives this
 * from the server's per-item `MockReveal` (`buildMockResultsSummary` below);
 * Study mode (Topik.tsx `StudyMode`) tallies the same shape client-side from
 * the inline-`correct` reveals the learner already saw while working through
 * the draw — no second grading pass, just a normalized record of what was
 * already shown.
 */
export interface ResultsReviewRow {
  /** Unique React key — the item id (string or number depending on source). */
  key: string | number;
  number: number;
  prompt: string;
  /** The shared reading passage the item was asked about (B-008), if any. */
  passage?: string;
  isCorrect: boolean;
  /** Display text for the learner's pick, or `SKIPPED_PICK` if left blank. */
  pickedText: string;
  /** Display text for the correct choice — always computed, only ever shown
   *  when `!isCorrect` (F-009: wrong-answer detail is for misses only). */
  correctText: string;
  /** Only rendered when `!isCorrect` (F-009 — see `TopikResults` below). */
  explanation: string;
}

/** The score + review summary `TopikResults` renders — the shape BOTH modes'
 *  results screens tally into (F-008), so one component serves both. */
export interface ResultsSummary {
  percentage: number;
  band: string;
  correct: number;
  totalItems: number;
  answered: number;
  rows: ResultsReviewRow[];
}

interface TopikResultsProps {
  summary: ResultsSummary;
  onRestart: () => void;
  /** "New mock" (Mock mode) or "New set" (Study mode) — chrome, so callers
   *  pass a `<Bilingual>` pair (P3b). */
  restartLabel: ReactNode;
}

/**
 * Shared results/grade screen (F-008): score card + per-item review list.
 * Used by Mock mode (server-graded `MockResult`) and Study mode (client-
 * tallied reveals) alike — see `ResultsSummary` above for the shared shape.
 *
 * F-009: the explanation paragraph is gated on `!row.isCorrect` — explanation
 * detail is for the items the learner actually missed, not every item. The
 * correct-choice line is gated the same way (unchanged from the prior Mock-
 * only behavior): a correct pick needs no "here's what you should have
 * picked" callout.
 */
export function TopikResults({
  summary,
  onRestart,
  restartLabel,
}: TopikResultsProps): JSX.Element {
  const wrongCount = summary.totalItems - summary.correct;

  return (
    <div className="km-mock__results">
      {/* F-183 device #1/#2 — the score panel is a feat CityCard hero
          (the milestone/completion surface), replacing the plain flat
          Card, shared by both Mock's server-graded and Study's
          client-tallied results screens. */}
      <CityCard tone="accent" rail feat className="km-mock__score">
        <Eyebrow>{summary.band}</Eyebrow>
        <div className="km-mock__score-pct">
          {String(summary.percentage)}
          <span className="km-mock__score-unit">%</span>
        </div>
        <p className="km-topik__explain">
          <Bilingual
            en={`${String(summary.correct)} / ${String(summary.totalItems)} correct · ${String(summary.answered)} answered · ${
              wrongCount > 0 ? `${String(wrongCount)} to review` : 'no misses'
            }`}
            kr={`정답 ${String(summary.correct)} / ${String(summary.totalItems)} · 답변 ${String(summary.answered)}개 · ${
              wrongCount > 0
                ? `복습할 문제 ${String(wrongCount)}개`
                : '틀린 문제 없음'
            }`}
          />
        </p>
      </CityCard>

      <Eyebrow className="km-mock__review-head">
        <Bilingual en="Review" kr="복습" />
      </Eyebrow>
      <ol className="km-mock__review">
        {summary.rows.map((row, i) => {
          const markerId = `km-mock-reveal-${String(row.key)}`;
          return (
            <li key={row.key}>
              <Card
                variant="flat"
                className={cn(
                  'km-mock__review-item',
                  row.isCorrect
                    ? 'km-mock__review-item--correct'
                    : 'km-mock__review-item--wrong',
                )}
                id={markerId}
              >
                <div className="km-mock__review-top">
                  <span className="km-topik__num">
                    No. {String(row.number || i + 1)}
                  </span>
                  <span
                    className={cn(
                      'km-mock__verdict',
                      row.isCorrect
                        ? 'km-mock__verdict--correct'
                        : 'km-mock__verdict--wrong',
                    )}
                  >
                    {row.isCorrect ? (
                      <>
                        <Icon name="check" size={14} />{' '}
                        <Bilingual en="Correct" kr="맞았어요" compact />
                      </>
                    ) : (
                      <>
                        {'✗ '}
                        <Bilingual en="Incorrect" kr="틀렸어요" compact />
                      </>
                    )}
                  </span>
                </div>
                <p className="kr km-mock__review-prompt">{row.prompt}</p>
                {/* The passage the item was asked about (B-008) — the review
                    is unreadable without the text the question refers to. */}
                {row.passage ? <TopikPassage text={row.passage} /> : null}
                <div className="km-mock__review-picks">
                  <span className="km-mock__review-pick">
                    <Bilingual en="Your answer" kr="내 답" compact />:{' '}
                    <span className="kr">{row.pickedText}</span>
                  </span>
                  {!row.isCorrect ? (
                    <span className="km-mock__review-pick km-mock__review-pick--correct">
                      <Bilingual en="Correct answer" kr="정답" compact />:{' '}
                      <span className="kr">{row.correctText}</span>
                    </span>
                  ) : null}
                </div>
                {/* F-009: gated on !isCorrect — explanations surface only for
                    the items the learner actually missed. */}
                {!row.isCorrect && row.explanation.trim().length > 0 ? (
                  <p className="km-topik__explain">{row.explanation}</p>
                ) : null}
                {/* F-020: hand this reviewed item to the Chat tutor. The
                    explanation/miss fields mirror the F-009 gating above —
                    the seed only carries what this reveal actually shows. */}
                <div style={{ marginTop: 10 }}>
                  <AskAboutThisButton
                    prompt={row.prompt}
                    correctText={row.correctText}
                    passage={row.passage}
                    explanation={!row.isCorrect ? row.explanation : undefined}
                    userPick={
                      !row.isCorrect && row.pickedText !== SKIPPED_PICK
                        ? row.pickedText
                        : undefined
                    }
                  />
                </div>
              </Card>
            </li>
          );
        })}
      </ol>

      <div className="km-topik__footer">
        <Button
          variant="gold"
          onClick={onRestart}
          trailingIcon={<Icon name="arrow-right" size={14} />}
        >
          {restartLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Normalize a graded `MockResult` + the exam's answer-stripped items into the
 * shared `ResultsSummary` (F-008). The server already computed percentage/
 * band/correct — this only maps the per-item reveal + the item's prompt/
 * passage/choice text into `ResultsReviewRow`.
 */
function buildMockResultsSummary(
  result: MockResult,
  items: TopikMockItem[],
): ResultsSummary {
  // Index the items by their WIRE id (a string — the server projects
  // `i.id::text`, and `MockReveal.itemId` is the same string). The old code
  // built a Map<number> via Number(it.id) and looked it up with the string
  // reveal id — every lookup missed, so real mock reviews rendered number 0,
  // an empty prompt, and '—' for both picks.
  const byId = new Map<string, TopikMockItem>(items.map((it) => [it.id, it]));

  const choiceText = (
    item: TopikMockItem | undefined,
    id: ChoiceId | null,
  ): string => {
    if (item === undefined || id === null) return '—';
    const opt = item.options.find((o) => o.id === id);
    return opt ? opt.kr : id.toUpperCase();
  };

  const rows: ResultsReviewRow[] = result.items.map((rev) => {
    const item = byId.get(rev.itemId);
    return {
      key: rev.itemId,
      number: item?.number ?? 0,
      prompt: item?.prompt ?? '',
      ...(item?.passage !== undefined ? { passage: item.passage } : {}),
      isCorrect: rev.isCorrect,
      pickedText:
        rev.picked === null ? SKIPPED_PICK : choiceText(item, rev.picked),
      correctText: choiceText(item, rev.correctChoiceId),
      explanation: rev.explanation,
    };
  });

  return {
    percentage: result.percentage,
    band: result.band,
    correct: result.correct,
    totalItems: result.totalItems,
    answered: result.answered,
    rows,
  };
}
