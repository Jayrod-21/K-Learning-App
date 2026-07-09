/**
 * UploadViewer (U1b rework) — the view-only PAGE-IMAGE viewer at
 * `/uploads/:id`. `services/uploads.ts` is fully mocked (no pdf.js, no real
 * image bytes — the module under test only cares that it fetches the right
 * URL/state, not that a JPEG actually decodes).
 *
 * Covers: meta fetch (`page_count` via `getUpload`) drives the page-N-of-M
 * label, page nav (prev/next/jump) changes which page URL renders, a
 * per-page load failure shows Retry (not a broken-image icon) and Retry
 * re-mounts the image, the reorder tool (load current order, move-to-N,
 * optimistic update, PATCH call, rollback-on-failure), and abort-on-unmount
 * for every network call this component makes directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import type { BookUpload, Page } from '../types/domain';

const uploadsSvc = vi.hoisted(() => ({
  getUpload: vi.fn(),
  listPages: vi.fn(),
  reorderPages: vi.fn(),
  // Mirrors the real `pageUrl`'s cache-bust contract (services/uploads.ts):
  // a positive 4th arg appends `?r=<token>`, omitted/0 stays a bare path —
  // needed so tests below can assert Retry actually changes the requested
  // URL, not just remounts onto the same one.
  pageUrl: vi.fn(
    (id: string, n: number, _base?: string, cacheBust = 0) =>
      `/uploads/${id}/page/${String(n)}${cacheBust > 0 ? `?r=${String(cacheBust)}` : ''}`,
  ),
}));

vi.mock('../services/uploads', () => uploadsSvc);

// Imported AFTER the mock so the module under test binds the mocked service.
import UploadViewer from './UploadViewer';

const READY: BookUpload = {
  id: '9',
  title: '한국어 문법 사전',
  type: 'grammar',
  status: 'ready',
  pageCount: 5,
  byteSize: 4_200_000,
  createdAt: '2026-07-01T00:00:00Z',
};

const PROCESSING: BookUpload = {
  id: '9',
  title: '읽기 연습',
  type: 'literature',
  status: 'processing',
  byteSize: 1_000_000,
  createdAt: '2026-07-02T00:00:00Z',
};

const PAGES: Page[] = [
  { id: '101', pageNumber: 1 },
  { id: '102', pageNumber: 2 },
  { id: '103', pageNumber: 3 },
  { id: '104', pageNumber: 4 },
  { id: '105', pageNumber: 5 },
];

function renderViewer(id = '9', search = ''): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/uploads/${id}${search}`]}>
      <ToastProvider>
        <Routes>
          <Route path="/uploads/:id" element={<UploadViewer />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Fire the DOM `load`/`error` event on whichever `<img>` is currently rendered. */
function settleImage(kind: 'load' | 'error'): void {
  const img = document.querySelector('img');
  if (!img) throw new Error('no <img> rendered');
  img.dispatchEvent(new Event(kind));
}

