/**
 * Login screen — multi-step 2FA flow (PASS LOGIN — PART C3 / C7).
 *
 * We stub `useAuth` so each test can pin the `pending` state and the method
 * resolutions, driving one step at a time without a real AuthProvider. The
 * `qrcode` module is stubbed to a deterministic data URL so the enroll step's
 * `<img>` is assertable without invoking the real encoder.
 *
 * Coverage:
 *   - Step transitions render the right fields (credentials / code / enroll).
 *   - Code step accepts a 6-digit code + has the recovery-code toggle.
 *   - Enroll step renders the QR (alt text) AND the manual secret.
 *   - The recovery-codes ack gates app entry (button disabled until checked,
 *     then `completeEnrollment` fires).
 *   - Fixed error strings for invalid_code / account_locked / challenge_invalid
 *     — and that a raw server `message` is NEVER echoed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';
import type { AuthContextValue } from '../hooks/auth-context';

// ─── Mocks ────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  authValue: null as AuthContextValue | null,
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => mocks.authValue,
}));

// Deterministic QR so the enroll <img> is assertable without the real encoder.
vi.mock('../lib/qr', () => ({
  otpauthUriToDataUrl: vi.fn(async () => 'data:image/png;base64,QRTEST'),
}));

// F-006: the ResendVerificationButton (used by the check-email + unverified
// notice steps) calls services/auth.resendVerification directly. Stub it so
// the resend flow is assertable without a network layer. Phase 2.1: the
// forgot-password step calls services/auth.requestPasswordReset directly,
// same pattern.
const resendMock = vi.hoisted(() => vi.fn(async () => undefined));
const requestPasswordResetMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../services/auth', () => ({
  resendVerification: resendMock,
  requestPasswordReset: requestPasswordResetMock,
}));

import Login from './Login';

/** Build a default mocked auth context; tests override per-case. */
function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'guest',
    user: null,
    loading: false,
    pending: null,
    login: vi.fn(async () => undefined),
    submitTotp: vi.fn(async () => undefined),
    enroll: vi.fn(async () => ({ otpauthUri: 'otpauth://x', secret: 'SEED' })),
    confirmEnroll: vi.fn(async () => ({ recoveryCodes: ['AAAAA-BBBBB'] })),
    completeEnrollment: vi.fn(async () => undefined),
    register: vi.fn(async () => 'authenticated' as const),
    logout: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.authValue = makeAuth();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Credentials step ─────────────────────────────────────────

describe('Login — credentials step', () => {
  it('renders email + password and submits via login()', async () => {
    const login = vi.fn(async () => undefined);
    mocks.authValue = makeAuth({ login });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'jay@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).toHaveBeenCalledWith('jay@example.com', 'a-long-passphrase');
  });

  it('P3b: the brand eyebrow + title render Korean in both-mode', () => {
    render(<Login />);
    // Pre-auth there is no SettingsProvider — the primitive falls back to
    // the 'both' default, so both halves of the pair must be present.
    expect(screen.getByText('한국어 마스터')).toBeInTheDocument();
    expect(screen.getByText('Korean Master')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: '환영합니다 · Welcome' }),
    ).toBeInTheDocument();
  });

  it('maps a 401 to the fixed credential string (never echoes server text)', async () => {
    const login = vi.fn(async () => {
      throw new ApiError('user bob@evil.com not found', {
        status: 401,
        code: 'invalid_credentials',
      });
    });
    mocks.authValue = makeAuth({ login });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'jay@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email or password is incorrect.');
    // The raw server message must NOT leak.
    expect(alert).not.toHaveTextContent('bob@evil.com');
  });

  it('maps registration_closed (403) to the fixed string in register mode', async () => {
    const register = vi.fn(async () => {
      throw new ApiError('registration disabled', {
        status: 403,
        code: 'registration_closed',
      });
    });
    mocks.authValue = makeAuth({ register });
    render(<Login />);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: /Create one/ }),
    );
    await user.type(screen.getByLabelText('Email'), 'jay@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Registration is closed.',
    );
  });
});

// ─── F-006: register → check-your-email step ──────────────────

