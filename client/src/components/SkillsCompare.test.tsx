/**
 * SkillsCompare — verifies the reference picker switches the active ref id
 * (which in turn re-drives target + tick across every SkillBar), and that
 * variant=compact suppresses both gap notes and the legend.
 *
 * Picker uses `role="radiogroup"` / `role="radio"` / `aria-checked` — the
 * honest ARIA contract for a "pick one of N" gesture that doesn't switch
 * tabpanels. The previous tablist role lied; this test pins the new
 * contract.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkillsCompare } from './SkillsCompare';
import type { SkillRow, SkillReference } from './SkillsCompare';

const SKILLS: ReadonlyArray<SkillRow> = [
  { key: 'reading', label: 'Reading', kr: '읽기', score: 60, note: 'On track' },
  {
    key: 'listening',
    label: 'Listening',
    kr: '듣기',
    score: 45,
    note: 'Largest gap',
  },
];

const REFS: ReadonlyArray<SkillReference> = [
  { id: 'l4', label: 'TOPIK 4', kr: '4급', value: 55 },
  { id: 'l5', label: 'TOPIK 5', kr: '5급', value: 70 },
  { id: 'native', label: 'Native', kr: '원어민', value: 100, isCeiling: true },
];

// F-011: reading carries a real confidence band; listening carries the
// degenerate low == score == high fallback, which must render NO band.
const BANDED_SKILLS: ReadonlyArray<SkillRow> = [
  {
    key: 'reading',
    label: 'Reading',
    kr: '읽기',
    score: 60,
    scoreLow: 52,
    scoreHigh: 68,
    note: 'On track',
  },
  {
    key: 'listening',
    label: 'Listening',
    kr: '듣기',
    score: 45,
    scoreLow: 45,
    scoreHigh: 45,
    note: 'Largest gap',
  },
];

// F-002: the ladder reaches down to TOPIK 1/2 — the picker must render and
// honour beginner reference lines, not just the old L3+ set.
const BEGINNER_REFS: ReadonlyArray<SkillReference> = [
  { id: 'L1', label: 'TOPIK 1', kr: '1급', value: 10 },
  { id: 'L2', label: 'TOPIK 2', kr: '2급', value: 25 },
  { id: 'L3', label: 'TOPIK 3', kr: '3급', value: 40 },
];

describe('SkillsCompare', () => {
  it('defaults to the first reference id', () => {
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    const active = screen.getByRole('radio', { name: 'TOPIK 4' });
    expect(active).toHaveAttribute('aria-checked', 'true');
  });

  it('honours an explicit defaultRefId', () => {
    render(
      <SkillsCompare
        skills={SKILLS}
        references={REFS}
        defaultRefId="l5"
      />,
    );
    expect(screen.getByRole('radio', { name: 'TOPIK 5' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('switches refId state when the user picks another reference', async () => {
    const user = userEvent.setup();
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    await user.click(screen.getByRole('radio', { name: 'TOPIK 5' }));
    expect(screen.getByRole('radio', { name: 'TOPIK 5' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'TOPIK 4' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('marks the ceiling pick with the ceiling class when active', async () => {
    const user = userEvent.setup();
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    const nativeRadio = screen.getByRole('radio', { name: 'Native' });
    await user.click(nativeRadio);
    expect(nativeRadio.className).toContain('km-skillscompare__pick--ceiling');
  });

  it('F-002: renders TOPIK 1 / TOPIK 2 reference options and switches between them', async () => {
    const user = userEvent.setup();
    render(
      <SkillsCompare
        skills={SKILLS}
        references={BEGINNER_REFS}
        defaultRefId="L2"
      />,
    );
    // Both beginner refs are pickable and the explicit default is honoured.
    expect(screen.getByRole('radio', { name: 'TOPIK 1' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'TOPIK 2' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Switching to TOPIK 1 re-targets the bars and updates the legend's
    // Korean shorthand — the beginner refs behave exactly like the old set.
    await user.click(screen.getByRole('radio', { name: 'TOPIK 1' }));
    expect(screen.getByRole('radio', { name: 'TOPIK 1' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/1급/)).toBeInTheDocument();
  });

  it('groups the radios under a single radiogroup with a label', () => {
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    expect(
      screen.getByRole('radiogroup', { name: 'Reference level' }),
    ).toBeInTheDocument();
  });

  it('hides legend and gap notes in compact variant', () => {
    render(
      <SkillsCompare
        skills={SKILLS}
        references={REFS}
        variant="compact"
      />,
    );
    expect(screen.queryByText('Largest gap')).not.toBeInTheDocument();
    expect(screen.queryByText(/At \/ above/)).not.toBeInTheDocument();
  });

  it('shows legend and gap notes in full variant', () => {
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.getByText(/At \/ above/)).toBeInTheDocument();
    expect(screen.getByText(/Below/)).toBeInTheDocument();
  });

  it('renders nothing fatal when references is empty', () => {
    const { container } = render(
      <SkillsCompare skills={SKILLS} references={[]} />,
    );
    expect(container.querySelector('.km-skillscompare--empty')).toBeTruthy();
  });

  it('F-011: renders a confidence band for scoreLow < scoreHigh, and none for a degenerate range', () => {
    const { container } = render(
      <SkillsCompare skills={BANDED_SKILLS} references={REFS} />,
    );
    // Only reading (52–68) draws a band; listening (45–45) degrades to the
    // plain bar — no visible range, no crash.
    const bands = container.querySelectorAll('.km-skillbar__band');
    expect(bands).toHaveLength(1);
    const band = bands[0] as HTMLElement;
    expect(band.style.left).toBe('52%');
    expect(band.style.width).toBe('16%');
    // The overlay is decorative — the range is announced via aria-label.
    expect(band).toHaveAttribute('aria-hidden', 'true');
  });

  it('F-011: announces "estimated X, range Low–High" on a banded bar and stays plain otherwise', () => {
    render(<SkillsCompare skills={BANDED_SKILLS} references={REFS} />);
    expect(
      screen.getByRole('progressbar', {
        name: 'Reading skill — estimated 60, range 52–68',
      }),
    ).toBeInTheDocument();
    // Degenerate band keeps the pre-F-011 label — no fake range claim.
    expect(
      screen.getByRole('progressbar', { name: 'Listening skill' }),
    ).toBeInTheDocument();
  });

  it('F-011: the legend explains the band only when at least one bar draws one', () => {
    const { rerender } = render(
      <SkillsCompare skills={BANDED_SKILLS} references={REFS} />,
    );
    expect(screen.getByText('Confidence band')).toBeInTheDocument();
    // No banded rows (legacy snapshot shape) → no band legend entry.
    rerender(<SkillsCompare skills={SKILLS} references={REFS} />);
    expect(screen.queryByText('Confidence band')).not.toBeInTheDocument();
  });

  it('fans the bars in with a per-index transition delay (i * 70ms)', () => {
    // A1: SkillsCompare passes `delayMs = i * 70` (within the 70–90ms
    // envelope) so the bars cascade in; SkillBar applies it as the fill's
    // transition-delay. Pin the cadence so a future refactor can't silently
    // flatten the stagger.
    const { container } = render(
      <SkillsCompare skills={SKILLS} references={REFS} />,
    );
    const fills = container.querySelectorAll('.km-skillbar__fill');
    expect(fills.length).toBe(SKILLS.length);
    expect((fills[0] as HTMLElement).style.transitionDelay).toBe('0ms');
    expect((fills[1] as HTMLElement).style.transitionDelay).toBe('70ms');
  });
});
