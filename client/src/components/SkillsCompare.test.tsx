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
