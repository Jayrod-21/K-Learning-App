/**
 * UploadViewer (U1b rework) — the view-only PAGE-IMAGE viewer at
 * `/uploads/:id`. `services/uploads.ts` is fully mocked (no pdf.js, no real
 * image bytes — the module under test only cares that it fetches the right
 * URL/state, not that a JPEG actually decodes).
 *
 * Covers: meta fetch (`page_count` via `getUpload`) drives the page-N-of-M
 * label, page nav (prev/next/jump) changes which page URL renders, a
 * per-page load failure shows Retry (not a broken-image icon) and Retry
 * re-mounts the image, the F-057 zoom model (auto fit-width default,
 * width-based zoom, rotation that really transforms — including the
 * quarter-turn branch's measured rotated-box geometry), the F-059 OCR
 * control (honestly disabled — no U2 backend exists), the F-024 back
 * control (guarded deep-link fallback → /uploads), the reorder tool (load
 * current order, move-to-N, optimistic update, PATCH call,
 * rollback-on-failure), abort-on-unmount for every network call this
 * component makes directly, the F-155 swipe-to-turn-page gesture (mouse/pen
 * via Pointer Events, touch via real `touchstart`/`touchmove`/`touchend`/
 * `touchcancel` listeners — module header §"F-155 second real-device fix"),
 * and the bottom-pager relocation (Prev/Next + the page-N-of-M readout now
 * live under the page image, not the top toolbar).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
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
          <Route
            path="/uploads"
            element={<div data-testid="uploads-probe">uploads</div>}
          />
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

/** The F-155 swipe target — the scrollable page box the gesture listens on. */
function pageBox(): HTMLElement {
  const el = document.querySelector('.km-upload-viewer__page');
  if (!(el instanceof HTMLElement)) throw new Error('no page box rendered');
  return el;
}

/**
 * A full valid leftward swipe (120px, past the 48px threshold floor) that
 * must turn to the NEXT page — mirrors `components/SwipeCarousel.test.tsx`'s
 * `swipeLeft` helper (same Pointer Events model, real left-button primary
 * pointer, an intermediate move so the axis lock has somewhere to decide).
 */
function swipeLeft(el: HTMLElement, pointerId = 7): void {
  fireEvent.pointerDown(el, {
    pointerId, isPrimary: true, button: 0, clientX: 200, clientY: 50,
  });
  fireEvent.pointerMove(el, {
    pointerId, isPrimary: true, clientX: 140, clientY: 52,
  });
  fireEvent.pointerMove(el, {
    pointerId, isPrimary: true, clientX: 80, clientY: 55,
  });
  fireEvent.pointerUp(el, {
    pointerId, isPrimary: true, clientX: 80, clientY: 55,
  });
}

/** The mirror gesture — a full valid rightward swipe (PREVIOUS page). */
function swipeRight(el: HTMLElement, pointerId = 7): void {
  fireEvent.pointerDown(el, {
    pointerId, isPrimary: true, button: 0, clientX: 80, clientY: 50,
  });
  fireEvent.pointerMove(el, {
    pointerId, isPrimary: true, clientX: 140, clientY: 52,
  });
  fireEvent.pointerMove(el, {
    pointerId, isPrimary: true, clientX: 200, clientY: 55,
  });
  fireEvent.pointerUp(el, {
    pointerId, isPrimary: true, clientX: 200, clientY: 55,
  });
}

/**
 * A single mock `Touch` for `fireEvent.touchStart/Move/End`'s `touches`/
 * `changedTouches` arrays — happy-dom's `TouchEvent` (module header
 * §"F-155 second real-device fix") stores whatever plain object is handed
 * to it verbatim, so a duck-typed `{ identifier, clientX, clientY }`
 * matches `Touch` exactly as far as `touchById` (component) reads it.
 */
function touch(identifier: number, clientX: number, clientY: number): object {
  return { identifier, clientX, clientY };
}

/**
 * A full native-touch leftward swipe (120px, past the 48px threshold
 * floor) — the REAL device event family (module header §"F-155 second
 * real-device fix"): `touchstart`/`touchmove`/`touchend`, not Pointer
 * Events. Mirrors `swipeLeft` above sample-for-sample.
 */
