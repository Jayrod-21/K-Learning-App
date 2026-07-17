/**
 * ResendVerificationButton (F-006) — one-shot "send me a new verification
 * email" affordance, shared by the Login unverified notice, the post-register
 * "check your email" step, the VerifyEmail landing page, and the in-app
 * unverified banner.
 *
 * Security/UX contract:
 *   - The server's resend endpoint is deliberately non-enumerating (fixed
 *     generic 200 whether or not the account exists / is verified), so the
 *     success copy here is phrased conditionally ("If an account exists…").
 *   - Fixed error strings only — server `message` text is NEVER echoed
 *     (same never-echo rule as the Login error tables).
 *   - Double-submit guarded locally; the server's per-IP limiter and per-user
 *     cooldown are the real backstops.
 */
import { useState, type JSX } from 'react';
import { resendVerification } from '../services/auth';
import { ApiError } from '../services/api';

type SendState = 'idle' | 'sending' | 'sent' | 'error';

export function ResendVerificationButton({
  email,
  label = 'Resend verification email',
}: {
  email: string;
  label?: string;
}): JSX.Element {
  const [state, setState] = useState<SendState>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    if (state === 'sending') return;
    setError(null);
    setState('sending');
    try {
      await resendVerification(email);
      setState('sent');
    } catch (err) {
      // Fixed strings only — never server text.
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Please wait a moment and try again.'
          : 'Could not send the email. Check your connection and retry.',
      );
      setState('error');
    }
  }

  if (state === 'sent') {
    return (
      <p className="km-field__hint" role="status" aria-live="polite">
        If an account exists for {email} and still needs verification, a new
        email is on its way. Check your inbox (and spam folder).
      </p>
    );
  }

  return (
    <div className="km-resend">
      <button
        type="button"
        className="km-link focusring"
        onClick={() => {
          void handleClick();
        }}
        disabled={state === 'sending'}
        aria-busy={state === 'sending'}
      >
        <span role="status" aria-live="polite">
          {state === 'sending' ? 'Sending…' : label}
        </span>
      </button>
      {error ? (
        <div role="alert" className="km-login__error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
