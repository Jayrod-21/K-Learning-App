/**
 * SkillBar — verifies the fill-color decision (meets vs below) flips at the
 * threshold and the numeric header reflects the current values. The width
 * animation itself is exercised in the integration of SkillsCompare; here
 * we only verify the class contract.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillBar } from './SkillBar';

function getFill(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.km-skillbar__fill');
  if (!(el instanceof HTMLElement)) {
    throw new Error('expected a .km-skillbar__fill element');
  }
  return el;
}

describe('SkillBar', () => {
  it('paints moss when score meets the target', () => {
    const { container } = render(
      <SkillBar label="Reading" kr="읽기" score={60} target={55} />,
    );
    const fill = getFill(container);
    expect(fill.className).toContain('km-skillbar__fill--meets');
    expect(fill.className).not.toContain('km-skillbar__fill--below');
  });

  it('paints paper-faint when score falls below the target', () => {
    const { container } = render(
      <SkillBar label="Reading" kr="읽기" score={40} target={55} />,
    );
    const fill = getFill(container);
    expect(fill.className).toContain('km-skillbar__fill--below');
    expect(fill.className).not.toContain('km-skillbar__fill--meets');
  });

  it('treats equality as meeting the target (>=)', () => {
    const { container } = render(
      <SkillBar label="Reading" kr="읽기" score={55} target={55} />,
    );
    expect(getFill(container).className).toContain('km-skillbar__fill--meets');
  });

  it('renders the {score}/{target} numeric header', () => {
    const { container } = render(
      <SkillBar label="Writing" kr="쓰기" score={42} target={55} />,
    );
    const header = container.querySelector('.km-skillbar__score');
    expect(header?.textContent).toContain('42');
    expect(header?.textContent).toContain('/ 55');
  });

  it('P3b: renders the label pair bilingually (Korean visible in default both-mode)', () => {
    const { container } = render(
      <SkillBar label="Reading" kr="읽기" score={60} target={55} />,
    );
    const label = container.querySelector('.km-skillbar__label');
    expect(label?.textContent).toContain('읽기');
    expect(label?.textContent).toContain('Reading');
  });

  it('paints the tick indigo when tone="ceiling"', () => {
    const { container } = render(
      <SkillBar
        label="Reading"
        kr="읽기"
        score={60}
        target={100}
        tone="ceiling"
      />,
    );
    const tick = container.querySelector('.km-skillbar__tick');
    expect(tick?.className).toContain('km-skillbar__tick--ceiling');
  });

  it('hides the gap note in compact mode', () => {
    render(
      <SkillBar
        label="Listening"
        kr="듣기"
        score={40}
        target={55}
        gapNote="Largest gap"
        compact
      />,
    );
    expect(screen.queryByText('Largest gap')).not.toBeInTheDocument();
  });

  it('shows the gap note in full mode', () => {
    render(
      <SkillBar
        label="Listening"
        kr="듣기"
        score={40}
        target={55}
        gapNote="Largest gap"
      />,
    );
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
  });

  it('F-011: an INVERTED band pair (scoreLow > scoreHigh) renders sorted — non-negative width, sorted aria range', () => {
    // The server invariant is scoreLow <= scoreHigh, but SkillBar promises a
    // corrupt inverted pair can never paint a negative-width band. Pin the
    // min/max sort so a refactor can't "simplify" it away (fixpass R3 S1).
    const { container } = render(
      <SkillBar
        label="Reading"
        kr="읽기"
        score={60}
        target={55}
        scoreLow={68}
        scoreHigh={52}
      />,
    );
    const band = container.querySelector('.km-skillbar__band');
    expect(band).toBeInstanceOf(HTMLElement);
    // Sorted geometry: left = min(52, 68) = 52%, width = 68 − 52 = 16%.
    expect((band as HTMLElement).style.left).toBe('52%');
    expect((band as HTMLElement).style.width).toBe('16%');
    // The announced range is also the SORTED pair, not the raw inverted one.
    expect(
      screen.getByRole('progressbar', {
        name: 'Reading skill — estimated 60, range 52–68',
      }),
    ).toBeInTheDocument();
  });
});
