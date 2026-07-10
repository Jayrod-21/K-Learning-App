/**
 * TextSizeProvider — verifies the app-wide text-size state layer (F-025):
 *   - defaults to md with no stored choice (the app must NOT shrink by
 *     default — Small is opt-in),
 *   - setTextSize stores km.textSize + stamps data-text-size on <html>,
 *   - derives the size from a pre-existing stored choice at mount,
 *   - rejects a corrupt stored value (coerces back to md),
 *   - respects a pre-stamped attribute (index.html no-flash bootstrap).
 *
 * The server half of the two-way sync (adopt-on-hydrate, change-PUT,
 * pre-hydration PUT guard) is owned by the Settings screen and covered in
 * `pages/Settings.test.tsx` ("text size cross-device sync") — the same split
 * the accent layer uses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { TextSizeProvider } from './TextSizeProvider';
import { useTextSize } from './useTextSize';
import { DEFAULT_TEXT_SIZE, TEXT_SIZE_STORAGE_KEY } from './text-size-context';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.textSize;
});

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <TextSizeProvider>{children}</TextSizeProvider>;
}

describe('TextSizeProvider (F-025)', () => {
  it('starts on the md default with no stored choice (current app size)', () => {
    const { result } = renderHook(() => useTextSize(), { wrapper });
    expect(result.current.textSize).toBe(DEFAULT_TEXT_SIZE);
    expect(document.documentElement.dataset.textSize).toBe('md');
  });

  it("setTextSize('lg') stores km.textSize and stamps data-text-size", () => {
    const { result } = renderHook(() => useTextSize(), { wrapper });
    act(() => {
      result.current.setTextSize('lg');
    });
    expect(result.current.textSize).toBe('lg');
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('lg');
    expect(document.documentElement.dataset.textSize).toBe('lg');
  });

  it('derives the size from a pre-existing stored choice', () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, 'sm');
    const { result } = renderHook(() => useTextSize(), { wrapper });
    expect(result.current.textSize).toBe('sm');
    expect(document.documentElement.dataset.textSize).toBe('sm');
  });

  it('coerces a corrupt stored value back to md', () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, 'gigantic');
    const { result } = renderHook(() => useTextSize(), { wrapper });
    expect(result.current.textSize).toBe('md');
    expect(document.documentElement.dataset.textSize).toBe('md');
  });

  it('accepts a pre-stamped attribute without a redundant rewrite', () => {
    // Simulate the index.html no-flash bootstrap: attribute already correct.
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, 'lg');
    document.documentElement.dataset.textSize = 'lg';
    const { result } = renderHook(() => useTextSize(), { wrapper });
    expect(result.current.textSize).toBe('lg');
    expect(document.documentElement.dataset.textSize).toBe('lg');
  });

  it('switches sizes repeatedly without a reload', () => {
    const { result } = renderHook(() => useTextSize(), { wrapper });
    act(() => {
      result.current.setTextSize('sm');
    });
    act(() => {
      result.current.setTextSize('md');
    });
    expect(result.current.textSize).toBe('md');
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('md');
    expect(document.documentElement.dataset.textSize).toBe('md');
  });
});
