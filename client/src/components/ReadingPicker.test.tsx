/**
 * ReadingPicker — corpus tabs, paginated unit list, select + pager, and the
 * loading / error / empty states.
 *
 * The units service is mocked at the module boundary so each render drives a
 * fixed page; selecting a row / paging fires observable calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReadingSelection } from '../types/domain';

vi.mock('../services/reading', () => ({
  fetchUnitsPage: vi.fn(),
}));

import { ReadingPicker } from './ReadingPicker';
import { fetchUnitsPage } from '../services/reading';

function renderPicker(
  overrides: Partial<Parameters<typeof ReadingPicker>[0]> = {},
): { onSelect: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <ReadingPicker
      open
      onClose={onClose}
      current={null}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { onSelect, onClose };
}

// Iyagi is the default corpus tab (B-001) — the fixture the no-selection
// tests render against.
const IYAGI_PAGE = {
  corpus: 'iyagi' as const,
  total: 45,
  units: [
    { id: 1, title: '이야기 #1', episode_number: 1 },
    { id: 2, title: '이야기 #2', episode_number: 2 },
  ],
};

const TTMIK_PAGE = {
  corpus: 'ttmik' as const,
  total: 3,
  units: [{ id: 9, title: '안녕하세요', lesson_level: 1, lesson_number: 1 }],
};

describe('ReadingPicker', () => {
  beforeEach(() => {
    vi.mocked(fetchUnitsPage).mockReset();
  });

  it('renders nothing when closed and fires no fetch', () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue(IYAGI_PAGE);
    render(
      <ReadingPicker
        open={false}
        onClose={() => undefined}
        current={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(vi.mocked(fetchUnitsPage)).not.toHaveBeenCalled();
  });

  it('defaults the corpus tab to Iyagi when there is no current selection (B-001)', async () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue(IYAGI_PAGE);
    renderPicker();

    expect(await screen.findByText('이야기 #1')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Iyagi' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(vi.mocked(fetchUnitsPage)).toHaveBeenCalledWith({
      corpus: 'iyagi',
      limit: 20,
      offset: 0,
    });
  });

  it('lists units and shows the corpus total in the pager', async () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue(IYAGI_PAGE);
    renderPicker();

    expect(await screen.findByText('이야기 #1')).toBeInTheDocument();
    expect(screen.getByText('이야기 #2')).toBeInTheDocument();
    // Pager reflects the real total, not the page length (appears in header + pager).
    expect(screen.getAllByText(/1–2 of 45/).length).toBeGreaterThan(0);
  });

  it('fires onSelect with the chosen corpus + unit id', async () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue(IYAGI_PAGE);
    const { onSelect } = renderPicker();
    const user = userEvent.setup();

    const row = await screen.findByRole('button', {
      name: /이야기 #2 — Episode 2/i,
    });
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith({
      corpus: 'iyagi',
      unitId: 2,
      title: '이야기 #2',
    });
  });

  it('seeds the tab from the current selection and marks it with a Current pill', async () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue(TTMIK_PAGE);
    const current: ReadingSelection = {
      corpus: 'ttmik',
      unitId: 9,
      title: '안녕하세요',
    };
    renderPicker({ current });
    await screen.findByText('안녕하세요');
    // Reopening lands on the corpus being read, not the default tab.
    expect(screen.getByRole('radio', { name: 'TTMIK' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(vi.mocked(fetchUnitsPage)).toHaveBeenCalledWith({
      corpus: 'ttmik',
      limit: 20,
      offset: 0,
    });
  });

  it('switches corpus and refetches with the new corpus, resetting offset', async () => {
    vi.mocked(fetchUnitsPage).mockImplementation((opts) =>
      Promise.resolve(opts.corpus === 'ttmik' ? TTMIK_PAGE : IYAGI_PAGE),
    );
    renderPicker();
    const user = userEvent.setup();

    await screen.findByText('이야기 #1');
    await user.click(screen.getByRole('radio', { name: 'TTMIK' }));

    expect(await screen.findByText('안녕하세요')).toBeInTheDocument();
    expect(vi.mocked(fetchUnitsPage)).toHaveBeenLastCalledWith({
      corpus: 'ttmik',
      limit: 20,
      offset: 0,
    });
  });

  it('pages forward with Next, advancing the offset', async () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue(IYAGI_PAGE);
    renderPicker();
    const user = userEvent.setup();

    await screen.findByText('이야기 #1');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => {
      expect(vi.mocked(fetchUnitsPage)).toHaveBeenLastCalledWith({
        corpus: 'iyagi',
        limit: 20,
        offset: 20,
      });
    });
  });

  it('disables Prev on the first page', async () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue(IYAGI_PAGE);
    renderPicker();
    expect(await screen.findByText('이야기 #1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
  });

  it('shows an empty state when the corpus has no units', async () => {
    vi.mocked(fetchUnitsPage).mockResolvedValue({
      corpus: 'iyagi',
      total: 0,
      units: [],
    });
    renderPicker();
    expect(
      await screen.findByText(/No lessons available yet/i),
    ).toBeInTheDocument();
  });

  it('surfaces an error with Retry, and Retry refetches', async () => {
    vi.mocked(fetchUnitsPage)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(IYAGI_PAGE);
    renderPicker();
    const user = userEvent.setup();

    const retry = await screen.findByRole('button', { name: /Retry/i });
    await user.click(retry);
    expect(await screen.findByText('이야기 #1')).toBeInTheDocument();
  });
});
