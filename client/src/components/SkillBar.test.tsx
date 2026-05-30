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
});
