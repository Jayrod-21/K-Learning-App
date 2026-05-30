/**
 * SkillsCompare — bar chart of skills with a selectable TOPIK reference line.
 *
 * Two visual modes:
 *   - `compact` — Today screen tile; tighter spacing, no gap notes, no legend.
 *   - `full`    — Diagnostic results; gap notes per bar + legend at bottom.
 *
 * Scoring contract (per design README): scores are **0–100 mapped to TOPIK
 * bands** (L3=40, L4=55, L5=70, L6=85, Native=100). We never invent decimal
 * levels like "L3.4" — TOPIK levels are bands, not a continuum, so faking
 * precision is misleading. The reference picker is the only honest way to
 * express "how do I sit vs Level 4 vs Native".
 *
 * The reference picker is a segmented pill row driven by local state. When
 * the user picks a new ref, each `SkillBar` tick re-flows over 360ms (the
 * transition is on `.km-skillbar__tick` left). Tick color flips to indigo
 * when the picked ref is the Native ceiling — anchor, not goal.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { Eyebrow } from './Eyebrow';
import { SkillBar } from './SkillBar';
import { cn } from '../lib/cn';

export interface SkillRow {
  /** Stable key for React; e.g. 'reading'. */
  key: string;
  /** English label, e.g. "Reading". */
  label: string;
  /** Korean label, e.g. "읽기". */
  kr: string;
  /** Current score, 0–100. */
  score: number;
  /** Optional one-line gap explanation; shown in full mode only. */
  note?: string;
}

export interface SkillReference {
  /** Stable id used as the picker key, e.g. 'l4' or 'native'. */
  id: string;
  /** Short label for the segmented control, e.g. "TOPIK 4". */
  label: string;
  /** Korean shorthand for the legend, e.g. "4급". */
  kr?: string;
  /** Target score 0–100. */
  value: number;
  /** When true, this ref is the "Native ceiling" — tick paints indigo. */
  isCeiling?: boolean;
}

export type SkillsCompareVariant = 'compact' | 'full';

export interface SkillsCompareProps {
  skills: ReadonlyArray<SkillRow>;
  references: ReadonlyArray<SkillReference>;
  /** Initial selected ref id. Defaults to the first reference. */
  defaultRefId?: string;
  variant?: SkillsCompareVariant;
}

export function SkillsCompare({
  skills,
  references,
  defaultRefId,
  variant = 'full',
}: SkillsCompareProps): JSX.Element {
  // useState lazy initializer — first reference id, or the explicit override.
  // Resolves to '' when refs are empty; the empty-refs guard below renders an
  // empty shell so the screen never crashes on a fixture bug. The hook stays
  // at the top of the function so the call order is stable across renders.
  const [refId, setRefId] = useState<string>(
    () => defaultRefId ?? (references.length > 0 ? references[0].id : ''),
  );

  if (references.length === 0) {
    return <div className="km-skillscompare km-skillscompare--empty" />;
  }

  // Fallback to the first reference if the caller mutates `references` and
  // the previously-selected id disappears — keeps the picker visible.
  const activeRef = references.find((r) => r.id === refId) ?? references[0];
  const isCompact = variant === 'compact';

  return (
    <div className={cn('km-skillscompare', isCompact && 'km-skillscompare--compact')}>
      {/* Reference picker ────────────────────────────────────────── */}
      {/*
       * Picker is a radiogroup, not a tablist. ARIA tablist requires
       * matching `role="tabpanel"` content for each tab; this picker
       * doesn't switch panels — it switches the *target line* for the
       * existing bars, which is a "pick one of N" gesture. Radiogroup
       * with `aria-checked` is the honest role.
       */}
      <div className="km-skillscompare__pickerrow">
        <Eyebrow>Compare to</Eyebrow>
        <div
          className="km-skillscompare__picker"
          role="radiogroup"
          aria-label="Reference level"
        >
          {references.map((r) => {
            const selected = r.id === activeRef.id;
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={cn(
                  'km-skillscompare__pick focusring',
                  selected && 'km-skillscompare__pick--active',
                  selected && r.isCeiling && 'km-skillscompare__pick--ceiling',
                )}
                onClick={() => {
                  setRefId(r.id);
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bars ───────────────────────────────────────────────────── */}
      <div className="km-skillscompare__bars">
        {skills.map((s, i) => (
          <SkillBar
            key={s.key}
            label={s.label}
            kr={s.kr}
            score={s.score}
            target={activeRef.value}
            tone={activeRef.isCeiling ? 'ceiling' : 'target'}
            compact={isCompact}
            gapNote={s.note}
            // Fan bars in (~70ms apart) — same cadence as the prototype.
            delayMs={i * 70}
          />
        ))}
      </div>

      {/* Legend (full mode only) ────────────────────────────────── */}
      {!isCompact ? (
        <div className="km-skillscompare__legend">
          <span className="km-skillscompare__legenditem">
            <span
              className={cn(
                'km-skillscompare__legendtick',
                activeRef.isCeiling && 'km-skillscompare__legendtick--ceiling',
              )}
            />
            {activeRef.label}
            {activeRef.kr ? (
              <span className="kr km-skillscompare__legendkr">· {activeRef.kr}</span>
            ) : null}
          </span>
          <span className="km-skillscompare__legenditem">
            <span className="km-skillscompare__legendsq km-skillscompare__legendsq--meets" />
            At / above
          </span>
          <span className="km-skillscompare__legenditem">
            <span className="km-skillscompare__legendsq km-skillscompare__legendsq--below" />
            Below
          </span>
        </div>
      ) : null}
    </div>
  );
}
