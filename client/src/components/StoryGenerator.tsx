/**
 * StoryGenerator — the F-068 "New story from Claude" panel, shared by the
 * Reading AI-stories tab and the Listen landing's story creator (Listen-tab
 * story generator work). Extracted verbatim from `pages/Reading.tsx`; the
 * `km-reading__gen*` class vocabulary moved with it into the co-located
 * `StoryGenerator.css` (imported here, so every consumer gets the styles).
 *
 * Self-contained: level radiogroup (roving tabindex, arrow keys wrap),
 * optional topic, POST /reading/generate, and a single `onCreated` callback
 * with the fresh story — what happens next (navigate to the reader, or show
 * an inline card) is entirely the parent's concern.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Bilingual } from './Bilingual';
import { Button } from './Button';
import { CityCard } from './CityCard';
import { Icon } from './Icon';
import { errorMessageFor } from '../lib/errorCopy';
import { GENERATED_STORY_LEVELS, generateStory } from '../services/reading';
import type {
  GeneratedStory,
  GeneratedStoryLevel,
} from '../services/reading';
import './StoryGenerator.css';

/** Generator panel lifecycle — one state at a time, no boolean soup.
 *  No 'done' phase: a successful generation opens the new story. */
type GenState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'error'; message: string };

/** Fixed fallback copy for a failed generation (errorCopy contract). */
const GENERATE_FAILED_COPY = 'Could not generate a story. Try again.';

/**
 * "New story from Claude" panel — level radiogroup (roving tabindex, arrow
 * keys wrap: the WritingTopicGenerator/ModeToggle segmented pattern),
 * optional topic, and a Generate button that goes `aria-disabled` (NOT
 * `disabled` — the hard attribute would drop keyboard focus to <body>
 * mid-generation, WCAG 2.4.3) while POST /reading/generate is in flight.
 * 429 is a first-class path (expensive route): `errorMessageFor` renders
 * the structured `retryAfter` and the button stays enabled as the retry.
 */
export function StoryGenerator({
  onCreated,
}: {
  onCreated: (story: GeneratedStory) => void;
}): JSX.Element {
  const [level, setLevel] = useState<GeneratedStoryLevel>('L3');
  const [topic, setTopic] = useState('');
  const [state, setState] = useState<GenState>({ phase: 'idle' });
  const levelRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const uid = useId();

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
      const trimmed = topic.trim();
      const story = await generateStory(
        { level, ...(trimmed !== '' ? { topic: trimmed } : {}) },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      // Hand the fresh story to the parent (Reading navigates into the
      // reader, unmounting this panel; Listen shows an inline card). Reset
      // the phase so a panel that STAYS mounted is ready for the next run.
      setState({ phase: 'idle' });
      onCreated(story);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setState({
        phase: 'error',
        message: errorMessageFor(err, GENERATE_FAILED_COPY),
      });
    }
  };

  // Roving-tabindex arrows on the level radios (WAI-ARIA radiogroup).
  const onLevelKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = GENERATED_STORY_LEVELS.indexOf(level);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (current + 1) % GENERATED_STORY_LEVELS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next =
        (current - 1 + GENERATED_STORY_LEVELS.length) %
        GENERATED_STORY_LEVELS.length;
    }
    if (next === null) return;
    e.preventDefault();
    const target = GENERATED_STORY_LEVELS[next];
    if (target === undefined) return;
    setLevel(target);
    levelRefs.current[next]?.focus();
  };

  const busy = state.phase === 'busy';

  return (
    // The hosting page's hero CTA (F-068 Claude generation) — a `mint`-tone,
    // `feat` CityCard signboard/hanji-paper card (devices #1/#2), mirroring
    // the design mock's dedicated "Generate a short story" sign.
    <CityCard
      tone="mint"
      rail
      feat
      className="km-reading__gen"
      aria-busy={busy || undefined}
    >
      <div className="km-reading__gen-head" id={`${uid}-label`}>
        {/* Device #9 — mother-of-pearl shimmer on the hero CTA's spark
            glyph. Sparing by design: this is the hosting page's ONLY najeon
            use. */}
        <span className="km-reading__gen-spark km-najeon km-najeon--shimmer">
          <Icon name="spark" size={14} />
        </span>
        <Bilingual en="New story from Claude" kr="새 이야기 만들기" />
      </div>

      <div
        className="km-reading__gen-levels"
        role="radiogroup"
        aria-labelledby={`${uid}-label`}
      >
        {GENERATED_STORY_LEVELS.map((l, i) => {
          const selected = l === level;
          return (
            <button
              key={l}
              ref={(el) => {
                levelRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className={
                selected
                  ? 'km-reading__gen-level km-reading__gen-level--active focusring'
                  : 'km-reading__gen-level focusring'
              }
              onClick={() => {
                setLevel(l);
              }}
              onKeyDown={onLevelKeyDown}
            >
              {l}
            </button>
          );
        })}
      </div>

      <div className="km-reading__gen-topic">
        <label htmlFor={`${uid}-topic`}>
          <Bilingual en="Topic (optional)" kr="주제 (선택)" compact />
        </label>
        <input
          id={`${uid}-topic`}
          type="text"
          value={topic}
          maxLength={500}
          placeholder="e.g. 바닷가 마을"
          onChange={(e) => {
            setTopic(e.target.value);
          }}
        />
      </div>

      <div>
        <Button
          variant="gold"
          size="sm"
          // aria-disabled, NOT disabled: the hard attribute would move
          // keyboard focus to <body> the instant the call starts. The busy
          // guard below is the real re-entry gate.
          aria-disabled={busy || undefined}
          leadingIcon={<Icon name="spark" size={14} />}
          onClick={() => {
            if (busy) return; // aria-disabled doesn't block clicks — we do.
            void generate();
          }}
        >
          {busy ? (
            <Bilingual en="Generating…" kr="생성 중…" compact />
          ) : (
            <Bilingual en="Generate story" kr="이야기 생성" compact />
          )}
        </Button>
      </div>

      {state.phase === 'error' ? (
        <div role="alert" className="km-reading__gen-error">
          {state.message}
        </div>
      ) : null}
    </CityCard>
  );
}