beforeEach(() => {
  uploadsSvc.getUpload.mockReset();
  uploadsSvc.listPages.mockReset();
  uploadsSvc.reorderPages.mockReset();
  uploadsSvc.getUpload.mockResolvedValue(READY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UploadViewer — meta + page rendering', () => {
  it('fetches page_count via getUpload and renders page 1 of N', async () => {
    renderViewer('9');
    expect(await screen.findByText('1 / 5')).toBeInTheDocument();
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/uploads/9/page/1');
  });

  it('shows a fixed loading message before meta resolves', () => {
    uploadsSvc.getUpload.mockReturnValue(new Promise(() => {}));
    renderViewer();
    expect(screen.getByText(/Loading this book/)).toBeInTheDocument();
  });

  it('shows an error + retry when meta fails to load', async () => {
    uploadsSvc.getUpload.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderViewer();

    expect(await screen.findByText(/Couldn.t load this book/)).toBeInTheDocument();

    uploadsSvc.getUpload.mockResolvedValueOnce(READY);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 / 5')).toBeInTheDocument();
  });

  it('shows a fixed "still processing" state instead of the pager when there is no page_count', async () => {
    uploadsSvc.getUpload.mockResolvedValue(PROCESSING);
    renderViewer();
    expect(await screen.findByText(/still processing/)).toBeInTheDocument();
  });
});

// U3c deep-link: `?page=N` seeds the initial page (the reader's "view
// original scan" threads a chapter's start_page through it). Strictly
// validated — invalid/absent → page 1; overshoot clamps to page_count.
describe('UploadViewer — initial page deep-link (?page=N)', () => {
  it('opens at the requested page', async () => {
    renderViewer('9', '?page=3');
    expect(await screen.findByText('3 / 5')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/3');
  });

  it('clamps an out-of-range page to the page count (never requests a nonexistent page)', async () => {
    renderViewer('9', '?page=99');
    expect(await screen.findByText('5 / 5')).toBeInTheDocument();
    // The one mounted <img> is the clamped page — page 99 was never requested.
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/5');
  });

  it.each(['?page=abc', '?page=0', '?page=-2', '?page=1.5'])(
    'defaults to page 1 for the invalid param %s',
    async (search) => {
      renderViewer('9', search);
      expect(await screen.findByText('1 / 5')).toBeInTheDocument();
      expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/1');
    },
  );

  it('leaves normal navigation intact after a deep-linked open', async () => {
    const user = userEvent.setup();
    renderViewer('9', '?page=3');
    await screen.findByText('3 / 5');

    await user.click(screen.getByLabelText('Previous page'));
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/2');
  });
});

describe('UploadViewer — page nav', () => {
  it('Next/Previous change which page URL is requested', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    await user.click(screen.getByLabelText('Next page'));
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/2');

    await user.click(screen.getByLabelText('Previous page'));
    expect(await screen.findByText('1 / 5')).toBeInTheDocument();
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
  });

  it('Next is disabled on the last page, Previous disabled on the first', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
    expect(screen.getByLabelText('Next page')).not.toBeDisabled();
  });

  it('jump-to-page navigates directly and clamps out-of-range input', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    await user.type(screen.getByLabelText('Jump to page'), '4');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('4 / 5')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/4');
  });

  it('only ever mounts ONE page image at a time (lazy — never all pages)', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    expect(document.querySelectorAll('img')).toHaveLength(1);
  });
});

describe('UploadViewer — per-page error + retry', () => {
  it('a page image load failure shows Retry (not a broken-image icon)', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    settleImage('error');
    expect(await screen.findByText(/Couldn.t load this page/)).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('Retry re-mounts the image (fresh load attempt) for the same page', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    settleImage('error');
    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    await user.click(retryBtn);

    // Back to a loading/loaded image element for the SAME page.
    expect(await screen.findByText(/Loading this page/)).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toContain('/uploads/9/page/1');
  });

  // B-S1 regression: a plain nav never cache-busts (the page route is
  // deliberately cache-friendly), but a RETRY must force a fresh URL each
  // time — otherwise a browser-cached bad-but-200 response would replay
  // forever no matter how many times the user taps Retry.
  it('normal navigation never appends a cache-bust query param', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/1');
  });

  it('Retry cache-busts the URL, and a second Retry bumps it again (never repeats the same URL)', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    settleImage('error');
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText(/Loading this page/);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/1?r=1');

    settleImage('error');
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText(/Loading this page/);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/1?r=2');
  });

  it('navigating to a new page after a retry resets the cache-bust (fresh page starts uncached-request-free)', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    settleImage('error');
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText(/Loading this page/);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/1?r=1');

    await user.click(screen.getByLabelText('Next page'));
    await screen.findByText('2 / 5');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/2');
  });
});

