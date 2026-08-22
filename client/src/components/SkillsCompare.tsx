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
 *
 * F-011: rows may carry `scoreLow`/`scoreHigh` confidence-band edges — each
 * bar renders them as a subtle translucent range, and the full-mode legend
 * gains a "Confidence band" entry only when at least one bar draws one.
 *
 * Mobile hardening: the picker holds up to 7 pills (TOPIK 1–6 + Native). The
 * pills' VISIBLE text is the short code ("T1"…"T6", "Native" spelled out —
 * see `shortRefLabel` below), so all 7 fit on a 360px phone row without
 * sliding. The FULL descriptive label ("TOPIK 4", plus the Korean shorthand
 * when present, e.g. "4급 · TOPIK 4") never disappears — it moves to the
 * pick button's `aria-label`/`title` instead of the visible text, so
 * screen-reader users and sighted hover-tooltip users both still get the
 * unabbreviated name. `SkillsCompare.css` still gives the picker its own
 * `overflow-x: auto` scroll rail (see that file's header) as a fallback —
 * short labels make it dormant at normal sizes, but it keeps the full
 * 1 → Native range reachable by scroll if a larger text-size setting, a
 * future 8th level, or a narrower-than-360px device ever reintroduces
 * overflow.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { Bilingual } from './Bilingual';
import { Eyebrow } from './Eyebrow';
import { SkillBar } from './SkillBar';
import { cn } from '../lib/cn';
import { hasVisibleBand } from '../lib/skillBand';
import './SkillsCompare.css';

export interface SkillRow {
  /** Stable key for React; e.g. 'reading'. */
  key: string;
  /** English label, e.g. "Reading". */
  label: string;
  /** Korean label, e.g. "읽기". */
  kr: string;
  /** Current score, 0–100. */
  score: number;
  /**
   * F-011 confidence band edges, 0–100. When `scoreLow < scoreHigh` the bar
   * renders a subtle translucent range; omitted or equal edges render no
   * band (honest "confidence unknown" degrade).
   */
  scoreLow?: number;
  /** Upper edge of the confidence band, 0–100. See `scoreLow`. */
  scoreHigh?: number;
  /** Optional one-line gap explanation; shown in full mode only. */
  note?: string;
  /**
   * Diagnostic-polish FIX 3: true when every item served for this skill was
   * skipped — there is no real score to bar-chart. The row renders as
   * "Not assessed" instead of a `SkillBar`; `score`/band fields are ignored.
   */
  skipped?: boolean;
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

/**
 * Mobile hardening: abbreviate a reference's full label to the short pick-pill
 * code — "TOPIK 4" → "T4". `Native` carries no numeral to shorten and stays
 * spelled out per product spec (the regex simply doesn't match it, so it
 * falls through unchanged — no special-case needed). Pure string transform,
 * no I/O, so no threat model.
 */
function shortRefLabel(label: string): string {
  const match = /^TOPIK\s+(\d+)$/i.exec(label.trim());
  return match ? `T${match[1]}` : label;
}

/**
 * Full descriptive name for a reference — used as the pick button's
 * accessible name (`aria-label`) and hover `title` so the abbreviated visible
 * text never costs screen-reader or sighted-tooltip users the real label.
 * Mirrors the "kr · en" shape the component already used for its computed
 * accessible name before this pass, so existing consumers/tests that assert
 * on that exact string see no behavior change.
 */
function fullRefName(r: SkillReference): string {
  return r.kr ? `${r.kr} · ${r.label}` : r.label;
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
  // F-011: the legend explains the confidence band only when at least one
  // bar actually draws one (same visibility rule as SkillBar itself).
  const hasAnyBand = skills.some((s) => hasVisibleBand(s.scoreLow, s.scoreHigh));

  return (
    <div className={cn('km-skillscompare', isCompact && 'km-skillscompare--compact')}>
      {/* Reference picker ────────────────────────────────────────── */}
      {/*
       * Picker is a radiogroup, not a tablist. ARIA tablist requires
       * matching `role="tabpanel"` content for each tab; this picker
       * doesn't switch panels — it switches the *target line* for the
       * existing bars, which is a "pick one of N" gesture. Radiogroup
       * with `aria-checked` is the honest role.
       *
       * Mobile hardening (short pills): the VISIBLE text on each pick is the
       * abbreviated `shortRefLabel(r.label)` ("T4", "Native") so all 7 pills
       * fit a 360px phone row without sliding — see the file-header doc
       * comment. This intentionally steps outside the usual `<Bilingual/>`
       * chrome convention: "T4" is a compact universal level code (same idea
       * as the `id` values like 'L4' already are), not a translation choice,
       * so it doesn't flex with the user's language-display setting. Nothing
       * is lost — `aria-label`/`title` below carry the full "kr · en"
       * descriptive name (same shape the computed accessible name used
       * before this pass) for screen readers and hover tooltips alike.
       */}
      <div className="km-skillscompare__pickerrow">
        <Eyebrow>
          <Bilingual en="Compare to" kr="비교 기준" />
        </Eyebrow>
        <div
          className="km-skillscompare__picker"
          role="radiogroup"
          aria-label="Reference level"
        >
          {references.map((r) => {
            const selected = r.id === activeRef.id;
            const fullName = fullRefName(r);
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={fullName}
                title={fullName}
                className={cn(
                  'km-skillscompare__pick focusring',
                  selected && 'km-skillscompare__pick--active',
                  selected && r.isCeiling && 'km-skillscompare__pick--ceiling',
                )}
                onClick={() => {
                  setRefId(r.id);
                }}
              >
                {/* `aria-hidden` — the button's `aria-label` above is already
                    the full accessible name; this visible short code is a
                    presentation-only stand-in, not additional information for
                    assistive tech to announce.
                    FIX-PASS lock (REVIEW_mobile2-logic.md S1): deliberately
                    stays a hardcoded "Tn"/"Native" universal-level code in
                    EVERY language-display mode — NOT routed through
                    <Bilingual/>, even for mode:'ko'. The full localized name
                    ("kr · en") is preserved via aria-label/title above; see
                    `SkillsCompare.test.tsx`'s Korean-mode test for the pin. */}
                <span aria-hidden="true">{shortRefLabel(r.label)}</span>
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
            scoreLow={s.scoreLow}
            scoreHigh={s.scoreHigh}
            target={activeRef.value}
            tone={activeRef.isCeiling ? 'ceiling' : 'target'}
            compact={isCompact}
            gapNote={s.note}
            // FIX 3: a fully-skipped dimension renders "Not assessed" —
            // SkillBar owns that layout so this stays a single pass-through.
            skipped={s.skipped}
            // Fan bars in (~70ms apart) — same cadence as the prototype.
            delayMs={i * 70}
          />
        ))}
      </div>

      {/* Legend (full mode only) ────────────────────────────────── */}
      {!isCompact ? (
        <div className="km-skillscompare__legend">
          {/* P3b: legend entries render `<Bilingual/>` — no hand-composed
              "label · kr" strings. `activeRef.kr` may be absent; the
              primitive's fallback renders the label alone. */}
          <span className="km-skillscompare__legenditem">
            <span
              className={cn(
                'km-skillscompare__legendtick',
                activeRef.isCeiling && 'km-skillscompare__legendtick--ceiling',
              )}
            />
            <Bilingual en={activeRef.label} kr={activeRef.kr} />
          </span>
          <span className="km-skillscompare__legenditem">
            <span className="km-skillscompare__legendsq km-skillscompare__legendsq--meets" />
            <Bilingual en="At / above" kr="달성" />
          </span>
          <span className="km-skillscompare__legenditem">
            <span className="km-skillscompare__legendsq km-skillscompare__legendsq--below" />
            <Bilingual en="Below" kr="미달" />
          </span>
          {hasAnyBand ? (
            <span className="km-skillscompare__legenditem">
              <span className="km-skillscompare__legendsq km-skillscompare__legendsq--band" />
              <Bilingual en="Confidence band" kr="신뢰 구간" />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
