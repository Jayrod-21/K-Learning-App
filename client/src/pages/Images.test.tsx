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
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';
import type { ImageCapture } from '../types/domain';

const {
  FIXTURE,
  UPLOADED,
  hookState,
  uploadImageMock,
  fetchImageMock,
  mineWordMock,
} = vi.hoisted(() => {
    const fixture: ImageCapture[] = [
      {
        id: 'img1',
        name: '카페 메뉴판',
        caption_kr: '카페 메뉴판',
        caption_en: 'Café menu',
        blobUrl: '/images/img1/blob',
        // WIRE FIDELITY: OCR words carry NO id (`ImageWordDTO` is
        // kr/en/gloss/pos only) — the added-set must key on a derived
        // position+text key, never a fabricated id.
        words: [
          { kr: '음료', en: 'beverage', pos: 'n.', gloss: 'beverage' },
          { kr: '오늘', en: 'today', pos: 'n.', gloss: 'today' },
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
      words: [{ kr: '버스', en: 'bus', pos: 'n.', gloss: 'city bus' }],
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
      mineWordMock: vi.fn(),
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

vi.mock('../services/vocab', () => ({
  mineWord: mineWordMock,
}));

// Pull the page AFTER the mocks are set up.
import Images from './Images';
import { ToastProvider } from '../components/ToastProvider';

/**
 * Images consumes `useToast` (FU-NF-33 bank-failure surface), so every render
 * needs a `<ToastProvider/>` in the tree.
 */
function renderImages(): ReturnType<typeof render> {
  return render((<Images />) as ReactElement, {
    wrapper: ({ children }) => <ToastProvider>{children}</ToastProvider>,
  });
}

beforeEach(() => {
  hookState.data = FIXTURE;
  hookState.loading = false;
  hookState.error = null;
  hookState.isMock = true;
  uploadImageMock.mockReset();
  fetchImageMock.mockReset();
  mineWordMock.mockReset();
  mineWordMock.mockResolvedValue({ entryId: 1, card: { id: 10, version: 1 } });
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
    renderImages();
    expect(screen.getByText('Capture or upload')).toBeInTheDocument();
    expect(screen.getByText(/Or try a sample/)).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /카페 메뉴판/ }).length,
    ).toBeGreaterThan(0);
  });

  it('P3b: title + trimmed nav eyebrow render Korean in both-mode', () => {
    renderImages();
    expect(
      screen.getByRole('heading', { level: 1, name: '이미지 · Images' }),
    ).toBeInTheDocument();
    // nav.ts pair — the old "mine real-world Korean" wording is gone.
    expect(screen.getByText('OCR · 실생활 한국어')).toBeInTheDocument();
    expect(screen.getByText('OCR · real-world Korean')).toBeInTheDocument();
    expect(
      screen.queryByText(/mine real-world Korean/),
    ).not.toBeInTheDocument();
  });

  it('shows the 🅂 mock badge when on mock data and hides it when real', () => {
    const { rerender } = renderImages();
    expect(screen.getByTestId('mock-badge')).toBeInTheDocument();

    hookState.isMock = false;
    rerender(
      <ToastProvider>
        <Images />
      </ToastProvider>,
    );
    expect(screen.queryByTestId('mock-badge')).not.toBeInTheDocument();
  });
});