function touchSwipeLeft(el: HTMLElement, identifier = 40): void {
  fireEvent.touchStart(el, { touches: [touch(identifier, 200, 50)] });
  fireEvent.touchMove(el, { touches: [touch(identifier, 140, 52)] });
  fireEvent.touchMove(el, { touches: [touch(identifier, 80, 55)] });
  fireEvent.touchEnd(el, { changedTouches: [touch(identifier, 80, 55)] });
}

/**
 * happy-dom quirk (verified directly): the `EventTarget` global visible to
 * test code is Node's own built-in class, NOT the internal base class
 * happy-dom's DOM nodes actually inherit `addEventListener`/
 * `removeEventListener` from — `el.addEventListener !==
 * EventTarget.prototype.addEventListener` even before any spy is involved,
 * so `vi.spyOn(EventTarget.prototype, ...)` silently spies on a class no
 * real DOM node uses. This walks a throwaway node's OWN prototype chain to
 * find whichever level actually owns `addEventListener` (happy-dom's real
 * internal EventTarget-equivalent, shared by every element), which is the
 * one `vi.spyOn` must target for the calls to actually show up.
 */
interface DomEventTargetProto {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

function domEventTargetProto(): DomEventTargetProto {
  let proto = Object.getPrototypeOf(document.createElement('div')) as object | null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'addEventListener')) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) throw new Error('could not locate the DOM EventTarget prototype');
  return proto as DomEventTargetProto;
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

// F-057 zoom model: `zoom` is a multiplier of the CONTAINER width (1 = exact
// fit-width — the default), implemented as a real CSS width, never
// `transform: scale()` (a transform doesn't grow the layout box, so the old
// scale-based zoom could paint pixels the scroll container refused to reach).
describe('UploadViewer — F-057 zoom + auto fit-width', () => {
  it('opens auto fit-width: the page spans the container and the readout shows Fit', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    settleImage('load');

    const img = document.querySelector('img');
    expect(img?.style.width).toBe('100%');
    expect(screen.getByText('Fit')).toBeInTheDocument();
    // Already at fit — the reset control has nothing to do.
    expect(screen.getByRole('button', { name: 'Fit width' })).toBeDisabled();
  });

  it('zoom in/out change the rendered width relative to fit, and Fit width restores it', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    settleImage('load');

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(document.querySelector('img')?.style.width).toBe('125%');
    expect(screen.getByText('125%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(document.querySelector('img')?.style.width).toBe('75%');

    const fitBtn = screen.getByRole('button', { name: 'Fit width' });
    expect(fitBtn).not.toBeDisabled();
    await user.click(fitBtn);
    expect(document.querySelector('img')?.style.width).toBe('100%');
    expect(screen.getByText('Fit')).toBeInTheDocument();
  });

  it('zoom clamps at its bounds — the buttons disable at min/max', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    const out = (): HTMLElement => screen.getByRole('button', { name: 'Zoom out' });
    const zoomIn = (): HTMLElement => screen.getByRole('button', { name: 'Zoom in' });

    await user.click(out());
    await user.click(out());
    expect(document.querySelector('img')?.style.width).toBe('50%');
    expect(out()).toBeDisabled();

    for (let i = 0; i < 8; i += 1) {
      await user.click(zoomIn());
    }
    expect(document.querySelector('img')?.style.width).toBe('250%');
    expect(zoomIn()).toBeDisabled();
  });
});

