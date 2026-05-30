/**
 * Images page (Pass 8) — list render, upload → capture-open, real-image +
 * word-list (NO boxes) render, word-row → popover, upload error path,
 * uploading state, and the 🅂 mock badge off when real.
 *
 * `vi.hoisted` holds the fixtures + service spies so the hoisted `vi.mock`
 * factories can reference them without TDZ. The endpoint hook is mocked so the
 * list data is deterministic; the images service is mocked so upload/fetch are
 * controllable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';
import type { ImageCapture } from '../types/domain';

const { FIXTURE, UPLOADED, hookState, uploadImageMock, fetchImageMock } =
  vi.hoisted(() => {
    const fixture: ImageCapture[] = [
      {
        id: 'img1',
        name: '카페 메뉴판',
        caption_kr: '카페 메뉴판',
        caption_en: 'Café menu',
        blobUrl: '/images/img1/blob',
        words: [
          { id: 'w1', kr: '음료', en: 'beverage', pos: 'n.', gloss: 'beverage' },
          { id: 'w2', kr: '오늘', en: 'today', pos: 'n.', gloss: 'today' },
        ],
        capturedAt: '2026-05-28T10:14:00+09:00',
      },
    ];
    const uploaded: ImageCapture = {
      id: 'up9',
      name: 'upload.jpg',
      caption_kr: '새 캡처',
      caption_en: 'A fresh capture',
      blobUrl: '/images/up9/blob',
      words: [
        { id: 'u1', kr: '버스', en: 'bus', pos: 'n.', gloss: 'city bus' },
      ],
      capturedAt: '2026-05-30T09:00:00+09:00',
    };
    return {
      FIXTURE: fixture,
      UPLOADED: uploaded,
      hookState: {
        data: fixture as ImageCapture[] | null,
        loading: false,
        error: null as unknown,
        isMock: true,
      },
      uploadImageMock: vi.fn(),
      fetchImageMock: vi.fn(),
    };
  });

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: () => ({
    data: hookState.data,
    loading: hookState.loading,
    error: hookState.error,
    isMock: hookState.isMock,
    refetch: () => undefined,
  }),
}));

vi.mock('../services/images', () => ({
  uploadImage: uploadImageMock,
  fetchImage: fetchImageMock,
  fetchImages: vi.fn(),
}));

// Pull the page AFTER the mocks are set up.
import Images from './Images';

beforeEach(() => {
  hookState.data = FIXTURE;
  hookState.loading = false;
  hookState.error = null;
  hookState.isMock = true;
  uploadImageMock.mockReset();
  fetchImageMock.mockReset();
});

function pickFile(): Promise<void> {
  const user = userEvent.setup();
  const input = screen.getByLabelText(/Upload an image/i);
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'upload.jpg', {
    type: 'image/jpeg',
  });
  return user.upload(input, file);
}

describe('Images page — list view', () => {
  it('renders the upload card and sample list', () => {
    render(<Images />);
    expect(screen.getByText('Capture or upload')).toBeInTheDocument();
    expect(screen.getByText(/Or try a sample/)).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /카페 메뉴판/ }).length,
    ).toBeGreaterThan(0);
  });

  it('shows the 🅂 mock badge when on mock data and hides it when real', () => {
    const { rerender } = render(<Images />);
    expect(screen.getByTestId('mock-badge')).toBeInTheDocument();

    hookState.isMock = false;
    rerender(<Images />);
    expect(screen.queryByTestId('mock-badge')).not.toBeInTheDocument();
  });
});

describe('Images page — capture view (no boxes)', () => {
  it('opens the CaptureView with the real image and word list, no overlay boxes', async () => {
    const user = userEvent.setup();
    render(<Images />);

    const sampleButtons = screen.getAllByRole('button', {
      name: /카페 메뉴판/,
    });
    await user.click(sampleButtons[0]);

    expect(screen.getByText(/2 words detected/)).toBeInTheDocument();
    // The real photo renders with the caption as alt text.
    const img = screen.getByAltText('Café menu');
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toBe('/images/img1/blob');
    // The detected-word list is the sole tap surface — both words appear.
    expect(screen.getByText('Detected words')).toBeInTheDocument();
    expect(within(document.body).getByText('음료')).toBeInTheDocument();
    expect(within(document.body).getByText('오늘')).toBeInTheDocument();
    // No bounding-box overlay buttons exist anymore.
    expect(document.querySelector('.km-images__ocrbox')).toBeNull();
  });

  it('opens WordPopover when a detected-word row is tapped', async () => {
    const user = userEvent.setup();
    render(<Images />);

    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Open 음료' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('음료')).toBeInTheDocument();
    // The popover surfaces the gloss in more than one slot (headword + note),
    // so assert presence without requiring a single match.
    expect(within(dialog).getAllByText(/beverage/).length).toBeGreaterThan(0);
  });

  it('hydrates words via fetchImage when a list capture arrives without them', async () => {
    // Simulate the real `GET /images` list (summaries with empty words).
    hookState.data = [{ ...FIXTURE[0], words: [] }];
    hookState.isMock = false;
    fetchImageMock.mockResolvedValueOnce(FIXTURE[0]);

    const user = userEvent.setup();
    render(<Images />);

    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);

    expect(fetchImageMock).toHaveBeenCalledWith('img1');
    // After hydration the words appear.
    await waitFor(() => {
      expect(within(document.body).getByText('음료')).toBeInTheDocument();
    });
  });
});

describe('Images page — upload', () => {
  it('shows an uploading state while the upload is in flight', async () => {
    let resolveUpload!: (cap: ImageCapture) => void;
    uploadImageMock.mockReturnValueOnce(
      new Promise<ImageCapture>((res) => {
        resolveUpload = res;
      }),
    );

    render(<Images />);
    await pickFile();

    // The card flips to its busy copy + spinner while in flight.
    expect(screen.getByText('Reading your image…')).toBeInTheDocument();
    expect(screen.getByTestId('upload-spinner')).toBeInTheDocument();

    // Resolve → the new capture opens.
    resolveUpload(UPLOADED);
    await waitFor(() => {
      expect(screen.getByAltText('A fresh capture')).toBeInTheDocument();
    });
  });

  it('opens the uploaded capture on success', async () => {
    uploadImageMock.mockResolvedValueOnce(UPLOADED);

    render(<Images />);
    await pickFile();

    await waitFor(() => {
      // Single detected word → singular noun ("1 word", not "1 words").
      expect(screen.getByText(/1 word detected/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/1 words detected/)).not.toBeInTheDocument();
    expect(screen.getByAltText('A fresh capture')).toBeInTheDocument();
    expect(within(document.body).getByText('버스')).toBeInTheDocument();
  });

  it('surfaces an inline error and stays on the list when upload fails', async () => {
    uploadImageMock.mockRejectedValueOnce(
      new ApiError('daily limit reached', {
        status: 429,
        code: 'rate_limited',
      }),
    );

    render(<Images />);
    await pickFile();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('daily limit reached');
    // The list view is still rendered (upload card present) — not broken.
    expect(screen.getByText('Capture or upload')).toBeInTheDocument();

    // The error is dismissable.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
