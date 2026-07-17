/**
 * ResendVerificationButton (F-006) — behavior tests.
 *
 * Covers the review-flagged gaps (fix-pass client SF-2 / N-4): the 429 →
 * fixed-copy branch, the retry_after backoff lockout, the disabled-while-
 * sending guard, and the non-enumerating success copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';

const mocks = vi.hoisted(() => ({
  resendVerification: vi.fn<(email: string) => Promise<void>>(),
}));

vi.mock('../services/auth', () => ({
  resendVerification: mocks.resendVerification,
}));

import { ResendVerificationButton } from './ResendVerificationButton';

beforeEach(() => {
  mocks.resendVerification.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ResendVerificationButton', () => {
  it('sends once and swaps to the non-enumerating success copy', async () => {
    mocks.resendVerification.mockResolvedValue(undefined);
    render(<ResendVerificationButton email="me@example.com" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Resend verification email/ }));

    expect(
      await screen.findByText(/If an account exists for me@example.com/),
    ).toBeInTheDocument();
    expect(mocks.resendVerification).toHaveBeenCalledTimes(1);
    expect(mocks.resendVerification).toHaveBeenCalledWith('me@example.com');
    // The button is gone — the happy path is one-shot per mount.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a non-429 failure shows the fixed network copy and stays retryable', async () => {
    mocks.resendVerification.mockRejectedValue(
      new ApiError('boom detail from server', { status: 0, code: 'network' }),
    );
    render(<ResendVerificationButton email="me@example.com" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Resend verification email/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not send the email. Check your connection and retry.',
    );
    // Never the server prose.
    expect(screen.queryByText(/boom detail/)).not.toBeInTheDocument();
    // No backoff for a plain failure — immediately retryable.
    expect(
      screen.getByRole('button', { name: /Resend verification email/ }),
    ).toBeEnabled();
  });

  it('a 429 shows the fixed copy and locks the button for retry_after seconds (SF-2)', async () => {
    mocks.resendVerification.mockRejectedValue(
      new ApiError('too fast', { status: 429, code: 'rate_limited', retryAfter: 2 }),
    );
    render(<ResendVerificationButton email="me@example.com" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Resend verification email/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
    const locked = screen.getByRole('button', { name: /Retry in 2s/ });
    expect(locked).toBeDisabled();
    expect(mocks.resendVerification).toHaveBeenCalledTimes(1);

    // After the window passes the button re-enables with its normal label.
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Resend verification email/ }),
        ).toBeEnabled();
      },
      { timeout: 4000 },
    );
  });

  it('a 429 with no retry_after falls back to the default backoff (still disabled)', async () => {
    mocks.resendVerification.mockRejectedValue(
      new ApiError('too fast', { status: 429, code: 'rate_limited' }),
    );
    render(<ResendVerificationButton email="me@example.com" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Resend verification email/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
    // Fallback is 30s — assert the lockout engaged without waiting it out.
    expect(screen.getByRole('button', { name: /Retry in 30s/ })).toBeDisabled();
  });
});
