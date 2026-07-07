/**
 * Shared browse controls for the Review-library pages — extracted from
 * pages/Reference.tsx in Overhaul P1.2 when its tabs became the sibling
 * routes `/review/vocab`, `/review/dictionary`, `/review/grammar`.
 *
 *   - `SearchBox`   — search input with a clear affordance. Pairs with
 *                     `useDebouncedSearch` (hooks/) for the rate defence;
 *                     this component is presentation-only.
 *   - `Pager`       — minimal Prev / Next over a known server `total`.
 *   - `FilterGroup` — one row of mutually-exclusive filter chips (same
 *                     visual + a11y shape the Grammar screen's level filter
 *                     established: `role="group"` + `aria-pressed`).
 *
 * All user-controlled text renders through React text children / value
 * props — no innerHTML anywhere; sanitisation is the server's job.
 */
import type { JSX } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { Icon } from './Icon';
import type { FilterOption } from '../lib/libraryFilters';

export interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  placeholder: string;
  ariaLabel: string;
}

export function SearchBox({
  value,
  onChange,
  onClear,
  placeholder,
  ariaLabel,
}: SearchBoxProps): JSX.Element {
  return (
    <Card className="km-reference__search">
      <Icon name="search" size={18} />
      <input
        type="search"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        className="kr focusring km-reference__input"
        aria-label={ariaLabel}
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          className="km-btn km-btn--ghost km-btn--sm focusring"
          aria-label="Clear search"
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </Card>
  );
}

export interface PagerProps {
  offset: number;
  pageSize: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

/** A minimal pager — Prev / Next over a known `total`. */
export function Pager({
  offset,
  pageSize,
  total,
  onPrev,
  onNext,
}: PagerProps): JSX.Element {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);
  const hasPrev = offset > 0;
  const hasNext = offset + pageSize < total;
  return (
    <div className="km-resources__pager">
      <Button variant="ghost" size="sm" onClick={onPrev} disabled={!hasPrev}>
        Prev
      </Button>
      <span className="km-resources__pager-count">
        {String(from)}–{String(to)} of {String(total)}
      </span>
      <Button variant="ghost" size="sm" onClick={onNext} disabled={!hasNext}>
        Next
      </Button>
    </div>
  );
}

export interface FilterGroupProps<T extends string> {
  ariaLabel: string;
  options: ReadonlyArray<FilterOption<T>>;
  value: T;
  onChange: (next: T) => void;
}

/** One row of mutually-exclusive filter chips. */
export function FilterGroup<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: FilterGroupProps<T>): JSX.Element {
  return (
    <div className="km-review__tabs" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={selected}
            className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
            onClick={() => {
              onChange(opt.id);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
