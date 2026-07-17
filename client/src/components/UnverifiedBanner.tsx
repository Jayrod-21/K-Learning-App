/**
 * UnverifiedBanner (F-006) — a dismissible in-app notice shown to a
 * signed-in user whose email is not yet verified.
 *
 * When is a user both signed in AND unverified? Only when the login gate is
 * off (`EMAIL_VERIFICATION_REQUIRED=false` — the operator kill-switch), or
 * immediately after an email change reset `email_verified_at` while the
 * session stayed valid. With the gate ON, an unverified user never reaches
 * the app shell at all (login 403s), so this banner simply never renders —
 * which is the correct behavior, not a gap.
 *
 * Renders nothing unless `user.email_verified === false` (an explicit false;
 * a missing field from a legacy fixture is treated as "don't nag"). The
 * resend affordance reuses the shared, non-enumerating endpoint.
 */
import { useState, type JSX } from 'react';
import { useAuth } from '../hooks/useAuth';
import { ResendVerificationButton } from './ResendVerificationButton';

export function UnverifiedBanner(): JSX.Element | null {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  // Only an EXPLICIT false triggers the banner (undefined = legacy fixture).
  if (!user || user.email_verified !== false || dismissed) return null;

  return (
    <div className="km-unverified-banner" role="status">
      <div className="km-unverified-banner__body">
        <p className="km-unverified-banner__text">
          Your email <strong>{user.email}</strong> isn&apos;t verified yet.
          Check your inbox for the verification link.
        </p>
        <ResendVerificationButton email={user.email} label="Resend link" />
      </div>
      <button
        type="button"
        className="km-unverified-banner__dismiss focusring"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}
