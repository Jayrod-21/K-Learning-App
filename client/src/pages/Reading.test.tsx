/**
 * Reading — the /learn/reading placeholder (P1.1). Static page; the tests
 * pin the title + the coming-soon promise so the LEARN menu's seventh slot
 * never silently rots into a blank screen. P3b: the chrome renders through
 * `<Bilingual/>` — without a SettingsProvider the default mode is 'both'
 * (Korean-first), so both languages must be present.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Reading from './Reading';

describe('Reading placeholder (P1.1)', () => {
  it('renders the bilingual title and eyebrow in both-mode', () => {
    render(<Reading />);
    expect(
      screen.getByRole('heading', { level: 1, name: '읽기 · Reading' }),
    ).toBeInTheDocument();
    // Eyebrow comes from the nav manifest pair (Coming soon · 준비 중).
    expect(screen.getByText('준비 중')).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('renders the trimmed coming-soon copy in both languages', () => {
    render(<Reading />);
    expect(
      screen.getByText(/graded passages from your scanned books/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('스캔한 책의 지문이 여기에 담길 예정이에요.'),
    ).toBeInTheDocument();
    // The old two-sentence pitch is gone.
    expect(
      screen.queryByText(/coming with your book scans/i),
    ).not.toBeInTheDocument();
  });
});
