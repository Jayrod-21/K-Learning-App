/**
 * tourDriver — the driver.js boundary module (fix-pass S2: this logic
 * previously shipped untested; provider tests mock this module wholesale).
 *
 * driver.js itself is mocked at the import boundary, so these tests exercise
 * the REAL production logic in tourDriver.ts against a real (happy-dom) DOM:
 *   - the missing-target filter (absent anchors dropped; present anchors
 *     mapped with element/title/body/side; target-less steps mapped as
 *     centered popovers),
 *   - the availability threshold (fix-pass S1): a tour that DEFINES anchored
 *     steps but resolves NONE reports 'unavailable' (and never starts the
 *     overlay); the SAME tour starts once an anchor is present; modal-only
 *     tours are always available,
 *   - reduced motion → `animate: false`,
 *   - the `finished` latch: onDestroyed → onFinished fires exactly once for
 *     finish, skip/Esc, and caller destroy — including a destroy racing a
 *     finish,
 *   - `disableActiveInteraction` + `allowClose` pinned in the config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'driver.js';
import type { TourDefinition } from './tours';

const driverMocks = vi.hoisted(() => ({
  driver: vi.fn(),
  drive: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('driver.js', () => ({ driver: driverMocks.driver }));

import { startTour } from './tourDriver';

/** The config handed to driver.js on the most recent startTour call. */
function lastConfig(): Config {
  const calls = driverMocks.driver.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Config;
}

/** Invoke the config's onDestroyed the way driver.js's destroy pipeline
 *  does (hook args are unused by tourDriver's latch — empty step/opts). */
function fireDestroyed(): void {
  lastConfig().onDestroyed?.(undefined, {}, {} as never);
}

function makeTour(steps: TourDefinition['steps']): TourDefinition {
  // The runner only reads `steps` — id/label/path exist for the registry.
  return { id: 'hanja', label: 'Hanja', kr: '한자', path: '/learn/hanja', steps };
}

/** Stamp a `data-tour` anchor into the test DOM. */
function addAnchor(key: string): void {
  const el = document.createElement('div');
  el.setAttribute('data-tour', key);
  document.body.appendChild(el);
}