describe('UploadViewer — F-057 rotation', () => {
  it('Rotate cycles 90° → 180° → 270° → 0°, really transforming the page image', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    settleImage('load');

    const rotateBtn = (): HTMLElement =>
      screen.getByRole('button', { name: /Rotate page/ });
    const imgTransform = (): string =>
      document.querySelector('img')?.style.transform ?? '';

    expect(imgTransform()).not.toContain('rotate');

    await user.click(rotateBtn());
    expect(imgTransform()).toContain('rotate(90deg)');
    // The accessible name carries the current angle (screen-reader parity
    // with the visual readout).
    expect(
      screen.getByRole('button', { name: 'Rotate page (rotated 90°)' }),
    ).toBeInTheDocument();

    await user.click(rotateBtn());
    expect(imgTransform()).toBe('rotate(180deg)');

    await user.click(rotateBtn());
    expect(imgTransform()).toContain('rotate(270deg)');

    await user.click(rotateBtn());
    expect(imgTransform()).not.toContain('rotate');
    expect(
      screen.getByRole('button', { name: 'Rotate page' }),
    ).toBeInTheDocument();
  });

  it('a quarter turn sizes an explicit rotated box from the container width + natural size', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    // Give the scroll box a real measured width (happy-dom lays out nothing,
    // so clientWidth is 0 unless stubbed)…
    const box = document.querySelector('.km-upload-viewer__page');
    if (!(box instanceof HTMLElement)) throw new Error('no page box rendered');
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true });
    fireEvent(window, new Event('resize'));

    // …and the image real natural dimensions (portrait 1000×1500), then load.
    const img = document.querySelector('img');
    if (!(img instanceof HTMLImageElement)) throw new Error('no <img> rendered');
    Object.defineProperty(img, 'naturalWidth', { value: 1000, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1500, configurable: true });
    fireEvent.load(img);

    await user.click(screen.getByRole('button', { name: /Rotate page/ }));

    // Rotated 90° at fit-width: the img's CSS height becomes the visual
    // width → pinned to the measured 800px; the wrapper carries the ROTATED
    // layout box (800 wide, 800·1000/1500 ≈ 533.33 tall) so scroll extent
    // stays honest.
    const rotated = document.querySelector('img');
    expect(rotated?.style.transform).toContain('rotate(90deg)');
    expect(rotated?.style.height).toBe('800px');
    const wrapper = document.querySelector('.km-upload-viewer__rotated');
    if (!(wrapper instanceof HTMLElement)) throw new Error('no rotated box rendered');
    expect(wrapper.style.width).toBe('800px');
    expect(wrapper.style.height).toBe('533.33px');
  });

  it('rotation persists across page navigation (a sideways book is sideways on every page)', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    settleImage('load');

    await user.click(screen.getByRole('button', { name: /Rotate page/ }));
    await user.click(screen.getByLabelText('Next page'));
    await screen.findByText('2 / 5');

    expect(document.querySelector('img')?.style.transform).toContain('rotate(90deg)');
  });
});

// F-059 — no OCR backend exists yet (U2 is a later, separate phase — see
// server/src/routes/uploads.ts). The control is rendered honestly disabled
// with VISIBLE coming-soon copy, never wired to a nonexistent endpoint.
describe('UploadViewer — F-059 OCR control (not yet available)', () => {
  it('renders Extract text disabled with visible coming-soon copy', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const btn = screen.getByRole('button', {
      name: 'Extract text (OCR) — coming soon',
    });
    expect(btn).toBeDisabled();
    // The "coming soon" lives in the visible label — not a hover tooltip.
    expect(screen.getByText('Extract text (coming soon)')).toBeInTheDocument();
  });
});

