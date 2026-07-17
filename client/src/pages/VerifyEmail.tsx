/**
 * VerifyEmail — the landing page for the emailed verification link (F-006).
 *
 * `${CLIENT_ORIGIN}/verify-email?token=…` lands here (a PUBLIC route: works
 * for guests AND for a signed-in-but-unverified session, e.g. after an email
 * change with the gate off). On mount the token is relayed once to
 * `POST /auth/verify` and the outcome renders one of:
 *   - success  — verified (or already verified: re-clicking a used link is a
 *                friendly success, not an error — the server is idempotent);
 *   - expired  — the link's 24 h window passed; offers the resend form;
 *   - invalid  — unknown / superseded / malformed token;
 *   - network  — could not reach the server; offers a retry.
 *
 * Threat model (page scope):
 *   - Token handling: the raw token is read from the URL and sent to the
 *     server ONCE; it is never persisted (no storage, no state beyond the
 *     in-flight request) and never logged. It is single-use + short-lived
 *     server-side, so a leaked browser-history entry goes stale on first use.
 *   - Error copy: fixed strings selected by `ApiError.code`/`status` — server
 *     message text is NEVER echoed (no oracle, no reflected-XSS drift).
 *   - Resend: the endpoint is non-enumerating; the copy is phrased
 *     conditionally to match.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { SealStamp } from '../components/SealStamp';
import { DoubleRule } from '../components/DoubleRule';
import { ApiError } from '../services/api';
import { resendVerification, verifyEmail } from '../services/auth';

type VerifyState = 'verifying' | 'success' | 'expired' | 'invalid' | 'network';

export default function VerifyEmail(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<VerifyState>(
    token ? 'verifying' : 'invalid',
  );
  // One shot per mount + retry counter: StrictMode's dev double-mount must
  // not double-consume (the server is idempotent anyway, but a second POST
  // racing the first could render already_verified copy on the FIRST visit).
  const attemptRef = useRef(0);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!token) return;
    const attempt = ++attemptRef.current;
    let active = true;
    void (async () => {
      try {
        await verifyEmail(token);
        // 'verified' and 'already_verified' are BOTH success — re-clicking
        // a used link must feel fine, not broken.
        if (active && attemptRef.current === attempt) setState('success');
      } catch (err) {
        if (!active || attemptRef.current !== attempt) return;
        if (err instanceof ApiError) {
          if (err.code === 'token_expired') {
            setState('expired');
            return;
          }
          if (err.status === 0) {
            setState('network');
            return;
          }
        }
        setState('invalid');
      }
    })();
    return () => {
      active = false;
    };
    // Re-run only on an explicit retry (network state) or a token change.
  }, [token, retryNonce]);

  return (
    <div className="km-shell">
      <div className="km-shell__statusbar" aria-hidden="true" />
      <main className="km-shell__scroll km-login">
        <div className="km-login__seal" aria-hidden="true">
          <SealStamp char="韓" size="lg" />
        </div>
        <Eyebrow>
          <Bilingual kr="한국어 마스터" en="Korean Master" />
        </Eyebrow>

        {state === 'verifying' ? (
          <>
            <h1 className="kr-display km-login__title">
              <Bilingual kr="확인 중…" en="Verifying…" />
            </h1>
            <p className="km-login__lede" role="status" aria-live="polite">
              Checking your verification link…
            </p>
          </>
        ) : state === 'success' ? (
          <>
            <h1 className="kr-display km-login__title">
              <Bilingual kr="인증 완료" en="Email verified" />
            </h1>
            <p className="km-login__lede">
              Your email address is verified. You can sign in now.
            </p>
            <DoubleRule accent style={{ margin: '18px 0 22px' }} />
            <Link to="/login" className="km-link focusring">
              Go to sign in
            </Link>
          </>
        ) : state === 'expired' ? (
          <ExpiredPanel />
        ) : state === 'network' ? (
          <>
            <h1 className="kr-display km-login__title">
              <Bilingual kr="연결 오류" en="Connection problem" />
            </h1>
            <p className="km-login__lede">
              We couldn&apos;t reach the server to check your link. Check your
              connection and try again.
            </p>
            <DoubleRule accent style={{ margin: '18px 0 22px' }} />
            <Button
              type="button"
              variant="gold"
              size="lg"
              onClick={() => {
                setState('verifying');
                setRetryNonce((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            <h1 className="kr-display km-login__title">
              <Bilingual kr="유효하지 않은 링크" en="Link not valid" />
            </h1>
            <p className="km-login__lede">
              This verification link isn&apos;t valid — it may have been
              replaced by a newer email or already used from another device.
              Sign in to check your status, or request a fresh link below.
            </p>
            <DoubleRule accent style={{ margin: '18px 0 22px' }} />
            <ResendForm />
            <div className="km-login__switch">
              <Link to="/login" className="km-link focusring">
                Back to sign in
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/** Expired-link panel: explains + offers the resend form. */
function ExpiredPanel(): JSX.Element {
  return (
    <>
      <h1 className="kr-display km-login__title">
        <Bilingual kr="링크 만료" en="Link expired" />
      </h1>
      <p className="km-login__lede">
        This verification link has expired. Enter your account email and
        we&apos;ll send a fresh one.
      </p>
      <DoubleRule accent style={{ margin: '18px 0 22px' }} />
      <ResendForm />
      <div className="km-login__switch">
        <Link to="/login" className="km-link focusring">
          Back to sign in
        </Link>
      </div>
    </>
  );
}

/**
 * Email capture + resend. The page can't know the account email (the token
 * is opaque by design), so the user supplies it; the endpoint's generic
 * response keeps this enumeration-safe — the success copy is conditional
 * ("if an account exists…") to match. Fixed error strings only.
 */
function ResendForm(): JSX.Element {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (sending) return;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setError(null);
    setSending(true);
    try {
      await resendVerification(trimmed);
      setSentTo(trimmed);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Please wait a moment and try again.'
          : 'Could not send the email. Check your connection and retry.',
      );
    } finally {
      setSending(false);
    }
  }

  if (sentTo !== null) {
    return (
      <p className="km-field__hint" role="status" aria-live="polite">
        If an account exists for {sentTo} and still needs verification, a new
        email is on its way. Check your inbox (and spam folder).
      </p>
    );
  }

  return (
    <form
      className="km-login__form"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      noValidate
      aria-busy={sending}
    >
      <div className="km-field">
        <label htmlFor={emailId} className="km-field__label">
          Email
        </label>
        <input
          id={emailId}
          className="km-field__input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          maxLength={254}
          placeholder="you@example.com"
        />
      </div>
      {error ? (
        <div role="alert" className="km-login__error">
          {error}
        </div>
      ) : null}
      <Button type="submit" variant="gold" size="lg" fullWidth disabled={sending}>
        <span role="status" aria-live="polite">
          {sending ? 'Sending…' : 'Send a new link'}
        </span>
      </Button>
    </form>
  );
}