beforeEach(() => {
  document.body.innerHTML = '';
  driverMocks.driver.mockReset();
  driverMocks.drive.mockReset();
  driverMocks.destroy.mockReset();
  driverMocks.driver.mockReturnValue({
    drive: driverMocks.drive,
    destroy: driverMocks.destroy,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tourDriver — missing-target filter', () => {
  it('drops anchored steps whose element is absent and keeps the rest', () => {
    addAnchor('present');
    const result = startTour(
      makeTour([
        { title: 'Welcome', body: 'intro copy' },
        { target: '[data-tour="present"]', title: 'Here', body: 'anchored', side: 'bottom' },
        { target: '[data-tour="missing"]', title: 'Gone', body: 'dropped' },
      ]),
      { onFinished: vi.fn() },
    );

    expect(result.status).toBe('started');
    const config = lastConfig();
    expect(config.steps).toEqual([
      { popover: { title: 'Welcome', description: 'intro copy' } },
      {
        element: '[data-tour="present"]',
        popover: { title: 'Here', description: 'anchored', side: 'bottom' },
      },
    ]);
    expect(driverMocks.drive).toHaveBeenCalledTimes(1);
  });

  it('omits the side hint when a step does not declare one', () => {
    addAnchor('present');
    startTour(
      makeTour([{ target: '[data-tour="present"]', title: 'T', body: 'B' }]),
      { onFinished: vi.fn() },
    );
    const step = (lastConfig().steps as { popover: object }[])[0];
    expect(step.popover).not.toHaveProperty('side');
  });
});

describe('tourDriver — availability threshold (S1)', () => {
  const anchoredTour = makeTour([
    { title: 'Welcome', body: 'connective copy — always resolvable' },
    { target: '[data-tour="shelf"]', title: 'Shelf', body: 'anchored' },
    { title: 'Outro', body: 'more connective copy' },
  ]);

  it("a tour whose anchors are ALL absent is 'unavailable' — even with un-anchored copy steps present — and never starts the overlay", () => {
    const onFinished = vi.fn();
    const result = startTour(anchoredTour, { onFinished });

    expect(result).toEqual({ status: 'unavailable' });
    expect(driverMocks.driver).not.toHaveBeenCalled();
    expect(driverMocks.drive).not.toHaveBeenCalled();
    // The caller's mark-seen path hangs off onFinished — it must never fire.
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('the SAME tour starts once its anchor is present (the retry-next-visit half)', () => {
    addAnchor('shelf');
    const result = startTour(anchoredTour, { onFinished: vi.fn() });

    expect(result.status).toBe('started');
    expect(driverMocks.drive).toHaveBeenCalledTimes(1);
    expect(lastConfig().steps).toHaveLength(3);
  });

  it('a PARTIALLY resolved tour still runs (only the fully-anchorless case defers)', () => {
    addAnchor('a');
    const result = startTour(
      makeTour([
        { target: '[data-tour="a"]', title: 'A', body: 'here' },
        { target: '[data-tour="b"]', title: 'B', body: 'still loading' },
      ]),
      { onFinished: vi.fn() },
    );
    expect(result.status).toBe('started');
    expect(lastConfig().steps).toHaveLength(1);
  });

  it('a modal-only tour (no anchored steps defined) is always available', () => {
    const result = startTour(
      makeTour([{ title: 'Just copy', body: 'no anchors anywhere' }]),
      { onFinished: vi.fn() },
    );
    expect(result.status).toBe('started');
  });

  it("a tour with zero steps of any kind is 'unavailable'", () => {
    const result = startTour(makeTour([]), { onFinished: vi.fn() });
    expect(result).toEqual({ status: 'unavailable' });
    expect(driverMocks.driver).not.toHaveBeenCalled();
  });
});

describe('tourDriver — reduced motion + interaction posture', () => {
  it('animates by default (no reduced-motion preference)', () => {
    startTour(makeTour([{ title: 'T', body: 'B' }]), { onFinished: vi.fn() });
    expect(lastConfig().animate).toBe(true);
  });

  it('sets animate:false when prefers-reduced-motion is reduce', () => {
    // Re-stub over the setup.ts default (matches:false for every query).
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      })),
    );
    startTour(makeTour([{ title: 'T', body: 'B' }]), { onFinished: vi.fn() });
    expect(lastConfig().animate).toBe(false);
    vi.unstubAllGlobals();
  });

  it('pins allowClose (Esc/overlay skip) and disableActiveInteraction (inert spotlight)', () => {
    startTour(makeTour([{ title: 'T', body: 'B' }]), { onFinished: vi.fn() });
    const config = lastConfig();
    expect(config.allowClose).toBe(true);
    expect(config.disableActiveInteraction).toBe(true);
  });
});

describe('tourDriver — onFinished single-fire latch', () => {
  it('fires onFinished exactly once when the drive completes (driver destroy pipeline)', () => {
    const onFinished = vi.fn();
    startTour(makeTour([{ title: 'T', body: 'B' }]), { onFinished });

    fireDestroyed();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('fires onFinished for a skip/Esc dismissal too — and only once under a double-destroy race', () => {
    const onFinished = vi.fn();
    startTour(makeTour([{ title: 'T', body: 'B' }]), { onFinished });

    // Esc/overlay-click and a racing route-change teardown both funnel
    // through the same driver destroy pipeline.
    fireDestroyed();
    fireDestroyed();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('handle.destroy() tears the overlay down and stays single-fire when the pipeline echoes back', () => {
    const onFinished = vi.fn();
    const result = startTour(makeTour([{ title: 'T', body: 'B' }]), {
      onFinished,
    });
    if (result.status !== 'started') throw new Error('expected started');

    // Real driver.js invokes onDestroyed from destroy(); emulate that echo.
    driverMocks.destroy.mockImplementation(() => {
      fireDestroyed();
    });
    result.handle.destroy();
    result.handle.destroy(); // idempotent — driver.js no-ops, latch holds
    expect(driverMocks.destroy).toHaveBeenCalledTimes(2);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