describe('Images page — capture view (no boxes)', () => {
  it('opens the CaptureView with the real image and word list, no overlay boxes', async () => {
    const user = userEvent.setup();
    renderImages();

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

  it('applies the staggered OCR-entrance class with a capped per-index delay', async () => {
    // A1 adaptation: detected-word rows cascade in (single ~460ms `rise`,
    // 100ms apart, capped at 12 rows), NOT a 1.6s infinite pulse on dropped
    // coordinate boxes. Reduced-motion is handled by the global CSS block.
    const user = userEvent.setup();
    renderImages();
    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);

    const rows = document.querySelectorAll('.km-images__detected-row--enter');
    expect(rows.length).toBe(2);
    // i-th row gets animation-delay = min(i, 12) * 100ms.
    expect((rows[0] as HTMLElement).style.animationDelay).toBe('0ms');
    expect((rows[1] as HTMLElement).style.animationDelay).toBe('100ms');
  });

  it('opens WordPopover when a detected-word row is tapped', async () => {
    const user = userEvent.setup();
    renderImages();

    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Open 음료' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('음료')).toBeInTheDocument();
    // The popover surfaces the gloss in more than one slot (headword + note),
    // so assert presence without requiring a single match.
    expect(within(dialog).getAllByText(/beverage/).length).toBeGreaterThan(0);
  });

  it('banks a detected word via mineWord by lemma + optimistic flip (FU-NF-33)', async () => {
    const user = userEvent.setup();
    renderImages();

    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);
    // The first detected word's Add button → mine by lemma (no krdictEntryId).
    const addButtons = screen.getAllByRole('button', { name: /^추가 · Add$/ });
    await user.click(addButtons[0]);

    await waitFor(() => {
      expect(mineWordMock).toHaveBeenCalledTimes(1);
    });
    expect(mineWordMock).toHaveBeenCalledWith({
      lemma: '음료',
      english: 'beverage',
      pos: 'n.',
    });
    // No krdictEntryId — OCR words have no /define lookup.
    expect(mineWordMock.mock.calls[0][0]).not.toHaveProperty('krdictEntryId');
    // Optimistic flip — the row locks to "Added".
    expect(screen.getByRole('button', { name: /Added/ })).toBeInTheDocument();
  });

  it('banking ONE word marks only THAT word Added (wire sends no word id)', async () => {
    // Regression: the wire's `image_words` rows carry NO `id`. The old code
    // keyed the added-set on the non-existent `OcrWord.id` — every word's key
    // was `undefined`, so banking one word flipped EVERY row to "Added" and
    // permanently blocked banking the rest of the capture. With the derived
    // position+text key, the second word must remain bankable.
    const user = userEvent.setup();
    renderImages();

    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);
    expect(screen.getAllByRole('button', { name: /^추가 · Add$/ })).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: /^추가 · Add$/ })[0]);
    await waitFor(() => {
      expect(mineWordMock).toHaveBeenCalledTimes(1);
    });

    // Exactly ONE row reads "Added"; the other still offers "Add".
    expect(screen.getAllByRole('button', { name: /Added/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^추가 · Add$/ })).toHaveLength(1);

    // And the second word can still be banked (the old bug short-circuited
    // it as already-added via the shared undefined key).
    await user.click(screen.getAllByRole('button', { name: /^추가 · Add$/ })[0]);
    await waitFor(() => {
      expect(mineWordMock).toHaveBeenCalledTimes(2);
    });
    expect(mineWordMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ lemma: '오늘' }),
    );
    expect(screen.getAllByRole('button', { name: /Added/ })).toHaveLength(2);
  });

  it('rolls the Added flip back + toasts when the bank fails (FU-NF-33)', async () => {
    mineWordMock.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderImages();

    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);
    await user.click(screen.getAllByRole('button', { name: /^추가 · Add$/ })[0]);

    // The fixed, non-blocking failure toast surfaces (never server text).
    expect(
      await screen.findByText(/Couldn't bank — try again/i),
    ).toBeInTheDocument();
    // The optimistic flip rolled back — the row is tappable as "Add" again.
    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: /^추가 · Add$/ }).length,
      ).toBeGreaterThan(0);
    });
  });

  it('hydrates words via fetchImage when a list capture arrives without them', async () => {
    // Simulate the real `GET /images` list (summaries with empty words).
    hookState.data = [{ ...FIXTURE[0], words: [] }];
    hookState.isMock = false;
    fetchImageMock.mockResolvedValueOnce(FIXTURE[0]);

    const user = userEvent.setup();
    renderImages();

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

    renderImages();
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

    renderImages();
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

    renderImages();
    await pickFile();

    const alert = await screen.findByRole('alert');
    // Fixed 429 copy (F-UP-018) — the server prose on ApiError.message
    // ("daily limit reached") must not render.
    expect(alert).toHaveTextContent(
      "You've hit today's image limit. Try again tomorrow.",
    );
    expect(alert).not.toHaveTextContent('daily limit reached');
    // The list view is still rendered (upload card present) — not broken.
    expect(screen.getByText('Capture or upload')).toBeInTheDocument();

    // The error is dismissable.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '닫기 · Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// F-184 "Seoul Day & Night" reskin — Images was the last screen still on the
// bare Topbar; it now adopts the shared PageHubHeader (SkylineHeader +
// DancheongRail) and every image tile is a CityCard.
describe('Images page — F-184 reskin', () => {
  it('renders the skyline hub-header + rail divider, drops Topbar, and carries km-rain-sheen on the root', () => {
    const { container } = renderImages();

    expect(document.querySelector('.km-hubheader__skyline')).toBeInTheDocument();
    expect(document.querySelector('.km-hubheader__rail-divider')).toBeInTheDocument();
    expect(document.querySelector('.km-topbar')).not.toBeInTheDocument();
    expect(container.querySelector('.screen.km-rain-sheen')).toBeInTheDocument();

    // The real <h1> still carries the page title and the section's
    // aria-labelledby target — the reskin didn't drop the heading contract.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('id', 'km-images-title');
  });

  it('wraps each sample row in a CityCard (device #1/#2)', () => {
    renderImages();
    // One fixture capture → one sample row → one CityCard.
    expect(
      document.querySelectorAll('.km-images__sample-card.km-citycard'),
    ).toHaveLength(1);
  });

  it('wraps the capture photo and the detected-word list in CityCards', async () => {
    const user = userEvent.setup();
    renderImages();

    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);

    expect(
      document.querySelector('.km-images__capture-card.km-citycard'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('.km-images__detected.km-citycard'),
    ).toBeInTheDocument();
  });

  it('textures the "no words detected" state with the giwa/hangul-watermark devices', async () => {
    // A capture with no words whose hydration attempt fails — the words
    // list stays empty and the CaptureView's empty state renders.
    hookState.data = [{ ...FIXTURE[0], words: [] }];
    hookState.isMock = false;
    fetchImageMock.mockRejectedValueOnce(new Error('network blip'));

    const user = userEvent.setup();
    renderImages();
    await user.click(screen.getAllByRole('button', { name: /카페 메뉴판/ })[0]);

    const empty = await screen.findByText(/No words detected/);
    const wrap = empty.closest('.km-images__detected-empty');
    expect(wrap).toHaveClass('km-giwa', 'km-hangul-watermark');
    expect(wrap).toHaveAttribute('data-glyph', '글');
  });
});
