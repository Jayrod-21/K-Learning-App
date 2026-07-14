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
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
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

// The real production shape (Progress + Diagnostic both pass all 7 of
// these — see data/mocks/diagnostic.ts) — the fixture the mobile-overflow
// bug actually reproduces with. REFS above deliberately uses a shorter list
// for the unrelated picker-behavior tests; this one exists so the
// full-width-picker tests below exercise the real pill count.
const FULL_LADDER_REFS: ReadonlyArray<SkillReference> = [
  { id: 'L1', label: 'TOPIK 1', kr: '1급', value: 10 },
  { id: 'L2', label: 'TOPIK 2', kr: '2급', value: 25 },
  { id: 'L3', label: 'TOPIK 3', kr: '3급', value: 40 },
  { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
  { id: 'L5', label: 'TOPIK 5', kr: '5급', value: 70 },
  { id: 'L6', label: 'TOPIK 6', kr: '6급', value: 85 },
  { id: 'native', label: 'Native', kr: '원어민', value: 100, isCeiling: true },
];

describe('SkillsCompare', () => {
  it('defaults to the first reference id', () => {
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    const active = screen.getByRole('radio', { name: '4급 · TOPIK 4' });
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
    expect(screen.getByRole('radio', { name: '5급 · TOPIK 5' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('switches refId state when the user picks another reference', async () => {
    const user = userEvent.setup();
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    await user.click(screen.getByRole('radio', { name: '5급 · TOPIK 5' }));
    expect(screen.getByRole('radio', { name: '5급 · TOPIK 5' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: '4급 · TOPIK 4' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('marks the ceiling pick with the ceiling class when active', async () => {
    const user = userEvent.setup();
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    const nativeRadio = screen.getByRole('radio', { name: '원어민 · Native' });
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
    expect(screen.getByRole('radio', { name: '1급 · TOPIK 1' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '2급 · TOPIK 2' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Switching to TOPIK 1 re-targets the bars and updates the legend's
    // Korean shorthand — the beginner refs behave exactly like the old set.
    await user.click(screen.getByRole('radio', { name: '1급 · TOPIK 1' }));
    expect(screen.getByRole('radio', { name: '1급 · TOPIK 1' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // 1급 now renders in BOTH the (bilingual) pick and the legend.
    expect(screen.getAllByText(/1급/).length).toBeGreaterThan(0);
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

  it('P3b: eyebrow + legend render bilingually in default both-mode', () => {
    render(<SkillsCompare skills={SKILLS} references={REFS} />);
    // "Compare to" eyebrow.
    expect(screen.getByText('비교 기준')).toBeInTheDocument();
    expect(screen.getByText('Compare to')).toBeInTheDocument();
    // Legend + picker: the active ref's Korean shorthand now flows through
    // <Bilingual/> (no hand-composed "· kr" span) — it appears in both the
    // segmented pick (P3b top-up, review S-2) and the legend entry.
    expect(screen.getAllByText('4급').length).toBeGreaterThan(0);
    // At / above → 달성, Below → 미달.
    expect(screen.getByText('달성')).toBeInTheDocument();
    expect(screen.getByText('미달')).toBeInTheDocument();
  });

  it('P3b: the confidence-band legend entry is bilingual', () => {
    render(<SkillsCompare skills={BANDED_SKILLS} references={REFS} />);
    expect(screen.getByText('Confidence band')).toBeInTheDocument();
    expect(screen.getByText('신뢰 구간')).toBeInTheDocument();
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

describe('SkillsCompare — mobile overflow fix (live bug: TOPIK 5 / Native fell off-screen)', () => {
  it('renders all 7 reference pills — nothing is dropped to fit narrow screens', () => {
    render(<SkillsCompare skills={SKILLS} references={FULL_LADDER_REFS} />);
    const group = screen.getByRole('radiogroup', { name: 'Reference level' });
    expect(within(group).getAllByRole('radio')).toHaveLength(7);
    // The two pills the live bug clipped off-screen must both be present
    // and pickable, not just counted.
    const topik5 = screen.getByRole('radio', { name: '5급 · TOPIK 5' });
    const native = screen.getByRole('radio', { name: '원어민 · Native' });
    expect(topik5).toBeInTheDocument();
    expect(native).toBeInTheDocument();
  });

  it('lets the user reach TOPIK 5 / Native via the picker even with the full 7-item ladder', async () => {
    const user = userEvent.setup();
    render(<SkillsCompare skills={SKILLS} references={FULL_LADDER_REFS} />);
    await user.click(screen.getByRole('radio', { name: '원어민 · Native' }));
    expect(
      screen.getByRole('radio', { name: '원어민 · Native' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  // happy-dom does no layout, so the actual on-screen overflow/scroll can't
  // be measured by rendering (same limitation as Toggle.test.tsx's /
  // FeedbackFab.test.tsx's stylesheet-contract tests) — pin the CSS
  // mechanism from source instead. SkillsCompare.css is colocated (not
  // styles/index.css) specifically so this fix doesn't touch the shared
  // global sheet other in-flight work depends on.
  it('CSS: the picker keeps its horizontal scroll rail as a fallback (short labels are the primary fix)', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'components', 'SkillsCompare.css'),
      'utf8',
    );

    const pickerRule =
      /\.km-skillscompare \.km-skillscompare__picker\s*\{[^}]*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(pickerRule).not.toBe('');
    // The flex-item min-width:auto default is what caused the overflow —
    // min-width: 0 is what lets the box actually shrink to available width.
    expect(pickerRule).toContain('min-width: 0;');
    expect(pickerRule).toContain('overflow-x: auto;');
    // Pills must scroll, not wrap mid-row and not be squashed illegibly.
    expect(pickerRule).toContain('flex-wrap: nowrap;');

    const pickRule =
      /\.km-skillscompare \.km-skillscompare__pick\s*\{[^}]*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(pickRule).not.toBe('');
    expect(pickRule).toContain('flex: 0 0 auto;');

    // Narrow-viewport layout: the eyebrow + picker stack instead of
    // fighting for space under `justify-content: space-between`.
    const mediaBlock =
      /@media \(max-width: 480px\) \{[\s\S]*?\n\}/.exec(stylesheet)?.[0] ?? '';
    expect(mediaBlock).toContain('flex-direction: column;');
  });
});

describe('SkillsCompare — abbreviated pick labels (mobile hardening pass 2: T1…T6/Native fit without scrolling)', () => {
  it('shows the short code as the VISIBLE text for every pill, Native spelled out', () => {
    render(<SkillsCompare skills={SKILLS} references={FULL_LADDER_REFS} />);
    const group = screen.getByRole('radiogroup', { name: 'Reference level' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(7);
    // Visible text (the aria-hidden presentational span) is the abbreviated
    // code, not the full "TOPIK n" label — this is what lets all 7 pills fit
    // a 360px row without the scroll rail engaging.
    const visible = radios.map((r) => r.textContent);
    expect(visible).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'Native']);
  });

  it('keeps the FULL descriptive label as the accessible name even though the visible text is abbreviated', () => {
    render(<SkillsCompare skills={SKILLS} references={FULL_LADDER_REFS} />);
    // Query by the full bilingual name — if the abbreviation had leaked into
    // the accessible name, this lookup would fail to find the pill at all.
    const t4 = screen.getByRole('radio', { name: '4급 · TOPIK 4' });
    expect(t4).toBeInTheDocument();
    expect(t4.textContent).toBe('T4');
    // Belt-and-suspenders: the same full string is available as a hover
    // tooltip for sighted mouse users, not just to assistive tech.
    expect(t4).toHaveAttribute('title', '4급 · TOPIK 4');
  });

  it('falls back to the plain label (no dangling separator) as the accessible name when a ref has no kr', () => {
    const noKrRef = { id: 'l4', label: 'TOPIK 4', value: 55 };
    render(
      <SkillsCompare
        skills={SKILLS}
        references={[noKrRef]}
        defaultRefId="l4"
      />,
    );
    const radio = screen.getByRole('radio', { name: 'TOPIK 4' });
    expect(radio).toBeInTheDocument();
    expect(radio.textContent).toBe('T4');
    expect(radio).toHaveAttribute('title', 'TOPIK 4');
  });

  it('all 7 pills stay reachable and pickable via their short visible text', async () => {
    const user = userEvent.setup();
    render(<SkillsCompare skills={SKILLS} references={FULL_LADDER_REFS} />);
    const group = screen.getByRole('radiogroup', { name: 'Reference level' });
    for (const radio of within(group).getAllByRole('radio')) {
      // Sequential picks by design: each assertion depends on the previous
      // click's committed state, so this loop can't be parallelized.
      await user.click(radio);
      expect(radio).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('selecting an abbreviated pill still re-targets the skill bars', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SkillsCompare skills={SKILLS} references={FULL_LADDER_REFS} />,
    );
    // Default ref is L1 (value 10) — every bar's tick sits near the left edge.
    const ticksBefore = Array.from(
      container.querySelectorAll<HTMLElement>('.km-skillbar__tick'),
    ).map((t) => t.style.left);

    await user.click(screen.getByRole('radio', { name: '원어민 · Native' }));

    const ticksAfter = Array.from(
      container.querySelectorAll<HTMLElement>('.km-skillbar__tick'),
    ).map((t) => t.style.left);
    // Native's target (100) moves every tick far right of L1's target (10) —
    // picking the abbreviated "Native" pill drove real behavior, not just its
    // own aria-checked flag.
    expect(ticksAfter).not.toEqual(ticksBefore);
    expect(ticksAfter).toEqual(['100%', '100%']);
  });

  it('derives the short code from the label, not the id — "TOPIK n" always abbreviates to "Tn"', () => {
    // Guards against a regression where a future id-casing change ('l4' vs
    // 'L4', seen across the fixtures in this file) silently breaks the
    // abbreviation because it started reading `id` instead of `label`.
    const mixedCaseIdRefs: ReadonlyArray<SkillReference> = [
      { id: 'l4', label: 'TOPIK 4', kr: '4급', value: 55 },
      { id: 'NATIVE', label: 'Native', kr: '원어민', value: 100 },
    ];
    render(
      <SkillsCompare
        skills={SKILLS}
        references={mixedCaseIdRefs}
        defaultRefId="l4"
      />,
    );
    expect(screen.getByRole('radio', { name: '4급 · TOPIK 4' }).textContent).toBe(
      'T4',
    );
    expect(
      screen.getByRole('radio', { name: '원어민 · Native' }).textContent,
    ).toBe('Native');
  });
});
