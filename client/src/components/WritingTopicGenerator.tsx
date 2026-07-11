/**
 * WritingTopicGenerator (F-027) — "generate a new writing topic" panel.
 *
 * Wraps `POST /writing/generate` (services/writing.generateWritingPrompt):
 * the learner picks a style — TOPIK-style (a Q53/Q54-shaped task; the server
 * defaults the rubric to Q54, mirroring /grade-writing) or a general
 * free-write — and Claude authors ONE fresh topic. The server persists
 * nothing; the topic is ephemeral inspiration until a graded attempt lands.
 *
 * Built as a shared component on purpose: F-027 surfaces it on the Today
 * writing tile and F-073 re-surfaces the same engine on the Learn → Writing
 * screen ("build once, surface twice" per the ticket notes).
 *
 * Interaction model:
 *   - Style choice is a WAI-ARIA radiogroup (roving tabindex, arrow keys
 *     wrap) — the same segmented-control pattern as Topik's ModeToggle.
 *   - Generate button: `aria-disabled` + "Generating…" while the call is in
 *     flight (`aria-busy` on the panel). NOT the `disabled` attribute — that
 *     would silently drop keyboard focus to <body> mid-generation and leave
 *     a keyboard user stranded at the top of the page when the call settles
 *     (WCAG 2.4.3). Re-entry is blocked by a busy guard in the click handler
 *     instead. A fresh generation replaces the previous topic; the button
 *     relabels to "New topic" once one exists.
 *   - The result renders in an `aria-live="polite"` region so screen
 *     readers hear the new topic without a focus jump.
 *
 * Failure is failure-safe, never a dead end:
 *   - The route sits in the server's EXPENSIVE rate-limit bucket, so 429 is
 *     a first-class path: `errorMessageFor` renders the structured
 *     `retryAfter` seconds ("try again in about N seconds") and the
 *     Generate button STAYS enabled as the retry.
 *   - Every other failure gets fixed fallback copy. Server prose is never
 *     echoed (errorCopy contract).
 *   - An in-flight call is aborted on unmount (and superseded on
 *     regenerate) via AbortController; an aborted call sets no state.
 *
 * Threat model:
 *   - Claude output (promptKr/promptEn/lengthHint) renders ONLY as React
 *     text children — escaped, never markup. No dangerouslySetInnerHTML.
 *   - The request body is a closed enum pair (`GenerateWritingPromptBody`);
 *     no user free-text enters the route from this component.
 *   - Error copy is a fixed lookup keyed on structured `ApiError` fields.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { Bilingual } from './Bilingual';
import { Button } from './Button';
import { Icon } from './Icon';
import { Pill } from './Pill';
import { cn } from '../lib/cn';
import { errorMessageFor } from '../lib/errorCopy';
import { generateWritingPrompt } from '../services/writing';
import type {
  GeneratedWritingPrompt,
  WritingGenerateMode,
} from '../services/writing';
import './WritingTopicGenerator.css';

/** The two styles the learner picks between, in display order. */
const MODES: ReadonlyArray<{
  id: WritingGenerateMode;
  en: string;
  kr: string;
}> = [
  { id: 'topik', en: 'TOPIK-style', kr: '토픽형' },
  { id: 'general', en: 'Free write', kr: '자유 주제' },
];

/** Fixed fallback copy for a failed generation (errorCopy contract). */
const GENERATE_FAILED_COPY = 'Could not generate a topic. Try again.';

/** Panel lifecycle — one state at a time, no boolean soup. */
type GenState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; prompt: GeneratedWritingPrompt }
  | { phase: 'error'; message: string };

export interface WritingTopicGeneratorProps {
  /**
   * F-073 (Writing screen): when provided, the generated result grows a
   * "Write this topic" action that hands the topic to the caller — the
   * Writing page makes it the active, gradable task. The Today tile (F-027)
   * omits it and renders byte-identically to the pre-prop component: the
   * topic stays display-only inspiration there.
   */
  onUseTopic?: (topic: GeneratedWritingPrompt) => void;
}