describe('Login — F-006 register verification_required', () => {
  it('advances to the "check your email" step (no session) when register resolves verification_required', async () => {
    const register = vi.fn(async () => 'verification_required' as const);
    mocks.authValue = makeAuth({ register });
    render(<Login />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Create one/ }));
    await user.type(screen.getByLabelText('Email'), 'New@Example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    // The check-email step renders, addressed to the lower-cased email.
    expect(
      await screen.findByRole('heading', { level: 1, name: /Check your email/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('new@example.com')).toBeInTheDocument();
    // register was called with the trimmed email.
    expect(register).toHaveBeenCalledWith(
      'New@Example.com',
      'a-long-passphrase',
      undefined,
    );
  });

  it('the check-email step resend button calls resendVerification with the account email', async () => {
    const register = vi.fn(async () => 'verification_required' as const);
    mocks.authValue = makeAuth({ register });
    render(<Login />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Create one/ }));
    await user.type(screen.getByLabelText('Email'), 'checkme@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await screen.findByRole('heading', { level: 1, name: /Check your email/ });
    await user.click(
      screen.getByRole('button', { name: /Resend verification email/ }),
    );
    await waitFor(() => {
      expect(resendMock).toHaveBeenCalledWith('checkme@example.com');
    });
    // Non-enumerating success copy.
    expect(
      await screen.findByText(/If an account exists for checkme@example.com/),
    ).toBeInTheDocument();
  });
});

describe('Login — B-044 register mfa_setup_required', () => {
  it('switches to sign-in with a notice (no session) when register resolves mfa_setup_required', async () => {
    const register = vi.fn(async () => 'mfa_setup_required' as const);
    mocks.authValue = makeAuth({ register });
    render(<Login />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Create one/ }));
    await user.type(screen.getByLabelText('Email'), 'mfa-setup@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    // No app navigation (no session was minted) — the screen prompts sign-in
    // so the user can enroll a factor.
    expect(
      await screen.findByText(
        /Sign in to finish setting up two-factor authentication/,
      ),
    ).toBeInTheDocument();
    // Switched to login mode — the register-only "Create account" submit is gone.
    expect(
      screen.queryByRole('button', { name: 'Create account' }),
    ).not.toBeInTheDocument();
  });
});

// ─── F-006: unverified login notice ───────────────────────────

describe('Login — F-006 email_unverified login', () => {
  it('renders the unverified notice + resend affordance (not a generic failure) on a typed email_unverified error', async () => {
    const login = vi.fn(async () => {
      throw new ApiError('email address not verified', {
        status: 403,
        code: 'email_unverified',
      });
    });
    mocks.authValue = makeAuth({ login });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'Unverified@Example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/hasn.t been verified yet/);
    // Addressed to the lower-cased email; the raw server message never leaks.
    expect(alert).toHaveTextContent('unverified@example.com');
    expect(alert).not.toHaveTextContent('email address not verified');

    // The resend affordance is present and wired.
    await user.click(
      screen.getByRole('button', { name: /Resend verification email/ }),
    );
    await waitFor(() => {
      expect(resendMock).toHaveBeenCalledWith('unverified@example.com');
    });
  });
});

// ─── Phase 2.1: forgot-password request step ───────────────────

describe('Login — Phase 2.1 forgot password', () => {
  it('the sign-in step offers "Forgot password?" but the register step does not', async () => {
    render(<Login />);
    expect(
      screen.getByRole('button', { name: 'Forgot password?' }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Create one/ }));
    expect(
      screen.queryByRole('button', { name: 'Forgot password?' }),
    ).not.toBeInTheDocument();
  });

  it('clicking "Forgot password?" swaps in the request step and submits the email', async () => {
    render(<Login />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: /Reset your password/ }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'Locked@Example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => {
      expect(requestPasswordResetMock).toHaveBeenCalledWith('locked@example.com');
    });
    // Non-enumerating success copy — never "email sent to your account".
    expect(
      await screen.findByText(/If an account exists for locked@example.com/),
    ).toBeInTheDocument();
  });

  it('"Back to sign in" returns to the credentials step', async () => {
    render(<Login />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await screen.findByRole('heading', { level: 1, name: /Reset your password/ });

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Welcome/ }),
    ).toBeInTheDocument();
  });

  it('a 429 disables the form for the server retry_after window (fixed copy, no server text)', async () => {
    requestPasswordResetMock.mockRejectedValueOnce(
      new ApiError('rate limited', { status: 429, code: 'rate_limited', retryAfter: 30 }),
    );
    render(<Login />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await screen.findByRole('heading', { level: 1, name: /Reset your password/ });

    await user.type(screen.getByLabelText('Email'), 'ratelimited@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Too many attempts/);
    expect(alert).not.toHaveTextContent('rate limited');
    expect(
      screen.getByRole('button', { name: /Retry in 30s/ }),
    ).toBeDisabled();
  });
});

