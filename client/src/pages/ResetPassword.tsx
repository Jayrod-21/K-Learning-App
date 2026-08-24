/**
 * ResetPassword — the landing page for the emailed password-reset link
 * (Phase 2.1, self-service account recovery). Mirrors VerifyEmail.tsx's
 * token-handling posture closely; the difference is this page collects a NEW
 * password before it ever talks to the server (the token alone isn't enough
 * — the server route needs both the token and the replacement password in
 * the same request to consume it).
 *
 * `${CLIENT_ORIGIN}/reset-password#token=…` lands here (a PUBLIC route: works
 * for a guest completing "forgot password" AND for a signed-in session that
 * opened the link — a confirmed reset revokes that session too, so either
 * way the user ends up signed out). On mount the token is captured once;
 * submitting the form calls `POST /auth/password-reset/confirm` and the
 * outcome renders one of:
 *   - form     — token captured, waiting for the new-password submit;
 *   - success  — password changed, every session revoked; offers sign-in;
 *   - expired  — the link's 1h window passed; offers a fresh request;
 *   - invalid  — unknown / superseded / malformed token, or no token at all;
 *   - network  — could not reach the server; offers a retry.
 *
 * Threat model (page scope):
 *   - Token handling (mirrors VerifyEmail's fix-pass SF-1/SF-2): the raw
 *     token rides the URL FRAGMENT (`#token=`), which the browser never
 *     sends on the wire — so reverse-proxy/CDN access logs and Referer
 *     headers can never capture a live token. It is captured into component
 *     state ONCE on mount and the fragment is immediately scrubbed from the
 *     address bar/history (`navigate(…, { replace: true })`), so browser
 *     history and history-sync services never retain it either. It is never
 *     persisted (no storage, no state beyond the mount capture) and never
 *     logged; single-use + 1h expiry server-side back all of this up.
 *   - No auto-login: a successful confirm does NOT sign the user in — the
 *     server revoked every session (including any the caller might already
 *     be holding), so this page always routes success to /login, never into
 *     the app. The user proves the new password by signing in fresh.
 *   - Error copy: fixed strings selected by `ApiError.code`/`status` — server
 *     message text is NEVER echoed (same posture as VerifyEmail / Login).
 *   - Request-a-new-link: reuses the non-enumerating
 *     `/auth/password-reset/request` endpoint; the copy is phrased
 *     conditionally to match, and a 429 disables the form for the server's
 *     `retry_after` window.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { SealStamp } from '../components/SealStamp';
import { DoubleRule } from '../components/DoubleRule';
import { ApiError } from '../services/api';
import { confirmPasswordReset, requestPasswordReset } from '../services/auth';
import { useRetryCountdown } from '../hooks/useRetryCountdown';

type ResetState = 'form' | 'submitting' | 'success' | 'expired' | 'invalid' | 'network';

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

/** Parse `token` out of a `#token=…` fragment — same helper as VerifyEmail.
 *  Deliberately no `?token=` fallback: no such link has ever been emailed. */
function tokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  return new URLSearchParams(raw).get('token');
}

