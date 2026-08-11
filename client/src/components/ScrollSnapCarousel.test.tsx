/**
 * ScrollSnapCarousel — what a layoutless DOM CAN verify: pages + dots
 * render with the ARIA carousel/tabs contract (and WITHOUT SwipeCarousel's
 * aria-hidden/inert on off-screen pages — the intentional difference: native
 * scroll must be able to reach every page), dot clicks issue the right
 * programmatic `scrollTo` (index × width, smooth vs reduced-motion 'auto'),
 * keyboard nav (arrows with wrap, Home/End) moves the active dot and
 * scrolls, `onChange` fires immediately on dot navigation and on a settled
 * scroll at a new index (driven by a synthetic `scroll` event over stubbed
 * `scrollLeft`/`clientWidth` geometry), and intermediate smooth-scroll
 * positions never fire it.
 *
 * What happy-dom CANNOT verify (no layout engine — `clientWidth`,
 * `scrollLeft`, and scroll-snap physics are inert) and therefore MUST be
 * checked on a real device (the Samsung/Brave case that motivated this
 * component):
 *   1. A horizontal thumb-swipe on the Listen landing pages over — full
 *      page change, with momentum + snap, including slightly arced swipes.
 *   2. A vertical swipe STARTED ON the carousel scrolls the document (the
 *      tall tile grid) — the track must not trap vertical pans.
 *   3. No mid-page resting position after a slow drag release
 *      (`scroll-snap-type: x mandatory` + `scroll-snap-stop: always`).
 *   4. A swipe at either end does not trigger browser back/forward
 *      navigation (`overscroll-behavior-x: contain`).
 *   5. The active dot follows the swipe and settles on the new page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScrollSnapCarousel } from './ScrollSnapCarousel';

function renderCarousel(
  props: Partial<{
    initialIndex: number;
    onChange: (index: number) => void;
  }> = {},
): ReturnType<typeof render> {
  return render(
    <ScrollSnapCarousel ariaLabel="Listen collections" {...props}>
      {[
        <div key="a">PAGE ALPHA</div>,
        <div key="b">PAGE BRAVO</div>,
        <div key="c">PAGE CHARLIE</div>,
      ]}
    </ScrollSnapCarousel>,
  );
}

/** The scroll-snap track (the native scroller). */
function trackOf(container: HTMLElement): HTMLElement {
  const track = container.querySelector('.km-snap-carousel__track');
  if (!(track instanceof HTMLElement)) throw new Error('no track');
  return track;
}

/**
 * Give the layoutless track fake geometry: a 320px-wide viewport whose
 * `scrollLeft` is writable. happy-dom's defaults are 0/read-only-ish, so
 * scroll math (`round(scrollLeft / clientWidth)`) can't be exercised
 * without this.
 */
function stubGeometry(track: HTMLElement, scrollLeft = 0): void {
  Object.defineProperty(track, 'clientWidth', {
    configurable: true,
    value: 320,
  });
  let left = scrollLeft;
  Object.defineProperty(track, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (v: number) => {
      left = v;
    },
  });
}

/** aria-selected assertion helper — `page` is 1-based. */
function expectSelectedPage(page: number, of = 3): void {
  expect(
    screen.getByRole('tab', { name: `Page ${String(page)} of ${String(of)}` }),
  ).toHaveAttribute('aria-selected', 'true');
}

// `Element.prototype.scrollTo` may not exist in happy-dom — install a spy so
// (a) the component's feature-detect finds it and (b) tests can assert the
// exact programmatic scroll it issues.
let scrollToSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollToSpy = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: scrollToSpy,
  });
});

afterEach(() => {
  // @ts-expect-error — remove the test-installed prototype member entirely.
  delete Element.prototype.scrollTo;
});

