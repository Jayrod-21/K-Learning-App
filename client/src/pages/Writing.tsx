/**
 * Writing screen (Phase 3C-2 rework) — TOPIK writing practice graded by the
 * real `POST /grade-writing` rubric grader, plus the Claude topic generator
 * (F-073) and a deep-link seam for Today-generated topics (F-101).
 *
 * Layout: BackButton (F-024) → Topbar → two `Tabs` (Phase-1 primitive):
 *
 *   WRITE — the practice surface. The active task comes from ONE of two
 *   sources, modeled as a discriminated union (`ActiveTask`):
 *     - 'bank': a curated prompt from `GET /writing/prompts/random?rubric=`
 *       (B-027: the old flow fetched the deterministic `/prompts` list and
 *       pinned index 0, so every visit opened the SAME task; the pick is now
 *       genuinely random, server-side). The Q53/Q54 radiogroup selects which
 *       rubric's pool to draw from; "New prompt" redraws.
 *     - 'generated': a Claude-authored topic — adopted from the on-page
 *       `WritingTopicGenerator` via its "Write this topic" action (F-073),
 *       or carried in through `location.state.generatedTopic` by the Today
 *       writing tile (F-101; the history entry is scrubbed on mount so
 *       Back/refresh can't replay the deep link — the Grammar drill-target
 *       idiom). Generated topics are gradable: TOPIK-style ones grade
 *       against their echoed rubric; free-writes grade against the real
 *       `free_write` rubric (migration 056/F-117 widened the server enum +
 *       DB CHECK, replacing the earlier Q54-borrowing stand-in — see
 *       `gradeRubricFor`).
 *
 *   The task header (eyebrow + target band + textarea label) derives from
 *   the ACTIVE task's own rubric/mode — never from a hardcoded Q53 default
 *   (the other half of B-027: the headers previously could not disagree with
 *   the tab, so a mis-served prompt would have worn the wrong rubric).
 *
 *   RESPONSES — the caller's graded-writing history via
 *   `GET /writing/attempts` (F-106, replacing the earlier F-074 honest stub
 *   that could only say "browsing is coming soon" — that endpoint didn't
 *   exist yet). Abortable fetch on tab activation, failure-safe (fixed-copy
 *   error + Retry, never a mock fallback), honest empty state for a learner
 *   who has never submitted a sample.
 *
 * Draft-preservation contract (F-UP-017's successor): the learner's text is
 * cleared ONLY when a genuinely different task lands after an explicit "New
 * prompt" redraw, or when a generated topic is adopted. A redraw that
 * returns the same prompt id, a rubric switch, and a tab round-trip (all
 * compose state lives at page level, above the re-keyed tab panels) all
 * preserve the draft. A failed redraw keeps it too — the error state is a
 * prompt-area problem, never a destroyed sheet.
 *
 * Failure is failure-SAFE, never a dead end (mirrors the Grammar drill): a
 * grade failure keeps the learner's text, surfaces a fixed-string inline
 * `role="alert"` ErrorCard (429 renders the structured `retryAfter` seconds
 * when present — never echoed server prose), and Grade stays available as
 * the retry (aria-disabled while in flight, NOT `disabled`, so keyboard
 * focus survives the round trip). A random-prompt fetch failure renders its
 * own fixed-copy ErrorCard with a Retry; an empty rubric pool (404) renders
 * an honest empty state. No mock fallback for any leg.
 *
 * Threat model:
 *   - The grade request is authenticated + user-scoped (session cookie via
 *     api.ts; `RequireAuth` gates the route) and expensive-bucket
 *     rate-limited server-side — the 429 path here is first-class.
 *   - All grade/topic text (evidence, improvements, comments, generated
 *     prompts) is Claude output relayed by our server — rendered ONLY
 *     through React text children, so it cannot escape into HTML. No
 *     dangerouslySetInnerHTML.
 *   - `location.state` is attacker-shapeable in principle (any in-app code
 *     can navigate with state), so `readGeneratedTopic` narrows it field by
 *     field at runtime — a malformed payload falls back to the bank flow,
 *     never a crash or a type lie.
 *   - Error copy is a fixed lookup keyed on `ApiError.code`/`status`; server
 *     message strings are never echoed (the Login.messageFor contract).
 *   - The sample is soft-capped by `maxLength` (5,000 — the server's own Zod
 *     ceiling) so a runaway paste can't balloon the request.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Pill, type PillTone } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { GoldRule } from '../components/GoldRule';
import { ErrorCard } from '../components/ErrorCard';
import { Tabs, type TabItem } from '../components/Tabs';
import { WritingTopicGenerator } from '../components/WritingTopicGenerator';
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import {
  fetchRandomWritingPrompt,
  fetchWritingAttempts,
  gradeWriting,
} from '../services/writing';
import type {
  GeneratedWritingPrompt,
  WritingPromptDTO,
} from '../services/writing';
import type {
  GradeWritingBody,
  TopikWritingRubric,
  WritingAttemptDTO,
  WritingDimensionScore,
  WritingEstimatedLevel,
  WritingGradeResult,
  WritingRubric,
} from '../types/domain';
import './Writing.css';

/**
 * Server-side Zod ceiling on `sample` (gradeWriting.ts: 1..5000). The textarea
 * soft-caps at the same bound so the client can never author a 400.
 */
