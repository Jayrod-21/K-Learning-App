/**
 * ThemeProvider — verifies the PF-A A4 three-way mode control:
 *   - setMode('light'|'dark') stores km.theme + applies data-theme,
 *   - setMode('system') CLEARS km.theme and resolves from matchMedia,
 *   - 'system' tracks live matchMedia change events,
 *   - `mode` is derived from storage at mount (stored ⇒ explicit, absent ⇒ system),
 *   - toggleTheme flips the resolved theme and pins it as an explicit choice.
 *
 * happy-dom's matchMedia is stubbed so we can drive prefers-color-scheme.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { ThemeProvider } from './ThemeProvider';
import { useTheme } from './useTheme';
import { THEME_STORAGE_KEY } from './theme-context';

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
