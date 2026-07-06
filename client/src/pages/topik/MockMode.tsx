/**
 * MockMode — the TOPIK answer-stripped, server-graded Mock-Test flow (FU-NF-39).
 *
 * A three-phase state machine:
 *
 *   select  → section cards (Reading 50/~70min, Listening 50/~60min; Writing
 *             disabled "coming soon" → FU-NF-47). Tapping a section fetches an
 *             answer-stripped exam (`fetchMockTest`) and enters `exam`.
 *   exam    → a countdown timer (from the section's allotted minutes, ticking
 *             once/sec; auto-submits at 0), one item at a time with a question
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
 * React-19 discipline: the timer is an interval owned by an effect with
 * cleanup (cleared on unmount, exit, and submit); no `Date.now()`/`Math.random()`
 * runs in render; per-item time is stamped in handlers/effects into a ref and
 * read only in a handler. The network flow manages its own AbortController and
 * aborts on unmount.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { AskAboutThisButton } from '../../components/AskAboutThisButton';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Pill } from '../../components/Pill';
import { Eyebrow } from '../../components/Eyebrow';
import { Icon } from '../../components/Icon';
import { ErrorCard } from '../../components/ErrorCard';
import { MockBadge } from '../../components/MockBadge';
import { TopikImageNote } from '../../components/TopikImageNote';
import { TopikPassage } from '../../components/TopikPassage';
import { cn } from '../../lib/cn';
import { splitImageItem } from '../../lib/topikImage';
import { useModalA11y } from '../../hooks/useModalA11y';
import { ApiError } from '../../services/api';
import {
  fetchMockTest,
  submitMockTest,
  fetchAttempt,
  saveAttempt,
  clearAttempt,
  type AttemptState,
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
  TopikMockItem,
} from '../../types/domain';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

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

/** Allotted minutes per section — the countdown's starting seconds = mins×60. */
const SECTION_MINUTES: Record<MockSection, number> = {
  reading: 70,
  listening: 60,
};

function toMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Phase of the in-flight network call (orthogonal to the exam phase machine). */
type NetPhase = 'idle' | 'loading' | 'submitting' | 'error';

/** What the network error refers to — drives which retry the ErrorCard wires. */
type NetErrorKind = 'fetch' | 'submit';

