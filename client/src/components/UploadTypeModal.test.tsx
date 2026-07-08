/**
 * UploadTypeModal (U1b, page-image rework) — the two-step upload flow: type
 * chips → file + title → `uploadBook`. Covers every type choosing the right
 * service call, the filename-default title (with `.pdf`/`.zip` stripped,
 * and that a manual edit isn't clobbered by picking a new file), the client
 * pre-check (a file that's neither a PDF nor a zip is rejected before any
 * network call; a zip IS accepted), success (`onUploaded` + `onClose`), a
 * server failure (fixed copy, modal stays open), and abort-on-close/unmount.
 *
 * `checkBookFile` runs for REAL (not mocked) so the pre-check assertions
 * exercise the actual validation logic, not a stand-in; only `uploadBook`
 * is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UploadTypeModal } from './UploadTypeModal';
import { uploadBook } from '../services/uploads';
import { ApiError } from '../services/api';
import type { BookUpload, BookUploadType } from '../types/domain';

vi.mock('../services/uploads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/uploads')>();
  return { ...actual, uploadBook: vi.fn() };
});

beforeEach(() => {
  vi.mocked(uploadBook).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const READY: BookUpload = {
  id: '9',
  title: '한국어 문법 사전',
  type: 'grammar',
  status: 'processing',
  byteSize: 1024,
  createdAt: '2026-07-01T00:00:00Z',
};

function makePdfFile(name = 'my-book.pdf'): File {
  return new File([new Uint8Array(1024)], name, { type: 'application/pdf' });
}

function makeJpegFile(name = 'photo.jpg'): File {
  return new File([new Uint8Array(10)], name, { type: 'image/jpeg' });
}

function makeZipFile(name = 'vflat-export.zip'): File {
  return new File([new Uint8Array(1024)], name, { type: 'application/zip' });
}

/** Every TYPE_OPTIONS chip's rendered (default both-mode) accessible name. */
const TYPE_LABELS: Record<BookUploadType, string> = {
  vocab: '단어 · Vocabulary',
  grammar: '문법 · Grammar',
  both: '단어 + 문법 · Vocab + grammar',
  dialogue: '대화 · Dialogue',
  literature: '문학 · Literature',
};

function renderModal(
  props: Partial<{
    open: boolean;
    onClose: () => void;
    onUploaded: (upload: BookUpload) => void;
  }> = {},
): {
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onUploaded: ReturnType<typeof vi.fn<(upload: BookUpload) => void>>;
} & ReturnType<typeof render> {
  const onClose = vi.fn<() => void>();
  const onUploaded = vi.fn<(upload: BookUpload) => void>();
  const result = render(
    <UploadTypeModal
      open={props.open ?? true}
      onClose={props.onClose ?? onClose}
      onUploaded={props.onUploaded ?? onUploaded}
    />,
  );
  return { ...result, onClose, onUploaded };
}

describe('UploadTypeModal — closed state', () => {
  it('renders nothing when closed', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('UploadTypeModal — type step', () => {
  it('shows all five bilingual type chips', async () => {
    renderModal();
    const dialog = await screen.findByRole('dialog', { name: 'Upload a book' });
    for (const label of Object.values(TYPE_LABELS)) {
      expect(within(dialog).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it.each(Object.entries(TYPE_LABELS) as [BookUploadType, string][])(
    'selecting %s advances to the file step',
    async (_type, label) => {
      const user = userEvent.setup();
      renderModal();
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: label }));
      expect(within(dialog).getByText('Book file')).toBeInTheDocument();
      expect(
        within(dialog).getByRole('button', { name: 'Choose a PDF or zip…' }),
      ).toBeInTheDocument();
    },
  );

  it('Back from the file step returns to the type step', async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.vocab }));
    expect(within(dialog).getByText('Book file')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /뒤로/ }));
    expect(within(dialog).getByRole('button', { name: TYPE_LABELS.vocab })).toBeInTheDocument();
  });
});