export function WritingTopicGenerator({
  onUseTopic,
}: WritingTopicGeneratorProps = {}): JSX.Element {
  const [mode, setMode] = useState<WritingGenerateMode>('topik');
  const [state, setState] = useState<GenState>({ phase: 'idle' });
  const modeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const groupId = useId();

  // Abort any in-flight generation on unmount so a late resolve can't set
  // state on a dead component (the catch below drops aborted rejections).
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const generate = async (): Promise<void> => {
    // Supersede: a regenerate while one is in flight cancels the old call —
    // exactly one outcome ever lands.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ phase: 'busy' });
    try {
      // Rubric deliberately omitted — the server defaults topik mode to Q54
      // (the same default /grade-writing uses); general mode takes none.
      const prompt = await generateWritingPrompt({ mode }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setState({ phase: 'done', prompt });
    } catch (err) {
      // Aborted (unmount/supersede) → this outcome no longer matters.
      if (ctrl.signal.aborted) return;
      setState({
        phase: 'error',
        message: errorMessageFor(err, GENERATE_FAILED_COPY),
      });
    }
  };

  // Roving-tabindex arrows on the style radios (WAI-ARIA radiogroup — the
  // arrow keys wrap; with two options either arrow flips the selection).
  const onModeKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const current = MODES.findIndex((m) => m.id === mode);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (current + 1) % MODES.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (current - 1 + MODES.length) % MODES.length;
    }
    if (next === null) return;
    e.preventDefault();
    setMode(MODES[next].id);
    modeRefs.current[next]?.focus();
  };

  const busy = state.phase === 'busy';

  return (
    <div className="km-topicgen" aria-busy={busy || undefined}>
      <div className="km-topicgen__head" id={`${groupId}-label`}>
        <Icon name="spark" size={14} />
        <Bilingual en="New topic from Claude" kr="새 주제 만들기" />
      </div>

      <div className="km-topicgen__controls">
        <div
          className="km-topicgen__modes"
          role="radiogroup"
          aria-labelledby={`${groupId}-label`}
        >
          {MODES.map((m, i) => {
            const selected = m.id === mode;
            return (
              <button
                key={m.id}
                ref={(el) => {
                  modeRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className={cn(
                  'km-topicgen__mode focusring',
                  selected && 'km-topicgen__mode--active',
                )}
                onClick={() => {
                  setMode(m.id);
                }}
                onKeyDown={onModeKeyDown}
              >
                <Bilingual en={m.en} kr={m.kr} compact />
              </button>
            );
          })}
        </div>

        <Button
          variant="gold"
          size="sm"
          // aria-disabled, NOT disabled: the hard attribute would move
          // keyboard focus to <body> the instant the call starts. The busy
          // guard below is the real re-entry gate.
          aria-disabled={busy || undefined}
          leadingIcon={<Icon name="pen" size={14} />}
          onClick={() => {
            if (busy) return; // aria-disabled doesn't block clicks — we do.
            void generate();
          }}
        >
          {busy ? (
            <Bilingual en="Generating…" kr="생성 중…" compact />
          ) : state.phase === 'done' ? (
            <Bilingual en="New topic" kr="새 주제" compact />
          ) : (
            <Bilingual en="Generate topic" kr="주제 생성" compact />
          )}
        </Button>
      </div>

      {/* Announce the fresh topic politely; errors interrupt via role=alert.
          The live region stays mounted so the announcement fires reliably. */}
      <div aria-live="polite">
        {state.phase === 'done' ? (
          <div className="km-topicgen__result">
            <div className="kr km-topicgen__kr">{state.prompt.promptKr}</div>
            <div className="km-topicgen__en">{state.prompt.promptEn}</div>
            <div className="km-topicgen__tags">
              <Pill tone="gold">
                {state.prompt.mode === 'topik' ? (
                  <Bilingual en="TOPIK-style" kr="토픽형" compact />
                ) : (
                  <Bilingual en="Free write" kr="자유 주제" compact />
                )}
              </Pill>
              {state.prompt.lengthHint !== null ? (
                <Pill>{state.prompt.lengthHint}</Pill>
              ) : null}
              {onUseTopic !== undefined ? (
                // F-073: hand the topic to the host page (it becomes the
                // active gradable task there). Rendered inside the polite
                // live region alongside the topic it acts on.
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onUseTopic(state.prompt);
                  }}
                >
                  <Bilingual en="Write this topic" kr="이 주제로 쓰기" compact />
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {state.phase === 'error' ? (
        <div role="alert" className="km-topicgen__error">
          {state.message}
        </div>
      ) : null}
    </div>
  );
}

export default WritingTopicGenerator;