// ─── Code step ────────────────────────────────────────────────

describe('Login — code step (mfa_required)', () => {
  it('renders the 6-digit code field with one-time-code autofill', () => {
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
    });
    render(<Login />);

    const input = screen.getByLabelText('Authentication code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('maxlength', '6');
  });

  it('submits the code via submitTotp()', async () => {
    const submitTotp = vi.fn(async () => undefined);
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
      submitTotp,
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(submitTotp).toHaveBeenCalledWith('123456');
  });

  it('toggles to a recovery-code field', async () => {
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    expect(screen.getByLabelText('Recovery code')).toBeInTheDocument();
  });

  it('maps invalid_code to the fixed string', async () => {
    const submitTotp = vi.fn(async () => {
      throw new ApiError('totp mismatch step 42', {
        status: 401,
        code: 'invalid_code',
      });
    });
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
      submitTotp,
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/didn.t match/);
    expect(alert).not.toHaveTextContent('step 42');
  });

  it('maps account_locked (423) to the wait message', async () => {
    const submitTotp = vi.fn(async () => {
      throw new ApiError('locked', { status: 423, code: 'account_locked' });
    });
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
      submitTotp,
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
  });

  it('renders the specific "wait N minutes" copy when the 423 carries retry_after (SF1)', async () => {
    // 423 with retry_after = 90s → ceil(90/60) = 2 minutes. The api layer now
    // preserves retry_after on ApiError.retryAfter, so the UI shows the real N
    // instead of degrading to the generic "a few minutes".
    const submitTotp = vi.fn(async () => {
      throw new ApiError('locked', {
        status: 423,
        code: 'account_locked',
        retryAfter: 90,
      });
    });
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
      submitTotp,
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('wait 2 minutes');
    // Singular vs plural: a 30-second window rounds up to exactly 1 minute.
    expect(alert).not.toHaveTextContent('a few minutes');
  });

  it('uses singular "minute" when retry_after rounds to 1 (SF1)', async () => {
    const submitTotp = vi.fn(async () => {
      throw new ApiError('locked', {
        status: 423,
        code: 'account_locked',
        retryAfter: 30,
      });
    });
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
      submitTotp,
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('wait 1 minute');
  });

  it('falls back to generic copy when the 423 omits retry_after (SF1)', async () => {
    const submitTotp = vi.fn(async () => {
      throw new ApiError('locked', { status: 423, code: 'account_locked' });
    });
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
      submitTotp,
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts — wait a few minutes and try again.',
    );
  });

  it('maps challenge_invalid to the "start again" string', async () => {
    const submitTotp = vi.fn(async () => {
      throw new ApiError('challenge gone', {
        status: 401,
        code: 'challenge_invalid',
      });
    });
    mocks.authValue = makeAuth({
      pending: { kind: 'mfa', challengeToken: 'tok', expiresIn: 300 },
      submitTotp,
    });
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/);
  });
});

// ─── Enroll step ──────────────────────────────────────────────

