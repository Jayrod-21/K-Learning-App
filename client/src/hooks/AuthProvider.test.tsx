/**
 * AuthProvider — initial probe + `refresh()` re-probe behaviour.
 *
 * Mocks `services/api`'s `api.get` so we control the `/auth/me` response.
 * The Pass 3 addition under test is `refresh()` on the context value:
 * calling it must rerun the probe and update the cached `user`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { JSX } from 'react';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';
import { api, ApiError } from '../services/api';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Read auth state into the DOM so RTL assertions can observe it.
 * Exposes a button that calls `refresh()` so tests can drive the new
 * Pass-3 API surface.
 */
function Probe(): JSX.Element {
  const auth = useAuth();
  return (
    <div>
      <div data-testid="status">{auth.status}</div>
      <div data-testid="email">{auth.user?.email ?? ''}</div>
      <div data-testid="display_name">{auth.user?.display_name ?? ''}</div>
      <button
        type="button"
        onClick={() => {
          void auth.refresh();
        }}
      >
        refresh
      </button>
    </div>
  );
}

describe('AuthProvider — initial probe', () => {
  it('hydrates from GET /auth/me on mount', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      user: { id: 1, email: 'jay@example.com', display_name: 'Jay' },
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
    expect(screen.getByTestId('email')).toHaveTextContent('jay@example.com');
    expect(screen.getByTestId('display_name')).toHaveTextContent('Jay');
  });

  it('lands as guest on 401', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('no session', { status: 401, code: 'unauthenticated' }),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });
  });
});

describe('AuthProvider.refresh()', () => {
  it('re-runs the probe and reflects the new user', async () => {
    const getSpy = vi
      .spyOn(api, 'get')
      // Initial mount probe.
      .mockResolvedValueOnce({
        user: { id: 1, email: 'jay@example.com', display_name: 'Jay' },
      })
      // refresh() call.
      .mockResolvedValueOnce({
        user: {
          id: 1,
          email: 'jay@example.com',
          display_name: 'Jared',
          phone: '+15555550100',
        },
      });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('display_name')).toHaveTextContent('Jay');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'refresh' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('display_name')).toHaveTextContent('Jared');
    });
    // Initial probe + the refresh call.
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      '/auth/me',
      expect.objectContaining({ signal: expect.any(AbortSignal) }) as unknown,
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      '/auth/me',
      expect.objectContaining({ signal: expect.any(AbortSignal) }) as unknown,
    );
  });

  it('refresh() after a 401 promotes back to authenticated when the next probe wins', async () => {
    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(
        new ApiError('no session', { status: 401, code: 'unauthenticated' }),
      )
      .mockResolvedValueOnce({
        user: { id: 7, email: 'late@example.com' },
      });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('guest');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'refresh' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
    expect(screen.getByTestId('email')).toHaveTextContent('late@example.com');
  });
});
