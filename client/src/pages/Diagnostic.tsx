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
 *     `result.correctAnswer`, `result.explain`) IMMEDIATELY — grading is a
 *     cheap local operation server-side and never waits on item generation
 *     (B-006). The client renders the reveal from the server's response — it
 *     never self-grades.
 *   - While the reveal is showing, the next item is PREFETCHED via
 *     `nextDiagnostic(runId)` (the expensive half — vocab/grammar items are
 *     Claude-generated). The multi-second generation overlaps the user's
 *     reveal dwell instead of blocking the reveal itself.
 *   - Advance → if the run is `done` (answer response) the graded item was the
 *     last, so `finishDiagnostic(runId)` writes the snapshot and we move to
 *     `done` → `results` carrying the fresh snapshot. Otherwise render the
 *     prefetched item (awaiting the in-flight prefetch if it hasn't landed);
 *     a prefetch of `next: null` (pools exhausted early) also finishes.
 *   - Skip = `picked: null`. Exit mid-run just leaves; no abandon call is
 *     needed (the server marks unfinished runs as stale on its own schedule).
 *
 * Sub-mode blocks are `<section aria-labelledby>` so each gets a real
 * accessibility name. They are NOT a tablist — the user does not jump between
 * them at will; the mode advances through a workflow.
 *
 * F-128 reskin ("Seoul Day & Night") — the shared `PageHubHeader` (devices
 * #4/#2) replaces the old bare `<h1>`/eyebrow pair on Intro and Results; the
 * Intro section list and the Results skills card are `CityCard` signboard/
 * hanji-paper surfaces (device #1) with a leading `DancheongRail` (device
 * #2); the live taking item is likewise a `CityCard` hero surface, mirroring
 * Topik's live-drill treatment; a `SubwayProgress` (device #5) rides
 * alongside the existing "Item N / M" readout for stepping through the run;
 * the Done screen's completion glyph is now the hand-stamped `SealStamp`
 * `milestone` look (device #7); the page root carries the ambient
 * `.km-rain-sheen` (device #8, Night-only per its own CSS gate). Diagnostic
 * has no genuine "zero data" empty state of its own (unlike Topik/Hanja's
 * "no items" case) — devices #3/#6 (giwa texture + hangul watermark) are
 * therefore not applied here, matching the established precedent that they
 * mark genuine emptiness, never a loading/error state (see Reading.tsx).
 *
 * F-143 — the Results screen's "Derived from your gaps / Next steps" goals
 * card and the "Begin today's plan" CTA are removed at the user's explicit
 * request. Results now ends at the skills snapshot + the retake action.
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
import { AskAboutThisButton } from '../components/AskAboutThisButton';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { CityCard } from '../components/CityCard';
import { Button } from '../components/Button';
import { Pill, type PillTone } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { DoubleRule } from '../components/DoubleRule';
import { PageHubHeader } from '../components/PageHubHeader';
import { SealStamp } from '../components/SealStamp';
import { AudioBlock } from '../components/AudioBlock';
import { TopikStudyAudio } from './topik/TopikStudyAudio';
import { SkillsCompare } from '../components/SkillsCompare';
import type { SkillRow, SkillReference } from '../components/SkillsCompare';
import { SubwayProgress } from '../components/SubwayProgress';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useToast } from '../components/useToast';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadDiagnosticSnapshotMock } from '../data/mocks/diagnostic';
import {
  answerDiagnostic,
  fetchLatestSnapshot,
  finishDiagnostic,
  nextDiagnostic,
  startDiagnostic,
} from '../services/diagnostic';
import { ApiError } from '../services/api';
import type {
  DiagnosticAnswerResult,
  DiagnosticLiveItem,
  DiagnosticNextResponse,
  DiagnosticProgress,
  DiagnosticSnapshot,
  DrillVerdict,
} from '../types/domain';
import { cn } from '../lib/cn';
import { errorMessageFor } from '../lib/errorCopy';
import './Diagnostic.css';

type Mode = 'intro' | 'taking' | 'done' | 'results';

const CHOICE_MARKERS = ['①', '②', '③', '④'] as const;

/**
 * Static intro descriptors — the Intro no longer pre-fetches a test bundle.
 * The live run is built server-side (4 each reading/listening/vocab/grammar/
 * hanja + 2 writing, 22 items, ~20 min adaptive); these are the human-
 * readable section labels + per-section item counts the Intro card lists.
 * Kept module-scope (immutable, never re-allocated). `hanja` (diagnostic-
 * upgrade Phase A) is coverage-only — it still gets its own intro row like
 * every other section. `writing` (diagnostic-upgrade Phase B) is weighted
 * DOWN to 2 items (server `WEIGHTS.writing` in `server/src/routes/
 * diagnostic.ts`) — the first dimension with a non-uniform per-section count,
 * hence the `items` field per row instead of one shared constant.
 */
const INTRO_SECTIONS: ReadonlyArray<{
  id: string;
  label: string;
  kr: string;
  items: number;
}> = [
  { id: 'reading', label: 'Reading', kr: '읽기', items: 4 },
  { id: 'listening', label: 'Listening', kr: '듣기', items: 4 },
  { id: 'vocab', label: 'Vocabulary', kr: '어휘', items: 4 },
  { id: 'grammar', label: 'Grammar', kr: '문법', items: 4 },
  { id: 'hanja', label: 'Hanja', kr: '한자', items: 4 },
  { id: 'writing', label: 'Writing', kr: '쓰기', items: 2 },
];

// MUST mirror the server's test shape — `WEIGHTS`/`TARGET_ITEM_COUNT` in
// `server/src/routes/diagnostic.ts` (4 each reading/listening/vocab/grammar/
// hanja + 2 writing → a 22-item schedule, diagnostic-upgrade Phase B). The
// taking-screen progress bar counts to the server's total, so a stale intro
// promise here is a user-visible contradiction (F-011 fixpass R3 B1). Retune
// alongside `INTRO_SECTIONS`' per-row `items` when turning the server knob.
const INTRO_TOTAL_MINS = 20;
const INTRO_TOTAL_ITEMS = 22;

/**
 * Normalise a thrown value to user-facing FIXED copy (F-UP-018). Previously
 * echoed `ApiError.message` — server prose — into the taking-flow alerts;
 * now delegates to the app-wide fixed-copy lookup, so only author-controlled
 * text (plus the structured retry_after number) ever renders.
 */
function toMessage(err: unknown, fallback: string): string {
  return errorMessageFor(err, fallback);
}

function Diagnostic(): JSX.Element {
  const snap = useEndpointOrMock<DiagnosticSnapshot>(
    'diagnostic.latest',
    loadDiagnosticSnapshotMock,
    { realFn: () => fetchLatestSnapshot() },
  );

  const { toast } = useToast();

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
      className="screen km-diagnostic km-rain-sheen"
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
          <Bilingual en="Loading diagnostic…" kr="진단 불러오는 중…" />
        </div>
      ) : null}

      {fatalError && !loading ? (
        // F-UP-018: fixed copy + a real retry. This branch is reachable in
        // prod (the PROD gate stopped the mock fallback from papering over
        // it), so it follows the ErrorCard contract — author-controlled
        // text keyed off the structured error, never echoed server prose —
        // and Retry re-runs the snapshot fetch instead of stranding the
        // user (IntroBlock's "Begin" below stays available regardless).
        <ErrorCard
          message={errorMessageFor(
            fatalError,
            'Couldn’t load your diagnostic results. Retry, or begin a new diagnostic below.',
          )}
          onRetry={snap.refetch}
        />
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
          onAlreadyRecorded={() => {
            // 409 auto-resync (E-DG-409): the server already recorded this
            // answer (a double-submit or a lost-response retry). There is no
            // GET-current-item endpoint to re-hydrate the in-flight run, so the
            // honest recovery is to leave the now-desynced Taking flow, refetch
            // the latest snapshot, and tell the user we're continuing — NOT to
            // trap them on a "Try again" loop that will only 409 again. The
            // toast carries the exact contract copy.
            toast({
              message: 'Answer already recorded — continuing.',
              tone: 'info',
            });
            snap.refetch();
            setMode(
              snap.data && snap.data.dimensions.length > 0
                ? 'results'
                : 'intro',
            );
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
      {/* F-128 devices #4/#2 — the shared hub-header recipe (skyline +
          dancheong rail) replaces the old bare `<h1>` + eyebrow pair. P3b
          trim carries over: the eyebrow keeps only the test-shape meta, not
          a repeated "진단평가 · …" prefix. */}
      <PageHubHeader
        titleId="dg-intro-h"
        eyebrow={
          <Bilingual
            en={`${String(INTRO_TOTAL_MINS)} min · ${String(INTRO_TOTAL_ITEMS)} items`}
            kr={`${String(INTRO_TOTAL_MINS)}분 · ${String(INTRO_TOTAL_ITEMS)}문항`}
          />
        }
        heading={<Bilingual kr="진단평가" en="Diagnostic" />}
      />

      {/* F-128 device #1/#2 — a CityCard signboard/hanji-paper surface with a
          leading DancheongRail, replacing the plain flat Card. */}
      <CityCard tone="accent" rail className="km-diagnostic__sections">
        <Eyebrow>
          <Bilingual en="Sections" kr="영역" />
        </Eyebrow>
        <ol className="km-diagnostic__section-list">
          {INTRO_SECTIONS.map((s, i) => (
            <li key={s.id} className="km-diagnostic__section-row">
              <span className="km-diagnostic__section-num">
                0{String(i + 1)}
              </span>
              <span className="km-diagnostic__section-label">
                {/* Section labels are chrome (the skill-domain WORD, not the
                    skill's learning content) — bilingual per the scope rule. */}
                <Bilingual en={s.label} kr={s.kr} />
              </span>
              <span className="km-diagnostic__section-count">
                <Bilingual
                  en={`${String(s.items)} items`}
                  kr={`${String(s.items)}문항`}
                  compact
                />
              </span>
            </li>
          ))}
        </ol>
      </CityCard>

      <DoubleRule accent className="km-diagnostic__rule" />

      <p className="km-diagnostic__hint">
        <Bilingual
          en="Mostly multiple choice, plus two short Korean writing prompts. Adaptive — questions track your level. Answer honestly — skips count as unsure."
          kr="대부분 객관식이고, 짧은 한국어 쓰기 문제가 2개 있어요. 난이도가 실력에 맞춰 조정돼요. 솔직하게 답하세요 — 건너뛰면 모른다고 기록돼요."
        />
      </p>

      <div className="km-diagnostic__cta-row">
        <Button
          variant="gold"
          onClick={onBegin}
          trailingIcon={<Icon name="arrow-right" size={16} />}
        >
          <Bilingual en="Begin test" kr="시험 시작" />
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <Bilingual en="Cancel" kr="취소" />
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
  /**
   * Fires when the server reports the current answer was ALREADY recorded
   * (a 409 ConflictError from `/answer` or `/finish`). The parent resyncs:
   * toast "answer already recorded — continuing", refetch the latest
   * snapshot, and leave the Taking flow — there is no stale Try-again
   * dead-end. See the E-DG-409 note where it's wired.
   */
  onAlreadyRecorded: () => void;
}

/** Phase of the in-flight network call driving the Taking block.
 *  `advancing` = the user clicked Next but the next-item prefetch hasn't
 *  landed yet (we're awaiting it, showing a busy Next button). */
type Phase = 'starting' | 'answering' | 'advancing' | 'finishing' | 'idle' | 'error';

function TakingBlock({
  onExit,
  onComplete,
  onAlreadyRecorded,
}: TakingProps): JSX.Element {
  const [runId, setRunId] = useState<number | null>(null);
  const [item, setItem] = useState<DiagnosticLiveItem | null>(null);
  const [progress, setProgress] = useState<DiagnosticProgress | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [reveal, setReveal] = useState<DiagnosticAnswerResult | null>(null);
  // Whether the just-graded item was the LAST one — true when the answer
  // response says `done`, or when the next-item prefetch comes back
  // `next: null` (remaining pools exhausted early). Kept as render state —
  // not derived from a ref — because the reveal footer reads it during render
  // and `react-hooks/refs` forbids ref reads in render.
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
  // The in-flight (or settled) next-item prefetch, started as soon as an
  // answer's reveal lands (B-006: the Claude generation overlaps the reveal
  // dwell). `advance` consumes it — awaiting a settled promise resolves in a
  // microtask, so the common case advances instantly. Cleared on failure so a
  // retry issues a fresh call. A ref (not state) because it's a hand-off
  // between two user gestures, not a render input.
  const nextPromiseRef = useRef<Promise<DiagnosticNextResponse> | null>(null);
  // Controller for the prefetch — separate from `ctrlRef` so submitting the
  // NEXT answer (which aborts the previous foreground call) can never cancel
  // a prefetch, and so unmount/exit still aborts it.
  const nextCtrlRef = useRef<AbortController | null>(null);

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
      nextCtrlRef.current?.abort();
    };
  }, [runStart]);

  const inFlight =
    phase === 'starting' ||
    phase === 'answering' ||
    phase === 'advancing' ||
    phase === 'finishing';

  // Kick off (or replace) the next-item prefetch. Fired right after a reveal
  // lands so the server's Claude generation runs while the user reads the
  // explanation. The background handlers only (a) flip `lastReveal` when the
  // run turns out to be over early, and (b) clear the ref on failure so
  // `advance` retries with a fresh call — real error UI is `advance`'s job,
  // not the dwell's.
  const prefetchNext = useCallback(
    (rid: number): Promise<DiagnosticNextResponse> => {
      nextCtrlRef.current?.abort();
      const ctrl = new AbortController();
      nextCtrlRef.current = ctrl;
      const promise = nextDiagnostic(rid, ctrl.signal);
      nextPromiseRef.current = promise;
      promise
        .then((res) => {
          if (ctrl.signal.aborted) return;
          if (res.next === null) setLastReveal(true);
        })
        .catch(() => {
          // Swallowed here deliberately (no unhandled rejection); `advance`
          // surfaces the failure when the user tries to move on.
          if (nextPromiseRef.current === promise) {
            nextPromiseRef.current = null;
          }
        });
      return promise;
    },
    [],
  );

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
          // `done` means "graded the last scheduled item" — `advance` then
          // finishes. Otherwise start the next-item prefetch NOW so the
          // generation latency overlaps the reveal dwell (B-006).
          setLastReveal(res.done);
          setPhase('idle');
          if (!res.done) {
            void prefetchNext(runId);
          }
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          // 409 auto-resync (E-DG-409): the server already recorded this
          // answer (a double-submit, or a retry after a lost success
          // response). Re-grading the same `responseId` would only 409 again,
          // so we must NOT land in the `error` phase that renders the stale
          // "Try again" control. Instead hand off to the parent's resync —
          // toast + refetch + leave the desynced run.
          if (err instanceof ApiError && err.status === 409) {
            onAlreadyRecorded();
            return;
          }
          setPhase('error');
          setErrorMsg(toMessage(err, 'Could not submit your answer.'));
        });
    },
    [runId, item, inFlight, reveal, beginCall, prefetchNext, onAlreadyRecorded],
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

  // Finish the run for the snapshot. Reached from `advance` when the graded
  // item was the last scheduled one, or when the next-item fetch reports the
  // run over early (`next: null`).
  const finishRun = useCallback((): void => {
    if (runId === null) return;
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
        // 409 here means the run is no longer finishable from this client's
        // view (already finished elsewhere, or a served item the UI doesn't
        // know about is unanswered). Resync rather than dead-end (E-DG-409).
        if (err instanceof ApiError && err.status === 409) {
          onAlreadyRecorded();
          return;
        }
        setPhase('error');
        setErrorMsg(toMessage(err, 'Could not finish the diagnostic.'));
      });
  }, [runId, beginCall, onComplete, onAlreadyRecorded]);

  // Advance past the revealed item: render the prefetched next item (awaiting
  // the prefetch if it is still in flight), or finish the run.
  const advance = useCallback((): void => {
    if (runId === null || reveal === null || inFlight) return;
    if (lastReveal) {
      finishRun();
      return;
    }
    // Consume the dwell prefetch; issue a fresh call only when there is none
    // (it failed, or its response was lost — the server re-serves the same
    // pending item, so a re-request never burns an extra generation).
    const promise = nextPromiseRef.current ?? prefetchNext(runId);
    setPhase('advancing');
    setErrorMsg(null);
    promise
      .then((res) => {
        if (nextCtrlRef.current?.signal.aborted) return;
        nextPromiseRef.current = null;
        if (res.next === null) {
          // Remaining pools were empty — the run ended early.
          finishRun();
          return;
        }
        setItem(res.next);
        setPicked(null);
        setReveal(null);
        setLastReveal(false);
        setProgress(res.progress);
        servedAtRef.current = Date.now();
        setPhase('idle');
      })
      .catch((err: unknown) => {
        if (nextCtrlRef.current?.signal.aborted) return;
        nextPromiseRef.current = null;
        // A 409 means the run state moved on without us (finished elsewhere).
        // Resync rather than dead-end (E-DG-409).
        if (err instanceof ApiError && err.status === 409) {
          onAlreadyRecorded();
          return;
        }
        setPhase('error');
        setErrorMsg(toMessage(err, 'Could not load the next question.'));
      });
  }, [
    runId,
    reveal,
    inFlight,
    lastReveal,
    finishRun,
    prefetchNext,
    onAlreadyRecorded,
  ]);

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
          <Bilingual en="Preparing your diagnostic…" kr="진단 준비 중…" />
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
            <Bilingual en="Exit" kr="나가기" />
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
          <Bilingual en="Loading the next question…" kr="다음 문제 불러오는 중…" />
        </div>
      </section>
    );
  }

  const revealed = reveal !== null;
  const isLast = revealed && lastReveal;
  const revealBlockId = `dg-reveal-${String(item.responseId)}`;
  const section = sectionLabel(item.section);
  const total = progress.total;
  // diagnostic-upgrade Phase B: the ONE item kind with no `choices` at all —
  // drives the textarea render branch + the writing-specific reveal below,
  // instead of `<ChoiceList>`/the MC correct/explain reveal.
  const isWriting = item.kind === 'writing-production';
  const canSubmitWriting = picked !== null && picked.trim() !== '';

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
          <Bilingual en="Exit" kr="나가기" />
        </Button>
        <Eyebrow className="km-diagnostic__progress-label">
          {String(item.ordinal)} / {String(total)}
        </Eyebrow>
      </div>

      {/* F-128 device #5 — the signature subway-line progress metaphor,
          alongside the numeric "N / M" readout above (kept for the exact
          reading the dots don't spell out in text). The active station is
          the CURRENT item's 0-based ordinal — matching Topik's study-mode
          precedent — regardless of whether it's been revealed yet. */}
      <div className="km-diagnostic__subwaywrap">
        <SubwayProgress
          steps={total}
          current={item.ordinal - 1}
          tone="accent"
          label="Diagnostic progress"
          valueText={`Item ${String(item.ordinal)} of ${String(total)}`}
        />
      </div>

      {/* F-128 device #1/#2 — the live item is the taking screen's hero
          surface, mirroring Topik's live-drill treatment: a CityCard
          signboard/hanji-paper card with a leading DancheongRail, not a bare
          fragment riding on the page's own padding. */}
      <CityCard rail tone="accent" className="km-diagnostic__card">
        <div className="km-diagnostic__pills">
          <Pill tone="gold">
            <Bilingual en={section.en} kr={section.kr} />
          </Pill>
          <Pill>{item.level}</Pill>
        </div>

        <p className="kr km-diagnostic__prompt">{item.prompt}</p>

        {/* Listening items with a mapped audio span render the SAME real
            player the TOPIK study screen uses (F-119/F-206), with the
            transcript reachable alongside it via `AudioBlock`'s
            `playerPresent` mode (a caption toggle, no false "no audio"
            claim — there IS audio, it's the player right above). Items with
            no mapped span fall back to `AudioBlock`'s honest transcript-only
            card instead. These two are a SINGLE branch, never both — a real
            player and a "no audio yet" note must never render together
            (B1 fix-pass). */}
        {item.audioUrl !== undefined &&
        item.audioStartMs !== undefined &&
        item.audioEndMs !== undefined ? (
          <>
            <TopikStudyAudio
              audioUrl={item.audioUrl}
              startMs={item.audioStartMs}
              endMs={item.audioEndMs}
            />
            {item.audio ? (
              <AudioBlock transcriptKr={item.audio.transcript} playerPresent />
            ) : null}
          </>
        ) : item.audio ? (
          <AudioBlock transcriptKr={item.audio.transcript} />
        ) : null}

        {isWriting ? (
          // The writing item's KR base sentence + EN gloss (Phase B reuses
          // `passage`/`hint` on the wire — no new fields — but the generic
          // PassageCard/hint-only-without-a-passage rendering below doesn't
          // fit a "transform this sentence" task, so it gets its own small
          // block instead. Reuses the Grammar screen's `km-grammar__context`/
          // `km-grammar__model-en` classes (already global CSS) so a writing
          // diagnostic item looks like the drill it actually is.
          <>
            <Eyebrow>
              <Bilingual en="Transform this" kr="문장을 바꿔 쓰세요" />
            </Eyebrow>
            {item.passage ? (
              <p className="kr km-grammar__context">{item.passage}</p>
            ) : null}
            {item.hint ? <p className="km-grammar__model-en">{item.hint}</p> : null}
          </>
        ) : (
          <>
            {item.passage ? <PassageCard item={item} /> : null}
            {item.hint && !item.passage ? (
              <div className="km-diagnostic__hint">{item.hint}</div>
            ) : null}
          </>
        )}

        {isWriting ? (
          <WritingInput
            value={picked ?? ''}
            revealed={revealed}
            disabled={inFlight}
            onChange={(text) => {
              if (!revealed && !inFlight) setPicked(text);
            }}
          />
        ) : (
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
        )}

        {reveal ? (
          <Card
            variant="flat"
            className="km-diagnostic__reveal"
            id={revealBlockId}
          >
            {isWriting ? (
              <WritingReveal reveal={reveal} />
            ) : (
              <>
                <Eyebrow>
                  {reveal.correct ? (
                    <Bilingual en="Correct" kr="정답" />
                  ) : (
                    <Bilingual en="Not quite" kr="아쉬워요" />
                  )}
                </Eyebrow>
                <p className="km-diagnostic__explain">{reveal.explain}</p>
                {/* F-020: hand the graded item to the Chat tutor. The stem lives on
                    `item`, the key + explanation on the server's `reveal` — the
                    choice ids are resolved to their display text here so the seed
                    reads naturally. When the correct id can't be resolved (corrupt
                    data — the green highlight is equally broken then), the line is
                    OMITTED via '' rather than seeding a bare id like "b" that
                    corresponds to nothing the learner saw (choices are labelled
                    ①②③④ on screen). Guarded to non-writing items only — a
                    writing item has no `choices` for this lookup to resolve
                    against (spec: "no choices for writing"). */}
                <div style={{ marginTop: 10 }}>
                  <AskAboutThisButton
                    prompt={item.prompt}
                    correctText={
                      item.choices.find((c) => c.id === reveal.correctAnswer)?.kr ??
                      ''
                    }
                    passage={buildSeedPassage(item)}
                    explanation={reveal.explain}
                    userPick={
                      !reveal.correct && picked !== null
                        ? item.choices.find((c) => c.id === picked)?.kr
                        : undefined
                    }
                  />
                </div>
              </>
            )}
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
              <Bilingual en="Try again" kr="다시 시도" />
            </Button>
          </div>
        ) : null}

        <div className="km-diagnostic__footer">
          {!revealed ? (
            <Button variant="ghost" onClick={skip} disabled={inFlight}>
              <Bilingual en="Skip" kr="건너뛰기" />
            </Button>
          ) : (
            <span className="km-diagnostic__count">
              {isLast ? (
                <Bilingual en="Last item" kr="마지막 문항" />
              ) : (
                <Bilingual en="Reviewing your answer" kr="정답 확인 중" />
              )}
            </span>
          )}
          {!revealed ? (
            <Button
              variant="gold"
              disabled={(isWriting ? !canSubmitWriting : picked === null) || inFlight}
              aria-busy={phase === 'answering'}
              onClick={submit}
            >
              {phase === 'answering' ? (
                <Bilingual en="Sending…" kr="보내는 중…" />
              ) : (
                <Bilingual en="Submit" kr="제출" />
              )}
            </Button>
          ) : (
            <Button
              variant="gold"
              onClick={advance}
              disabled={inFlight}
              aria-busy={phase === 'finishing' || phase === 'advancing'}
              trailingIcon={<Icon name="arrow-right" size={14} />}
            >
              {phase === 'finishing' ? (
                <Bilingual en="Scoring…" kr="채점 중…" />
              ) : phase === 'advancing' ? (
                <Bilingual en="Loading…" kr="불러오는 중…" />
              ) : isLast ? (
                <Bilingual en="See results" kr="결과 보기" />
              ) : (
                <Bilingual en="Next" kr="다음" />
              )}
            </Button>
          )}
        </div>
      </CityCard>
    </section>
  );
}

