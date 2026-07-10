/**
 * FilterSelect — verifies the native-select filter primitive (F-049/F-055):
 *   - the label is programmatically associated (getByLabelText resolves),
 *   - the placeholder renders as a real value:'' option (default "All"),
 *   - all options render and selection fires onChange with the raw value,
 *   - choosing the placeholder fires onChange('') — the clear-filter path,
 *   - disabled disables the control.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterSelect } from './FilterSelect';

const GENRES = [
  { value: 'news', label: 'News' },
  { value: 'literature', label: 'Literature' },
  { value: 'daily-life', label: 'Daily life' },
];

describe('FilterSelect', () => {
  it('associates the visible label with the select', () => {
    render(
      <FilterSelect
        label="Genre"
        options={GENRES}
        value=""
        onChange={() => undefined}
      />,
    );
    const select = screen.getByLabelText('Genre');
    expect(select.tagName).toBe('SELECT');
  });

  it('renders the placeholder (default "All") plus every option', () => {
    render(
      <FilterSelect
        label="Genre"
        options={GENRES}
        value=""
        onChange={() => undefined}
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'All',
      'News',
      'Literature',
      'Daily life',
    ]);
    expect(screen.getByRole('option', { name: 'All' })).toHaveValue('');
    // The placeholder is the selected state for value=''.
    expect(screen.getByLabelText('Genre')).toHaveValue('');
  });

  it('honours a custom placeholder', () => {
    render(
      <FilterSelect
        label="Difficulty"
        options={GENRES}
        value=""
        onChange={() => undefined}
        placeholder="Any level"
      />,
    );
    expect(screen.getByRole('option', { name: 'Any level' })).toHaveValue('');
  });

  it('fires onChange with the chosen value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterSelect
        label="Genre"
        options={GENRES}
        value=""
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Genre'), 'literature');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('literature');
  });

  it("fires onChange('') when the placeholder is re-chosen (clear filter)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterSelect
        label="Genre"
        options={GENRES}
        value="news"
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Genre'), '');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('disabled disables the control', () => {
    render(
      <FilterSelect
        label="Genre"
        options={GENRES}
        value=""
        onChange={() => undefined}
        disabled
      />,
    );
    expect(screen.getByLabelText('Genre')).toBeDisabled();
  });
});
