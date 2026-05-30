/**
 * Diagnostic — four-mode workflow (intro · taking · done · results).
 *
 * Mode resolution (Pass 5 — diagnostic is live):
 *   - Results reads the user's latest snapshot via
 *     `useEndpointOrMock('diagnostic.latest', …, { realFn: fetchLatestSnapshot })`.
 *     A snapshot with `dimensions.length > 0` (a prior run) defaults the mode
 *     to `results`; an empty snapshot (no prior run — the server returns a 200
 *     with `dimensions: []`, not a 404) lands on `intro`.
 *   - The retake CTA on results sets mode='intro'.
 *
 * Taking flow (Pass 5 — server-graded, item by item):
 *   - This is a local-state **mutation flow**, NOT `useEndpointOrMock`. The
 *     hook is for idempotent reads; the diagnostic is a stateful sequence of
 *     POSTs that each mutate the run.
 *   - Begin → `startDiagnostic()` → hold { runId, current `DiagnosticLiveItem`,
 *     progress }. The live item carries NO correct answer.
 *   - Pick a choice → `answerDiagnostic(runId, { responseId, picked, timeMs })`
 *     → the server grades and returns the reveal (`result.correct`,
 *     `result.correctAnswer`, `result.explain`). The client renders the reveal
 *     from the server's response — it never self-grades.
 *   - Advance → if `next` is non-null, render it; if `next` is null, the graded
 *     item was the last, so `finishDiagnostic(runId)` writes the snapshot and we
 *     move to `done` → `results` carrying the fresh snapshot.
 *   - Skip = `picked: null`. Exit mid-run just leaves; no abandon call is
 *     needed (the server marks unfinished runs as stale on its own schedule).
 *
 * Sub-mode blocks are `<section aria-labelledby>` so each gets a real
 * accessibility name. They are NOT a tablist — the user does not jump between
 * them at will; the mode advances through a workflow.
 *
 * Threat model:
 *   - **Answer-tampering / read-ahead.** The correct answer is never on the
 *     live item; it arrives only in the `/answer` reveal AFTER the user
 *     commits a choice. The client cannot read the key ahead of time or
 *     self-grade, so a tampered client gains nothing. See `services/diagnostic`.
 *   - **Text injection.** All Korean strings (prompt, passage, choices,
 *     explain, transcript) render as React children → escaped. No
 *     `dangerouslySetInnerHTML` anywhere.
 *   - **Double-submit / replay.** Send is disabled + `aria-busy` while a grade
 *     is in flight; the server independently rejects out-of-order or
 *     already-answered `responseId`s with 409, surfaced inline.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Pill } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { DoubleRule } from '../components/DoubleRule';
import { SealStamp } from '../components/SealStamp';
import { AudioBlock } from '../components/AudioBlock';
import { SkillsCompare } from '../components/SkillsCompare';
import type { SkillRow, SkillReference } from '../components/SkillsCompare';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadDiagnosticSnapshotMock } from '../data/mocks/diagnostic';
import {
  answerDiagnostic,
  fetchLatestSnapshot,
  finishDiagnostic,
  startDiagnostic,
} from '../services/diagnostic';
import { ApiError } from '../services/api';
import type {
  DiagnosticAnswerResult,
  DiagnosticLiveItem,
  DiagnosticProgress,
  DiagnosticSnapshot,
} from '../types/domain';
import { cn } from '../lib/cn';

type Mode = 'intro' | 'taking' | 'done' | 'results';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

/**
 * Static intro descriptors — the Intro no longer pre-fetches a test bundle.
 * The live run is built server-side (2 each reading/listening/vocab/grammar,
 * 8 items, ~12 min adaptive); these are the human-readable section labels the
 * Intro card lists. Kept module-scope (immutable, never re-allocated).
 */
