/**
 * TaskCard — one of the three task tiles in the Today screen grid.
 *
 * Skill + Korean tag in the header (e.g. "Listening · L3 → L4" / "듣기"),
 * Korean serif title in the middle, time + arrow in the footer. An optional
 * `Pill` (tone derived from `tone` prop) flags the tile:
 *   - `gold`    → "Largest gap" (vermilion accent)
 *   - `red`     → "Register drill" (indigo — the design's grammar accent)
 *   - `default` → no accent
 *
 * Min height 180px / min width 260px so the auto-fit grid in TodayScreen
 * tracks the prototype's responsive feel without explicit breakpoints.
 *
 * Renders as a `<button>` because the entire tile is the gesture — tap any
 * surface to enter the task. Inherits `.focusring` for keyboard a11y.
 */
import type { JSX } from 'react';
import { Pill } from './Pill';
import { Icon } from './Icon';
import { cn } from '../lib/cn';

export type TaskCardTone = 'default' | 'gold' | 'red';

export interface TaskCardProps {
  /** Skill string in the eyebrow, e.g. "Reading · L4". */
  skill: string;
  /** Korean skill tag, e.g. "읽기". */
  krTag: string;
  /** Korean title of the task. */
  title: string;
  /** Estimated minutes. */
  mins: number;
  /** Visual accent for the eyebrow + optional flag pill. */
  tone?: TaskCardTone;
  /** Optional flag label (e.g. "Largest gap"); renders as a Pill in `tone`. */
  tag?: string;
  onClick?: () => void;
}

export function TaskCard({
  skill,
  krTag,
  title,
  mins,
  tone = 'default',
  tag,
  onClick,
}: TaskCardProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'km-taskcard focusring',
        tone === 'gold' && 'km-taskcard--gold',
        tone === 'red' && 'km-taskcard--red',
      )}
    >
      <div className="km-taskcard__head">
        <div className="km-taskcard__heading">
          <div className="km-taskcard__skill">{skill}</div>
          <div className="kr km-taskcard__krtag">{krTag}</div>
        </div>
        {tag ? (
          <Pill tone={tone === 'red' ? 'red' : tone === 'gold' ? 'gold' : 'default'}>
            {tag}
          </Pill>
        ) : null}
      </div>
      <div className="kr km-taskcard__title">{title}</div>
      <div className="km-taskcard__foot">
        <span className="km-taskcard__mins">
          <Icon name="timer" size={13} /> {mins} min
        </span>
        <Icon name="arrow-right" size={16} />
      </div>
    </button>
  );
}
