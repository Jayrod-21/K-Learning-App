/**
 * AccentProvider — verifies the Seoul Neon accent picker's state layer
 * (Redesign §14a):
 *   - defaults to coral with no stored choice,
 *   - setAccent stores km.accent + stamps data-accent on <html>,
 *   - derives the accent from a pre-existing stored choice at mount,
 *   - rejects a corrupt stored value (falls back to coral),
 *   - respects a pre-stamped attribute (index.html no-flash bootstrap).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { AccentProvider } from './AccentProvider';
import { useAccent } from './useAccent';
import { ACCENT_STORAGE_KEY, DEFAULT_ACCENT } from './accent-context';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.accent;
});

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <AccentProvider>{children}</AccentProvider>;
}

describe('AccentProvider (§14a)', () => {
  it('starts on the coral default with no stored choice', () => {
    const { result } = renderHook(() => useAccent(), { wrapper });
    expect(result.current.accent).toBe(DEFAULT_ACCENT);
    expect(document.documentElement.dataset.accent).toBe('coral');
  });

  it("setAccent('blue') stores km.accent and stamps data-accent", () => {
    const { result } = renderHook(() => useAccent(), { wrapper });
    act(() => {
      result.current.setAccent('blue');
    });
    expect(result.current.accent).toBe('blue');
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('blue');
    expect(document.documentElement.dataset.accent).toBe('blue');
  });

  it('derives the accent from a pre-existing stored choice', () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, 'mint');
    const { result } = renderHook(() => useAccent(), { wrapper });
    expect(result.current.accent).toBe('mint');
    expect(document.documentElement.dataset.accent).toBe('mint');
  });

  it('falls back to coral on a corrupt stored value', () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, 'chartreuse');
    const { result } = renderHook(() => useAccent(), { wrapper });
    expect(result.current.accent).toBe('coral');
    expect(document.documentElement.dataset.accent).toBe('coral');
  });

  it('accepts a pre-stamped attribute without a redundant rewrite', () => {
    // Simulate the index.html no-flash bootstrap: attribute already correct.
    localStorage.setItem(ACCENT_STORAGE_KEY, 'blue');
    document.documentElement.dataset.accent = 'blue';
    const { result } = renderHook(() => useAccent(), { wrapper });
    expect(result.current.accent).toBe('blue');
    expect(document.documentElement.dataset.accent).toBe('blue');
  });

  it('switches accents repeatedly without a reload', () => {
    const { result } = renderHook(() => useAccent(), { wrapper });
    act(() => {
      result.current.setAccent('mint');
    });
    act(() => {
      result.current.setAccent('coral');
    });
    expect(result.current.accent).toBe('coral');
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('coral');
    expect(document.documentElement.dataset.accent).toBe('coral');
  });
});
