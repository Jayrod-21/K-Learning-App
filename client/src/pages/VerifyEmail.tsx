/**
 * VerifyEmail — the landing page for the emailed verification link (F-006).
 *
 * `${CLIENT_ORIGIN}/verify-email#token=…` lands here (a PUBLIC route: works
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
 *   - Token handling (fix-pass SF-1/SF-2): the raw token rides the URL
 *     FRAGMENT (`#token=`), which the browser never sends on the wire — so
 *     reverse-proxy/CDN access logs and Referer headers can never capture a
 *     live token. It is captured into component state ONCE on mount and the
 *     fragment is immediately scrubbed from the address bar/history
 *     (`navigate(…, { replace: true })`), so browser history and history-sync
 *     services never retain it either. It is never persisted (no storage, no
 *     state beyond the mount capture) and never logged; single-use + 24 h
 *     expiry server-side back all of this up.
 *   - Error copy: fixed strings selected by `ApiError.code`/`status` — server
 *     message text is NEVER echoed (no oracle, no reflected-XSS drift).
 *   - Resend: the endpoint is non-enumerating; the copy is phrased
 *     conditionally to match, and a 429 disables the form for the server's
 *     `retry_after` window (structured number, not echoed prose).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { SealStamp } from '../components/SealStamp';
import { DoubleRule } from '../components/DoubleRule';
import { ApiError } from '../services/api';
import { resendVerification, verifyEmail } from '../services/auth';
import { useRetryCountdown } from '../hooks/useRetryCountdown';

type VerifyState = 'verifying' | 'success' | 'expired' | 'invalid' | 'network';

/** Parse `token` out of a `#token=…` fragment. The mailer puts the token in
 *  the fragment ONLY (never the query string) so it never leaves the browser;
 *  there is deliberately no `?token=` fallback — no such link has ever been
 *  emailed (the query form died in the F-006 fix-pass before first deploy). */
function tokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  return new URLSearchParams(raw).get('token');
}

export default function VerifyEmail(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  // Capture ONCE on mount (lazy initializer): the URL is scrubbed right after,
  // and the retry affordance re-uses this captured copy, not the URL.
  const [token] = useState<string | null>(() => tokenFromHash(location.hash));
  const [state, setState] = useState<VerifyState>(
    token ? 'verifying' : 'invalid',
  );
  // Latest-attempt-wins render guard + retry counter: StrictMode's dev
  // double-mount fires the effect (and its POST) twice — the server is
  // idempotent and both outcomes map to the same success UI, so this ref only
  // guarantees the LATEST attempt's result renders (it does not, and need
  // not, prevent the second request).
  const attemptRef = useRef(0);
  const [retryNonce, setRetryNonce] = useState(0);

  // Scrub the token from the address bar / history as soon as we've captured
  // it (fix-pass client SF-1). Fragments never reach the server, but they DO
  // linger in browser history and history-sync — replace-navigate to the bare
  // path. Idempotent, so the StrictMode double-run is harmless.
  useEffect(() => {
    if (location.hash) {
      navigate(location.pathname, { replace: true });
    }
    // Mount-only by design: we scrub whatever fragment we arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const { secondsLeft, start: startBackoff } = useRetryCountdown();
  const emailId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (sending || secondsLeft > 0) return;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      // Fixed copy — an empty submit must never be a silent no-op (the form
      // is noValidate, so the browser won't announce anything either).
      setError('Enter your account email to request a new link.');
      return;
    }
    setError(null);
    setSending(true);
    try {
      await resendVerification(trimmed);
      setSentTo(trimmed);
    } catch (err) {
      // Fixed strings only — never server text. A 429 disables the form for
      // the server's retry_after window (fix-pass SF-2).
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Please wait a moment and try again.');
        startBackoff(err.retryAfter);
      } else {
        setError('Could not send the email. Check your connection and retry.');
      }
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
      <Button
        type="submit"
        variant="gold"
        size="lg"
        fullWidth
        disabled={sending || secondsLeft > 0}
      >
        <span role="status" aria-live="polite">
          {sending
            ? 'Sending…'
            : secondsLeft > 0
              ? `Retry in ${String(secondsLeft)}s`
              : 'Send a new link'}
        </span>
      </Button>
    </form>
  );
}