describe('ScrollSnapCarousel', () => {
  it('renders every page and the ARIA carousel/tabs contract', () => {
    renderCarousel();

    const region = screen.getByRole('region', { name: 'Listen collections' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');

    expect(screen.getByText('PAGE ALPHA')).toBeInTheDocument();
    expect(screen.getByText('PAGE BRAVO')).toBeInTheDocument();
    expect(screen.getByText('PAGE CHARLIE')).toBeInTheDocument();

    expect(
      screen.getByRole('tablist', { name: 'Listen collections pages' }),
    ).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');

    // Tabs and panels are wired both ways.
    const panels = screen.getAllByRole('tabpanel');
    expect(panels).toHaveLength(3);
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panels[0]?.id);
    expect(panels[0]?.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
  });

  it('keeps off-screen pages visible to AT and scroll — never aria-hidden/inert (deliberate SwipeCarousel difference)', () => {
    renderCarousel();

    // All three panels are queryable WITHOUT `hidden: true` — nothing is
    // aria-hidden — and none is inert. Native scroll (sequential focus,
    // find-in-page, the swipe itself) must be able to reach every page;
    // inerting them would make the pager's own mechanism unreachable.
    const panels = screen.getAllByRole('tabpanel');
    expect(panels).toHaveLength(3);
    for (const panel of panels) {
      expect(panel).not.toHaveAttribute('aria-hidden');
      expect(panel).not.toHaveAttribute('inert');
    }
  });

  it('scrolls to index × width on a dot click (smooth by default) and marks the dot active', async () => {
    const user = userEvent.setup();
    const { container } = renderCarousel();
    stubGeometry(trackOf(container));

    await user.click(screen.getByRole('tab', { name: 'Page 3 of 3' }));

    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    expect(scrollToSpy).toHaveBeenCalledWith({
      left: 2 * 320,
      behavior: 'smooth',
    });
    expectSelectedPage(3);
  });

  it('uses an instant jump (behavior auto) under prefers-reduced-motion', async () => {
    const user = userEvent.setup();
    const matchMediaSpy = vi
      .spyOn(window, 'matchMedia')
      .mockImplementation(
        (query: string) =>
          ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            onchange: null,
            dispatchEvent: () => false,
          }) as unknown as MediaQueryList,
      );
    try {
      const { container } = renderCarousel();
      stubGeometry(trackOf(container));

      await user.click(screen.getByRole('tab', { name: 'Page 2 of 3' }));

      expect(scrollToSpy).toHaveBeenCalledWith({
        left: 320,
        behavior: 'auto',
      });
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it('moves selection with arrow keys (wrapping) and Home/End, scrolling each time', async () => {
    const user = userEvent.setup();
    const { container } = renderCarousel();
    stubGeometry(trackOf(container));

    await user.click(screen.getByRole('tab', { name: 'Page 1 of 3' }));
    await user.keyboard('{ArrowRight}');
    expectSelectedPage(2);
    // Focus roves with selection.
    expect(screen.getByRole('tab', { name: 'Page 2 of 3' })).toHaveFocus();
    // The keyboard move scrolled the track to page 2.
    expect(scrollToSpy).toHaveBeenLastCalledWith({
      left: 320,
      behavior: 'smooth',
    });

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    // 2 → 1 → wrap to 3.
    expectSelectedPage(3);

    await user.keyboard('{ArrowRight}');
    // Wrap 3 → 1.
    expectSelectedPage(1);

    await user.keyboard('{End}');
    expectSelectedPage(3);
    await user.keyboard('{Home}');
    expectSelectedPage(1);
  });

  it('respects initialIndex and clamps it into range', () => {
    const first = renderCarousel({ initialIndex: 1 });
    expectSelectedPage(2);
    first.unmount();

    renderCarousel({ initialIndex: 99 });
    expectSelectedPage(3);
  });

  it('renders a single page with no dots', () => {
    render(
      <ScrollSnapCarousel ariaLabel="Solo">
        {[<div key="only">ONLY PAGE</div>]}
      </ScrollSnapCarousel>,
    );
    expect(screen.getByText('ONLY PAGE')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('activates the new page dot and fires onChange when a scroll settles at a new index', async () => {
    const onChange = vi.fn();
    const { container } = renderCarousel({ onChange });
    const track = trackOf(container);
    // Simulate the browser having natively swiped/snapped to page 2:
    // scrollLeft rests at exactly one page width.
    stubGeometry(track, 320);

    fireEvent.scroll(track);

    // The settle debounce (real timers) elapses, then reports exactly once.
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expectSelectedPage(2);
  });

  it('does not fire onChange when a scroll settles back on the same page (spring-back)', async () => {
    const onChange = vi.fn();
    const { container } = renderCarousel({ onChange });
    const track = trackOf(container);
    // A nudge that snapped back: rests well under half a page width.
    stubGeometry(track, 40);

    fireEvent.scroll(track);

    // Deterministic settle: wait until the live rAF sync has run AND the
    // settle window has passed (the dot staying on page 1 is the signal),
    // then assert silence.
    await waitFor(
      () => {
        expectSelectedPage(1);
      },
      { timeout: 1000 },
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(onChange).not.toHaveBeenCalled();
    expectSelectedPage(1);
  });

  it('fires onChange immediately on a dot click, and not for the already-active dot', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = renderCarousel({ onChange });
    stubGeometry(trackOf(container));

    await user.click(screen.getByRole('tab', { name: 'Page 1 of 3' }));
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: 'Page 3 of 3' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('does not re-fire onChange when the smooth scroll from a dot click settles', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = renderCarousel({ onChange });
    const track = trackOf(container);
    stubGeometry(track);

    await user.click(screen.getByRole('tab', { name: 'Page 2 of 3' }));
    expect(onChange).toHaveBeenCalledTimes(1);

    // The browser's smooth scroll streams scroll events and lands on the
    // target; the settle must recognize it as already-reported.
    track.scrollLeft = 160;
    fireEvent.scroll(track);
    track.scrollLeft = 320;
    fireEvent.scroll(track);

    await new Promise((r) => setTimeout(r, 250));
    expect(onChange).toHaveBeenCalledTimes(1);
    expectSelectedPage(2);
  });

  it('fires onChange on dot keyboard navigation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = renderCarousel({ onChange });
    stubGeometry(trackOf(container));

    await user.click(screen.getByRole('tab', { name: 'Page 1 of 3' }));
    onChange.mockClear(); // active-dot click fired nothing anyway
    await user.keyboard('{ArrowRight}');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('clamps a settled scroll index into range (over-scrolled geometry)', async () => {
    const onChange = vi.fn();
    const { container } = renderCarousel({ onChange });
    const track = trackOf(container);
    // Bogus rest position past the last page (rubber-band overshoot).
    stubGeometry(track, 5 * 320);

    fireEvent.scroll(track);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(2);
    });
    expectSelectedPage(3);
  });
});