describe('Login — enroll step (enrollment_required)', () => {
  it('renders the QR and the manual secret', async () => {
    mocks.authValue = makeAuth({
      pending: { kind: 'enroll', challengeToken: 'tok', expiresIn: 300 },
      enroll: vi.fn(async () => ({
        otpauthUri: 'otpauth://totp/x?secret=SEED',
        secret: 'SEEDSECRET',
      })),
    });
    render(<Login />);

    // QR <img> appears once enroll() + the (stubbed) encoder resolve.
    const img = await screen.findByAltText(
      'QR code for setting up two-factor authentication',
    );
    expect(img).toHaveAttribute('src', 'data:image/png;base64,QRTEST');
    // Manual-entry secret is shown.
    expect(screen.getByText('SEEDSECRET')).toBeInTheDocument();
  });

  it('confirms and surfaces recovery codes gated by the ack', async () => {
    const confirmEnroll = vi.fn(async () => ({
      recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'],
    }));
    const completeEnrollment = vi.fn(async () => undefined);
    mocks.authValue = makeAuth({
      pending: { kind: 'enroll', challengeToken: 'tok', expiresIn: 300 },
      enroll: vi.fn(async () => ({ otpauthUri: 'otpauth://x', secret: 'SEED' })),
      confirmEnroll,
      completeEnrollment,
    });
    render(<Login />);

    const user = userEvent.setup();
    // Wait for the confirm input to enable (it disables until the secret lands).
    await waitFor(() => {
      expect(screen.getByLabelText('Authentication code')).not.toBeDisabled();
    });
    await user.type(screen.getByLabelText('Authentication code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Confirm & continue' }));

    expect(confirmEnroll).toHaveBeenCalledWith('654321');

    // Recovery codes shown.
    expect(await screen.findByText('AAAAA-BBBBB')).toBeInTheDocument();
    expect(screen.getByText('CCCCC-DDDDD')).toBeInTheDocument();

    // Entry is gated: the continue button is disabled until the ack box is
    // checked. completeEnrollment must NOT have fired yet.
    const enter = screen.getByRole('button', { name: /I saved them/ });
    expect(enter).toBeDisabled();
    expect(completeEnrollment).not.toHaveBeenCalled();

    await user.click(
      screen.getByLabelText(/saved these codes somewhere safe/),
    );
    expect(enter).not.toBeDisabled();
    await user.click(enter);
    expect(completeEnrollment).toHaveBeenCalledTimes(1);
  });

  it('re-enables the acknowledge button when the entry probe settles without flipping the gate (no permanent "One moment…")', async () => {
    // completeEnrollment resolves only when we release it — and it resolves
    // WITHOUT authenticating (the provider's probe maps any network flap /
    // 5xx to `guest` and never rejects), so the recovery screen stays up.
    let settleProbe!: () => void;
    const completeEnrollment = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleProbe = resolve;
        }),
    );
    mocks.authValue = makeAuth({
      pending: { kind: 'enroll', challengeToken: 'tok', expiresIn: 300 },
      enroll: vi.fn(async () => ({ otpauthUri: 'otpauth://x', secret: 'SEED' })),
      confirmEnroll: vi.fn(async () => ({ recoveryCodes: ['AAAAA-BBBBB'] })),
      completeEnrollment,
    });
    render(<Login />);

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText('Authentication code')).not.toBeDisabled();
    });
    await user.type(screen.getByLabelText('Authentication code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Confirm & continue' }));
    await screen.findByText('AAAAA-BBBBB');

    await user.click(
      screen.getByLabelText(/saved these codes somewhere safe/),
    );
    await user.click(screen.getByRole('button', { name: /I saved them/ }));
    expect(completeEnrollment).toHaveBeenCalledTimes(1);
    // While the probe is in flight the button reads the busy label.
    expect(
      screen.getByRole('button', { name: 'One moment…' }),
    ).toBeInTheDocument();

    // The probe settles as a failure-shaped no-op (state stays guest, screen
    // stays mounted). Pre-fix `finishing` was never reset, so the button
    // stayed "One moment…" forever with no retry — only a reload (losing the
    // one-time codes) recovered.
    await act(async () => {
      settleProbe();
    });
    expect(
      await screen.findByRole('button', { name: 'I saved them — enter' }),
    ).toBeInTheDocument();

    // …and the restored button actually retries the probe.
    await user.click(
      screen.getByRole('button', { name: 'I saved them — enter' }),
    );
    expect(completeEnrollment).toHaveBeenCalledTimes(2);
  });

  it('falls back to the manual key when the QR fails to render', async () => {
    const qr = await import('../lib/qr');
    vi.mocked(qr.otpauthUriToDataUrl).mockRejectedValueOnce(
      new Error('encode failed'),
    );
    mocks.authValue = makeAuth({
      pending: { kind: 'enroll', challengeToken: 'tok', expiresIn: 300 },
      enroll: vi.fn(async () => ({
        otpauthUri: 'otpauth://x',
        secret: 'FALLBACKKEY',
      })),
    });
    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('FALLBACKKEY')).toBeInTheDocument();
    });
    // No QR image rendered, but a fallback hint + the manual key are present.
    expect(
      screen.queryByAltText(
        'QR code for setting up two-factor authentication',
      ),
    ).not.toBeInTheDocument();
  });
});