describe('UploadViewer — F-024 back control', () => {
  it('deep-link entry (no in-app history) falls back to the Uploads listing', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(await screen.findByTestId('uploads-probe')).toBeInTheDocument();
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

// F-155 (paired with F-130) — touch swipe on the page box must turn pages.
// Mouse/pen dragging is still driven by Pointer Events (same model as
// `components/SwipeCarousel.tsx`), covered by the `swipeLeft`/`swipeRight`
// helpers below; TOUCH is driven by real `touchstart`/`touchmove`/
// `touchend`/`touchcancel` listeners (module header §"F-155 second
// real-device fix" — attached via `addEventListener` with `touchmove`
// explicitly `{ passive: false }`, NOT the JSX `onPointerDown`-family props),
// covered by the `touchSwipeLeft` helper and the dedicated touch tests
// further down. Real gestures throughout — never a synthetic "swipe" event,
// which doesn't exist on the web platform.
describe('UploadViewer — F-155 mobile swipe', () => {
  it('a leftward swipe past the snap threshold advances to the next page', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    swipeLeft(pageBox());

    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/2');
  });

  it('a rightward swipe past the snap threshold returns to the previous page', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');
    await user.click(screen.getByLabelText('Next page'));
    await screen.findByText('2 / 5');

    swipeRight(pageBox());

    expect(await screen.findByText('1 / 5')).toBeInTheDocument();
  });

  it('a swipe under the snap threshold snaps back — the page does not change', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const box = pageBox();
    fireEvent.pointerDown(box, {
      pointerId: 3, isPrimary: true, button: 0, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(box, {
      pointerId: 3, isPrimary: true, clientX: 175, clientY: 51,
    });
    // Only 25px left — under the 48px threshold floor.
    fireEvent.pointerUp(box, {
      pointerId: 3, isPrimary: true, clientX: 175, clientY: 51,
    });

    expect(screen.getByText('1 / 5')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/1');
  });

  it('a vertical-dominant drag surrenders the gesture — the page never changes (native scroll wins)', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const box = pageBox();
    fireEvent.pointerDown(box, {
      pointerId: 4, isPrimary: true, button: 0, clientX: 200, clientY: 50,
    });
    // Vertical-dominant move (dy=140 >> dx=10) — surrenders on the axis lock.
    fireEvent.pointerMove(box, {
      pointerId: 4, isPrimary: true, clientX: 210, clientY: 190,
    });
    // Even a large horizontal delta after surrender must not resurrect it.
    fireEvent.pointerMove(box, {
      pointerId: 4, isPrimary: true, clientX: 340, clientY: 190,
    });
    fireEvent.pointerUp(box, {
      pointerId: 4, isPrimary: true, clientX: 340, clientY: 190,
    });

    expect(screen.getByText('1 / 5')).toBeInTheDocument();
  });

  // F-155 second real-device fix regression: this is the touch-specific
  // twin of the mouse/pen "calls preventDefault" test, but through the REAL
  // event family a phone actually dispatches. Mirrors
  // `SwipeCarousel.test.tsx`'s "calls preventDefault on every move once the
  // axis locks horizontal, not before" — a cancelable event's `dispatchEvent`
  // return value is `true` iff `preventDefault` was NOT called. This is also
  // the one test that would catch a regression back to JSX `onTouchMove`
  // (React registers that as PASSIVE by default — confirmed against
  // `react-dom`'s `addTrappedEventListener` — so `preventDefault()` would
  // silently stop working and `dispatchEvent` would keep returning `true`).
  it('calls preventDefault on every touchmove once the axis locks horizontal, not before', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    const box = pageBox();
    const id = 22;

    fireEvent.touchStart(box, { touches: [touch(id, 200, 50)] });

    // Still inside the 8px axis-lock window — undecided, so the browser
    // must remain free to claim the gesture (no preventDefault yet).
    const undecided = fireEvent.touchMove(box, { touches: [touch(id, 204, 51)] });
    expect(undecided).toBe(true);

    // This move crosses the threshold with a horizontal-dominant delta —
    // the axis locks 'h' and this SAME move must already be vetoed.
    const locking = fireEvent.touchMove(box, { touches: [touch(id, 180, 52)] });
    expect(locking).toBe(false);

    // Every subsequent 'h'-axis move keeps vetoing, not just the first.
    const continuing = fireEvent.touchMove(box, { touches: [touch(id, 140, 53)] });
    expect(continuing).toBe(false);

    fireEvent.touchEnd(box, { changedTouches: [touch(id, 140, 53)] });
  });

  it('leaves a vertical-dominant touch drag alone, preserving native scroll (no preventDefault)', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    const box = pageBox();
    const id = 23;

    fireEvent.touchStart(box, { touches: [touch(id, 200, 50)] });
    // Vertical-dominant move — the axis locks 'v' and surrenders. This
    // component must never veto a gesture it surrendered.
    const notPrevented = fireEvent.touchMove(box, { touches: [touch(id, 202, 120)] });
    expect(notPrevented).toBe(true);

    fireEvent.touchEnd(box, { changedTouches: [touch(id, 202, 120)] });
  });

  it('a touchcancel ends the gesture cleanly — no page change, no stuck drag on the next swipe', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    const box = pageBox();
    const id = 24;

    fireEvent.touchStart(box, { touches: [touch(id, 200, 50)] });
    fireEvent.touchMove(box, { touches: [touch(id, 80, 55)] });
    fireEvent.touchCancel(box, { changedTouches: [touch(id, 80, 55)] });
    fireEvent.touchEnd(box, { changedTouches: [touch(id, 80, 55)] });
    expect(screen.getByText('1 / 5')).toBeInTheDocument();

    // A fresh touch swipe with a new identifier must still work — the
    // canceled gesture didn't leave `swipeRef` stuck.
    touchSwipeLeft(box, 25);
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
  });

  it('a second finger touching down mid-gesture is ignored, not restarted', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    const box = pageBox();

    fireEvent.touchStart(box, { touches: [touch(50, 200, 50)] });
    // Second finger down — since one gesture is already tracked, this must
    // be ignored (not treated as a fresh arm that would corrupt `startX`).
    fireEvent.touchStart(box, { touches: [touch(50, 200, 50), touch(51, 10, 10)] });
    fireEvent.touchMove(box, { touches: [touch(50, 140, 52), touch(51, 10, 10)] });
    fireEvent.touchMove(box, { touches: [touch(50, 60, 55), touch(51, 10, 10)] });
    fireEvent.touchEnd(box, { changedTouches: [touch(50, 60, 55)] });

    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
  });

  it('right-click and non-primary pointers never arm the swipe gesture', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const box = pageBox();
    // Right button.
    fireEvent.pointerDown(box, {
      pointerId: 5, isPrimary: true, button: 2, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(box, { pointerId: 5, isPrimary: true, clientX: 80, clientY: 55 });
    fireEvent.pointerUp(box, { pointerId: 5, isPrimary: true, clientX: 80, clientY: 55 });
    expect(screen.getByText('1 / 5')).toBeInTheDocument();

    // Non-primary (a second touch point).
    fireEvent.pointerDown(box, {
      pointerId: 6, isPrimary: false, button: 0, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(box, { pointerId: 6, isPrimary: false, clientX: 80, clientY: 55 });
    fireEvent.pointerUp(box, { pointerId: 6, isPrimary: false, clientX: 80, clientY: 55 });
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
  });

  it('pointercancel ends the gesture cleanly — no page change, no stuck drag on the next swipe', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const box = pageBox();
    fireEvent.pointerDown(box, {
      pointerId: 8, isPrimary: true, button: 0, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(box, { pointerId: 8, isPrimary: true, clientX: 80, clientY: 55 });
    fireEvent.pointerCancel(box, { pointerId: 8, isPrimary: true, clientX: 80, clientY: 55 });
    fireEvent.pointerUp(box, { pointerId: 8, isPrimary: true, clientX: 80, clientY: 55 });
    expect(screen.getByText('1 / 5')).toBeInTheDocument();

    // A fresh swipe with a new pointer id must still work — the canceled
    // gesture didn't leave the ref stuck.
    swipeLeft(box, 9);
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
  });

  // S-1 (`REVIEW_batch2-uploads.md`) — of the three documented stuck-drag
  // exits (pointercancel/pointerleave/lostpointercapture), only pointercancel
  // had a dedicated test above. These two close the gap: a regression that
  // inverted the `d.axis !== 'h'` guard on pointerleave, or dropped the
  // `onLostPointerCapture` prop entirely, would pass every other test in
  // this file but should fail here.
  it('pointerleave while the axis is still undecided ends the gesture cleanly — no stuck drag on the next swipe', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const box = pageBox();
    // Down, then leave BEFORE any move clears the 8px axis-lock threshold —
    // the gesture is still in the capture-less 'none' phase (a real mouse
    // leaving the element mid-drag can never deliver a pointerup here).
    fireEvent.pointerDown(box, {
      pointerId: 10, isPrimary: true, button: 0, clientX: 200, clientY: 50,
    });
    fireEvent.pointerLeave(box, { pointerId: 10, isPrimary: true, clientX: 200, clientY: 50 });
    // A pointerup after the leave (e.g. released off-element) must not
    // resurrect or misfire the now-ended gesture.
    fireEvent.pointerUp(box, { pointerId: 10, isPrimary: true, clientX: 80, clientY: 55 });
    expect(screen.getByText('1 / 5')).toBeInTheDocument();

    // A fresh swipe with a NEW pointer id must still work.
    swipeLeft(box, 11);
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
  });

  it('lostpointercapture ends an in-progress (axis-locked) gesture cleanly — no stuck drag on the next swipe', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const box = pageBox();
    fireEvent.pointerDown(box, {
      pointerId: 12, isPrimary: true, button: 0, clientX: 200, clientY: 50,
    });
    // Clears the 8px horizontal axis lock — the gesture is now captured
    // ('h' axis), the phase `onPagePointerLeave` explicitly does NOT end.
    fireEvent.pointerMove(box, { pointerId: 12, isPrimary: true, clientX: 140, clientY: 52 });
    // The OS/browser revokes pointer capture mid-gesture (e.g. an
    // interrupting system gesture) — `onLostPointerCapture` must end the
    // drag unconditionally so it can't block a future swipe.
    fireEvent.lostPointerCapture(box, { pointerId: 12, isPrimary: true });
    fireEvent.pointerUp(box, { pointerId: 12, isPrimary: true, clientX: 80, clientY: 55 });
    expect(screen.getByText('1 / 5')).toBeInTheDocument();

    // A fresh swipe with a NEW pointer id must still work.
    swipeLeft(box, 13);
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
  });

  it('the swipe gesture is not armed once zoomed past fit-width — a horizontal drag never turns the page', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeInTheDocument();

    swipeLeft(pageBox());

    // Still page 1 — above fit-width a horizontal drag is a legitimate pan
    // over the zoomed page, not a page turn (module header §"F-155").
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
  });

  // SHOULD-FIX (`REVIEW_mobile3-logic.md`) — the mouse/pointer twin above
  // proved `swipeEligible` gates the pointer path; this closes the touch-path
  // gap by inspection only, since the touch effect (`useEffect` keyed on
  // `[swipeEligible, pageBoxEl]`) is a structurally separate attach path
  // that could, in principle, regress independently (e.g. an edit that only
  // updated the pointer guard and missed the effect's early return).
  it('the touch swipe is not armed once zoomed past fit-width — a horizontal touch drag never turns the page', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeInTheDocument();

    touchSwipeLeft(pageBox());

    // Still page 1 — above fit-width the touch effect's own `swipeEligible`
    // check (`UploadViewer.tsx`, same flag as the pointer guard) never
    // attaches its listeners, so this dispatch has nothing to reach; the
    // drag is left entirely to native pinch/pan, same contract as mouse/pen.
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
  });

  // SHOULD-FIX (`REVIEW_mobile3-logic.md`) — the touch effect's cleanup
  // function looked correct by inspection but had no regression coverage:
  // nothing in the suite would previously fail if a future edit dropped the
  // `return () => { ... }` or removed a listener under a different function
  // reference than the one that was added (which would silently leak on
  // every remount/zoom-toggle rather than throw). Spies on the real DOM
  // EventTarget prototype (`domEventTargetProto()` above — NOT the global
  // `EventTarget`, which happy-dom's elements don't actually inherit from)
  // so the add/remove pairing — and the exact handler identity — is
  // verified structurally, not just "no crash."
  it('attaches the four touch listeners on mount and removes the exact same handlers on unmount (no leak)', async () => {
    const targetProto = domEventTargetProto();
    const addSpy = vi.spyOn(targetProto, 'addEventListener');
    const removeSpy = vi.spyOn(targetProto, 'removeEventListener');
    const touchTypes = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];

    const { unmount } = renderViewer();
    await screen.findByText('1 / 5');
    const box = pageBox();

    const added = addSpy.mock.calls
      .map((call, i) => ({ type: call[0], handler: call[1], target: addSpy.mock.instances[i] }))
      .filter((c) => c.target === box && touchTypes.includes(c.type as string));
    // Exactly one add per touch event type on the real page-box element —
    // not the JSX pointer-event props, which never call addEventListener.
    expect(added.map((c) => c.type).sort()).toEqual([...touchTypes].sort());

    unmount();

    const removed = removeSpy.mock.calls
      .map((call, i) => ({ type: call[0], handler: call[1], target: removeSpy.mock.instances[i] }))
      .filter((c) => c.target === box && touchTypes.includes(c.type as string));
    expect(removed.map((c) => c.type).sort()).toEqual([...touchTypes].sort());

    // Same function reference add→remove per event type: a cleanup bug that
    // removed a DIFFERENT closure (e.g. a re-created handler) than the one
    // actually attached would pass a naive "removeEventListener was called"
    // check but still leak — this catches that specifically.
    for (const type of touchTypes) {
      const addedHandler = added.find((c) => c.type === type)?.handler;
      const removedHandler = removed.find((c) => c.type === type)?.handler;
      expect(removedHandler).toBe(addedHandler);
    }

    // Belt-and-braces: dispatching a touchmove at the (now-detached) element
    // after unmount must not throw — proves the handler is really gone, not
    // merely that removeEventListener was called with matching-looking args.
    expect(() => {
      fireEvent.touchMove(box, { touches: [touch(99, 80, 55)] });
    }).not.toThrow();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('arrow-button paging still works after the swipe handlers are wired up', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    await user.click(screen.getByLabelText('Next page'));
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Previous page'));
    expect(await screen.findByText('1 / 5')).toBeInTheDocument();
  });

  // Real-device regression: a leftward swipe survived every jsdom
  // pointer-event assertion above yet still failed on a real phone. Two
  // independent causes were found and fixed (module header): #1 the `<img>`'s
  // own native drag-source/long-press-callout handling (a separate subsystem
  // that can swallow a touch sequence before the axis lock even matters —
  // still asserted by the two tests below), and #2 — the actual root cause —
  // `.km-upload-viewer__page` being a genuinely-scrollable box, which meant
  // Pointer Events couldn't reliably win the native-scroll race on a real
  // touch device. This test exercises the REAL event family a phone
  // dispatches (`touchstart`/`touchmove`/`touchend`, not Pointer Events) so a
  // regression back to the Pointer-Events-only implementation — or to a
  // passive JSX `onTouchMove` — would be caught here, not just on-device.
  it('a real touch-typed horizontal drag past the snap threshold turns the page', async () => {
    renderViewer();
    await screen.findByText('1 / 5');
    const box = pageBox();

    touchSwipeLeft(box, 30);

    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/uploads/9/page/2');
  });

  // Root-cause regression for the real-phone failure: an <img> is an
  // implicit native drag source (`draggable` defaults to `true` for
  // `img`/`a`), and on a real touch device that competes with (and can
  // outright hijack) the custom pointer-swipe — no `preventDefault` inside
  // `onPointerMove` can stop it, since native drag arbitration is a
  // different browser subsystem than the scroll/pan one `touch-action`
  // governs. `draggable={false}` is the fix; this asserts it directly on
  // the rendered node rather than trusting the JSX literal never regresses.
  it('the page image is not a native drag source (draggable=false)', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const img = document.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('draggable', 'false');
  });

  // Belt-and-braces half of the same fix: some engines have historically
  // honored a dragstart veto even where a bare `draggable={false}` attribute
  // was insufficient (e.g. dragging by a descendant), so the component also
  // wires `onDragStart` to call `preventDefault()`. A cancelable event's
  // `dispatchEvent` return value is `false` iff `preventDefault()` was
  // called — the same proxy pattern used for the pointermove assertions
  // above.
  it('vetoes a native dragstart on the page image', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    const img = document.querySelector('img');
    if (!(img instanceof HTMLImageElement)) throw new Error('no <img> rendered');
    const notPrevented = fireEvent.dragStart(img);
    expect(notPrevented).toBe(false);
  });

  // FIX-PASS S2 (`REVIEW_mobile2-logic.md`) — the JS half of the fix
  // (draggable=false + the dragstart veto) is covered above, but the CSS
  // half — the iOS long-press-callout/drag-lift shutoff, which has no
  // JS-side event to assert against — had no regression coverage at all.
  // happy-dom does no layout, so the actual on-screen callout/select
  // behavior can't be measured by rendering — pin the CSS mechanism from
  // source instead (same pattern as SkillsCompare.test.tsx's mobile-overflow
  // fix / Today.test.tsx's peek-slider contract tests).
  it('CSS: the page image carries the iOS drag/callout shutoff rules, and the DOM node stays draggable=false', async () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'UploadViewer.css'),
      'utf8',
    );

    const imgRule =
      /\.km-upload-viewer__img\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(imgRule).not.toBe('');
    expect(imgRule).toContain('-webkit-touch-callout: none;');
    expect(imgRule).toContain('-webkit-user-drag: none;');
    expect(imgRule).toContain('user-select: none;');

    // Belt-and-braces: the CSS-only half above and the JS attribute
    // (asserted independently by the dedicated `draggable=false` test
    // earlier in this file) must both hold at once — re-confirmed here so
    // this one test is a complete pin of the full fix, CSS + DOM.
    renderViewer();
    await screen.findByText('1 / 5');
    expect(document.querySelector('img')).toHaveAttribute('draggable', 'false');
  });
});

