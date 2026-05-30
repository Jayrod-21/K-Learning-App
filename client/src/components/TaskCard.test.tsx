/**
 * TaskCard — verifies tone resolves to the right CSS class, the tag pill
 * renders only when given, and the click handler fires.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCard } from './TaskCard';

describe('TaskCard', () => {
  it('applies the gold tone class when tone="gold"', () => {
    render(
      <TaskCard
        skill="Listening · L3 → L4"
        krTag="듣기"
        title="대화 듣기"
        mins={6}
        tone="gold"
        tag="Largest gap"
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('km-taskcard--gold');
  });

  it('applies the red tone class when tone="red"', () => {
    render(
      <TaskCard
        skill="Writing · L4"
        krTag="쓰기"
        title="문어체 연습"
        mins={8}
        tone="red"
        tag="Register drill"
      />,
    );
    expect(screen.getByRole('button').className).toContain('km-taskcard--red');
  });

  it('renders no tone class for default', () => {
    render(
      <TaskCard
        skill="Reading · L4"
        krTag="읽기"
        title="신문 기사"
        mins={5}
      />,
    );
    const cls = screen.getByRole('button').className;
    expect(cls).not.toContain('km-taskcard--gold');
    expect(cls).not.toContain('km-taskcard--red');
  });

  it('renders the flag pill only when `tag` is set', () => {
    const { rerender } = render(
      <TaskCard skill="Reading · L4" krTag="읽기" title="t" mins={5} />,
    );
    expect(screen.queryByText('Largest gap')).not.toBeInTheDocument();
    rerender(
      <TaskCard
        skill="Reading · L4"
        krTag="읽기"
        title="t"
        mins={5}
        tone="gold"
        tag="Largest gap"
      />,
    );
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
  });

  it('fires onClick when the tile is activated', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TaskCard
        skill="Reading · L4"
        krTag="읽기"
        title="t"
        mins={5}
        onClick={onClick}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
