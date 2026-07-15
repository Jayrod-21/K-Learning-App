/**
 * ThemeProvider — verifies the PF-A A4 mode control, extended by F-132 to a
 * four-way mode:
 *   - setMode('light'|'dark') stores km.theme + applies data-theme,
 *   - setMode('system') CLEARS km.theme and resolves from matchMedia,
 *   - 'system' tracks live matchMedia change events,
 *   - setMode('auto') stores 'auto' and resolves Day/Night Seoul from the
 *     local hour (F-132),
 *   - 'auto' re-checks the clock on a timer and flips at the 06:00/18:00
 *     boundary while the app stays open, no reload needed,
 *   - a manual setMode('light'|'dark') (or toggleTheme) always wins over
 *     'auto'/'system' — they're mutually exclusive modes, not layers,
 *   - `mode` is derived from storage at mount (stored ⇒ explicit, absent ⇒ system),
 *   - toggleTheme flips the resolved theme and pins it as an explicit choice.
 *
 * happy-dom's matchMedia is stubbed so we can drive prefers-color-scheme.
 * Fake timers pin the wall clock for 'auto' tests — vi.setSystemTime, never
 * the real clock, decides "daytime" vs. "nighttime" here, so the suite is
 * deterministic regardless of when/where it runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { ThemeProvider } from './ThemeProvider';
import { useTheme } from './useTheme';
import { resolveAutoTheme, THEME_STORAGE_KEY } from './theme-context';

// ─── matchMedia harness ───────────────────────────────────────────
// A controllable prefers-color-scheme matcher. `setSystemDark` flips the
// match value and fires the registered `change` listeners, simulating the OS
// theme switching under the user.
let systemDark = false;
let listeners: Array<(e: MediaQueryListEvent) => void> = [];

function setSystemDark(next: boolean): void {
  systemDark = next;
  const event = { matches: next } as MediaQueryListEvent;
  for (const l of listeners) l(event);
}

beforeEach(() => {
  systemDark = false;
  listeners = [];
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('dark') ? systemDark : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.push(cb);
      },
      removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners = listeners.filter((l) => l !== cb);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })),
  );
  // Fake timers so 'auto' mode's polling interval is controllable and its
  // day/night resolution is pinned to a deterministic instant rather than
  // whatever the real wall clock happens to read when the suite runs.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Set the fake wall clock to a LOCAL time on a fixed date (no timezone
 *  suffix, so `new Date(...)` parses it in the host's local timezone — the
 *  same interpretation `resolveAutoTheme`'s default `getHours` reads via
 *  `Date.prototype.getHours`). */
