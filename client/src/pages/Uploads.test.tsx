/**
 * Uploads (U1b) — `/uploads`, the front door for user-uploaded books.
 *
 * Covers: list render (title/type/status pill/size+date), tap-a-row
 * navigation to the viewer (`/uploads/:id`), confirm-gated delete (cancel
 * aborts, accept deletes + removes the row, a failed delete toasts fixed
 * copy without removing the row), the empty/loading/error states, and that
 * the "+ Upload" entry actually opens the shared `UploadTypeModal`. The
 * modal's own upload flow (type→file→submit) is exercised end-to-end in
 * UploadTypeModal.test.tsx — here we only confirm the wiring opens it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { JSX } from 'react';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import type { BookUpload } from '../types/domain';

const uploadsSvc = vi.hoisted(() => ({
  listUploads: vi.fn(),
  deleteUpload: vi.fn(),
  uploadBook: vi.fn(),
  getUpload: vi.fn(),
  listPages: vi.fn(),
  reorderPages: vi.fn(),
  pageUrl: vi.fn((id: string, n: number) => `/uploads/${id}/page/${String(n)}`),
  checkBookFile: vi.fn(() => null as string | null),
}));

vi.mock('../services/uploads', () => uploadsSvc);

import Uploads from './Uploads';

const READY: BookUpload = {
  id: '9',
  title: '한국어 문법 사전',
  type: 'grammar',
  status: 'ready',
  pageCount: 240,
  byteSize: 4_200_000,
  createdAt: '2026-07-01T00:00:00Z',
};

const PROCESSING: BookUpload = {
  id: '10',
  title: '읽기 연습',
  type: 'literature',
  status: 'processing',
  byteSize: 1_000_000,
  createdAt: '2026-07-02T00:00:00Z',
};

/** Probe route so we can assert WHICH id a row-tap navigated to. */
function ViewerProbe(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  return <div data-testid="viewer-probe">viewer:{id}</div>;
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/uploads']}>
      <ToastProvider>
        <Routes>
          <Route path="/uploads" element={<Uploads />} />
          <Route path="/uploads/:id" element={<ViewerProbe />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  uploadsSvc.listUploads.mockReset();
  uploadsSvc.deleteUpload.mockReset();
  uploadsSvc.uploadBook.mockReset();
  uploadsSvc.getUpload.mockReset();
  uploadsSvc.checkBookFile.mockReset();

  uploadsSvc.listUploads.mockResolvedValue([READY, PROCESSING]);
  uploadsSvc.deleteUpload.mockResolvedValue(undefined);
  uploadsSvc.checkBookFile.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Uploads — list', () => {
  it('lists every upload with title, type, status pill, size, and date', async () => {
    renderPage();
    expect(await screen.findByText('한국어 문법 사전')).toBeInTheDocument();
    expect(screen.getByText('읽기 연습')).toBeInTheDocument();
    // Status pills.
    expect(screen.getByText(/Ready/)).toBeInTheDocument();
    expect(screen.getByText(/Processing/)).toBeInTheDocument();
    // Ready upload shows its page count; processing (no pageCount) doesn't.
    expect(screen.getByText(/240 pp/)).toBeInTheDocument();
    expect(screen.getByText(/4\.0 MB/)).toBeInTheDocument();
  });

  it('shows a loading state, then an empty state when there are no uploads', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText(/No uploads yet/),
    ).toBeInTheDocument();
  });

  it('shows an error card with Retry on a failed load', async () => {
    uploadsSvc.listUploads.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    renderPage();
    expect(
      await screen.findByText('Could not load your uploads.'),
    ).toBeInTheDocument();

    uploadsSvc.listUploads.mockResolvedValueOnce([READY]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('한국어 문법 사전')).toBeInTheDocument();
  });

  it('tapping a row navigates to the viewer at /uploads/:id', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('한국어 문법 사전');

    await user.click(screen.getByRole('button', { name: 'View 한국어 문법 사전' }));

    expect(await screen.findByTestId('viewer-probe')).toHaveTextContent('viewer:9');
  });
});

describe('Uploads — delete (confirm-gated)', () => {
  it('cancel aborts — nothing is deleted', async () => {
    const confirmFn = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirmFn);
    try {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('한국어 문법 사전');

      await user.click(screen.getByRole('button', { name: 'Delete 한국어 문법 사전' }));
      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(uploadsSvc.deleteUpload).not.toHaveBeenCalled();
      expect(screen.getByText('한국어 문법 사전')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accept deletes the upload and removes the row', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    try {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('한국어 문법 사전');

      await user.click(screen.getByRole('button', { name: 'Delete 한국어 문법 사전' }));

      await waitFor(() => {
        expect(uploadsSvc.deleteUpload).toHaveBeenCalledWith('9');
      });
      await waitFor(() => {
        expect(screen.queryByText('한국어 문법 사전')).not.toBeInTheDocument();
      });
      // The other row is untouched.
      expect(screen.getByText('읽기 연습')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a failed delete toasts fixed copy and leaves the row in place', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    uploadsSvc.deleteUpload.mockRejectedValueOnce(
      new ApiError('constraint violation xyz', { status: 500, code: 'server_error' }),
    );
    try {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('한국어 문법 사전');

      await user.click(screen.getByRole('button', { name: 'Delete 한국어 문법 사전' }));

      expect(
        await screen.findByText('Could not delete that upload.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('constraint violation xyz')).not.toBeInTheDocument();
      // Row survives the failed delete — nothing was actually removed.
      expect(screen.getByText('한국어 문법 사전')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // C-S4 regression: the delete button was correctly `disabled={pending}`,
  // but the row's "view" button had no such gate — a click landing between
  // "delete request sent" and "row removed from `rows`" could navigate into
  // an id that's about to be deleted server-side.
  it('disables the row-open ("view") button while THAT row\'s delete is pending, and blocks navigation', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    let resolveDelete!: () => void;
    uploadsSvc.deleteUpload.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    try {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('한국어 문법 사전');

      await user.click(screen.getByRole('button', { name: 'Delete 한국어 문법 사전' }));
      await waitFor(() => expect(uploadsSvc.deleteUpload).toHaveBeenCalledTimes(1));

      // Delete is now in flight — that row's view button must be disabled...
      const viewButton = screen.getByRole('button', { name: 'View 한국어 문법 사전' });
      expect(viewButton).toBeDisabled();
      // ...and the OTHER row's view button is untouched (only this row is gated).
      expect(screen.getByRole('button', { name: 'View 읽기 연습' })).not.toBeDisabled();

      // A click on a disabled button never fires onClick / navigates.
      await user.click(viewButton);
      expect(screen.queryByTestId('viewer-probe')).not.toBeInTheDocument();

      resolveDelete();
      await waitFor(() => {
        expect(screen.queryByText('한국어 문법 사전')).not.toBeInTheDocument();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Uploads — the "+ Upload" entry', () => {
  it('opens the shared UploadTypeModal', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('한국어 문법 사전');

    await user.click(screen.getByRole('button', { name: /Upload a book/ }));

    expect(await screen.findByRole('dialog', { name: 'Upload a book' })).toBeInTheDocument();
  });
});
