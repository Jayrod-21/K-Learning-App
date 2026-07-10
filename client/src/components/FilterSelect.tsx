/**
 * FilterSelect (F-049/F-055) — a labelled, tokenized dropdown for list
 * filters (genre/domain, difficulty, …).
 *
 * A styled NATIVE `<select>` on purpose: the platform widget brings the full
 * a11y contract for free — real label association, the OS/AT picker UI,
 * complete keyboard support (arrows, type-ahead, Home/End), and correct
 * behavior in every mobile browser — where a custom listbox has to re-earn
 * each of those and usually loses at least one. Only the closed control is
 * skinned (`appearance: none` + token colors + a CSS chevron); the open
 * popup stays native.
 *
 * The empty-string value is reserved for the "everything" filter state: the
 * placeholder (default "All") renders as a real `<option value="">`, so
 * `onChange('')` means "clear this filter". Callers therefore must not use
 * `''` as a real option value.
 *
 * No I/O — no threat model.
 */
import { useId, type JSX } from 'react';
import { cn } from '../lib/cn';
import './FilterSelect.css';

export interface FilterSelectOption {
  value: string;
  label: string;
}

export interface FilterSelectProps {
  /** Visible label rendered above the control and associated via htmlFor. */
  label: string;
  /** Selectable values. `value: ''` is reserved for the placeholder. */
  options: ReadonlyArray<FilterSelectOption>;
  /** Controlled value — `''` selects the placeholder ("All") state. */
  value: string;
  /** Fires with the chosen option's value (`''` for the placeholder). */
  onChange: (value: string) => void;
  /** Copy for the clear-filter option. */
  placeholder?: string;
  /** Optional id override (defaults to a generated unique id). */
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function FilterSelect({
  label,
  options,
  value,
  onChange,
  placeholder = 'All',
  id,
  disabled = false,
  className,
}: FilterSelectProps): JSX.Element {
  const autoId = useId();
  const selectId = id ?? autoId;

  return (
    <div className={cn('km-filterselect', className)}>
      <label htmlFor={selectId} className="km-filterselect__label">
        {label}
      </label>
      <div className="km-filterselect__control">
        <select
          id={selectId}
          className="km-filterselect__select focusring"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          <option value="">{placeholder}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="km-filterselect__chevron" aria-hidden="true" />
      </div>
    </div>
  );
}
