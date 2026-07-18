/**
 * Uploads (U1b) — `/uploads`, the front door for user-uploaded books.
 *
 * Covers: list render (title/type/status pill/size+date), the F-058
 * viewable-rendition filter (rendition-less `ready`-with-no-pages ghosts are
 * excluded; processing/failed lifecycle rows are not), tap-a-row navigation
 * to the viewer (`/uploads/:id`), the F-024 back control (→ /review, the
 * library index that links here), confirm-gated delete (cancel aborts,
 * accept deletes + removes the row, a failed delete toasts fixed copy
 * without removing the row), the empty/loading/error states, and that the
 * "+ Upload" entry actually opens the shared `UploadTypeModal`. The modal's
 * own upload flow (type→file→submit) is exercised end-to-end in
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
          <Route
            path="/review"
            element={<div data-testid="review-probe">review</div>}
          />
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

  it("shows the bilingual Picture / Comic / Manga type label on a 'comic' upload row (Track P)", async () => {
    const comic: BookUpload = {
      id: '11',
      title: '만화 모험',
      type: 'comic',
      status: 'ready',
      pageCount: 24,
      byteSize: 2_400_000,
      createdAt: '2026-07-03T00:00:00Z',
    };
    uploadsSvc.listUploads.mockResolvedValue([comic]);
    renderPage();

    expect(await screen.findByText('만화 모험')).toBeInTheDocument();
    // TYPE_META is a total Record over BookUploadType — a missing 'comic'
    // entry would crash the row render, so the visible label is the proof.
    expect(screen.getByText(/Picture \/ Comic \/ Manga/)).toBeInTheDocument();
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

  // F-024: the listing is a nested page (Library → Uploads) — its back
  // control targets the library index that links here, deterministically.
  it('the back control navigates to the Library index', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('한국어 문법 사전');

    // The label comes from navItem('review') — the tab is "Library" (F-043).
    await user.click(screen.getByRole('button', { name: 'Back to Library' }));

    expect(await screen.findByTestId('review-probe')).toBeInTheDocument();
  });
});

// F-058 — the listing shows only uploads with a viewable page-image
// rendition. `ready` rows WITHOUT pages are pre-041 legacy ghosts (their
// original PDF blob was dropped by the migration, nothing viewable remains)
// and must be excluded; `processing`/`failed` are lifecycle states of a
// real rendition and must stay visible.
describe('Uploads — F-058 viewable-rendition filter', () => {
  const GHOST_NO_COUNT: BookUpload = {
    id: '11',
    title: '유령 업로드',
    type: 'vocab',
    status: 'ready',
    // No pageCount at all — the pre-041 shape.
    byteSize: 2_000_000,
    createdAt: '2026-05-01T00:00:00Z',
  };

  const GHOST_ZERO: BookUpload = {
    id: '12',
    title: '빈 업로드',
    type: 'vocab',
    status: 'ready',
    pageCount: 0,
    byteSize: 500_000,
    createdAt: '2026-05-02T00:00:00Z',
  };

  const FAILED: BookUpload = {
    id: '13',
    title: '실패한 업로드',
    type: 'dialogue',
    status: 'failed',
    byteSize: 3_000_000,
    createdAt: '2026-07-03T00:00:00Z',
  };

  it('excludes ready-with-no-pages ghosts but keeps processing and failed rows', async () => {
    uploadsSvc.listUploads.mockResolvedValue([
      READY,
      GHOST_NO_COUNT,
      PROCESSING,
      GHOST_ZERO,
      FAILED,
    ]);
    renderPage();

    // Real renditions (and lifecycle states of one) all render…
    expect(await screen.findByText('한국어 문법 사전')).toBeInTheDocument();
    expect(screen.getByText('읽기 연습')).toBeInTheDocument();
    expect(screen.getByText('실패한 업로드')).toBeInTheDocument();
    // …the rendition-less ghosts do not.
    expect(screen.queryByText('유령 업로드')).not.toBeInTheDocument();
    expect(screen.queryByText('빈 업로드')).not.toBeInTheDocument();
  });

  it('a listing of ONLY ghosts renders the empty state, not dead rows', async () => {
    uploadsSvc.listUploads.mockResolvedValue([GHOST_NO_COUNT, GHOST_ZERO]);
    renderPage();
    expect(await screen.findByText(/No uploads yet/)).toBeInTheDocument();
    expect(screen.queryByText('유령 업로드')).not.toBeInTheDocument();
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

// F-128 "Seoul Day & Night" reskin — the shared hub-header recipe
// (PageHubHeader: SkylineHeader + DancheongRail) replaces the bare Topbar,
// and each row is a CityCard.
describe('Uploads — F-128 reskin', () => {
  it('renders the skyline hub-header, the rail divider, and a CityCard per row', async () => {
    renderPage();
    await screen.findByText('한국어 문법 사전');

    expect(document.querySelector('.km-hubheader__skyline')).toBeInTheDocument();
    expect(document.querySelector('.km-hubheader__rail-divider')).toBeInTheDocument();
    // Two rows (READY + PROCESSING) → two CityCards.
    expect(document.querySelectorAll('.km-uploads__card.km-citycard')).toHaveLength(2);

    // The real <h1> still carries the page title and the section's
    // aria-labelledby target — the reskin didn't drop the heading contract.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('id', 'km-uploads-title');
  });

  it('textures the empty state with the giwa/hangul-watermark devices', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    renderPage();

    const empty = await screen.findByText(/No uploads yet/);
    const wrap = empty.closest('.km-reference__empty');
    expect(wrap).toHaveClass('km-giwa', 'km-hangul-watermark');
    expect(wrap).toHaveAttribute('data-glyph', '책');
  });
});