/** Human-readable section label pair for the in-test Pill — rendered through
 *  `<Bilingual/>` (P3b: never hand-compose "kr · en" strings). */
function sectionLabel(
  section: DiagnosticLiveItem['section'],
): { en: string; kr: string } {
  switch (section) {
    case 'reading':
      return { en: 'Reading', kr: '읽기' };
    case 'listening':
      return { en: 'Listening', kr: '듣기' };
    case 'vocab':
      return { en: 'Vocabulary', kr: '어휘' };
    case 'grammar':
      return { en: 'Grammar', kr: '문법' };
    case 'hanja':
      return { en: 'Hanja', kr: '한자' };
    case 'writing':
      return { en: 'Writing', kr: '쓰기' };
    default: {
      // Exhaustiveness guard — a new section must update this switch.
      const _never: never = section;
      return _never;
    }
  }
}

/**
 * The passage-equivalent context an "Ask about this" seed carries (F-020).
 * Mirrors what the item actually rendered:
 *   - listening items keep their content in `audio.transcript` (shown by
 *     `AudioBlock` — a caption toggle beside the real `TopikStudyAudio`
 *     player when a span is mapped, or the honest fallback card when it
 *     isn't) — without it the tutor gets a stem like "무엇에 대한
 *     이야기입니까?" with no idea what was said;
 *   - underline items emphasise a span of the passage (`PassageCard` below)
 *     — the seed marks it with ⟨ ⟩ so "밑줄 친 부분…" questions keep WHICH
 *     span was underlined.
 */
