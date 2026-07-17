/**
 * VerifyEmail (F-006) — landing-page state machine tests.
 *
 * services/auth is stubbed so each test drives one server outcome
 * (verified / already_verified / token_expired / token_invalid / network)
 * without a network layer. The page is rendered under a MemoryRouter with the
 * token in the URL FRAGMENT (`#token=…` — fix-pass SF-1: the fragment never
 * leaves the browser) so `useLocation().hash` reads it exactly as production
 * does; the page must scrub the fragment from history once captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ApiError } from '../services/api';

const mocks = vi.hoisted(() => ({
  verifyEmail: vi.fn<(token: string) => Promise<'verified' | 'already_verified'>>(),
  resendVerification: vi.fn<(email: string) => Promise<void>>(),
}));

vi.mock('../services/auth', () => ({
  verifyEmail: mocks.verifyEmail,
  resendVerification: mocks.resendVerification,
}));

import VerifyEmail from './VerifyEmail';

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
          path="/verify-email"
          element={
            <>
              <VerifyEmail />
              <LocationProbe />
            </>
          }
        />
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.verifyEmail.mockReset();
  mocks.resendVerification.mockReset();
  mocks.resendVerification.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('VerifyEmail — success', () => {
  it('consumes the token from the URL FRAGMENT and shows the verified state', async () => {
    mocks.verifyEmail.mockResolvedValue('verified');
    renderAt('/verify-email#token=abcDEF-_123');

    expect(
      await screen.findByRole('heading', { level: 1, name: /Email verified/ }),
    ).toBeInTheDocument();
    expect(mocks.verifyEmail).toHaveBeenCalledWith('abcDEF-_123');
    // Offers the sign-in link.
    expect(screen.getByRole('link', { name: /Go to sign in/ })).toBeInTheDocument();
  });

  it('scrubs the token fragment from the URL/history once captured (SF-1)', async () => {
    mocks.verifyEmail.mockResolvedValue('verified');
    renderAt('/verify-email#token=secretsecretsecret');

    // The verify call still received the token (captured before the scrub)…
    await waitFor(() => {
      expect(mocks.verifyEmail).toHaveBeenCalledWith('secretsecretsecret');
    });
    // …but the live URL no longer carries it.
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        /^\/verify-email$/,
      );
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: /Email verified/ }),
    ).toBeInTheDocument();
  });

  it('treats already_verified as a friendly success (idempotent double-click)', async () => {
    mocks.verifyEmail.mockResolvedValue('already_verified');
    renderAt('/verify-email#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(
      await screen.findByRole('heading', { level: 1, name: /Email verified/ }),
    ).toBeInTheDocument();
  });

  it('a legacy ?token= query URL is NOT honored (fragment is the only token channel)', async () => {
    // No query-form link has ever been emailed; honoring one would re-open
    // the access-log exposure the fragment scheme closed.
    renderAt('/verify-email?token=queryformtoken');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Link not valid/ }),
    ).toBeInTheDocument();
    expect(mocks.verifyEmail).not.toHaveBeenCalled();
  });
});

describe('VerifyEmail — expired', () => {
  it('shows the expired state with a resend form, and never echoes server text', async () => {
    mocks.verifyEmail.mockRejectedValue(
      new ApiError('token expired at 2020', {
        status: 400,
        code: 'token_expired',
      }),
    );
    renderAt('/verify-email#token=expiredtoken_aaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(
      await screen.findByRole('heading', { level: 1, name: /Link expired/ }),
    ).toBeInTheDocument();
    // Fixed copy, not the server message.
    expect(screen.queryByText(/token expired at 2020/)).not.toBeInTheDocument();

    // The resend form: enter an email → send → non-enumerating success copy.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'Me@Example.com');
    await user.click(screen.getByRole('button', { name: /Send a new link/ }));
    await waitFor(() => {
      expect(mocks.resendVerification).toHaveBeenCalledWith('me@example.com');
    });
    expect(
      await screen.findByText(/If an account exists for me@example.com/),
    ).toBeInTheDocument();
  });
});

describe('VerifyEmail — invalid', () => {
  it('shows the invalid state for a non-expired rejection', async () => {
    mocks.verifyEmail.mockRejectedValue(
      new ApiError('nope', { status: 400, code: 'token_invalid' }),
    );
    renderAt('/verify-email#token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    expect(
      await screen.findByRole('heading', { level: 1, name: /Link not valid/ }),
    ).toBeInTheDocument();
  });

  it('shows the invalid state immediately when no token is present (no call)', async () => {
    renderAt('/verify-email');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Link not valid/ }),
    ).toBeInTheDocument();
    expect(mocks.verifyEmail).not.toHaveBeenCalled();
  });
});

describe('VerifyEmail — resend form (invalid/expired states)', () => {
  async function renderInvalidWithForm() {
    mocks.verifyEmail.mockRejectedValue(
      new ApiError('nope', { status: 400, code: 'token_invalid' }),
    );
    renderAt('/verify-email#token=ddddddddddddddddddddddddddddddddddddddddddd');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Link not valid/ }),
    ).toBeInTheDocument();
  }

  it('an empty submit shows the fixed prompt (never a silent no-op)', async () => {
    await renderInvalidWithForm();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Send a new link/ }));
    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('Enter your account email to request a new link.');
    expect(mocks.resendVerification).not.toHaveBeenCalled();
  });

  it('a 429 disables the form for retry_after seconds, then re-enables (SF-2 backoff)', async () => {
    await renderInvalidWithForm();
    mocks.resendVerification.mockRejectedValue(
      new ApiError('slow down', { status: 429, code: 'rate_limited', retryAfter: 2 }),
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'me@example.com');
    await user.click(screen.getByRole('button', { name: /Send a new link/ }));

    // Fixed copy (never the server prose), and the button is locked out.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
    expect(screen.queryByText(/slow down/)).not.toBeInTheDocument();
    const locked = screen.getByRole('button', { name: /Retry in 2s/ });
    expect(locked).toBeDisabled();

    // Clicking while locked fires nothing further.
    expect(mocks.resendVerification).toHaveBeenCalledTimes(1);

    // The countdown elapses → the button re-enables with its normal label.
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Send a new link/ }),
        ).toBeEnabled();
      },
      { timeout: 4000 },
    );
  });
});

describe('VerifyEmail — network', () => {
  it('shows a retry affordance on a network error and re-verifies on retry', async () => {
    mocks.verifyEmail
      .mockRejectedValueOnce(new ApiError('down', { status: 0, code: 'network' }))
      .mockResolvedValueOnce('verified');
    renderAt('/verify-email#token=ccccccccccccccccccccccccccccccccccccccccccc');

    expect(
      await screen.findByRole('heading', { level: 1, name: /Connection problem/ }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Email verified/ }),
    ).toBeInTheDocument();
    expect(mocks.verifyEmail).toHaveBeenCalledTimes(2);
  });
});
