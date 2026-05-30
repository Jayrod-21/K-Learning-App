/**
 * Pill — smoke test that proves the Vitest + RTL + happy-dom + jest-dom
 * stack is wired correctly. Real component tests for stateful composites
 * land alongside their implementations in Pass 2.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Pill } from './Pill';

describe('Pill', () => {
  it('renders its children inside a span with the base class', () => {
    render(<Pill>Due now</Pill>);
    const el = screen.getByText('Due now');
    expect(el).toBeInTheDocument();
    expect(el.tagName).toBe('SPAN');
    expect(el).toHaveClass('km-pill');
    expect(el).toHaveClass('km-pill--default');
  });

  it('switches tone class when tone prop is set', () => {
    render(<Pill tone="gold">L4</Pill>);
    expect(screen.getByText('L4')).toHaveClass('km-pill--gold');
  });
});
