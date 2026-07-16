/**
 * Global test setup — runs once before the suite.
 *
 * Imports `@testing-library/jest-dom` so every `expect(...)` call gains the
 * DOM-aware matchers (`toBeInTheDocument`, `toHaveAttribute`, etc.).
 *
 * RTL's auto-cleanup only runs when Vitest globals are exposed. We keep
 * `globals: false` for explicit imports, which means RTL never sees a
 * global `afterEach` to hook. Wire cleanup ourselves once here.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

/**
 * Device-adaptive epic (Phase D0): a deterministic, mobile-first default
 * for `window.matchMedia`.
 *
 * happy-dom DOES implement `matchMedia` for width/height queries — but it
 * reads its OWN internal viewport fields, which default to a desktop-ish
 * 1024×768 (a generic jsdom-era convention, set long before this app read
 * any width query). Reassigning `window.innerWidth` from test code does
 * NOT reach those internal fields (verified empirically: Vitest's
 * happy-dom environment exposes `window` as a snapshot whose own
 * `innerWidth` is independent of what the live `MediaQueryList` actually
 * reads) — there's no supported hook to change happy-dom's viewport size
 * from outside `environmentOptions`. Left alone, EVERY `(min-width: …)`
 * query — including `useDeviceClass`'s — would report "desktop" by
 * default in every test, for a reason that has nothing to do with what
 * any given test is exercising.
 *
 * The fix: replace `matchMedia` outright with a `matches: false` default —
 * "nothing matches" is exactly the safe, mobile-first baseline this
 * mobile-first app (`useDeviceClass`, Shell.tsx's Sidebar/BottomNav swap)
 * needs, and it's also consistent with every OTHER matchMedia-driven
 * feature (prefers-reduced-motion, prefers-color-scheme, …) already
 * defaulting to "off" absent an explicit override. It's a `beforeEach`
 * (not a one-time module-load stub) so it re-applies before EVERY test
 * regardless of what an earlier test in the same file did — a test file
 * that stubs `matchMedia` itself (`vi.stubGlobal`/`vi.spyOn(...)
 * .mockImplementation`, the convention every existing consumer already
 * uses — ThemeProvider, InstallPrompt, Shell's reduced-motion tests,
 * Chat.test.tsx) simply re-stubs AFTER this one runs (Vitest fires
 * outer/earlier-registered `beforeEach` hooks first), so its override
 * still wins for its own tests; `vi.stubGlobal` (not a bare assignment)
 * so a test's own `vi.unstubAllGlobals()` cleanly reverts back to what
 * THIS hook set moments earlier, not to happy-dom's native 1024-wide
 * implementation.
 */
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })),
  );
});