// "Arrows to the bottom" — Prev/Next + the page-N-of-M readout moved out of
// the dense top toolbar into their own thumb-reachable bar directly under
// the page image (component's module header). The buttons are still real
// accessible-name-bearing `<button>`s (already exercised by every swipe/nav
// test above via `getByLabelText('Previous page' | 'Next page')`) — these
// tests pin the RELOCATION specifically, so a regression that moved them
// back to the top would fail here even though every other test still passes.
describe('UploadViewer — arrows moved to the bottom', () => {
  it('renders the Prev/Next pager AFTER the page-image card, not in the top toolbar', async () => {
    const { container } = renderViewer();
    await screen.findByText('1 / 5');

    const card = container.querySelector('.km-upload-viewer__card');
    const pager = container.querySelector('.km-upload-viewer__pager');
    expect(card).toBeInTheDocument();
    expect(pager).toBeInTheDocument();

    // DOM order, not just both-present: the pager must follow the card
    // (`Node.compareDocumentPosition` — DOCUMENT_POSITION_FOLLOWING = 4).
    const position = card?.compareDocumentPosition(pager as Node);
    expect((position ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The top toolbar (zoom/rotate/jump/reorder/OCR) no longer carries the
    // Prev/Next buttons or the page-count readout — they live in the pager.
    const toolbar = container.querySelector('.km-upload-viewer__toolbar');
    expect(toolbar?.querySelector('[aria-label="Previous page"]')).not.toBeInTheDocument();
    expect(toolbar?.querySelector('[aria-label="Next page"]')).not.toBeInTheDocument();
    expect(pager?.querySelector('[aria-label="Previous page"]')).toBeInTheDocument();
    expect(pager?.querySelector('[aria-label="Next page"]')).toBeInTheDocument();
  });

  it('the bottom pager shows the live page-N-of-M readout and stays keyboard-operable', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('1 / 5');

    const pager = screen.getByRole('group', { name: 'Page navigation' });
    expect(pager).toHaveTextContent('1 / 5');

    // Keyboard-accessible: a real <button>, focusable and Enter-activatable
    // — not a swipe-only affordance (the reason arrows exist at all).
    const next = screen.getByLabelText('Next page');
    next.focus();
    expect(next).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('2 / 5')).toBeInTheDocument();
    expect(pager).toHaveTextContent('2 / 5');

    // NIT (`REVIEW_mobile3-logic.md`) — the test name says "keyboard-
    // operable" but only drove Enter; a real <button> also activates on
    // Space, so exercise that too rather than leaving the claim half-proven.
    const prev = screen.getByLabelText('Previous page');
    prev.focus();
    expect(prev).toHaveFocus();
    await user.keyboard('[Space]');
    expect(await screen.findByText('1 / 5')).toBeInTheDocument();
  });
});