const SAMPLE_MAX_CHARS = 5_000;

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const WRITING_NAV = navItem('writing');

/** Per-rubric presentation meta. Target bands are the official TOPIK specs. */
const RUBRIC_META: Record<
  TopikWritingRubric,
  { label: string; eyebrow: string; krEyebrow: string; target: string }
> = {
  topik_ii_53: {
    label: 'Q53 · 200–300자',
    eyebrow: 'Describe and explain',
    krEyebrow: '설명하는 글',
    target: '200–300자',
  },
  topik_ii_54: {
    label: 'Q54 · 600–700자',
    eyebrow: 'Argue a position',
    krEyebrow: '주장하는 글',
    target: '600–700자',
  },
};

/** Rubric radio order — Q53 first (the shorter, friendlier on-ramp). */
const RUBRICS: readonly TopikWritingRubric[] = ['topik_ii_53', 'topik_ii_54'];

/**
 * Fallback TOPIK rubric for a generated `mode: 'topik'` task whose own
 * `rubric` is somehow missing (the server always echoes one for topik mode —
 * this is defensive, not a real path). Mirrors `/grade-writing`'s own Q54
 * default. NOT used for `mode: 'general'` free-writes — those grade against
 * the real `free_write` rubric (migration 056/F-117); see `gradeRubricFor`.
 */
const DEFAULT_GENERATED_RUBRIC: TopikWritingRubric = 'topik_ii_54';

/** The two top-level sections (Phase-1 `Tabs` primitive). */
const WRITING_TABS: ReadonlyArray<TabItem> = [
  { id: 'write', label: <Bilingual en="Write" kr="쓰기" compact /> },
  {
    id: 'responses',
    label: <Bilingual en="My responses" kr="내 답안" compact />,
  },
];

/**
 * Phases of the grade lifecycle. Deliberately NO 'error' phase (mirrors the
 * Grammar drill's DrillPhase): a failed grade returns to 'composing' with the
 * text preserved and an inline alert — the screen never dead-ends.
 */
type WritingPhase = 'composing' | 'grading' | 'graded';

/** Estimated-level pill: label + tone. Exhaustive over the server enum. */
const LEVEL_META: Record<
  WritingEstimatedLevel,
  { label: string; tone: PillTone }
> = {
  below_L3: { label: 'Below TOPIK 3', tone: 'red' },
  L3: { label: 'TOPIK 3', tone: 'ochre' },
  L4: { label: 'TOPIK 4', tone: 'default' },
  L5: { label: 'TOPIK 5', tone: 'gold' },
  L6: { label: 'TOPIK 6', tone: 'green' },
};

/**
 * The task on the compose surface — the union the whole write panel renders
 * from. `source` decides the grade body (bank prompts link the persisted
 * attempt via `promptId`; generated topics have no source row) and the
 * header meta (the ACTUAL rubric/mode, never a hardcoded default — B-027).
 */
type ActiveTask =
  | { source: 'bank'; prompt: WritingPromptDTO }
  | { source: 'generated'; prompt: GeneratedWritingPrompt };

/** Prompt-area lifecycle. 'empty' is the honest no-active-prompts 404. */
type TaskState =
  | { phase: 'loading' }
  | { phase: 'empty' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; task: ActiveTask };

/**
 * The rubric a task grades against. Bank prompts carry their own; a generated
 * TOPIK-style topic echoes the rubric the server authored against (falling
 * back to `DEFAULT_GENERATED_RUBRIC` only if it were somehow absent); a
 * generated `general`-mode topic is a genuine free-write and grades against
 * the real `free_write` rubric (migration 056/F-117 — no longer a Q54
 * borrow).
 */
function gradeRubricFor(task: ActiveTask): WritingRubric {
  if (task.source === 'bank') return task.prompt.rubric;
  if (task.prompt.mode === 'general') return 'free_write';
  return task.prompt.rubric ?? DEFAULT_GENERATED_RUBRIC;
}

