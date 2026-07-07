/**
 * TaskCard — verifies tone resolves to the right CSS class, the tag pill
 * renders only when given, and the click handler fires.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCard } from './TaskCard';
import { SettingsProvider } from '../hooks/SettingsProvider';
import { SETTINGS_STORAGE_KEY } from '../lib/settings';

beforeEach(() => {
  window.localStorage.clear();
});

/** The text a sighted user sees (excludes the .km-sr-only duplicate). */
function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.km-sr-only').forEach((sr) => {
    sr.remove();
  });
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

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

  it('P3b: renders the skill eyebrow and minutes bilingually (both-mode default)', () => {
    const { container } = render(
      <TaskCard
        skill="Listening · L3 → L4"
        krTag="듣기"
        title="대화 듣기"
        mins={6}
      />,
    );
    const skill = container.querySelector('.km-taskcard__skill');
    expect(skill?.textContent).toContain('듣기');
    expect(skill?.textContent).toContain('Listening · L3 → L4');
    // Minutes are compact chrome: Korean-first 'both' shows 6분 visually,
    // the sr-only reading keeps "6 min".
    const mins = container.querySelector('.km-taskcard__mins');
    expect(mins).not.toBeNull();
    expect(visibleText(mins as Element)).toContain('6분');
    expect(mins?.querySelector('.km-sr-only')?.textContent).toContain('6 min');
  });

  it("P3b: mode 'en' hides the Korean tag visually but keeps it in the sr reading", () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        languageDisplay: { mode: 'en', primary: 'ko', subScale: 0.7 },
      }),
    );
    const { container } = render(
      <SettingsProvider>
        <TaskCard skill="Reading · L4" krTag="읽기" title="t" mins={5} />
      </SettingsProvider>,
    );
    const skill = container.querySelector('.km-taskcard__skill');
    expect(skill).not.toBeNull();
    expect(visibleText(skill as Element)).toBe('Reading · L4');
    expect(skill?.querySelector('.km-sr-only')?.textContent).toContain('읽기');
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
