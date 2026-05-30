/**
 * SwatchPicker — radio-group row used four times on Settings:
 * Paper, Highlight (accent), Correct, Incorrect (wrong).
 *
 * Ported from `Claude Design/.../screens-d.jsx` SwatchPicker, with these
 * upgrades for production:
 *   - Real radio-group ARIA (`role="radiogroup"` + `role="radio"`
 *     `aria-checked`), so screen readers announce the picker correctly.
 *   - Arrow-key navigation (Left/Right, Home/End). Tab moves into the
 *     group, then arrows move focus between swatches — standard radio
 *     pattern. **Focus and selection are separate**: arrows move focus
 *     only; Space/Enter (or click) commits the selection. This prevents
 *     a keyboard sweep through the swatches from churning the
 *     `localStorage` debounce + the `applyPaletteVars` projection on
 *     every keypress (which would CSS-cascade-invalidate the entire
 *     page on each press).
 *   - `tabIndex` is roving: only the focused swatch is tabbable, the
 *     rest are `-1`. The focused swatch isn't necessarily the selected
 *     one — keeping the roving anchor on focus rather than selection
 *     mirrors the WAI-ARIA APG radio-group pattern for separated-focus
 *     groups.
 *
 * Visual: a row per category. Left has label + sub-hint, right has the
 * selected preset's Korean name. Below: equal-width swatch buttons.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { PresetMap } from '../lib/palette-presets';

export interface SwatchPickerProps {
  /** English label, e.g. "Paper". */
  label: string;
  /** Optional helper line under the label, e.g. "Background.". */
  hint?: string;
  /** Map of preset id → preset definition (from `palette-presets.ts`). */
  presets: PresetMap;
  /** Currently-selected preset id (must be a key of `presets`). */
  selectedId: string;
  /** Called with the newly-selected preset id. */
  onSelect: (id: string) => void;
  /**
   * Optional override for the small Korean label shown on the right. Falls
   * back to `presets[selectedId].kr` — pass this only to customise (e.g.
   * a non-preset-derived label).
   */
  currentKrName?: string;
  /** Drop the bottom border (use on the last row in a group). */
  last?: boolean;
}

export function SwatchPicker({
  label,
  hint,
  presets,
  selectedId,
  onSelect,
  currentKrName,
  last = false,
}: SwatchPickerProps): JSX.Element {
  const entries = Object.entries(presets);
  const ids = entries.map(([id]) => id);
  // We attach refs by id rather than by index so focus management still
  // works if the preset order is reshuffled by a future locale.
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const krLabel = currentKrName ?? presets[selectedId]?.kr ?? '';

  // Focused id is separate from selectedId per the WAI-ARIA APG
  // separated-focus radio-group pattern. Arrows move focus only; Space
  // / Enter commits the focused swatch as the new selection. The
  // initial focused id mirrors selection so Tab into the group lands
  // on the active swatch.
  const [focusedId, setFocusedId] = useState<string>(selectedId);

  // Keep focusedId synchronized when selectedId changes externally
  // (e.g. reset, or the parent resyncs from a different source). Without
  // this, the roving tabIndex anchor would drift away from the now-
  // active swatch.
  useEffect(() => {
    setFocusedId(selectedId);
  }, [selectedId]);

  const moveFocus = useCallback(
    (nextIndex: number): void => {
      // Wrap around — standard radio-group behaviour.
      const wrapped = (nextIndex + ids.length) % ids.length;
      const nextId = ids[wrapped];
      if (!nextId) return;
      setFocusedId(nextId);
      // Move the DOM focus to the new anchor so the visible focus ring
      // follows. Selection is NOT committed until Space/Enter.
      refs.current.get(nextId)?.focus();
    },
    [ids],
  );

  const commitFocused = useCallback((): void => {
    if (focusedId !== selectedId) onSelect(focusedId);
  }, [focusedId, selectedId, onSelect]);

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
          // Some browsers don't fire the default click on Space/Enter
          // for `role="radio"` <button>s without an explicit handler
          // (the role overrides native button keyboard semantics in
          // some AT pipelines). Commit selection explicitly.
          e.preventDefault();
          commitFocused();
          break;
        default:
          break;
      }
    },
    [ids.length, moveFocus, focusedIndex, commitFocused],
  );

  return (
    <div
      className={
        'km-swatchpicker' + (last ? ' km-swatchpicker--last' : '')
      }
    >
      <div className="km-swatchpicker__header">
        <div className="km-swatchpicker__labels">
          <div className="km-swatchpicker__label">{label}</div>
          {hint && <div className="km-swatchpicker__hint">{hint}</div>}
        </div>
        <span className="km-swatchpicker__kr kr">{krLabel}</span>
      </div>

      <div
        className="km-swatchpicker__row"
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {entries.map(([id, p]) => {
          const isSelected = id === selectedId;
          const isFocused = id === focusedId;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              // Roving tabIndex anchored on focusedId, not selectedId,
              // so Tab into the group lands on the same swatch the
              // user was last looking at.
              tabIndex={isFocused ? 0 : -1}
              title={p.name}
              ref={(el) => {
                if (el) refs.current.set(id, el);
                else refs.current.delete(id);
              }}
              onFocus={() => {
                // Click-to-focus also moves the roving anchor.
                if (id !== focusedId) setFocusedId(id);
              }}
              onClick={() => {
                if (!isSelected) onSelect(id);
              }}
              className={
                'km-swatchpicker__option focusring' +
                (isSelected ? ' km-swatchpicker__option--selected' : '')
              }
            >
              <span
                className="km-swatchpicker__chip"
                style={{ background: p.swatch }}
                aria-hidden="true"
              />
              <span className="km-swatchpicker__name">{p.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