export default function ResetPassword(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  // Capture ONCE on mount (lazy initializer): the URL is scrubbed right after.
  const [token] = useState<string | null>(() => tokenFromHash(location.hash));
  const [state, setState] = useState<ResetState>(token ? 'form' : 'invalid');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Guards a double-submit (button disable) from also racing a StrictMode
  // dev double-invoke of the effect that scrubs the URL.
  const submittingRef = useRef(false);

  const passwordId = useId();
  const confirmId = useId();
  const errorId = useId();

  // Scrub the token from the address bar / history as soon as we've captured
  // it (mirrors VerifyEmail's fix-pass client SF-1). Fragments never reach
  // the server, but they DO linger in browser history and history-sync.
  useEffect(() => {
    if (location.hash) {
      navigate(location.pathname, { replace: true });
    }
    // Mount-only by design: we scrub whatever fragment we arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submittingRef.current || !token) return;
    setError(null);
    if (password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${String(PASSWORD_MIN)} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    submittingRef.current = true;
    setState('submitting');
    try {
      await confirmPasswordReset(token, password);
      setState('success');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'token_expired') {
          setState('expired');
          return;
        }
        if (err.status === 0) {
          setState('network');
          return;
        }
        if (err.code === 'token_invalid') {
          setState('invalid');
          return;
        }
      }
      // Validation-shaped failures (e.g. password too short/long per the
      // server's own bounds) land here — fixed generic copy, never server
      // text. Stay on the form so the user can correct and resubmit.
      setError('Could not reset your password. Check the requirements and try again.');
      setState('form');
    } finally {
      submittingRef.current = false;
    }
  }

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

        {state === 'form' || state === 'submitting' ? (
          <>
            <h1 className="kr-display km-login__title">
              <Bilingual kr="새 비밀번호" en="Choose a new password" />
            </h1>
            <p className="km-login__lede">
              Enter a new password for your account. Signing back in afterward
              will end every other session.
            </p>
            <DoubleRule accent style={{ margin: '18px 0 22px' }} />

            <form
              className="km-login__form"
              onSubmit={(e) => {
                void handleSubmit(e);
              }}
              noValidate
              aria-busy={state === 'submitting'}
            >
              <div className="km-field">
                <label htmlFor={passwordId} className="km-field__label">
                  New password
                </label>
                <input
                  id={passwordId}
                  className="km-field__input"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                  minLength={PASSWORD_MIN}
                  maxLength={PASSWORD_MAX}
                  placeholder={`At least ${String(PASSWORD_MIN)} characters`}
                  aria-describedby={`${passwordId}-hint`}
                  // First editable field gets focus on mount — dedicated
                  // single-purpose recovery route (same documented exception
                  // as Login's credentials step).
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
                <div id={`${passwordId}-hint`} className="km-field__hint">
                  A long passphrase beats short complex strings.
                </div>
              </div>

              <div className="km-field">
                <label htmlFor={confirmId} className="km-field__label">
                  Confirm new password
                </label>
                <input
                  id={confirmId}
                  className="km-field__input"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                  }}
                  minLength={PASSWORD_MIN}
                  maxLength={PASSWORD_MAX}
                />
              </div>

              {error ? (
                <div id={errorId} role="alert" className="km-login__error">
                  {error}
                </div>
              ) : null}

              <Button
                type="submit"
                variant="gold"
                size="lg"
                fullWidth
                disabled={state === 'submitting'}
                aria-describedby={error ? errorId : undefined}
              >
                <span role="status" aria-live="polite">
                  {state === 'submitting' ? 'One moment…' : 'Reset password'}
                </span>
              </Button>
            </form>

            <div className="km-login__switch">
              <Link to="/login" className="km-link focusring">
                Back to sign in
              </Link>
            </div>
          </>
        ) : state === 'success' ? (
          <>
            <h1 className="kr-display km-login__title">
              <Bilingual kr="비밀번호 변경 완료" en="Password updated" />
            </h1>
            <p className="km-login__lede">
              Your password has been changed and every device has been signed
              out, including this one. Sign in with your new password to
              continue.
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
              We couldn&apos;t reach the server to reset your password. Check
              your connection and try again.
            </p>
            <DoubleRule accent style={{ margin: '18px 0 22px' }} />
            <Button
              type="button"
              variant="gold"
              size="lg"
              onClick={() => {
                setState('form');
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
              This password-reset link isn&apos;t valid — it may have been
              replaced by a newer request or already used. Request a fresh
              link below.
            </p>
            <DoubleRule accent style={{ margin: '18px 0 22px' }} />
            <RequestResetForm />
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

/** Expired-link panel: explains + offers a fresh request form. */
function ExpiredPanel(): JSX.Element {
  return (
    <>
      <h1 className="kr-display km-login__title">
        <Bilingual kr="링크 만료" en="Link expired" />
      </h1>
      <p className="km-login__lede">
        This password-reset link has expired. Enter your account email and
        we&apos;ll send a fresh one.
      </p>
      <DoubleRule accent style={{ margin: '18px 0 22px' }} />
      <RequestResetForm />
      <div className="km-login__switch">
        <Link to="/login" className="km-link focusring">
          Back to sign in
        </Link>
      </div>
    </>
  );
}

/**
 * Email capture + reset request. The page can't know the account email (the
 * token is opaque by design), so the user supplies it; the endpoint's
 * generic response keeps this enumeration-safe — the success copy is
 * phrased conditionally ("if an account exists…") to match.
 */
function RequestResetForm(): JSX.Element {
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
      setError('Enter your account email to request a new link.');
      return;
    }
    setError(null);
    setSending(true);
    try {
      await requestPasswordReset(trimmed);
      setSentTo(trimmed);
    } catch (err) {
      // Fixed strings only — never server text. A 429 disables the form for
      // the server's retry_after window.
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
        If an account exists for {sentTo}, a reset link is on its way. Check
        your inbox (and spam folder).
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