function setClock(localTimeIso: string): void {
  vi.setSystemTime(new Date(`2026-07-14T${localTimeIso}`));
}

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe('ThemeProvider — mode (A4)', () => {
  it('starts in system mode with no stored choice', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.mode).toBe('system');
  });

  it("setMode('dark') stores km.theme and applies data-theme", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('dark');
    });
    expect(result.current.mode).toBe('dark');
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it("setMode('light') stores light and applies it", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('light');
    });
    expect(result.current.mode).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it("setMode('system') clears km.theme and resolves from matchMedia", () => {
    systemDark = true;
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('dark'); // explicit first
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    act(() => {
      result.current.setMode('system');
    });
    expect(result.current.mode).toBe('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    // System pref is dark → resolved theme follows it.
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('tracks live matchMedia changes while in system mode', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    act(() => {
      setSystemDark(true);
    });
    expect(result.current.theme).toBe('dark');
    act(() => {
      setSystemDark(false);
    });
    expect(result.current.theme).toBe('light');
  });

  it('ignores OS-pref changes once an explicit mode is chosen', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('light');
    });
    act(() => {
      setSystemDark(true); // OS goes dark, but user pinned light
    });
    expect(result.current.theme).toBe('light');
  });

  it('derives explicit mode from a pre-existing stored choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.mode).toBe('dark');
    expect(result.current.theme).toBe('dark');
  });

  it('toggleTheme flips the resolved theme and pins it', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    // From system(light) → toggle → explicit dark.
    act(() => {
      result.current.toggleTheme();
    });
    expect(result.current.theme).toBe('dark');
    expect(result.current.mode).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

describe('ThemeProvider — auto mode (F-132)', () => {
  it('resolves light at a daytime hour (10:00, inside the 06:00–18:00 window)', () => {
    setClock('10:00:00');
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('auto');
    });
    expect(result.current.mode).toBe('auto');
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('auto');
  });

  it('resolves dark at a nighttime hour (22:00, outside the window)', () => {
    setClock('22:00:00');
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('auto');
    });
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('resolves dark in the early morning (05:00, before the window opens)', () => {
    setClock('05:00:00');
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('auto');
    });
    expect(result.current.theme).toBe('dark');
  });

  it('derives auto mode from a pre-existing stored choice, resolved at mount', () => {
    setClock('12:00:00');
    localStorage.setItem(THEME_STORAGE_KEY, 'auto');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.mode).toBe('auto');
    expect(result.current.theme).toBe('light');
  });

  it('re-evaluates over time and flips exactly at the boundary, with no reload', () => {
    // Start one minute before the 18:00 day→night boundary.
    setClock('17:59:00');
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('auto');
    });
    expect(result.current.theme).toBe('light');

    // Cross the boundary purely by advancing the fake clock + the poll
    // interval — no unmount/remount, no manual re-resolution call.
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('stops polling once the mode leaves auto (no stray flips afterward)', () => {
    setClock('17:59:00');
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('auto');
    });
    act(() => {
      result.current.setMode('light'); // manual override — see next describe
    });
    expect(result.current.theme).toBe('light');

    // Advancing past the boundary must NOT flip an explicit 'light' choice.
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(result.current.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('ThemeProvider — manual override wins over auto/system (F-132)', () => {
  it('an explicit setMode(dark) while in auto overrides the clock-resolved theme', () => {
    setClock('10:00:00'); // daytime — auto would resolve light
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('auto');
    });
    expect(result.current.theme).toBe('light');

    act(() => {
      result.current.setMode('dark'); // manual override
    });
    expect(result.current.mode).toBe('dark');
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('toggleTheme from auto pins an explicit choice that survives the clock crossing the boundary', () => {
    setClock('17:59:00');
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setMode('auto'); // resolves light
    });
    act(() => {
      result.current.toggleTheme(); // manual: light -> dark, pinned
    });
    expect(result.current.mode).toBe('dark');
    expect(result.current.theme).toBe('dark');

    act(() => {
      vi.advanceTimersByTime(5 * 60_000); // crosses 18:00 — irrelevant now
    });
    expect(result.current.mode).toBe('dark');
    expect(result.current.theme).toBe('dark');
  });
});

describe('resolveAutoTheme (pure function, F-132)', () => {
  it('resolves light for every hour in [6, 18) via an injected hour extractor', () => {
    const dummyDate = new Date(0);
    for (let hour = 6; hour < 18; hour++) {
      expect(resolveAutoTheme(dummyDate, () => hour)).toBe('light');
    }
  });

  it('resolves dark for every hour outside [6, 18) via an injected hour extractor', () => {
    const dummyDate = new Date(0);
    for (const hour of [0, 1, 5, 18, 19, 23]) {
      expect(resolveAutoTheme(dummyDate, () => hour)).toBe('dark');
    }
  });

  it('defaults to the real local Date.prototype.getHours (no extractor supplied)', () => {
    const morning = new Date('2026-07-14T09:30:00');
    const night = new Date('2026-07-14T21:30:00');
    expect(resolveAutoTheme(morning)).toBe('light');
    expect(resolveAutoTheme(night)).toBe('dark');
  });
});