/** What the task header shows — derived from the task itself (B-027). */
interface TaskHeaderMeta {
  eyebrow: string;
  krEyebrow: string;
  /** Target length band ("200–300자"); null when the task carries none. */
  target: string | null;
}

function headerMetaFor(task: ActiveTask): TaskHeaderMeta {
  if (task.source === 'bank') {
    const m = RUBRIC_META[task.prompt.rubric];
    return { eyebrow: m.eyebrow, krEyebrow: m.krEyebrow, target: m.target };
  }
  if (task.prompt.mode === 'topik') {
    const m = RUBRIC_META[task.prompt.rubric ?? DEFAULT_GENERATED_RUBRIC];
    return {
      eyebrow: m.eyebrow,
      krEyebrow: m.krEyebrow,
      // Prefer the topic's own length hint; fall back to the rubric band.
      target: task.prompt.lengthHint ?? m.target,
    };
  }
  return {
    eyebrow: 'Free write',
    krEyebrow: '자유 주제',
    target: task.prompt.lengthHint,
  };
}

/** The shape we look for in `location.state` when a topic is deep-linked. */
interface WritingLocationState {
  generatedTopic?: GeneratedWritingPrompt;
}

/**
 * Narrow an opaque `location.state` to a `GeneratedWritingPrompt`, or null
 * when absent/malformed (F-101). Field-by-field runtime checks — router
 * state is not a trusted boundary, so a bad payload degrades to the bank
 * flow instead of crashing the page or lying to the grade route.
 */
function readGeneratedTopic(state: unknown): GeneratedWritingPrompt | null {
  if (typeof state !== 'object' || state === null) return null;
  const c = (state as WritingLocationState).generatedTopic;
  if (
    typeof c === 'object' &&
    c !== null &&
    typeof c.promptKr === 'string' &&
    c.promptKr.trim() !== '' &&
    typeof c.promptEn === 'string' &&
    (c.mode === 'topik' || c.mode === 'general') &&
    (c.lengthHint === null || typeof c.lengthHint === 'string') &&
    (c.rubric === null ||
      c.rubric === 'topik_ii_53' ||
      c.rubric === 'topik_ii_54')
  ) {
    return c;
  }
  return null;
}

/**
 * Fixed-string error copy keyed on the normalised `ApiError` — server prose is
 * never echoed (only the structured numeric `retryAfter` is interpolated).
 */
function messageFor(err: ApiError): string {
  if (err.status === 429) {
    return err.retryAfter !== undefined
      ? `Grading is rate-limited. Try again in about ${String(Math.ceil(err.retryAfter))} seconds — your text is saved here.`
      : 'Grading is rate-limited right now. Wait a moment and try again — your text is saved here.';
  }
  if (err.code === 'timeout') {
    return 'The grader took too long to respond. Your text is preserved — try again.';
  }
  if (err.code === 'network') {
    return 'Network unreachable. Your text is preserved — try again once you reconnect.';
  }
  if (err.status === 401) {
    return 'Your session has expired. Sign in again to grade this sample.';
  }
  return "The grader couldn't score this sample. Your text is preserved — try again.";
}

/**
 * Fixed-string error copy for the random-prompt fetch (same contract as
 * `messageFor` — never echoed server prose). The empty-pool 404 is handled
 * BEFORE this lookup (it renders the honest empty state, not an error).
 */
function promptsMessageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') {
      return 'Network unreachable. Reconnect and retry to load a writing task.';
    }
    if (err.status === 401) {
      return 'Your session has expired. Sign in again to load a writing task.';
    }
  }
  return "A writing task couldn't be loaded. Try again in a moment.";
}

/**
 * Fixed-string error copy for the Responses-tab history fetch (F-106; same
 * never-echo-server-prose contract as `messageFor`/`promptsMessageFor`).
 */
function attemptsMessageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') {
      return 'Network unreachable. Reconnect and retry to load your responses.';
    }
    if (err.status === 401) {
      return 'Your session has expired. Sign in again to see your responses.';
    }
  }
  return "Your responses couldn't be loaded. Try again in a moment.";
}

