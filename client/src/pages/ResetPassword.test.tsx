/**
 * ResetPassword (Phase 2.1) — landing-page state machine tests.
 *
 * services/auth is stubbed so each test drives one server outcome
 * (reset / token_expired / token_invalid / network / validation failure)
 * without a network layer. The page is rendered under a MemoryRouter with the
 * token in the URL FRAGMENT (`#token=…` — mirrors VerifyEmail's fix-pass
 * SF-1: the fragment never leaves the browser) so `useLocation().hash` reads
 * it exactly as production does; the page must scrub the fragment from
 * history once captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ApiError } from '../services/api';

const mocks = vi.hoisted(() => ({
  confirmPasswordReset: vi.fn<(token: string, password: string) => Promise<void>>(),
  requestPasswordReset: vi.fn<(email: string) => Promise<void>>(),
}));

vi.mock('../services/auth', () => ({
  confirmPasswordReset: mocks.confirmPasswordReset,
  requestPasswordReset: mocks.requestPasswordReset,
}));

import ResetPassword from './ResetPassword';

const VALID_PASSWORD = 'a-perfectly-long-passphrase';

/** Exposes the router's CURRENT full location so tests can assert the token
 *  fragment was scrubbed from the address bar/history. */
function LocationProbe(): JSX.Element {
  const location = useLocation();
  return (
    <div data-testid="location-probe">
      {location.pathname + location.search + location.hash}
    </div>
  );
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/reset-password"
          element={
            <>
              <ResetPassword />
              <LocationProbe />
            </>
          }
        />
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function submitNewPassword(
  password = VALID_PASSWORD,
  confirm = VALID_PASSWORD,
): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('New password'), password);
  await user.type(screen.getByLabelText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Reset password' }));
}

beforeEach(() => {
  mocks.confirmPasswordReset.mockReset();
  mocks.requestPasswordReset.mockReset();
  mocks.requestPasswordReset.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ResetPassword — form + success', () => {
  it('renders the new-password form when a token is present in the URL FRAGMENT', async () => {
    renderAt('/reset-password#token=abcDEF-_123');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Choose a new password/ }),
    ).toBeInTheDocument();
    expect(mocks.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it('scrubs the token fragment from the URL/history once captured (mirrors VerifyEmail SF-1)', async () => {
    mocks.confirmPasswordReset.mockResolvedValue(undefined);
    renderAt('/reset-password#token=secretsecretsecret');

    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        /^\/reset-password$/,
      );
    });

    await submitNewPassword();
    await waitFor(() => {
      expect(mocks.confirmPasswordReset).toHaveBeenCalledWith(
        'secretsecretsecret',
        VALID_PASSWORD,
      );
    });
  });

  it('a mismatched confirmation is rejected client-side without calling the server', async () => {
    renderAt('/reset-password#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await submitNewPassword(VALID_PASSWORD, 'a-different-passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(mocks.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it('a too-short password is rejected client-side without calling the server', async () => {
    renderAt('/reset-password#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await submitNewPassword('short', 'short');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /at least 12 characters/,
    );
    expect(mocks.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it('on success shows the "password updated" state with NO auto-login (only a sign-in link)', async () => {
    mocks.confirmPasswordReset.mockResolvedValue(undefined);
    renderAt('/reset-password#token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    await submitNewPassword();
    expect(
      await screen.findByRole('heading', { level: 1, name: /Password updated/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/every device has been signed out/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to sign in/ })).toBeInTheDocument();
  });
});

describe('ResetPassword — expired', () => {
  it('shows the expired state with a request-new-link form, and never echoes server text', async () => {
    mocks.confirmPasswordReset.mockRejectedValue(
      new ApiError('token expired at 2020', { status: 400, code: 'token_expired' }),
    );
    renderAt('/reset-password#token=expiredtoken_aaaaaaaaaaaaaaaaaaaaaaaaaaa');

    await submitNewPassword();
    expect(
      await screen.findByRole('heading', { level: 1, name: /Link expired/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/token expired at 2020/)).not.toBeInTheDocument();

    // The request-new-link form: enter an email → send → non-enumerating copy.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'Me@Example.com');
    await user.click(screen.getByRole('button', { name: /Send a new link/ }));
    await waitFor(() => {
      expect(mocks.requestPasswordReset).toHaveBeenCalledWith('me@example.com');
    });
    expect(
      await screen.findByText(/If an account exists for me@example.com/),
    ).toBeInTheDocument();
  });
});

describe('ResetPassword — invalid', () => {
  it('shows the invalid state for a non-expired rejection', async () => {
    mocks.confirmPasswordReset.mockRejectedValue(
      new ApiError('nope', { status: 400, code: 'token_invalid' }),
    );
    renderAt('/reset-password#token=ccccccccccccccccccccccccccccccccccccccccccc');

    await submitNewPassword();
    expect(
      await screen.findByRole('heading', { level: 1, name: /Link not valid/ }),
    ).toBeInTheDocument();
  });

  it('shows the invalid state immediately when no token is present (no server call, no form)', async () => {
    renderAt('/reset-password');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Link not valid/ }),
    ).toBeInTheDocument();
    expect(mocks.confirmPasswordReset).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('a legacy ?token= query URL is NOT honored (fragment is the only token channel)', async () => {
    renderAt('/reset-password?token=queryformtoken');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Link not valid/ }),
    ).toBeInTheDocument();
  });
});

describe('ResetPassword — network + validation failures', () => {
  it('a network failure (status 0) offers a retry back to the form', async () => {
    mocks.confirmPasswordReset.mockRejectedValue(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );
    renderAt('/reset-password#token=ddddddddddddddddddddddddddddddddddddddddddd');

    await submitNewPassword();
    expect(
      await screen.findByRole('heading', { level: 1, name: /Connection problem/ }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Choose a new password/ }),
    ).toBeInTheDocument();
  });

  it('a server validation failure (e.g. password rejected) shows fixed copy and stays on the form', async () => {
    mocks.confirmPasswordReset.mockRejectedValue(
      new ApiError('password too weak per policy X', {
        status: 400,
        code: 'validation_error',
      }),
    );
    renderAt('/reset-password#token=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');

    await submitNewPassword();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not reset your password/);
    expect(alert).not.toHaveTextContent('password too weak per policy X');
    // Still on the form — not bounced to a dead end.
    expect(
      screen.getByRole('button', { name: 'Reset password' }),
    ).toBeInTheDocument();
  });
});
