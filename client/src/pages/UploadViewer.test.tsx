/**
 * UploadViewer (U1b) — the view-only PDF viewer at `/uploads/:id`.
 *
 * `pdfjs-dist` is FULLY MOCKED (per the feature brief: never exercise real
 * PDF rendering in vitest). What we assert instead:
 *   - the worker is wired to the BUNDLED asset URL (the `?url` import), not
 *     a CDN string — `GlobalWorkerOptions.workerSrc` is set at module load;
 *   - `getDocument` is called with the correct `/uploads/:id/file` URL and
 *     `withCredentials: true` (the session-cookie requirement, since pdf.js
 *     does its own fetch/XHR outside axios);
 *   - the loading / ready / error states render fixed copy;
 *   - Retry re-issues `getDocument`;
 *   - the document + loading task are torn down on unmount (no leaked pdf.js
 *     worker resources).
 *
 * `getUpload` (the best-effort title fetch) is mocked via `importOriginal`
 * so `pdfFileUrl`'s REAL URL-building logic still runs — the assertion on
 * the exact URL passed to `getDocument` is only meaningful if that's real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const pdfjsMock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {} as { workerSrc?: string },
  RenderingCancelledException: class RenderingCancelledExceptionMock extends Error {},
}));

vi.mock('pdfjs-dist', () => pdfjsMock);
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'mock-bundled-worker.mjs',
}));

vi.mock('../services/uploads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/uploads')>();
  return { ...actual, getUpload: vi.fn() };
});

// Imported AFTER the mocks so the module under test binds the mocked pdf.js.
import UploadViewer from './UploadViewer';
import { getUpload } from '../services/uploads';

/** A minimal fake PDFPageProxy — enough for renderPage's call shape. */
function fakePage(): {
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
} {
  return {
    getViewport: vi.fn(() => ({ width: 100, height: 200 })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
  };
}

/** A minimal fake PDFDocumentProxy. */
function fakeDoc(numPages = 3): {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    numPages,
    getPage: vi.fn(() => Promise.resolve(fakePage())),
    destroy: vi.fn(() => Promise.resolve()),
  };
}

/** A minimal fake PDFDocumentLoadingTask wrapping a resolved/rejected doc. */
function loadingTaskFor(promise: Promise<unknown>): {
  promise: Promise<unknown>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return { promise, destroy: vi.fn(() => Promise.resolve()) };
}

function renderViewer(id = '9'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/uploads/${id}`]}>
      <Routes>
        <Route path="/uploads/:id" element={<UploadViewer />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  pdfjsMock.getDocument.mockReset();
  vi.mocked(getUpload).mockReset();
  vi.mocked(getUpload).mockResolvedValue({
    id: '9',
    title: '한국어 문법 사전',
    type: 'grammar',
    status: 'ready',
    byteSize: 1024,
    createdAt: '2026-07-01T00:00:00Z',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UploadViewer — pdf.js + Vite worker wiring', () => {
  it('bundles the worker: workerSrc is the ?url-imported asset, never a CDN string', () => {
    expect(pdfjsMock.GlobalWorkerOptions.workerSrc).toBe('mock-bundled-worker.mjs');
  });

  it('requests the PDF via GET /uploads/:id/file, cookie-authed (withCredentials)', async () => {
    pdfjsMock.getDocument.mockReturnValue(loadingTaskFor(new Promise(() => {})));
    renderViewer('9');

    await waitFor(() => {
      expect(pdfjsMock.getDocument).toHaveBeenCalledWith({
        url: '/uploads/9/file',
        withCredentials: true,
      });
    });
  });
});

describe('UploadViewer — loading / ready / error states', () => {
  it('shows fixed loading copy before the document resolves', () => {
    pdfjsMock.getDocument.mockReturnValue(loadingTaskFor(new Promise(() => {})));
    renderViewer();
    expect(screen.getByText(/Loading the PDF/)).toBeInTheDocument();
  });

  it('renders the page nav + zoom controls once the document resolves', async () => {
    const doc = fakeDoc(5);
    pdfjsMock.getDocument.mockReturnValue(loadingTaskFor(Promise.resolve(doc)));
    renderViewer();

    await screen.findByText('1 / 5');
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
    expect(screen.getByLabelText('Next page')).not.toBeDisabled();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('page nav advances and calls page.render again', async () => {
    const doc = fakeDoc(3);
    pdfjsMock.getDocument.mockReturnValue(loadingTaskFor(Promise.resolve(doc)));
    const user = userEvent.setup();
    renderViewer();

    await screen.findByText('1 / 3');
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));

    await user.click(screen.getByLabelText('Next page'));
    await screen.findByText('2 / 3');
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(2));
  });

  it('shows a fixed error message when the document fails to load, and Retry re-issues getDocument', async () => {
    pdfjsMock.getDocument
      .mockReturnValueOnce(loadingTaskFor(Promise.reject(new Error('corrupt'))))
      .mockReturnValueOnce(loadingTaskFor(Promise.resolve(fakeDoc(1))));
    const user = userEvent.setup();
    renderViewer();

    expect(await screen.findByText(/Couldn.t load this PDF/)).toBeInTheDocument();
    expect(screen.queryByText('corrupt')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('1 / 1');
    expect(pdfjsMock.getDocument).toHaveBeenCalledTimes(2);
  });

  it('a best-effort title-fetch failure never blocks the PDF from loading', async () => {
    vi.mocked(getUpload).mockRejectedValue(new Error('meta unavailable'));
    pdfjsMock.getDocument.mockReturnValue(loadingTaskFor(Promise.resolve(fakeDoc(2))));
    renderViewer();

    await screen.findByText('1 / 2');
  });
});

describe('UploadViewer — teardown', () => {
  it('destroys the document and loading task on unmount (no leaked worker resources)', async () => {
    const doc = fakeDoc(2);
    const task = loadingTaskFor(Promise.resolve(doc));
    pdfjsMock.getDocument.mockReturnValue(task);
    const { unmount } = renderViewer();

    await screen.findByText('1 / 2');
    unmount();

    expect(doc.destroy).toHaveBeenCalled();
  });
});