const INTRO_SECTIONS: ReadonlyArray<{ id: string; label: string; kr: string }> =
  [
    { id: 'reading', label: 'Reading', kr: '읽기' },
    { id: 'listening', label: 'Listening', kr: '듣기' },
    { id: 'vocab', label: 'Vocabulary', kr: '어휘' },
    { id: 'grammar', label: 'Grammar', kr: '문법' },
  ];

const INTRO_TOTAL_MINS = 12;
const INTRO_TOTAL_ITEMS = 8;
const INTRO_PER_SECTION = 2;

/** Normalise a thrown value to a user-facing message, defaulting to `fallback`. */
function toMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function Diagnostic(): JSX.Element {
  const snap = useEndpointOrMock<DiagnosticSnapshot>(
    'diagnostic.latest',
    loadDiagnosticSnapshotMock,
    { realFn: () => fetchLatestSnapshot() },
  );

  // Default to `results` only when a prior snapshot exists. Otherwise intro.
  // `null` while loading so we don't pick a mode on partial data.
  const [mode, setMode] = useState<Mode | null>(null);
  // The snapshot produced by a just-completed run (from /finish). When set, it
  // overrides the fetched snapshot for the Results render so the user sees
  // their fresh result without waiting on a /latest refetch.
  const [freshSnapshot, setFreshSnapshot] = useState<DiagnosticSnapshot | null>(
    null,
  );
  const isMock = snap.isMock;

  // Settle on a default mode the first time the fetch completes. Same
  // "synchronise UI to an external system (the loader)" case AuthProvider
  // handles; we need a one-shot landing point that survives later loader
  // re-runs (the user can re-test, which re-fetches but should NOT bounce
  // them back to intro mid-flow).
  useEffect(() => {
    if (mode !== null) return;
    if (snap.loading) return;
    const initial: Mode =
      snap.data && snap.data.dimensions.length > 0 ? 'results' : 'intro';
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(initial);
  }, [mode, snap.loading, snap.data]);

  const loading = snap.loading;
  // Fatal only when the snapshot fetch failed AND we have no data to fall back
  // on. With the mock fallback the snapshot almost always resolves, so this is
  // the genuinely-broken case.
  const fatalError = !snap.data && snap.error !== null ? snap.error : null;

  // The snapshot rendered by Results: a freshly-finished run wins over the
  // fetched-on-mount snapshot.
  const resultsSnapshot = freshSnapshot ?? snap.data;

  return (
    <section
      className="screen km-diagnostic"
      aria-labelledby="diagnostic-title"
      style={{ position: 'relative' }}
    >
      {isMock ? <MockBadge /> : null}
      {/* Hidden anchor so the section has an accessible name even before mode-specific titles mount. */}
      <span id="diagnostic-title" className="km-sr-only">
        Diagnostic
      </span>

      {loading || mode === null ? (
        <div className="km-diagnostic__state" role="status">
          Loading diagnostic…
        </div>
      ) : null}

      {fatalError && !loading ? (
        <div
          className="km-diagnostic__state km-diagnostic__state--error"
          role="alert"
        >
          Couldn’t load diagnostic. {fatalError.message}
        </div>
      ) : null}

      {!loading && mode === 'intro' ? (
        <IntroBlock
          onBegin={() => {
            setMode('taking');
          }}
          onCancel={() => {
            setMode(
              snap.data && snap.data.dimensions.length > 0
                ? 'results'
                : 'intro',
            );
          }}
        />
      ) : null}

      {!loading && mode === 'taking' ? (
        <TakingBlock
          onExit={() => {
            setMode(
              snap.data && snap.data.dimensions.length > 0
                ? 'results'
                : 'intro',
            );
          }}
          onComplete={(completed) => {
            setFreshSnapshot(completed);
            setMode('done');
          }}
        />
      ) : null}

      {!loading && mode === 'done' ? (
        <DoneBlock
          onContinue={() => {
            setMode('results');
          }}
        />
      ) : null}

      {!loading && mode === 'results' && resultsSnapshot ? (
        <ResultsBlock
          snapshot={resultsSnapshot}
          onRetest={() => {
            setFreshSnapshot(null);
            setMode('intro');
          }}
        />
      ) : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Intro
// ─────────────────────────────────────────────────────────────
interface IntroProps {
  onBegin: () => void;
  onCancel: () => void;
}

function IntroBlock({ onBegin, onCancel }: IntroProps): JSX.Element {
  return (
    <section aria-labelledby="dg-intro-h" className="km-diagnostic__intro">
      <Eyebrow>
        진단평가 · {String(INTRO_TOTAL_MINS)} min · {String(INTRO_TOTAL_ITEMS)}{' '}
        items
      </Eyebrow>
      <h1 id="dg-intro-h" className="kr-display km-diagnostic__display">
        진단평가
      </h1>

      <Card className="km-diagnostic__sections">
        <Eyebrow>Sections</Eyebrow>
        <ol className="km-diagnostic__section-list">
          {INTRO_SECTIONS.map((s, i) => (
            <li key={s.id} className="km-diagnostic__section-row">
              <span className="km-diagnostic__section-num">
                0{String(i + 1)}
              </span>
              <span className="km-diagnostic__section-label">
                <span className="kr km-diagnostic__section-kr">{s.kr}</span>
                <span className="km-diagnostic__section-en">· {s.label}</span>
              </span>
              <span className="km-diagnostic__section-count">
                {String(INTRO_PER_SECTION)} items
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <DoubleRule accent className="km-diagnostic__rule" />

      <p className="km-diagnostic__hint">
        Multiple choice. Adaptive — questions track your level. Answer honestly
        — skips count as unsure.
      </p>

      <div className="km-diagnostic__cta-row">
        <Button
          variant="gold"
          onClick={onBegin}
          trailingIcon={<Icon name="arrow-right" size={16} />}
        >
          Begin test
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Taking — server-graded, item by item
// ─────────────────────────────────────────────────────────────
interface TakingProps {
  onExit: () => void;
  /** Fires with the finished-run snapshot once the last item is graded. */
  onComplete: (snapshot: DiagnosticSnapshot) => void;
}

/** Phase of the in-flight network call driving the Taking block. */
type Phase = 'starting' | 'answering' | 'finishing' | 'idle' | 'error';

function TakingBlock({ onExit, onComplete }: TakingProps): JSX.Element {
  const [runId, setRunId] = useState<number | null>(null);
  const [item, setItem] = useState<DiagnosticLiveItem | null>(null);
  const [progress, setProgress] = useState<DiagnosticProgress | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [reveal, setReveal] = useState<DiagnosticAnswerResult | null>(null);
  // Whether the just-graded item was the LAST one (server returned next:null).
  // Kept as render state — not derived from `pendingNextRef` — because the
  // reveal footer reads it during render and `react-hooks/refs` forbids ref
  // reads in render. Set when an answer settles, reset on advance.
  const [lastReveal, setLastReveal] = useState<boolean>(false);
  const [phase, setPhase] = useState<Phase>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // One controller per in-flight call — aborts the previous start/answer/finish
  // when a new one begins, and on unmount/exit (the effect cleanup aborts).
  const ctrlRef = useRef<AbortController | null>(null);
  // Wall-clock stamp of when the current item was served, so we can report a
  // per-item `timeMs` to the server's CAT/telemetry. Initialised to 0 (a pure
  // value — `Date.now()` at init trips react-hooks/purity) and stamped with the
  // real serve time in `runStart` and `advance` before any answer reads it.
  const servedAtRef = useRef<number>(0);
  // The next item handed back by the last `/answer`, consumed by `advance`.
  // A ref (not state) because it's a hand-off between two user gestures, not
  // a render input — the reveal block is what renders between submit+advance.
  const pendingNextRef = useRef<DiagnosticLiveItem | null>(null);

  // Fresh AbortController for a new network step; aborts any prior in-flight.
  const beginCall = useCallback((): AbortController => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    return ctrl;
  }, []);

  // Start (or restart) the run: serve item 1. Shared by the mount effect and
  // the post-failure Retry, so the two paths can't drift.
  const runStart = useCallback((): void => {
    const ctrl = beginCall();
    setPhase('starting');
    setErrorMsg(null);
    startDiagnostic(ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setRunId(res.runId);
        setItem(res.item);
        setProgress(res.progress);
        servedAtRef.current = Date.now();
        setPhase('idle');
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setPhase('error');
        setErrorMsg(toMessage(err, 'Could not start the diagnostic.'));
      });
  }, [beginCall]);

  // Start the run on mount. Sync-to-external-system case — same exception the
  // useEndpointOrMock hook and Review's detail sheet use. `runStart` is stable
  // (deps: only the stable `beginCall`), so this runs once per mount.
  useEffect(() => {
    // Sync-to-external-system on mount: runStart() kicks the network fetch and
    // flips phase/state. Same documented exception as useEndpointOrMock's probe
    // and the Diagnostic mode-init effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runStart();
    return () => {
      ctrlRef.current?.abort();
    };
  }, [runStart]);

  const inFlight =
    phase === 'starting' || phase === 'answering' || phase === 'finishing';

  // Grade one answer (`picked: null` = skip). Shared by Submit + Skip so the
  // request/reveal/error handling lives in one place; the only difference is
  // the `picked` value, which the caller supplies.
  const gradeAnswer = useCallback(
    (choice: string | null): void => {
      if (runId === null || item === null || inFlight || reveal !== null) {
        return;
      }
      const ctrl = beginCall();
      setPhase('answering');
      setErrorMsg(null);
      const timeMs = Math.max(0, Date.now() - servedAtRef.current);
      answerDiagnostic(
        runId,
        { responseId: item.responseId, picked: choice, timeMs },
        ctrl.signal,
      )
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setReveal(res.result);
          setProgress(res.progress);
          // `null` next means "graded the last item" — `advance` then finishes.
          pendingNextRef.current = res.next;
          setLastReveal(res.next === null);
          setPhase('idle');
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          setPhase('error');
          setErrorMsg(toMessage(err, 'Could not submit your answer.'));
        });
    },
    [runId, item, inFlight, reveal, beginCall],
  );

  // Submit the currently-picked choice.
  const submit = useCallback((): void => {
    gradeAnswer(picked);
  }, [gradeAnswer, picked]);

  // Skip always sends `picked: null`, regardless of any prior selection.
  const skip = useCallback((): void => {
    setPicked(null);
    gradeAnswer(null);
  }, [gradeAnswer]);

  // Advance past the revealed item: render the next, or finish the run.
  const advance = useCallback((): void => {
    if (runId === null || reveal === null || inFlight) return;
    const next = pendingNextRef.current;
    if (next) {
      setItem(next);
      setPicked(null);
      setReveal(null);
      setLastReveal(false);
      pendingNextRef.current = null;
      servedAtRef.current = Date.now();
      setPhase('idle');
      return;
    }
    // No next item — that was the last. Finish the run for the snapshot.
    const ctrl = beginCall();
    setPhase('finishing');
    setErrorMsg(null);
    finishDiagnostic(runId, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        onComplete(res.snapshot);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setPhase('error');
        setErrorMsg(toMessage(err, 'Could not finish the diagnostic.'));
      });
  }, [runId, reveal, inFlight, beginCall, onComplete]);

  // Retry the failed step. A failed start (no runId yet) re-runs `runStart`;
  // a mid-run failure replays the step its `reveal` implies — `advance`
  // (finish) when a reveal is showing, else `gradeAnswer` (re-grade).
  const retry = useCallback((): void => {
    setErrorMsg(null);
    if (runId === null) {
      runStart();
      return;
    }
    setPhase('idle');
    if (reveal !== null) {
      advance();
    } else {
      gradeAnswer(picked);
    }
  }, [runId, reveal, picked, runStart, advance, gradeAnswer]);

  // ── Render states ──
  if (phase === 'starting' && item === null) {
    return (
      <section
        aria-labelledby="dg-taking-h"
        className="km-diagnostic__taking"
      >
        <h2 id="dg-taking-h" className="km-sr-only">
          Diagnostic test starting
        </h2>
        <div className="km-diagnostic__state" role="status" aria-busy="true">
          Preparing your diagnostic…
        </div>
      </section>
    );
  }

  if (phase === 'error' && item === null) {
    return (
      <section
        aria-labelledby="dg-taking-h"
        className="km-diagnostic__taking"
      >
        <h2 id="dg-taking-h" className="km-sr-only">
          Diagnostic test error
        </h2>
        <ErrorCard
          message={errorMsg ?? 'Could not start the diagnostic.'}
          onRetry={retry}
        />
        <div className="km-diagnostic__footer">
          <Button variant="ghost" onClick={onExit}>
            Exit
          </Button>
        </div>
      </section>
    );
  }

  if (item === null || progress === null) {
    // Defensive: no item to render and not in a known transitional state.
    return (
      <section
        aria-labelledby="dg-taking-h"
        className="km-diagnostic__taking"
      >
        <h2 id="dg-taking-h" className="km-sr-only">
          Diagnostic test in progress
        </h2>
        <div className="km-diagnostic__state" role="status" aria-busy="true">
          Loading the next question…
        </div>
      </section>
    );
  }

  const revealed = reveal !== null;
  const isLast = revealed && lastReveal;
  const revealBlockId = `dg-reveal-${String(item.responseId)}`;
  // Progress is derived from the CURRENT item's 1-based ordinal, not the
  // server's post-answer `progress.ordinal` (which points at the *next* item
  // and would make the bar jump forward on reveal then back on advance). The
  // total comes from the server. Before the reveal, `ordinal-1` items are done;
  // once the current item is graded (revealed), it counts too.
  const total = progress.total;
  const completed = item.ordinal - (revealed ? 0 : 1);
  const progressNow = Math.max(0, Math.min(total, completed));
  const progressPct = total > 0 ? (progressNow / total) * 100 : 0;

  return (
    <section aria-labelledby="dg-taking-h" className="km-diagnostic__taking">
      <h2 id="dg-taking-h" className="km-sr-only">
        Diagnostic test in progress
      </h2>

      <div className="km-diagnostic__taking-bar">
        <Button
          variant="ghost"
          size="sm"
          onClick={onExit}
          leadingIcon={<Icon name="close" size={12} />}
        >
          Exit
        </Button>
        <Eyebrow className="km-diagnostic__progress-label">
          {String(item.ordinal)} / {String(total)}
        </Eyebrow>
      </div>

      <div
        className="km-diagnostic__progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={progressNow}
        aria-label="Diagnostic progress"
      >
        <div
          className="km-diagnostic__progress-fill"
          style={{ width: `${String(progressPct)}%` }}
        />
      </div>

      <div className="km-diagnostic__pills">
        <Pill tone="gold">{sectionLabel(item.section)}</Pill>
        <Pill>{item.level}</Pill>
      </div>

      <p className="kr km-diagnostic__prompt">{item.prompt}</p>

      {item.audio ? (
        <AudioBlock
          transcriptKr={item.audio.transcript}
          durationS={item.audio.duration}
        />
      ) : null}

      {item.passage ? <PassageCard item={item} /> : null}

      {item.hint && !item.passage ? (
        <div className="km-diagnostic__hint">{item.hint}</div>
      ) : null}

      <ChoiceList
        item={item}
        picked={picked}
        revealed={revealed}
        reveal={reveal}
        revealBlockId={revealBlockId}
        onPick={(id) => {
          if (!revealed && !inFlight) setPicked(id);
        }}
      />

      {reveal ? (
        <Card
          variant="flat"
          className="km-diagnostic__reveal"
          id={revealBlockId}
        >
          <Eyebrow>{reveal.correct ? 'Correct' : 'Not quite'}</Eyebrow>
          <p className="km-diagnostic__explain">{reveal.explain}</p>
        </Card>
      ) : null}

      {errorMsg && phase === 'error' ? (
        <div role="alert" className="km-diagnostic__state km-diagnostic__state--error">
          <span>{errorMsg}</span>
          {/* Retry replays the failed step: a showing reveal → re-finish/advance,
              otherwise → re-grade the picked choice. Wiring it here makes the
              `retry` callback's mid-run branches reachable (they were dead when
              the only Retry control lived on the failed-start ErrorCard). */}
          <Button variant="ghost" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : null}

      <div className="km-diagnostic__footer">
        {!revealed ? (
          <Button variant="ghost" onClick={skip} disabled={inFlight}>
            Skip
          </Button>
        ) : (
          <span className="km-diagnostic__count">
            {isLast ? 'Last item' : 'Reviewing your answer'}
          </span>
        )}
        {!revealed ? (
          <Button
            variant="gold"
            disabled={picked === null || inFlight}
            aria-busy={phase === 'answering'}
            onClick={submit}
          >
            {phase === 'answering' ? 'Sending…' : 'Submit'}
          </Button>
        ) : (
          <Button
            variant="gold"
            onClick={advance}
            disabled={inFlight}
            aria-busy={phase === 'finishing'}
            trailingIcon={<Icon name="arrow-right" size={14} />}
          >
            {isLast
              ? phase === 'finishing'
                ? 'Scoring…'
                : 'See results'
              : 'Next'}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Human-readable section label for the in-test Pill. */
function sectionLabel(section: DiagnosticLiveItem['section']): string {
  switch (section) {
    case 'reading':
      return '읽기 · Reading';
    case 'listening':
      return '듣기 · Listening';
    case 'vocab':
      return '어휘 · Vocabulary';
    case 'grammar':
      return '문법 · Grammar';
    default: {
      // Exhaustiveness guard — a new section must update this switch.
      const _never: never = section;
      return _never;
    }
  }
}

interface PassageCardProps {
  item: DiagnosticLiveItem;
}

function PassageCard({ item }: PassageCardProps): JSX.Element {
  const passage = item.passage ?? '';
  const underline = item.underline;
  if (!underline) {
    return <div className="kr km-diagnostic__passage">{passage}</div>;
  }
  // Split-then-interleave the underline so it renders with the vermilion
  // underline + emphasis. Using `.split` keeps every part a plain text node;
  // React escapes them all.
  const parts = passage.split(underline);
  return (
    <div className="kr km-diagnostic__passage">
      {parts.map((part, idx) => (
        <span key={`p-${String(idx)}`}>
          {part}
          {idx < parts.length - 1 ? (
            <span className="km-diagnostic__underline">{underline}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

interface ChoiceListProps {
  item: DiagnosticLiveItem;
  picked: string | null;
  revealed: boolean;
  /** Server reveal — drives the correct/wrong markers AFTER grading only. */
  reveal: DiagnosticAnswerResult | null;
  revealBlockId: string;
  onPick: (id: string) => void;
}

function ChoiceList({
  item,
  picked,
  revealed,
  reveal,
  revealBlockId,
  onPick,
}: ChoiceListProps): JSX.Element {
  return (
    <div
      className="km-diagnostic__choices"
      role="radiogroup"
      aria-label="Diagnostic answer choices"
    >
      {item.choices.map((c, i) => {
        const isPicked = picked === c.id;
        // The correct-answer marker is driven SOLELY by the server reveal —
        // never by a client-held key (there is none). Before the reveal lands,
        // no choice is marked correct/wrong.
        const isAnswer = reveal !== null && c.id === reveal.correctAnswer;
        const showCorrect = revealed && isAnswer;
        const showWrong = revealed && isPicked && !isAnswer;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            // `aria-checked` is the radio contract; `aria-pressed` is
            // for toggle buttons. Carrying both confuses some AT
            // pipelines (they branch on whichever they encounter
            // first). Dropped `aria-pressed` to honour role="radio".
            aria-checked={isPicked}
            aria-describedby={revealed ? revealBlockId : undefined}
            disabled={revealed}
            className={cn(
              'km-diagnostic__choice focusring',
              isPicked && !revealed && 'km-diagnostic__choice--picked',
              showCorrect && 'km-diagnostic__choice--correct',
              showWrong && 'km-diagnostic__choice--wrong',
            )}
            onClick={() => {
              onPick(c.id);
            }}
          >
            <span className="km-diagnostic__marker">{CHOICE_MARKERS[i]}</span>
            <span className="km-diagnostic__choice-body">
              <span className="kr km-diagnostic__choice-kr">{c.kr}</span>
              <span className="km-diagnostic__choice-en">{c.en}</span>
            </span>
            {showCorrect ? <Icon name="check" size={16} /> : null}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Done
// ─────────────────────────────────────────────────────────────
interface DoneProps {
  onContinue: () => void;
}

function DoneBlock({ onContinue }: DoneProps): JSX.Element {
  return (
    <section aria-labelledby="dg-done-h" className="km-diagnostic__done">
      <SealStamp char="完" size="lg" />
      <Eyebrow className="km-diagnostic__done-eyebrow">진단평가 완료</Eyebrow>
      <h2 id="dg-done-h" className="kr-display km-diagnostic__done-title">
        Diagnostic complete
      </h2>
      <p className="km-diagnostic__done-hint">
        Scoring against TOPIK II L4 reference.
      </p>
      <Button
        variant="gold"
        onClick={onContinue}
        trailingIcon={<Icon name="arrow-right" size={14} />}
      >
        See gap map
      </Button>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────
interface ResultsProps {
  snapshot: DiagnosticSnapshot;
  onRetest: () => void;
}

function ResultsBlock({ snapshot, onRetest }: ResultsProps): JSX.Element {
  const navigate = useNavigate();
  const skills: ReadonlyArray<SkillRow> = snapshot.dimensions.map((d) => ({
    key: d.key,
    label: d.label,
    kr: d.kr,
    score: d.score,
    note: d.note,
  }));
  const references: ReadonlyArray<SkillReference> = snapshot.references.map(
    (r) => ({
      id: r.id,
      label: r.label,
      kr: r.kr,
      value: r.value,
      isCeiling: r.id === 'native',
    }),
  );

  return (
    <section aria-labelledby="dg-results-h" className="km-diagnostic__results">
      <Eyebrow>Diagnostic · completed 5 min ago</Eyebrow>
      <h1 id="dg-results-h" className="kr-display km-diagnostic__results-title">
        Diagnostic
      </h1>
      <p className="km-diagnostic__results-sub">
        Against TOPIK II <span className="km-diagnostic__level">Level 4</span>.
      </p>

      <Card className="km-diagnostic__skills-card">
        <Eyebrow>Where you are</Eyebrow>
        <div className="km-diagnostic__skills-title">Skills snapshot</div>
        <SkillsCompare
          skills={skills}
          references={references}
          defaultRefId={snapshot.defaultRef}
          variant="full"
        />
      </Card>

      <Card className="km-diagnostic__goals-card">
        <Eyebrow>Goals · derived from your gaps</Eyebrow>
        <div className="km-diagnostic__skills-title">Next steps</div>
        <ol className="km-diagnostic__goals">
          {snapshot.goals.map((g, i) => (
            <li key={`goal-${String(i)}`} className="km-diagnostic__goal-row">
              <span className="km-diagnostic__goal-num">0{String(i + 1)}</span>
              <span>{g}</span>
            </li>
          ))}
        </ol>
      </Card>

      <div className="km-diagnostic__cta-row">
        <Button
          variant="gold"
          onClick={() => {
            navigate('/');
          }}
          trailingIcon={<Icon name="arrow-right" size={16} />}
        >
          Begin today’s plan
        </Button>
        <Button variant="ghost" onClick={onRetest}>
          Re-test diagnostic
        </Button>
      </div>
    </section>
  );
}

export default Diagnostic;
