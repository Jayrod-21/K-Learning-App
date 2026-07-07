/**
 * Reading — the /learn/reading placeholder (P1.1). Static page; the test
 * pins the title + the "coming with your book scans" promise so the LEARN
 * menu's seventh slot never silently rots into a blank screen.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Reading from './Reading';

describe('Reading placeholder (P1.1)', () => {
  it('renders the title and the coming-soon copy', () => {
    render(<Reading />);
    expect(screen.getByText('읽기 · Reading')).toBeInTheDocument();
    expect(
      screen.getByText(/coming with your book scans/i),
    ).toBeInTheDocument();
  });
});
