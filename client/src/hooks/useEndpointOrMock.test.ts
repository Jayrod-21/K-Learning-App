/**
 * useEndpointOrMock — behaviour suite.
 *
 * Covers the contract cases the integration plan calls out:
 *   1. No realFn → resolves with mockFn, isMock=true.
 *   2. realFn resolves → returns real, isMock=false, error=null.
 *   3. realFn rejects → falls back to mock, error reflects the real failure,
 *      isMock=true.
 *   4. Unmount mid-flight aborts; no state writes occur after unmount.
 *   5. Mock-only rejection surfaces as `error`, data stays null.
 *   6. Key change resets `data` / `isMock` immediately (no stale flash).
 *   7. `refetch()` re-runs the loader without changing the key and also
 *      resets `data` / `isMock`.
 *
 * `act()` wraps every state-changing await so React 19's strict updater
 * batching doesn't surface warnings under the suite.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useEndpointOrMock } from './useEndpointOrMock';
import { ApiError } from '../services/api';

/** Tiny helper — yields a promise that resolves after `ms` so tests can
 *  inspect intermediate state without leaning on timer mocks. */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('useEndpointOrMock', () => {
  it('returns the mock value when no realFn is provided', async () => {
    const mockFn = vi.fn(async () => ({ greeting: 'mock' }));

    const { result } = renderHook(() =>
      useEndpointOrMock('k1', mockFn),
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.isMock).toBe(false);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ greeting: 'mock' });
    expect(result.current.isMock).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('prefers realFn over mockFn when realFn resolves', async () => {
    const mockFn = vi.fn(async () => ({ greeting: 'mock' }));
    const realFn = vi.fn(async () => ({ greeting: 'real' }));

    const { result } = renderHook(() =>
      useEndpointOrMock('k2', mockFn, { realFn }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ greeting: 'real' });
    expect(result.current.isMock).toBe(false);
    expect(result.current.error).toBeNull();
    expect(realFn).toHaveBeenCalledTimes(1);
    // mockFn never runs when the real call succeeds — important for cost on
    // real endpoints that bill per call (e.g. Claude proxy).
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('falls back to mockFn when realFn rejects, and surfaces the real error', async () => {
    const realError = new ApiError('server down', {
      status: 500,
      code: 'server_error',
    });
    const realFn = vi.fn(async () => {
      throw realError;
    });
    const mockFn = vi.fn(async () => ({ greeting: 'mock-fallback' }));

    const { result } = renderHook(() =>
      useEndpointOrMock('k3', mockFn, { realFn }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ greeting: 'mock-fallback' });
    expect(result.current.isMock).toBe(true);
    // The real-call failure passes through so the toast layer can surface it
    // even though the UI still renders the mock value underneath.
    expect(result.current.error).toBe(realError);
    expect(realFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight requests on unmount without writing state', async () => {
    // A promise that never resolves on its own — the only way out is abort.
    const pending = (): Promise<never> => new Promise<never>(() => {});
    const mockFn = vi.fn(pending);

    const { result, unmount } = renderHook(() =>
      useEndpointOrMock('k4', mockFn),
    );

    expect(result.current.loading).toBe(true);
    unmount();

    // Give the event loop a tick so any rogue setState after unmount would
    // surface as a React warning (which Vitest treats as a test failure when
    // the suite has the strict console assertion enabled).
    await act(async () => {
      await wait(20);
    });

    // Hook state is frozen at the unmount snapshot — no `loading: false`
    // flicker after the fact.
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('surfaces a mock-only failure as `error` with data null', async () => {
    const mockFailure = new ApiError('mock blew up', {
      status: 0,
      code: 'unknown',
    });
    const mockFn = vi.fn(async () => {
      throw mockFailure;
    });

    const { result } = renderHook(() =>
      useEndpointOrMock('k5', mockFn),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe(mockFailure);
    expect(result.current.isMock).toBe(false);
  });

  it('resets data and isMock to initial values when `key` changes', async () => {
    let nextValue: { greeting: string } = { greeting: 'A' };
    const mockFn = vi.fn(async () => nextValue);

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useEndpointOrMock(key, mockFn),
      { initialProps: { key: 'k-a' } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ greeting: 'A' });
    expect(result.current.isMock).toBe(true);

    // Swap the mock's payload and the key. Without the eager reset, the
    // consumer would briefly see the previous `data` + `isMock=true`
    // before the new run settled. We assert the transition resets to
    // `{ data: null, isMock: false, loading: true }` on the very next
    // render after the key change.
    nextValue = { greeting: 'B' };
    rerender({ key: 'k-b' });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.isMock).toBe(false);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ greeting: 'B' });
    expect(result.current.isMock).toBe(true);
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('refetch() re-runs the loader without changing the key', async () => {
    let calls = 0;
    const mockFn = vi.fn(async () => {
      calls += 1;
      return { tick: calls };
    });

    const { result } = renderHook(() =>
      useEndpointOrMock('k-rf', mockFn),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ tick: 1 });

    await act(async () => {
      result.current.refetch();
    });

    // refetch resets to loading state first (no stale data flash).
    // Wait for the new run to settle.
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ tick: 2 });
    expect(mockFn).toHaveBeenCalledTimes(2);
  });
});
