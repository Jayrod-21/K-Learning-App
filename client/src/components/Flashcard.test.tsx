/**
 * Flashcard — click + keyboard + aria-expanded reflects flipped.
 *
 * The parent owns flipped state; we just emit onFlip and toggle the
 * `--flipped` modifier class for CSS to handle the rotateY.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Flashcard } from './Flashcard';

describe('Flashcard', () => {
  it('renders both faces and announces aria-label', () => {
    render(
      <Flashcard
        front={<span>FRONT</span>}
        back={<span>BACK</span>}
        flipped={false}
        onFlip={() => undefined}
      />,
    );
    const el = screen.getByRole('button', { name: 'Flip card' });
    expect(el).toHaveAttribute('aria-expanded', 'false');
    // Both faces render in the DOM at all times — CSS hides the rotated one.
    expect(screen.getByText('FRONT')).toBeInTheDocument();
    expect(screen.getByText('BACK')).toBeInTheDocument();
  });

  it('applies the flipped modifier class and aria-expanded=true when flipped', () => {
    render(
      <Flashcard
        front={<span>F</span>}
        back={<span>B</span>}
        flipped
        onFlip={() => undefined}
      />,
    );
    const el = screen.getByRole('button', { name: 'Flip card' });
    expect(el).toHaveClass('km-flashcard--flipped');
    expect(el).toHaveAttribute('aria-expanded', 'true');
  });

  it('calls onFlip on click', async () => {
    const user = userEvent.setup();
    const onFlip = vi.fn();
    render(
      <Flashcard
        front={<span>F</span>}
        back={<span>B</span>}
        flipped={false}
        onFlip={onFlip}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it('calls onFlip on Enter and Space', async () => {
    const user = userEvent.setup();
    const onFlip = vi.fn();
    render(
      <Flashcard
        front={<span>F</span>}
        back={<span>B</span>}
        flipped={false}
        onFlip={onFlip}
      />,
    );
    const el = screen.getByRole('button', { name: 'Flip card' });
    el.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onFlip).toHaveBeenCalledTimes(2);
  });

  it('honours ariaLabel override', () => {
    render(
      <Flashcard
        front={<span>F</span>}
        back={<span>B</span>}
        flipped={false}
        onFlip={() => undefined}
        ariaLabel="Reveal answer"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Reveal answer' }),
    ).toBeInTheDocument();
  });
});
