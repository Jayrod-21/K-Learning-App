/**
 * Writing screen — TOPIK writing practice graded by the real
 * `POST /grade-writing` rubric grader (F-001: the endpoint existed server-side
 * but was orphaned; this screen is its first caller).
 *
 * Flow:
 *   1. Pick a rubric (Q53 200–300자 description / Q54 600–700자 essay). The
 *      tab's curated task prompts are FETCHED from `GET /writing/prompts`
 *      (F-014 — the DB replaced the screen's old hardcoded list, so the Today
 *      tile and this screen can never advertise different tasks). Rotate
 *      within the fetched pool with "New prompt".
 *   2. Compose Korean in the textarea (soft-capped at the server's 5,000-char
 *      Zod bound; live 자 count against the rubric's target band).
 *   3. Submit → `services/writing.gradeWriting` (with the served prompt's
 *      `promptId`, so the persisted attempt links to its source row) → reveal
 *      the grade: the three official rubric dimensions (내용 및 과제수행 /
 *      전개구조 / 언어사용) with evidence + improvement notes, the total, an
 *      estimated TOPIK II level, and the overall comment.
 *   4. "Revise & regrade" returns to composing with the text preserved;
 *      "New prompt" advances the rotation and clears the sheet. When the
 *      rubric's pool holds exactly ONE prompt, "New prompt" is disabled
 *      (F-UP-017): rotating would wrap to the same task, so its only effect
 *      would be silently destroying the learner's draft.
 *
 * Failure is failure-SAFE, never a dead end (mirrors the Grammar drill): a
 * grade failure keeps the learner's text, surfaces a fixed-string inline
 * `role="alert"` ErrorCard (429 renders the structured `retryAfter` seconds
 * when present — live now that B-016 populates it — never echoed server
 * prose), and Submit stays available as the retry. A prompts-fetch failure
 * renders its own fixed-copy ErrorCard with a Retry that re-runs the fetch.
 * There is no mock fallback for either leg — a fabricated grade (or a prompt
 * id that doesn't exist server-side) would be worse than an honest error.
 *
 * Threat model:
 *   - The grade request is authenticated + user-scoped (session cookie via
 *     api.ts; `RequireAuth` gates the route) and expensive-bucket rate-limited
 *     server-side — the 429 path here is first-class, not exceptional.
 *   - All grade text (evidence fragments, improvements, overall comment) is
 *     Claude output relayed by our server — rendered ONLY through React text
 *     children, so it cannot escape into HTML. No dangerouslySetInnerHTML.
 *   - Error copy is a fixed lookup keyed on `ApiError.code`/`status`; server
 *     message strings are never echoed (mirrors the Login.messageFor contract).
 *   - The sample is soft-capped by `maxLength` (5,000 — the server's own Zod
 *     ceiling) so a runaway paste can't balloon the request; the server bound
 *     remains the source of truth.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Pill, type PillTone } from '../components/Pill';
import { Eyebrow } from '../components/Eyebrow';
import { GoldRule } from '../components/GoldRule';
import { ErrorCard } from '../components/ErrorCard';
import { ApiError } from '../services/api';
import { fetchWritingPrompts, gradeWriting } from '../services/writing';
import type { WritingPromptDTO } from '../services/writing';
import type {
  TopikWritingRubric,
  WritingDimensionScore,
  WritingEstimatedLevel,
  WritingGradeResult,
} from '../types/domain';

/**
 * Server-side Zod ceiling on `sample` (gradeWriting.ts: 1..5000). The textarea
 * soft-caps at the same bound so the client can never author a 400.
 */
const SAMPLE_MAX_CHARS = 5_000;

/** Per-rubric presentation meta. Target bands are the official TOPIK specs. */
const RUBRIC_META: Record<
  TopikWritingRubric,
  { label: string; eyebrow: string; target: string }
> = {
  topik_ii_53: {
    label: 'Q53 · 200–300자',
    eyebrow: 'Describe and explain',
    target: '200–300자',
  },
  topik_ii_54: {
    label: 'Q54 · 600–700자',
    eyebrow: 'Argue a position',
    target: '600–700자',
  },
};

/** Rubric tab order — Q53 first (the shorter, friendlier on-ramp). */
const RUBRICS: readonly TopikWritingRubric[] = ['topik_ii_53', 'topik_ii_54'];

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
 * Fixed-string error copy for the prompts fetch (same contract as
 * `messageFor` — never echoed server prose). Loading tasks is a cheap GET,
 * so the vocabulary is "retry", not "wait".
 */
function promptsMessageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') {
      return 'Network unreachable. Reconnect and retry to load the writing tasks.';
    }
    if (err.status === 401) {
      return 'Your session has expired. Sign in again to load the writing tasks.';
    }
  }
  return "The writing tasks couldn't be loaded. Try again in a moment.";
}

function Writing(): JSX.Element {
  const [rubric, setRubric] = useState<TopikWritingRubric>('topik_ii_53');
  // Per-rubric prompt rotation cursor, so switching tabs doesn't lose the
  // learner's place in either task list. Pure UI state — nothing persisted.
  const [taskIdx, setTaskIdx] = useState<Record<TopikWritingRubric, number>>({
    topik_ii_53: 0,
    topik_ii_54: 0,
  });
  const [sample, setSample] = useState('');
  const [phase, setPhase] = useState<WritingPhase>('composing');
  const [grade, setGrade] = useState<WritingGradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Prompts for the CURRENT rubric tab, fetched from `GET /writing/prompts`
  // (F-014). `null` while loading / after a failure; the fetch effect below
  // re-keys on the rubric, and `promptsTick` is the Retry trigger (the same
  // monotonic-reload idiom the TTMIK tabs use).
  const [prompts, setPrompts] = useState<WritingPromptDTO[] | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(true);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [promptsTick, setPromptsTick] = useState(0);

  const textareaId = useId();
  const gradeId = useId();

  useEffect(() => {
    // Stale-fetch safety needs no ref: the cleanup below aborts this
    // controller before every re-run and on unmount (React guarantee).
    const ctrl = new AbortController();
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference/TTMIK tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setPromptsLoading(true);
    setPromptsError(null);
    setPrompts(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchWritingPrompts(rubric, ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setPrompts(rows);
        setPromptsLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setPromptsError(promptsMessageFor(err));
        setPromptsLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [rubric, promptsTick]);

  /** Retry for a failed prompts fetch — re-runs the effect without a reload. */
  const retryPrompts = useCallback((): void => {
    setPromptsTick((t) => t + 1);
  }, []);

  // The task on screen: the rotation cursor over the fetched pool. `null`
  // while loading, after a fetch failure, or when the rubric's pool is empty
  // — every consumer below guards on it (no grade without a served prompt).
  const task =
    prompts !== null && prompts.length > 0
      ? // Non-null: `idx % length` is a valid index of a non-empty array
        // (same invariant as Grammar's `pool[idx % pool.length]!`).
        prompts[taskIdx[rubric] % prompts.length]!
      : null;

  // In-flight grade controller: a re-submit or unmount aborts the stale call
  // so its settle can't clobber newer state.
  const ctrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      ctrlRef.current?.abort();
    };
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = sample.trim();
    if (trimmed.length === 0 || task === null) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setPhase('grading');
    setError(null);
    setGrade(null);
    try {
      const res = await gradeWriting(
        // `promptId` links the persisted attempt to its `writing_prompts`
        // source row (F-014); `promptKr` is the question the grader needs.
        { prompt: task.promptKr, sample: trimmed, rubric, promptId: task.id },
        ctrl.signal,
      );
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
  }, [sample, task, rubric]);

  /** Back to composing with the text intact, for a revise-and-regrade pass. */
  const revise = useCallback((): void => {
    setGrade(null);
    setError(null);
    setPhase('composing');
  }, []);

  /** Advance the current rubric's prompt rotation and clear the sheet. */
  const nextPrompt = useCallback((): void => {
    ctrlRef.current?.abort();
    setTaskIdx((prev) => ({ ...prev, [rubric]: prev[rubric] + 1 }));
    setSample('');
    setGrade(null);
    setError(null);
    setPhase('composing');
  }, [rubric]);

  /** Switch rubric tabs. An in-flight grade for the old task is aborted. */
  const switchRubric = useCallback(
    (next: TopikWritingRubric): void => {
      if (next === rubric) return;
      ctrlRef.current?.abort();
      setRubric(next);
      setGrade(null);
      setError(null);
      setPhase('composing');
    },
    [rubric],
  );

  const grading = phase === 'grading';
  const graded = phase === 'graded' && grade !== null;
  const canSubmit = !grading && sample.trim().length > 0 && task !== null;
  // F-UP-017: with exactly one prompt in the rubric's pool, "rotate" wraps to
  // the SAME prompt — the button's only effect would be silently clearing the
  // learner's draft. Disable it instead of lying; the pool size is server
  // truth, so this re-enables by itself the moment a second prompt exists.
  const canRotatePrompt = prompts !== null && prompts.length > 1;

  return (
    <section
      className="screen km-writing"
      aria-labelledby="writing-title"
      style={{ position: 'relative' }}
    >
      <Topbar
        krTitle={<span id="writing-title">쓰기 · Writing</span>}
        eyebrow="TOPIK writing grader"
      />

      {/* Rubric tabs ─────────────────────────────────────────── */}
      <div className="km-review__tabs" role="group" aria-label="Writing task type">
        {RUBRICS.map((r) => {
          const selected = rubric === r;
          return (
            <button
              key={r}
              type="button"
              aria-pressed={selected}
              className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
              onClick={() => {
                switchRubric(r);
              }}
            >
              {RUBRIC_META[r].label}
            </button>
          );
        })}
      </div>

      {/* Task prompt ─────────────────────────────────────────── */}
      <Card variant="default" style={{ marginBottom: 16 }}>
        <Eyebrow>{RUBRIC_META[rubric].eyebrow}</Eyebrow>
        {promptsLoading ? (
          <div className="km-grammar__state" role="status">
            Loading writing tasks…
          </div>
        ) : promptsError !== null ? (
          <ErrorCard message={promptsError} onRetry={retryPrompts} />
        ) : task === null ? (
          // Fetched fine, but the rubric's active pool is empty — an honest
          // empty state, not a spinner that never resolves.
          <p className="km-reference__empty">
            No writing tasks are available for this section yet.
          </p>
        ) : (
          <>
            <p className="kr km-grammar__context">{task.promptKr}</p>
            {task.promptEn !== null ? (
              // Optional English gloss of the task — muted, secondary to the
              // Korean. Server text rendered as React children only (escaped).
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--paper-mute)',
                  marginTop: -6,
                  marginBottom: 12,
                }}
              >
                {task.promptEn}
              </p>
            ) : null}

            <label
              htmlFor={textareaId}
              className="km-grammar__instruction"
              style={{ display: 'block' }}
            >
              Your writing in Korean · target {RUBRIC_META[rubric].target}
            </label>
            <textarea
              id={textareaId}
              className="kr km-grammar__textarea focusring"
              value={sample}
              onChange={(e) => {
                setSample(e.target.value);
              }}
              placeholder="여기에 한국어로 쓰십시오…"
              rows={rubric === 'topik_ii_54' ? 10 : 6}
              disabled={grading || graded}
              aria-describedby={graded ? gradeId : undefined}
              // Soft cap at the server's own Zod ceiling (1..5000) — defensive;
              // keeps a runaway paste from authoring a guaranteed 400.
              maxLength={SAMPLE_MAX_CHARS}
            />
            <div
              style={{
                fontSize: 12,
                color: 'var(--paper-mute)',
                marginTop: -8,
                marginBottom: 12,
              }}
            >
              {sample.length}자
            </div>

            {grading ? (
              <div className="km-grammar__state" role="status">
                Grading your writing… this can take up to a minute.
              </div>
            ) : null}

            {error ? <ErrorCard message={error} /> : null}

            <div className="km-grammar__footer">
              {!graded ? (
                <>
                  <Button
                    variant="ghost"
                    onClick={nextPrompt}
                    disabled={grading || !canRotatePrompt}
                    title={
                      canRotatePrompt
                        ? undefined
                        : 'Only one task is available for this section right now.'
                    }
                  >
                    New prompt
                  </Button>
                  <Button variant="gold" onClick={() => void submit()} disabled={!canSubmit}>
                    {grading ? 'Grading…' : 'Grade my writing'}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={revise}>
                    Revise &amp; regrade
                  </Button>
                  <Button
                    variant="gold"
                    onClick={nextPrompt}
                    disabled={!canRotatePrompt}
                    title={
                      canRotatePrompt
                        ? undefined
                        : 'Only one task is available for this section right now.'
                    }
                  >
                    New prompt
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </Card>

      {/* Grade reveal ────────────────────────────────────────── */}
      {graded ? <GradePanel grade={grade} gradeId={gradeId} /> : null}
    </section>
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

      <Eyebrow className="km-grammar__seed-eyebrow">Overall</Eyebrow>
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
        <div>
          <span className="kr" style={{ fontSize: 15, color: 'var(--paper)' }}>
            {krLabel}
          </span>{' '}
          <span style={{ fontSize: 12, color: 'var(--paper-mute)' }}>
            {enLabel}
          </span>
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