function Writing(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();

  // F-101: snapshot a Today-carried topic ONCE on mount (lazy initializer,
  // not a render-time read) so the history-state scrub below can't yank it
  // out from under the compose surface — the Grammar drill-target idiom.
  const [seedTopic] = useState<GeneratedWritingPrompt | null>(() =>
    readGeneratedTopic(location.state),
  );

  // Which source feeds the compose surface. 'bank' drives the random-prompt
  // fetch effect; 'generated' parks it (a generated task is already local).
  const [source, setSource] = useState<'bank' | 'generated'>(
    seedTopic !== null ? 'generated' : 'bank',
  );
  // The bank rubric the radiogroup selects — which pool "New prompt" draws
  // from. Independent of the ACTIVE task's rubric (a generated Q54 topic can
  // sit on the surface while the radios still show the learner's last pick).
  const [rubric, setRubric] = useState<TopikWritingRubric>('topik_ii_53');
  const [taskState, setTaskState] = useState<TaskState>(
    seedTopic !== null
      ? { phase: 'ready', task: { source: 'generated', prompt: seedTopic } }
      : { phase: 'loading' },
  );
  // Monotonic redraw/retry trigger for the fetch effect (the TTMIK idiom).
  const [drawTick, setDrawTick] = useState(0);

  const [sample, setSample] = useState('');
  const [phase, setPhase] = useState<WritingPhase>('composing');
  const [grade, setGrade] = useState<WritingGradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const textareaId = useId();
  const gradeId = useId();
  const rubricGroupId = useId();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rubricRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The last-served bank prompt id — lets a redraw that returns the SAME
  // prompt keep the learner's draft (F-UP-017's successor: never destroy a
  // draft for a task that didn't change).
  const lastBankIdRef = useRef<number | null>(null);
  // Set by "New prompt": clear the sheet when the redraw lands a DIFFERENT
  // task. Rubric switches and retries leave it false (draft preserved).
  const clearOnArrivalRef = useRef(false);
  // Set by adopt: move focus into the textarea after the commit (the user
  // just said "write this" — landing them in the sheet is the affordance).
  const pendingFocusRef = useRef(false);

  // Scrub the consumed deep-link topic out of the history entry so a Back or
  // reload doesn't replay it (the topic itself lives on in `seedTopic`).
  useEffect(() => {
    if (readGeneratedTopic(location.state) !== null) {
      void navigate(location.pathname, { replace: true, state: null });
    }
    // Mount-only: the topic was captured into state above; re-running on
    // location changes would re-scrub (harmless) or fight in-page navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bank prompt fetch — one random active prompt for the selected rubric
  // (B-027). Re-keys on source/rubric/drawTick; parked while a generated
  // task owns the surface. The cleanup aborts before every re-run and on
  // unmount, so a stale settle can never clobber newer state.
  useEffect(() => {
    if (source !== 'bank') return;
    const ctrl = new AbortController();
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference/TTMIK tabs use for their kickoff setState.
    setTaskState({ phase: 'loading' });
    fetchRandomWritingPrompt(rubric, ctrl.signal)
      .then((prompt) => {
        if (ctrl.signal.aborted) return;
        const changed = prompt.id !== lastBankIdRef.current;
        lastBankIdRef.current = prompt.id;
        setTaskState({ phase: 'ready', task: { source: 'bank', prompt } });
        if (clearOnArrivalRef.current && changed) {
          // An explicit "New prompt" landed a genuinely new task — fresh sheet.
          setSample('');
          setGrade(null);
          setError(null);
          setPhase('composing');
        }
        clearOnArrivalRef.current = false;
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        clearOnArrivalRef.current = false;
        if (err instanceof ApiError && err.status === 404) {
          // The rubric's active pool is empty — honest empty state, not an
          // error card with a retry that can never succeed.
          setTaskState({ phase: 'empty' });
          return;
        }
        setTaskState({ phase: 'error', message: promptsMessageFor(err) });
      });
    return () => {
      ctrl.abort();
    };
  }, [source, rubric, drawTick]);

  // Post-commit focus hand-off for `adoptTopic` (flag-guarded; no deps array
  // so it observes every commit, and the guard makes it a no-op otherwise).
  useEffect(() => {
    if (pendingFocusRef.current) {
      pendingFocusRef.current = false;
      textareaRef.current?.focus();
    }
  });

  // In-flight grade controller: a re-submit, task change, or unmount aborts
  // the stale call so its settle can't clobber newer state.
  const ctrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      ctrlRef.current?.abort();
    };
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (taskState.phase !== 'ready') return;
    const trimmed = sample.trim();
    if (trimmed.length === 0) return;
    const task = taskState.task;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setPhase('grading');
    setError(null);
    setGrade(null);
    try {
      // Bank prompts link the persisted attempt to their `writing_prompts`
      // source row via `promptId` (F-014); generated topics have no source
      // row, so the key is OMITTED (the route's schema is .strict()).
      const body: GradeWritingBody =
        task.source === 'bank'
          ? {
              prompt: task.prompt.promptKr,
              sample: trimmed,
              rubric: task.prompt.rubric,
              promptId: task.prompt.id,
            }
          : {
              prompt: task.prompt.promptKr,
              sample: trimmed,
              rubric: gradeRubricFor(task),
            };
      const res = await gradeWriting(body, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setGrade(res.result);
      setPhase('graded');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      // Canceled (unmount / superseding submit) — the newer run owns state.
      if (err instanceof ApiError && err.code === 'canceled') return;
      setError(
        err instanceof ApiError
          ? messageFor(err)
          : "The grader couldn't score this sample. Your text is preserved — try again.",
      );
      setPhase('composing');
    }
  }, [sample, taskState]);

  /** Back to composing with the text intact, for a revise-and-regrade pass. */
  const revise = useCallback((): void => {
    setGrade(null);
    setError(null);
    setPhase('composing');
  }, []);

  /**
   * Redraw a random prompt from the selected rubric's pool. The sheet clears
   * only if the redraw lands a DIFFERENT prompt (see the fetch effect); a
   * failed redraw keeps the draft too.
   */
  const nextPrompt = useCallback((): void => {
    ctrlRef.current?.abort();
    clearOnArrivalRef.current = true;
    setError(null);
    setDrawTick((t) => t + 1);
  }, []);

  /** Retry for a failed prompt fetch — re-runs the effect, draft untouched. */
  const retryPrompt = useCallback((): void => {
    setDrawTick((t) => t + 1);
  }, []);

  /**
   * Select a bank rubric (also the way BACK to bank tasks from a generated
   * topic). Preserves the draft — switching pools is exploratory, and
   * silently destroying text would repeat the F-UP-017 bug class.
   */
  const selectRubric = useCallback(
    (next: TopikWritingRubric): void => {
      if (source === 'bank' && next === rubric) return;
      ctrlRef.current?.abort();
      clearOnArrivalRef.current = false;
      setSource('bank');
      setRubric(next);
      setGrade(null);
      setError(null);
      setPhase('composing');
    },
    [source, rubric],
  );

  /**
   * F-073 / F-101: a generated topic becomes the active gradable task. An
   * explicit user action ("Write this topic"), so the sheet starts fresh and
   * focus lands in it.
   */
  const adoptTopic = useCallback((topic: GeneratedWritingPrompt): void => {
    ctrlRef.current?.abort();
    clearOnArrivalRef.current = false;
    setSource('generated');
    setTaskState({ phase: 'ready', task: { source: 'generated', prompt: topic } });
    setSample('');
    setGrade(null);
    setError(null);
    setPhase('composing');
    pendingFocusRef.current = true;
  }, []);

  // Roving-tabindex arrows on the rubric radios (WAI-ARIA radiogroup — the
  // same segmented-control pattern as WritingTopicGenerator's style choice).
  const onRubricKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const current = RUBRICS.indexOf(rubric);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (current + 1) % RUBRICS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (current - 1 + RUBRICS.length) % RUBRICS.length;
    }
    if (next === null) return;
    e.preventDefault();
    const target = RUBRICS[next];
    if (target === undefined) return;
    selectRubric(target);
    rubricRefs.current[next]?.focus();
  };

  const grading = phase === 'grading';
  const graded = phase === 'graded' && grade !== null;
  const canSubmit =
    !grading && sample.trim().length > 0 && taskState.phase === 'ready';

  const task = taskState.phase === 'ready' ? taskState.task : null;
  // Header meta comes from the ACTUAL task (B-027); while no task is on the
  // surface (loading/error/empty) it previews the selected bank rubric.
  const headerMeta =
    task !== null
      ? headerMetaFor(task)
      : {
          eyebrow: RUBRIC_META[rubric].eyebrow,
          krEyebrow: RUBRIC_META[rubric].krEyebrow,
          target: RUBRIC_META[rubric].target,
        };

  return (
    <section
      className="screen km-writing"
      aria-labelledby="writing-title"
      style={{ position: 'relative' }}
    >
      {/* F-024: Writing is a nested LEARN view; the launcher is an overlay
          (not a route), so the control is history-back with the guarded
          home fallback for deep links. */}
      <div className="km-writing__nav">
        <BackButton />
      </div>

      <Topbar
        krTitle="쓰기"
        title="Writing"
        titleId="writing-title"
        eyebrow={
          <Bilingual en={WRITING_NAV.eyebrow} kr={WRITING_NAV.krEyebrow} />
        }
      />

      <Tabs tabs={WRITING_TABS} ariaLabel="Writing sections">
        {(activeTab) =>
          activeTab === 'responses' ? (
            <MyResponses />
          ) : (
            <>
              {/* Rubric radiogroup ───────────────────────────────── */}
              <div
                className="km-review__tabs"
                role="radiogroup"
                aria-label="Writing task type"
                id={rubricGroupId}
              >
                {RUBRICS.map((r, i) => {
                  const selected = rubric === r;
                  return (
                    <button
                      key={r}
                      ref={(el) => {
                        rubricRefs.current[i] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
                      onClick={() => {
                        selectRubric(r);
                      }}
                      onKeyDown={onRubricKeyDown}
                    >
                      {RUBRIC_META[r].label}
                    </button>
                  );
                })}
              </div>

              {/* Task prompt + compose sheet ─────────────────────── */}
              <Card variant="default" style={{ marginBottom: 16 }}>
                <Eyebrow>
                  <Bilingual
                    en={headerMeta.eyebrow}
                    kr={headerMeta.krEyebrow}
                  />
                </Eyebrow>
                {taskState.phase === 'loading' ? (
                  <div className="km-grammar__state" role="status">
                    <Bilingual
                      en="Loading a writing task…"
                      kr="쓰기 과제를 불러오는 중…"
                    />
                  </div>
                ) : taskState.phase === 'error' ? (
                  <ErrorCard
                    message={taskState.message}
                    onRetry={retryPrompt}
                  />
                ) : taskState.phase === 'empty' ? (
                  // The rubric's active pool is empty (404) — an honest
                  // empty state, not a spinner or a doomed retry loop.
                  <p className="km-reference__empty">
                    <Bilingual
                      en="No writing tasks are available for this section yet."
                      kr="아직 이 영역의 쓰기 과제가 없어요."
                    />
                  </p>
                ) : (
                  <ComposeSheet
                    task={taskState.task}
                    headerMeta={headerMeta}
                    textareaId={textareaId}
                    textareaRef={textareaRef}
                    gradeId={gradeId}
                    sample={sample}
                    onSampleChange={setSample}
                    phase={phase}
                    graded={graded}
                    error={error}
                    canSubmit={canSubmit}
                    onSubmit={() => void submit()}
                    onRevise={revise}
                    onNextPrompt={nextPrompt}
                  />
                )}
              </Card>

              {/* Grade reveal — persistent polite live region so screen
                  readers hear the result land without a focus jump. */}
              <div aria-live="polite">
                {graded ? <GradePanel grade={grade} gradeId={gradeId} /> : null}
              </div>

              {/* F-073: the shared topic generator (same engine as the
                  Today tile) — "Write this topic" adopts the result above. */}
              <div className="km-writing__topicgen">
                <WritingTopicGenerator onUseTopic={adoptTopic} />
              </div>
            </>
          )
        }
      </Tabs>
    </section>
  );
}

/** Props for the compose sheet — all state lives in the page (it must
 *  survive tab round-trips through the re-keyed `Tabs` panels). */
interface ComposeSheetProps {
  task: ActiveTask;
  headerMeta: TaskHeaderMeta;
  textareaId: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  gradeId: string;
  sample: string;
  onSampleChange: (next: string) => void;
  phase: WritingPhase;
  graded: boolean;
  error: string | null;
  canSubmit: boolean;
  onSubmit: () => void;
  onRevise: () => void;
  onNextPrompt: () => void;
}

/** The prompt text + textarea + grade controls for the active task. */
function ComposeSheet({
  task,
  headerMeta,
  textareaId,
  textareaRef,
  gradeId,
  sample,
  onSampleChange,
  phase,
  graded,
  error,
  canSubmit,
  onSubmit,
  onRevise,
  onNextPrompt,
}: ComposeSheetProps): JSX.Element {
  const grading = phase === 'grading';
  const isGenerated = task.source === 'generated';
  // Bank prompts may lack a gloss (null); generated ones always carry one.
  const gloss: string | null = task.prompt.promptEn;
  return (
    <>
      {isGenerated ? (
        <div className="km-writing__srcrow">
          <Pill tone="gold">
            <Bilingual en="Generated topic" kr="만든 주제" compact />
          </Pill>
          {task.prompt.mode === 'general' ? (
            <Pill>
              <Bilingual en="Free write" kr="자유 주제" compact />
            </Pill>
          ) : null}
        </div>
      ) : null}

      <p className="kr km-grammar__context">{task.prompt.promptKr}</p>
      {gloss !== null && gloss !== '' ? (
        // Optional English gloss of the task — muted, secondary to the
        // Korean. Server/Claude text rendered as React children only.
        <p className="km-writing__gloss">{gloss}</p>
      ) : null}

      <label
        htmlFor={textareaId}
        className="km-grammar__instruction"
        style={{ display: 'block' }}
      >
        <Bilingual
          en={
            headerMeta.target !== null
              ? `Your writing in Korean · target ${headerMeta.target}`
              : 'Your writing in Korean'
          }
          kr={
            headerMeta.target !== null
              ? `한국어로 쓰기 · 목표 ${headerMeta.target}`
              : '한국어로 쓰기'
          }
        />
      </label>
      <textarea
        id={textareaId}
        ref={textareaRef}
        className="kr km-grammar__textarea focusring"
        value={sample}
        onChange={(e) => {
          onSampleChange(e.target.value);
        }}
        placeholder="여기에 한국어로 쓰십시오…"
        rows={gradeRubricFor(task) === 'topik_ii_54' ? 10 : 6}
        // readOnly, NOT disabled: the learner may be focused here when the
        // grade kicks off — disabling would drop focus to <body> (WCAG
        // 2.4.3). Read-only keeps the text selectable while it's graded.
        readOnly={grading || graded}
        aria-describedby={graded ? gradeId : undefined}
        // Soft cap at the server's own Zod ceiling (1..5000) — defensive;
        // keeps a runaway paste from authoring a guaranteed 400.
        maxLength={SAMPLE_MAX_CHARS}
      />
      <div className="km-writing__count">{sample.length}자</div>

      {grading ? (
        <div className="km-grammar__state" role="status">
          <Bilingual
            en="Grading your writing… this can take up to a minute."
            kr="채점 중이에요… 1분 정도 걸릴 수 있어요."
          />
        </div>
      ) : null}

      {error !== null ? <ErrorCard message={error} /> : null}

      <div className="km-grammar__footer">
        {!graded ? (
          <>
            {task.source === 'bank' ? (
              <Button variant="ghost" onClick={onNextPrompt} disabled={grading}>
                <Bilingual en="New prompt" kr="새 과제" />
              </Button>
            ) : null}
            <Button
              variant="gold"
              // aria-disabled while grading (focus survives the round trip;
              // the click guard is the real re-entry gate); hard-disabled
              // only while there is nothing submittable to begin with.
              aria-disabled={grading || undefined}
              disabled={!grading && !canSubmit}
              onClick={() => {
                if (grading) return; // aria-disabled doesn't block clicks.
                onSubmit();
              }}
            >
              {grading ? (
                <Bilingual en="Grading…" kr="채점 중…" />
              ) : (
                <Bilingual en="Grade my writing" kr="채점하기" />
              )}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onRevise}>
              <Bilingual en="Revise & regrade" kr="고쳐서 다시 채점" />
            </Button>
            {task.source === 'bank' ? (
              <Button variant="gold" onClick={onNextPrompt}>
                <Bilingual en="New prompt" kr="새 과제" />
              </Button>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** Rubric label for one history row — reuses RUBRIC_META's mixed-text label
 *  for the two TOPIK rubrics; free_write gets its own (056/F-117 — a REAL
 *  rubric now, not a Q54 borrow, so it earns its own label, not "Q54 ·…"). */
function attemptRubricLabel(rubric: WritingRubric): string {
  if (rubric === 'free_write') return 'Free write · 자유 주제';
  return RUBRIC_META[rubric].label;
}

/** Lifecycle for the F-106 attempts fetch. Deliberately NO combined
 *  loading+stale-data state — a fresh tab activation always starts clean
 *  (the Tabs primitive re-keys/remounts the panel on switch). */
type AttemptsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'empty' }
  | { phase: 'loaded'; attempts: WritingAttemptDTO[] };

/**
 * F-106 — the caller's graded-writing history via `GET /writing/attempts`,
 * replacing the earlier F-074 honest stub now that the endpoint is real.
 * Abortable on unmount/retry (the same idiom as the bank-prompt fetch
 * effect above); failure-safe (fixed-copy `ErrorCard` + Retry, never a mock
 * fallback); an honest empty state for a learner who has never graded a
 * sample. All prompt/sample text is Claude/learner text relayed by our
 * server, rendered ONLY through React text children (no `dangerouslySetInnerHTML`).
 */
function MyResponses(): JSX.Element {
  const [state, setState] = useState<AttemptsState>({ phase: 'loading' });
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    // Resets to 'loading' on a Retry (retryTick bump) without unmounting —
    // the initial mount is already 'loading' via useState's initializer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ phase: 'loading' });
    fetchWritingAttempts(undefined, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setState(
          res.attempts.length === 0
            ? { phase: 'empty' }
            : { phase: 'loaded', attempts: res.attempts },
        );
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setState({ phase: 'error', message: attemptsMessageFor(err) });
      });
    return () => {
      ctrl.abort();
    };
  }, [retryTick]);

  return (
    <Card variant="default">
      <Eyebrow>
        <Bilingual en="My responses" kr="내 답안" />
      </Eyebrow>
      {state.phase === 'loading' ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading your responses…" kr="답안을 불러오는 중…" />
        </div>
      ) : state.phase === 'error' ? (
        <ErrorCard
          message={state.message}
          onRetry={() => {
            setRetryTick((t) => t + 1);
          }}
        />
      ) : state.phase === 'empty' ? (
        <p className="km-reference__empty">
          <Bilingual
            en="You haven't graded a writing sample yet. Submit one in Write to see it here."
            kr="아직 채점된 답안이 없어요. 쓰기 탭에서 글을 제출해 보세요."
          />
        </p>
      ) : (
        <ul className="km-writing__attempts">
          {state.attempts.map((a) => (
            <AttemptRow key={a.id} attempt={a} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One row in the F-106 graded-writing history. */
function AttemptRow({ attempt }: { attempt: WritingAttemptDTO }): JSX.Element {
  const level = attempt.estimatedLevel !== null ? LEVEL_META[attempt.estimatedLevel] : null;
  return (
    <li className="km-writing__attempt" style={{ marginBottom: 16 }}>
      <Card variant="flat">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Pill>{attemptRubricLabel(attempt.rubric)}</Pill>
            {attempt.promptId === null ? (
              // No writing_prompts source row — this is a Claude-generated
              // topic, not a curated bank prompt (F-106's nullable prompt_id).
              <Pill tone="gold">
                <Bilingual en="Generated topic" kr="만든 주제" compact />
              </Pill>
            ) : null}
          </div>
          <time
            dateTime={attempt.gradedAt}
            style={{ fontSize: 13, color: 'var(--paper)', whiteSpace: 'nowrap' }}
          >
            {new Date(attempt.gradedAt).toLocaleDateString()}
          </time>
        </div>
        <p className="kr km-grammar__context">{attempt.promptKr}</p>
        <p className="kr km-writing__gloss">{attempt.sample}</p>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
            marginTop: 8,
          }}
        >
          <div className="km-grammar__score">
            <span className="km-grammar__score-num">{attempt.totalScore}</span>
            <span className="km-grammar__score-max"> / {attempt.maxTotal}</span>
          </div>
          {level !== null ? <Pill tone={level.tone}>{level.label}</Pill> : null}
        </div>
      </Card>
    </li>
  );
}

/** Post-grade reveal — total, estimated level, per-dimension detail, comment. */
function GradePanel({
  grade,
  gradeId,
}: {
  grade: WritingGradeResult;
  gradeId: string;
}): JSX.Element {
  const level = LEVEL_META[grade.estimatedLevel];
  return (
    <Card variant="flat" className="km-grammar__reveal" id={gradeId}>
      <div className="km-grammar__score-head">
        <div className="km-grammar__score">
          <span className="km-grammar__score-num">{grade.totalScore}</span>
          <span className="km-grammar__score-max"> / {grade.maxTotal}</span>
        </div>
        <Pill tone={level.tone}>{level.label}</Pill>
      </div>

      <GoldRule className="km-grammar__rule" />

      {/* Dimension headings render through <Bilingual> below (P3b). */}
      <DimensionBlock
        krLabel="내용 및 과제수행"
        enLabel="Content & task completion"
        dim={grade.content}
      />
      <DimensionBlock
        krLabel="전개구조"
        enLabel="Organization & development"
        dim={grade.organization}
      />
      <DimensionBlock
        krLabel="언어사용"
        enLabel="Language use"
        dim={grade.languageUse}
      />

      <Eyebrow className="km-grammar__seed-eyebrow">
        <Bilingual en="Overall" kr="총평" />
      </Eyebrow>
      <p className="km-grammar__summary">{grade.overallComment}</p>
    </Card>
  );
}

/** One rubric dimension: score fraction + evidence + improvement notes. */
function DimensionBlock({
  krLabel,
  enLabel,
  dim,
}: {
  krLabel: string;
  enLabel: string;
  dim: WritingDimensionScore;
}): JSX.Element {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 4,
        }}
      >
        <div style={{ fontSize: 15, color: 'var(--paper)' }}>
          {/* P3b: the rubric-dimension heading is a hand-composed kr/en pair —
              route it through the primitive so the setting applies. */}
          <Bilingual kr={krLabel} en={enLabel} />
        </div>
        <div style={{ fontSize: 14, color: 'var(--paper)', whiteSpace: 'nowrap' }}>
          {dim.score} / {dim.maxScore}
        </div>
      </div>
      {dim.evidence.length > 0 ? (
        <ul className="km-grammar__corrections">
          {dim.evidence.map((ev, i) => (
            <li key={`ev-${String(i)}`} className="km-grammar__correction">
              <span className="kr km-grammar__correction-span">{ev}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {dim.improvements.length > 0 ? (
        <ul className="km-grammar__corrections">
          {dim.improvements.map((note, i) => (
            <li key={`imp-${String(i)}`} className="km-grammar__correction">
              <span className="km-grammar__correction-fix">→ {note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default Writing;