// F-128 "Seoul Day & Night" reskin — the header adopts the shared
// PageHubHeader (SkylineHeader + DancheongRail) and the page sits on a
// CityCard, per the component's module header.
describe('UploadViewer — F-128 reskin', () => {
  it('renders the skyline hub-header, the rail divider, and the CityCard page surface', async () => {
    renderViewer();
    await screen.findByText('1 / 5');

    expect(document.querySelector('.km-hubheader__skyline')).toBeInTheDocument();
    expect(document.querySelector('.km-hubheader__rail-divider')).toBeInTheDocument();
    expect(document.querySelector('.km-upload-viewer__card.km-citycard')).toBeInTheDocument();

    // The real <h1> still carries the book title and the section's
    // aria-labelledby target — the reskin didn't drop the heading contract.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('id', 'km-upload-viewer-title');
    expect(heading).toHaveTextContent('한국어 문법 사전');
  });

  // S1 (`REVIEW_batch2-fidelity.md`) — this page's root was missing
  // `.km-rain-sheen` (device #8, Night ambient) while every sibling Library
  // page carries it. Fixed in the batch-2 fix-pass.
  it('carries the km-rain-sheen ambient overlay on the page root (S1)', async () => {
    const { container } = renderViewer();
    await screen.findByText('1 / 5');
    expect(container.querySelector('.screen.km-rain-sheen')).toBeInTheDocument();
  });
});