export function MockMode(): JSX.Element {
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

  const beginCall = useCallback((): AbortController => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    return ctrl;
  }, []);

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
          setPhase('exam');
        })
        .catch(() => {
          // The exact exam couldn't be re-fetched — drop the (now stale) banner
          // and stay on select rather than block. The attempt row is harmless.
          if (ctrl.signal.aborted) return;
          setResumable(null);
          setNet('idle');
        });
    },
    [beginCall],
  );

  // Start a section: fetch the answer-stripped exam, falling back to the
  // offline fixture so the exam always opens (failure-safe).
  const startSection = useCallback(
    (section: MockSection): void => {
      const ctrl = beginCall();
      setNet('loading');
      setErrorMsg(null);
      setResult(null);
      // Fresh start: no hydration, and dismiss any resume banner. The exam's
      // first save will upsert-replace any prior in-progress attempt.
      setInitialExam(null);
      setResumable(null);
      fetchMockTest(section, ctrl.signal)
        .then((real) => {
          if (ctrl.signal.aborted) return;
          setTest(real);
          setIsMock(false);
          setNet('idle');
          setPhase('exam');
        })
        .catch((realErr: unknown) => {
          if (ctrl.signal.aborted) return;
          // Failure-safe: fall back to the offline fixture rather than blank
          // the screen. The 🅂 badge fires so a dev sees it's not the server.
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
    // fresh select shows no resume banner.
    setInitialExam(null);
    setResumable(null);
    setPhase('select');
  }, []);

  return (
    <div className="km-mock" style={{ position: 'relative' }}>
      {isMock && (phase === 'exam' || phase === 'results') ? (
        <MockBadge />
      ) : null}

      {net === 'loading' ? (
        <div className="km-topik__state" role="status">
          Loading mock test…
        </div>
      ) : null}

      {net === 'submitting' ? (
        <div className="km-topik__state" role="status">
          Grading your test…
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
          {phase === 'select' ? (
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
              <SectionSelect onStart={startSection} />
            </>
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
            <TopikResults
              summary={buildMockResultsSummary(result, test?.items ?? [])}
              onRestart={newMock}
              restartLabel="New mock"
            />
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
  onStart: (section: MockSection) => void;
}

function SectionSelect({ onStart }: SectionSelectProps): JSX.Element {
  return (
    <div className="km-mock__select">
      <p className="km-mock__lead">
        Pick a section to take a timed, scored mock. Answers are graded after
        you submit — no peeking mid-exam.
      </p>
      <div className="km-mock__sections">
        {SECTIONS.map((s) => {
          const disabled = s.disabled === true;
          return (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              aria-label={
                disabled
                  ? `${s.en} mock test, coming soon`
                  : `Start ${s.en} mock test, ${String(s.items)} items, about ${String(s.mins)} minutes`
              }
              className={cn(
                'km-mock__section focusring',
                disabled && 'km-mock__section--disabled',
              )}
              onClick={() => {
                // Writing is deferred (FU-NF-47); the card is disabled so this
                // never fires for it, but the union-narrowing guard keeps the
                // call type-safe (`onStart` accepts only MockSection).
                if (!disabled && s.id !== 'writing') onStart(s.id);
              }}
            >
              <span className="km-mock__section-en">{s.en}</span>
              <span className="kr km-mock__section-kr">
                {s.kr} · {String(s.items)} items · {String(s.mins)} min
              </span>
              {disabled ? (
                <span className="km-mock__section-soon">
                  <Pill tone="default">Coming soon</Pill>
                </span>
              ) : (
                <span className="km-mock__section-go">
                  Start <Icon name="arrow-right" size={13} />
                </span>
              )}
            </button>
          );
        })}
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
        border: '1px solid rgba(127, 127, 127, 0.25)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <strong>
          Resume your <span className="kr">{sectionKr}</span> test
        </strong>
        <span style={{ fontSize: '0.85rem', color: 'var(--paper-mute)' }}>
          {attempt.answered} answered · {formatClock(remainingSec)} left
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="km-btn km-btn--sm focusring"
          onClick={onResume}
        >
          Resume
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

  // Stamp the start time once, on mount.
  useEffect(() => {
    const now = Date.now();
    examStartRef.current = now;
    itemShownAtRef.current = now;
  }, []);

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
  // Remaining seconds in render state, decremented by an interval owned by an
  // effect with cleanup. Initialised from the section's allotted minutes. The
  // interval is the ONLY ticker; render never reads the clock.
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
      const timeMs = accumMsRef.current.get(itemId);
      answers.push(
        timeMs !== undefined ? { itemId, picked, timeMs } : { itemId, picked },
      );
    }
    const durationMs = Math.max(0, Date.now() - examStartRef.current);
    return {
      sourceTest: test.sourceTest,
      section: test.section,
      answers,
      durationMs,
    };
  }, [current, flushItemTime, picks, test.sourceTest, test.section]);

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

  // The countdown interval. Ticks once/sec, decrementing `remaining` in state.
  // The updater only touches the clock (no side effects, no parent set-state)
  // — the auto-submit is a separate effect keyed on `remaining` reaching 0, so
  // we never call a state-setting callback from inside another setter. Cleared
  // on unmount/leave via the effect cleanup.
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining((r) => (r <= 0 ? 0 : r - 1));
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
    onSave(stateRef.current, ctrl.signal);
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
  // Image-dependent item (no stored asset — see lib/topikImage.ts): feature
  // the bracketed text description in a labelled block, same as Study mode.
  const imageSplit =
    current.hasImage === true
      ? splitImageItem(current.prompt, current.imageText)
      : null;

  return (
    <div className="km-mock__exam">
      <div className="km-mock__exam-head">
        <Pill tone="red">Timed · live</Pill>
        <span
          className="km-mock__timer"
          role="timer"
          // Polite (not assertive): announce the remaining time without
          // interrupting the user mid-keystroke every second.
          aria-live="polite"
          aria-label={`Time remaining ${formatClock(remaining)}`}
        >
          <Icon name="timer" size={16} />
          <span className="km-mock__timer-val">{formatClock(remaining)}</span>
        </span>
      </div>

      <div className="km-mock__progress">
        {sectionLabel} · {String(idx + 1)} / {String(total)}
      </div>

      <QuestionPalette
        items={items}
        currentIdx={idx}
        picks={picks}
        onJump={goTo}
      />

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
          Prev
        </Button>
        <span className="km-topik__count">
          {String(answeredCount)} / {String(total)} answered
        </span>
        <Button
          variant="ghost"
          disabled={idx >= total - 1}
          onClick={() => {
            goTo(idx + 1);
          }}
          trailingIcon={<Icon name="arrow-right" size={14} />}
        >
          Next
        </Button>
      </div>

      <div className="km-mock__submit-row">
        <Button
          variant="gold"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Submit test
        </Button>
      </div>

      {confirming ? (
        // Card doesn't forward refs, so the focus-trap container is this div,
        // which also carries the alertdialog role + label (useModalA11y above).
        <div ref={confirmRef} role="alertdialog" aria-label="Confirm submit">
          <Card variant="flat" className="km-mock__confirm">
            <Eyebrow>Submit test?</Eyebrow>
            <p className="km-topik__explain">
              You’ve answered {String(answeredCount)} of {String(total)}.
              Unanswered items are marked incorrect. This can’t be undone.
            </p>
            <div className="km-topik__footer">
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Keep going
              </Button>
              <Button
                variant="gold"
                onClick={doSubmit}
                trailingIcon={<Icon name="arrow-right" size={14} />}
              >
                Submit
              </Button>
            </div>
          </Card>
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
  /** "New mock" (Mock mode) or "New set" (Study mode). */
  restartLabel: string;
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
      <Card variant="flat" className="km-mock__score">
        <Eyebrow>{summary.band}</Eyebrow>
        <div className="km-mock__score-pct">
          {String(summary.percentage)}
          <span className="km-mock__score-unit">%</span>
        </div>
        <p className="km-topik__explain">
          {String(summary.correct)} / {String(summary.totalItems)} correct ·{' '}
          {String(summary.answered)} answered ·{' '}
          {wrongCount > 0
            ? `${String(wrongCount)} to review`
            : 'no misses'}
        </p>
      </Card>

      <Eyebrow className="km-mock__review-head">Review</Eyebrow>
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
                        <Icon name="check" size={14} /> Correct
                      </>
                    ) : (
                      '✗ Incorrect'
                    )}
                  </span>
                </div>
                <p className="kr km-mock__review-prompt">{row.prompt}</p>
                {/* The passage the item was asked about (B-008) — the review
                    is unreadable without the text the question refers to. */}
                {row.passage ? <TopikPassage text={row.passage} /> : null}
                <div className="km-mock__review-picks">
                  <span className="km-mock__review-pick">
                    Your answer: <span className="kr">{row.pickedText}</span>
                  </span>
                  {!row.isCorrect ? (
                    <span className="km-mock__review-pick km-mock__review-pick--correct">
                      Correct: <span className="kr">{row.correctText}</span>
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
  // Index the items by their numeric id so each reveal can show its prompt +
  // the picked/correct choice text.
  const byId = new Map<number, TopikMockItem>(
    items.map((it) => [Number(it.id), it]),
  );

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