describe('UploadViewer — reorder tool', () => {
  beforeEach(() => {
    uploadsSvc.listPages.mockResolvedValue(PAGES);
  });

  it('loads the current page order when Reorder pages is opened', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    await user.click(screen.getByRole('button', { name: 'Reorder pages' }));
    await waitFor(() => expect(uploadsSvc.listPages).toHaveBeenCalledWith('9', expect.anything()));
    expect(await screen.findByLabelText(/Move page 1 to position/)).toBeInTheDocument();
  });

  it('moving a page calls reorderPages with the full new id order, optimistically updates, and jumps to the new position', async () => {
    uploadsSvc.reorderPages.mockResolvedValue([
      { id: '102', pageNumber: 1 },
      { id: '103', pageNumber: 2 },
      { id: '101', pageNumber: 3 },
      { id: '104', pageNumber: 4 },
      { id: '105', pageNumber: 5 },
    ]);
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    await user.click(screen.getByRole('button', { name: 'Reorder pages' }));
    await screen.findByLabelText(/Move page 1 to position/);

    await user.type(screen.getByLabelText(/Move page 1 to position/), '3');
    await user.click(screen.getByRole('button', { name: 'Move' }));

    // Optimistic: jumps to the target position immediately.
    await waitFor(() => {
      expect(uploadsSvc.reorderPages).toHaveBeenCalledWith(
        '9',
        ['102', '103', '101', '104', '105'],
        expect.anything(),
      );
    });
    expect(await screen.findByText('3 / 5')).toBeInTheDocument();
  });

  it('rolls back the order + page position when the PATCH fails, and surfaces fixed copy', async () => {
    uploadsSvc.reorderPages.mockRejectedValue(
      new ApiError('constraint violation xyz', { status: 400, code: 'validation_error' }),
    );
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    await user.click(screen.getByRole('button', { name: 'Reorder pages' }));
    await screen.findByLabelText(/Move page 1 to position/);

    await user.type(screen.getByLabelText(/Move page 1 to position/), '3');
    await user.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(uploadsSvc.reorderPages).toHaveBeenCalledTimes(1));

    // Rolled back to page 1 (the pre-move position).
    await screen.findByText('1 / 5');
    expect(await screen.findByText('Could not move that page. Try again.')).toBeInTheDocument();
    expect(screen.queryByText('constraint violation xyz')).not.toBeInTheDocument();
  });

  it('rejects an out-of-range move target with fixed copy and never calls reorderPages', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    await user.click(screen.getByRole('button', { name: 'Reorder pages' }));
    await screen.findByLabelText(/Move page 1 to position/);

    await user.type(screen.getByLabelText(/Move page 1 to position/), '99');
    await user.click(screen.getByRole('button', { name: 'Move' }));

    expect(await screen.findByText(/Enter a page number between 1 and 5/)).toBeInTheDocument();
    expect(uploadsSvc.reorderPages).not.toHaveBeenCalled();
  });

  // B-S2 regression: the Move BUTTON is `disabled={reordering || ...}`, but
  // the move-target input's Enter handler called `submitMove()` directly
  // with no guard of its own — so pressing Enter again while a reorder was
  // still in flight bypassed the button's disabled state entirely and fired
  // a second concurrent PATCH (with a stale `previousPages` rollback
  // baseline, per the review). One `if (reordering) return;` guard at the
  // top of `submitMove` must cover BOTH paths.
  it('Enter cannot bypass the in-flight guard while a reorder is still pending (the button IS disabled, but Enter used to skip it)', async () => {
    // Never resolves — keeps `reordering` true so a second attempt via
    // Enter, while the first is still in flight, has something to bypass.
    uploadsSvc.reorderPages.mockReturnValue(new Promise<Page[]>(() => {}));
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    await user.click(screen.getByRole('button', { name: 'Reorder pages' }));
    const input = await screen.findByLabelText(/Move page 1 to position/);

    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(uploadsSvc.reorderPages).toHaveBeenCalledTimes(1));
    // The button is now disabled (visible confirmation the reorder is in flight).
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();

    // The INPUT itself is never disabled — type a new target and press
    // Enter directly on it, the path that used to skip the button check.
    await user.type(input, '4{Enter}');

    // Still exactly one call: the guard, not the (bypassable) disabled
    // button, is what stopped the second submission.
    expect(uploadsSvc.reorderPages).toHaveBeenCalledTimes(1);
  });
});

describe('UploadViewer — abort on unmount', () => {
  it('aborts the in-flight getUpload meta fetch on unmount', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    uploadsSvc.getUpload.mockImplementation(
      (_id: string, signal?: AbortSignal) =>
        new Promise<BookUpload>(() => {
          captured.signal = signal ?? null;
        }),
    );
    const { unmount } = renderViewer();
    await waitFor(() => expect(uploadsSvc.getUpload).toHaveBeenCalled());
    expect(captured.signal?.aborted).toBe(false);

    unmount();
    expect(captured.signal?.aborted).toBe(true);
  });

  it('aborts an in-flight listPages fetch on unmount', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    uploadsSvc.listPages.mockImplementation(
      (_id: string, signal?: AbortSignal) =>
        new Promise<Page[]>(() => {
          captured.signal = signal ?? null;
        }),
    );
    const user = userEvent.setup();
    const { unmount } = renderViewer();
    await screen.findByText('1 / 5');
    await user.click(screen.getByRole('button', { name: 'Reorder pages' }));
    await waitFor(() => expect(uploadsSvc.listPages).toHaveBeenCalled());

    unmount();
    expect(captured.signal?.aborted).toBe(true);
  });
});
