/**
 * SwatchPicker — interaction tests.
 *
 * Covers the WAI-ARIA APG separated-focus radio-group contract:
 *   - basic render: radiogroup, swatch buttons, KR label on the right
 *   - click selects, aria-checked flips
 *   - arrow keys move FOCUS, not selection (the user must commit via
 *     Space/Enter)
 *   - Space and Enter commit the focused swatch as the new selection
 *   - Home/End jump focus to the ends, no commit
 *   - the focused swatch gets tabIndex=0 (roving anchor); others -1
 *   - wrap-around at boundaries
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type JSX } from 'react';
import { SwatchPicker } from './SwatchPicker';
import { ACCENT_PRESETS } from '../lib/palette-presets';

function Harness({
  initial = 'vermilion',
  onChange,
}: {
  initial?: string;
  onChange?: (id: string) => void;
}): JSX.Element {
  const [id, setId] = useState(initial);
  return (
    <SwatchPicker
      label="Highlight"
      hint="Accents, links, active states."
      presets={ACCENT_PRESETS}
      selectedId={id}
      onSelect={(next) => {
        setId(next);
        onChange?.(next);
      }}
    />
  );
}

describe('SwatchPicker', () => {
  it('renders the label, hint, and current preset KR name', () => {
    render(<Harness />);
    expect(screen.getByText('Highlight')).toBeInTheDocument();
    expect(
      screen.getByText('Accents, links, active states.'),
    ).toBeInTheDocument();
    // Vermilion's KR is 단청
    expect(screen.getByText('단청')).toBeInTheDocument();
  });

  it('renders a radiogroup with one radio per preset', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Highlight' });
    const radios = screen.getAllByRole('radio');
    expect(group).toBeInTheDocument();
    expect(radios).toHaveLength(Object.keys(ACCENT_PRESETS).length);
  });

  it('marks the selected preset aria-checked=true and others false', () => {
    render(<Harness initial="indigo" />);
    expect(
      screen.getByRole('radio', { name: 'Indigo' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('radio', { name: 'Vermilion' }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('selects on click and flips aria-checked', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const plum = screen.getByRole('radio', { name: 'Plum' });
    await userEvent.click(plum);
    expect(onChange).toHaveBeenCalledWith('plum');
    expect(plum).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('radio', { name: 'Vermilion' }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('ArrowRight moves focus without committing selection', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const vermilion = screen.getByRole('radio', { name: 'Vermilion' });
    vermilion.focus();
    await userEvent.keyboard('{ArrowRight}');
    // ACCENT_PRESETS order: vermilion → indigo → plum → ochre
    // Focus should move to indigo, but selection stays on vermilion.
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole('radio', { name: 'Vermilion' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: 'Indigo' }),
    );
  });

  it('Space commits the focused swatch as the new selection', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const vermilion = screen.getByRole('radio', { name: 'Vermilion' });
    vermilion.focus();
    await userEvent.keyboard('{ArrowRight}'); // focus → indigo
    await userEvent.keyboard(' '); // commit
    expect(onChange).toHaveBeenCalledWith('indigo');
    expect(
      screen.getByRole('radio', { name: 'Indigo' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('Enter commits the focused swatch as the new selection', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const vermilion = screen.getByRole('radio', { name: 'Vermilion' });
    vermilion.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}'); // focus → plum
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('plum');
  });

  it('ArrowLeft from the first wraps focus to the last', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const vermilion = screen.getByRole('radio', { name: 'Vermilion' });
    vermilion.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).not.toHaveBeenCalled(); // focus only
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: 'Ochre' }),
    );
  });

  it('Home/End jump focus to the ends without committing', async () => {
    const onChange = vi.fn();
    render(<Harness initial="plum" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Plum' }).focus();
    await userEvent.keyboard('{End}');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: 'Ochre' }),
    );
    await userEvent.keyboard('{Home}');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: 'Vermilion' }),
    );
  });

  it('the focused swatch has tabIndex=0; others are -1 (roving anchor)', () => {
    render(<Harness initial="ochre" />);
    // Focus initially mirrors selection — Ochre is both the selected
    // swatch and the roving-tabIndex anchor.
    expect(
      screen.getByRole('radio', { name: 'Ochre' }),
    ).toHaveAttribute('tabIndex', '0');
    expect(
      screen.getByRole('radio', { name: 'Vermilion' }),
    ).toHaveAttribute('tabIndex', '-1');
  });
});
