/**
 * UnverifiedBanner (F-006) — renders only for a signed-in user whose email is
 * explicitly unverified; dismissible; wires the shared resend endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthContextValue } from '../hooks/auth-context';

const mocks = vi.hoisted(() => ({
  authValue: null as AuthContextValue | null,
  resendVerification: vi.fn(async () => undefined),
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => mocks.authValue,
}));
vi.mock('../services/auth', () => ({
  resendVerification: mocks.resendVerification,
}));

import { UnverifiedBanner } from './UnverifiedBanner';

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'authenticated',
    user: { id: 1, email: 'u@example.com', email_verified: false },
    loading: false,
    pending: null,
    login: vi.fn(async () => undefined),
    submitTotp: vi.fn(async () => undefined),
    enroll: vi.fn(async () => ({ otpauthUri: 'otpauth://x', secret: 'S' })),
    confirmEnroll: vi.fn(async () => ({ recoveryCodes: [] })),
    completeEnrollment: vi.fn(async () => undefined),
    register: vi.fn(async () => 'authenticated' as const),
    logout: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.authValue = makeAuth();
  mocks.resendVerification.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('UnverifiedBanner', () => {
  it('renders for a signed-in, explicitly-unverified user and can resend + dismiss', async () => {
    render(<UnverifiedBanner />);
    expect(screen.getByText(/isn.t verified yet/)).toBeInTheDocument();
    expect(screen.getByText('u@example.com')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Resend link/ }));
    await waitFor(() => {
      expect(mocks.resendVerification).toHaveBeenCalledWith('u@example.com');
    });

    // Dismiss removes the banner.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/isn.t verified yet/)).not.toBeInTheDocument();
  });

  it('renders nothing when the email IS verified', () => {
    mocks.authValue = makeAuth({
      user: { id: 1, email: 'u@example.com', email_verified: true },
    });
    const { container } = render(<UnverifiedBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when email_verified is absent (legacy fixture — do not nag)', () => {
    mocks.authValue = makeAuth({ user: { id: 1, email: 'u@example.com' } });
    const { container } = render(<UnverifiedBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is no user', () => {
    mocks.authValue = makeAuth({ user: null });
    const { container } = render(<UnverifiedBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
