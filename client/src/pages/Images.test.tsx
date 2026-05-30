/**
 * Images page — loading → data, sample click transition into Capture view.
 *
 * `vi.hoisted` holds the fixture so the hoisted `vi.mock` factory can
 * reference it without TDZ.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { FIXTURE } = vi.hoisted(() => {
  return {
    FIXTURE: [
      {
        id: 'img1',
        name: '카페 메뉴판',
        caption_kr: '카페 메뉴판',
        caption_en: 'Café menu',
        gradient: 'linear-gradient(135deg, #fff 0%, #ddd 100%)',
        scene: [{ text: '오늘의 음료', x: 12, y: 8, size: 22 }],
        words: [
          {
            id: 'w1',
            kr: '음료',
            en: 'beverage',
            pos: 'n.',
            gloss: 'beverage',
            box: { x: 12, y: 8, w: 28, h: 8 },
          },
          {
            id: 'w2',
            kr: '오늘',
            en: 'today',
            pos: 'n.',
            gloss: 'today',
            box: { x: 12, y: 18, w: 18, h: 7 },
          },
        ],
        capturedAt: '2026-05-28T10:14:00+09:00',
      },
    ],
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: () => ({
    data: FIXTURE,
    loading: false,
    error: null,
    isMock: true,
    refetch: () => undefined,
  }),
}));

// Pull the page AFTER the hook mock is set up.
import Images from './Images';

describe('Images page', () => {
  it('renders the upload card and sample list', () => {
    render(<Images />);
    expect(screen.getByText('Capture or upload')).toBeInTheDocument();
    expect(screen.getByText(/Or try a sample/)).toBeInTheDocument();
    // Both the Or-try-a-sample list AND the Recent captures grid expose
    // a button whose accessible name contains 카페 메뉴판 — the first
    // match here is the sample row, which is the one we want to exercise.
    expect(
      screen.getAllByRole('button', { name: /카페 메뉴판/ }).length,
    ).toBeGreaterThan(0);
  });

  it('opens the CaptureView when a sample row is clicked', async () => {
    const user = userEvent.setup();
    render(<Images />);

    const sampleButtons = screen.getAllByRole('button', {
      name: /카페 메뉴판/,
    });
    await user.click(sampleButtons[0]);

    expect(screen.getByText(/2 words detected/)).toBeInTheDocument();
    // Detected-words section heading exists; find the words list under it.
    const detectedHeading = screen.getByText('Detected words');
    expect(detectedHeading).toBeInTheDocument();
    // Both KR words appear somewhere in the capture view.
    expect(within(document.body).getByText('음료')).toBeInTheDocument();
    expect(within(document.body).getByText('오늘')).toBeInTheDocument();
  });
});