describe('UploadTypeModal — file + title step', () => {
  it('defaults the title to the filename with .pdf stripped', async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.grammar }));

    const fileInput = within(dialog).getByLabelText('Book file') as HTMLInputElement;
    await user.upload(fileInput, makePdfFile('KGIU-Book.pdf'));

    const titleInput = within(dialog).getByLabelText('Title') as HTMLInputElement;
    expect(titleInput.value).toBe('KGIU-Book');
  });

  it('accepts a vFlat zip export (a zip of page images), stripping .zip from the default title', async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.vocab }));

    const fileInput = within(dialog).getByLabelText('Book file') as HTMLInputElement;
    await user.upload(fileInput, makeZipFile('2000-Essential-Words.zip'));

    expect(screen.queryByText(/isn.t a PDF or a zip/)).not.toBeInTheDocument();
    const titleInput = within(dialog).getByLabelText('Title') as HTMLInputElement;
    expect(titleInput.value).toBe('2000-Essential-Words');
    expect(within(dialog).getByRole('button', { name: '2000-Essential-Words.zip' })).toBeInTheDocument();
  });

  it('does not clobber a manually-edited title when a new file is picked', async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.grammar }));

    const fileInput = within(dialog).getByLabelText('Book file') as HTMLInputElement;
    await user.upload(fileInput, makePdfFile('first.pdf'));
    const titleInput = within(dialog).getByLabelText('Title') as HTMLInputElement;
    await user.clear(titleInput);
    await user.type(titleInput, 'My custom title');

    await user.upload(fileInput, makePdfFile('second.pdf'));
    expect(titleInput.value).toBe('My custom title');
  });

  it('rejects a non-PDF file with fixed copy and never calls uploadBook', async () => {
    // `applyAccept: false` — the real browser's OS file-picker already
    // filters by `accept="application/pdf"` (userEvent enforces the same
    // filter by default and would silently drop a non-matching file before
    // it ever reaches our onChange). This test exercises the CLIENT
    // pre-check itself — the defense for the cases the OS picker doesn't
    // catch (drag-and-drop, a lenient mobile browser, programmatic
    // assignment) — so it deliberately opts out of that simulated filter.
    const user = userEvent.setup({ applyAccept: false });
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.dialogue }));

    const fileInput = within(dialog).getByLabelText('Book file') as HTMLInputElement;
    await user.upload(fileInput, makeJpegFile());

    expect(await within(dialog).findByText(/isn.t a PDF/)).toBeInTheDocument();
    expect(uploadBook).not.toHaveBeenCalled();
    // No file accepted — the file-choose button still shows the placeholder.
    expect(within(dialog).getByRole('button', { name: 'Choose a PDF or zip…' })).toBeInTheDocument();
  });

  it('submits (file, type, trimmed title, signal) and fires onUploaded + onClose on success', async () => {
    vi.mocked(uploadBook).mockResolvedValue(READY);
    const user = userEvent.setup();
    const { onClose, onUploaded } = renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.literature }));

    const fileInput = within(dialog).getByLabelText('Book file') as HTMLInputElement;
    const file = makePdfFile('novel.pdf');
    await user.upload(fileInput, file);

    const titleInput = within(dialog).getByLabelText('Title') as HTMLInputElement;
    await user.clear(titleInput);
    await user.type(titleInput, '  소나기  ');

    await user.click(within(dialog).getByRole('button', { name: /Upload/ }));

    await waitFor(() => {
      expect(uploadBook).toHaveBeenCalledTimes(1);
    });
    const [sentFile, sentType, sentTitle, signal] = vi.mocked(uploadBook).mock.calls[0];
    expect(sentFile).toBe(file);
    expect(sentType).toBe('literature');
    // Trimmed, not the raw whitespace-padded value.
    expect(sentTitle).toBe('소나기');
    expect(signal).toBeInstanceOf(AbortSignal);

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith(READY);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // C-S3 regression: the title input had no length cap, so a >200-char
  // title round-tripped to a server 400 with (pre C-S2) misleading copy.
  // `maxLength` on the input is the primary defense (blocks typing/pasting
  // past the cap in a real browser); this asserts the DOM attribute exists
  // at the exact value the server's `UploadBodySchema`/migration-040 CHECK
  // enforces (200), so the two limits can't silently drift apart.
  it('caps the title input at 200 characters (the server\'s exact limit)', async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.grammar }));

    const titleInput = within(dialog).getByLabelText('Title') as HTMLInputElement;
    expect(titleInput.maxLength).toBe(200);
  });

  it('rejects a title over 200 characters client-side (defense-in-depth) and never calls uploadBook', async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.grammar }));

    const fileInput = within(dialog).getByLabelText('Book file') as HTMLInputElement;
    await user.upload(fileInput, makePdfFile());

    // Bypass the native `maxLength` truncation (simulating a programmatic
    // value assignment) to exercise the `submit()`-level guard directly.
    const titleInput = within(dialog).getByLabelText('Title') as HTMLInputElement;
    const overLong = 'a'.repeat(201);
    fireEvent.change(titleInput, { target: { value: overLong } });

    await user.click(within(dialog).getByRole('button', { name: /Upload/ }));

    expect(await within(dialog).findByText(/200 characters max/)).toBeInTheDocument();
    expect(uploadBook).not.toHaveBeenCalled();
  });

  // C-S5: a real (up to ~300 MB) book upload can run minutes — the button
  // must show real progress driven by `uploadBook`'s `onProgress` callback,
  // not a static "Uploading…" the whole time.
  it('shows an upload-progress percentage driven by onProgress, not a static label', async () => {
    let capturedOnProgress: ((percent: number) => void) | undefined;
    vi.mocked(uploadBook).mockImplementation(
      (_file, _type, _title, _signal, onProgress) =>
        new Promise<BookUpload>(() => {
          capturedOnProgress = onProgress;
        }),
    );
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.grammar }));
    await user.upload(
      within(dialog).getByLabelText('Book file') as HTMLInputElement,
      makePdfFile(),
    );
    await user.click(within(dialog).getByRole('button', { name: /Upload/ }));

    await waitFor(() => expect(uploadBook).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText(/Uploading…$/)).toBeInTheDocument();

    act(() => {
      capturedOnProgress?.(42);
    });
    expect(await within(dialog).findByText(/Uploading… 42%/)).toBeInTheDocument();

    act(() => {
      capturedOnProgress?.(100);
    });
    expect(await within(dialog).findByText(/Uploading… 100%/)).toBeInTheDocument();
  });

  it('a server failure surfaces fixed copy (never raw server prose) and keeps the modal open', async () => {
    vi.mocked(uploadBook).mockRejectedValue(
      new ApiError('internal driver detail', { status: 413, code: 'payload_too_large' }),
    );
    const user = userEvent.setup();
    const { onClose } = renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.vocab }));
    await user.upload(
      within(dialog).getByLabelText('Book file') as HTMLInputElement,
      makePdfFile(),
    );
    await user.click(within(dialog).getByRole('button', { name: /Upload/ }));

    expect(await within(dialog).findByText(/too large/)).toBeInTheDocument();
    expect(screen.queryByText('internal driver detail')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('UploadTypeModal — abort discipline', () => {
  it('aborts the in-flight upload when the modal closes mid-request', async () => {
    // Object wrapper (not a bare `let`) so the mutation inside the mocked
    // uploadBook's Promise executor is unambiguous to read back afterward.
    const captured: { signal: AbortSignal | null } = { signal: null };
    vi.mocked(uploadBook).mockImplementation(
      (_file, _type, _title, signal) =>
        new Promise<BookUpload>(() => {
          captured.signal = signal ?? null;
        }),
    );
    const user = userEvent.setup();
    const { rerender, onClose } = renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.grammar }));
    await user.upload(
      within(dialog).getByLabelText('Book file') as HTMLInputElement,
      makePdfFile(),
    );
    await user.click(within(dialog).getByRole('button', { name: /Upload/ }));

    await waitFor(() => {
      expect(uploadBook).toHaveBeenCalledTimes(1);
    });
    expect(captured.signal?.aborted).toBe(false);

    // Parent closes the modal while the upload is still pending.
    const noopOnUploaded = vi.fn<(upload: BookUpload) => void>();
    rerender(<UploadTypeModal open={false} onClose={onClose} onUploaded={noopOnUploaded} />);

    await waitFor(() => {
      expect(captured.signal?.aborted).toBe(true);
    });
  });

  it('aborts the in-flight upload on unmount', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    vi.mocked(uploadBook).mockImplementation(
      (_file, _type, _title, signal) =>
        new Promise<BookUpload>(() => {
          captured.signal = signal ?? null;
        }),
    );
    const user = userEvent.setup();
    const { unmount } = renderModal();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: TYPE_LABELS.grammar }));
    await user.upload(
      within(dialog).getByLabelText('Book file') as HTMLInputElement,
      makePdfFile(),
    );
    await user.click(within(dialog).getByRole('button', { name: /Upload/ }));

    await waitFor(() => {
      expect(uploadBook).toHaveBeenCalledTimes(1);
    });

    act(() => {
      unmount();
    });

    expect(captured.signal?.aborted).toBe(true);
  });
});