function buildSeedPassage(item: DiagnosticLiveItem): string | undefined {
  const passage = item.passage ?? item.audio?.transcript;
  if (passage === undefined) return undefined;
  const underline = item.underline ?? '';
  if (underline === '' || !passage.includes(underline)) return passage;
  return passage.split(underline).join(`⟨${underline}⟩`);
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

/** Max length mirrors the server's `AnswerBodySchema.picked` free-text bound
 *  (`z.string().max(600)`) — a client-side soft cap, defensive only; the
 *  server enforces its own. */
const WRITING_ANSWER_MAX_LENGTH = 600;

interface WritingInputProps {
  value: string;
  revealed: boolean;
  disabled: boolean;
  onChange: (text: string) => void;
}

/**
 * The writing item's answer surface (diagnostic-upgrade Phase B) — a free-
 * text `<textarea>`, NOT `<ChoiceList>` (a writing item ships no `choices`).
 * Mirrors the Grammar screen's own production-drill textarea (same maxLength
 * convention, same disabled-while-revealed/scoring posture).
 */
function WritingInput({
  value,
  revealed,
  disabled,
  onChange,
}: WritingInputProps): JSX.Element {
  return (
    <>
      <label htmlFor="dg-writing-answer" className="km-sr-only">
        Write one sentence in Korean
      </label>
      <textarea
        id="dg-writing-answer"
        className="kr km-grammar__textarea focusring"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder="Write one sentence in Korean…"
        rows={3}
        disabled={revealed || disabled}
        maxLength={WRITING_ANSWER_MAX_LENGTH}
      />
    </>
  );
}

/** Verdict → Pill tone/label, mirroring Grammar.tsx's own `VERDICT_META`
 *  (duplicated locally rather than imported — Grammar.tsx is a page module,
 *  not a shared component, and this is a 4-entry lookup table). */
const WRITING_VERDICT_META: Record<DrillVerdict, { tone: PillTone; label: string }> = {
  excellent: { tone: 'green', label: 'Excellent' },
  good: { tone: 'gold', label: 'Good' },
  needs_work: { tone: 'ochre', label: 'Needs work' },
  incorrect: { tone: 'red', label: 'Incorrect' },
};

interface WritingRevealProps {
  reveal: DiagnosticAnswerResult;
}

/**
 * The writing item's reveal (diagnostic-upgrade Phase B) — Claude's verdict/
 * summary/corrections/reference model, NOT the MC correct-choice/explain
 * reveal (a writing item has no choice to mark correct). Reuses the Grammar
 * screen's `km-grammar__*` reveal classes (already global CSS) so a writing
 * diagnostic item's reveal looks like the drill reveal it actually is. No
 * own `id` — the enclosing `<Card id={revealBlockId}>` already carries the
 * canonical reveal-block id; duplicating it here would be invalid HTML.
 */
function WritingReveal({ reveal }: WritingRevealProps): JSX.Element {
  // Defensive fallback: `verdict` is optional on the wire type (only present
  // for a writing item), but this component only renders when the item IS
  // writing — `reveal.correct` still degrades sensibly if the server ever
  // omitted verdict for some reason.
  const meta =
    reveal.verdict !== undefined
      ? WRITING_VERDICT_META[reveal.verdict]
      : { tone: (reveal.correct ? 'green' : 'red') as PillTone, label: reveal.correct ? 'Correct' : 'Not quite' };
  return (
    <>
      <Eyebrow>
        <Bilingual en="Writing" kr="쓰기" />
      </Eyebrow>
      <div className="km-grammar__score-head">
        <Pill tone={meta.tone}>{meta.label}</Pill>
      </div>
      {reveal.summary ? <p className="km-grammar__summary">{reveal.summary}</p> : null}
      {reveal.corrections && reveal.corrections.length > 0 ? (
        <ul className="km-grammar__corrections">
          {reveal.corrections.map((c, i) => (
            <li key={`${c.span}-${String(i)}`} className="km-grammar__correction">
              <span className="km-grammar__correction-span kr">{c.span}</span>
              <span className="km-grammar__correction-issue">{c.issue}</span>
              <span className="km-grammar__correction-fix kr">{c.fix}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {reveal.referenceModelKr ? (
        <>
          <Eyebrow>
            <Bilingual en="Model answer" kr="모범 답안" />
          </Eyebrow>
          <p className="kr km-grammar__model">{reveal.referenceModelKr}</p>
          {reveal.referenceModelEn ? (
            <p className="km-grammar__model-en">{reveal.referenceModelEn}</p>
          ) : null}
        </>
      ) : null}
    </>
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
      {/* F-128 device #7 — the hand-stamped 도장 rotation now marks this as
          the completion milestone it is, rather than the plain upright
          section-anchor badge look used elsewhere (Hanja/Login/Review). */}
      <SealStamp char="完" size="lg" milestone tone="accent" />
      {/* P3b trim — the "진단평가 완료" eyebrow was the title's Korean twin;
          one bilingual title now carries both. */}
      <h2 id="dg-done-h" className="kr-display km-diagnostic__done-title">
        <Bilingual kr="진단평가 완료" en="Diagnostic complete" />
      </h2>
      <p className="km-diagnostic__done-hint">
        {/* P3b: the old "Comparing against TOPIK II L4 reference." hard-coded
            a reference the results pick dynamically (a beginner run defaults
            to L2) — the same dishonest-literal class B-007 cut from Results. */}
        <Bilingual en="Your results are ready." kr="결과가 준비됐어요." />
      </p>
      <Button
        variant="gold"
        onClick={onContinue}
        trailingIcon={<Icon name="arrow-right" size={14} />}
      >
        <Bilingual en="See gap map" kr="약점 지도 보기" />
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
  const skills: ReadonlyArray<SkillRow> = snapshot.dimensions.map((d) => ({
    key: d.key,
    label: d.label,
    kr: d.kr,
    score: d.score,
    // F-011: confidence band edges. SkillBar renders no band when they
    // collapse onto the score (the server's "unknown confidence" fallback).
    scoreLow: d.scoreLow,
    scoreHigh: d.scoreHigh,
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
      {/* F-128 devices #4/#2 — the shared hub-header recipe replaces the old
          bare eyebrow + `<h1>` pair. Honest labeling (B-007 + F-011) carries
          over unchanged: the snapshot carries no capture timestamp, so a
          neutral eyebrow stands in for a time claim, and the sub-line below
          says what this actually is (a rough estimate with per-skill
          confidence bands) rather than implying an official placement. */}
      <PageHubHeader
        titleId="dg-results-h"
        eyebrow={<Bilingual en="Quick placement estimate" kr="간단 실력 추정" />}
        heading={<Bilingual kr="진단평가" en="Diagnostic" />}
      />
      <p className="km-diagnostic__results-sub">
        <Bilingual
          en="A short adaptive quiz — a rough placement estimate, not an official TOPIK score. Bands show how confident each result is."
          kr="짧은 적응형 퀴즈예요 — 공식 TOPIK 점수가 아닌 대략적인 추정이에요. 신뢰 구간은 각 결과의 신뢰도를 보여 줘요."
        />
      </p>

      {/* F-128 device #1/#2 — a CityCard signboard/hanji-paper surface with a
          leading DancheongRail, replacing the plain flat Card. */}
      <CityCard tone="accent" rail className="km-diagnostic__skills-card">
        <Eyebrow>
          <Bilingual en="Where you are" kr="현재 위치" />
        </Eyebrow>
        <div className="km-diagnostic__skills-title">
          <Bilingual en="Skills snapshot" kr="실력 요약" />
        </div>
        <SkillsCompare
          skills={skills}
          references={references}
          defaultRefId={snapshot.defaultRef}
          variant="full"
        />
      </CityCard>

      {/* F-143 — the "Derived from your gaps / Next steps" goals card and the
          "Begin today's plan" CTA are removed at the user's explicit request.
          The results screen now ends at the skills snapshot + the retake
          action; `snapshot.goals` is still part of the shared API contract
          (other consumers may read it) but this screen no longer renders it. */}
      <div className="km-diagnostic__cta-row">
        <Button variant="gold" onClick={onRetest}>
          <Bilingual en="Re-test diagnostic" kr="진단 다시 하기" />
        </Button>
      </div>
    </section>
  );
}

export default Diagnostic;
