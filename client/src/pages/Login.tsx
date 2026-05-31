/**
 * Login / Register screen — hanji-styled, cookie-session backed.
 *
 * Single form that toggles between Sign in (`POST /auth/login`) and
 * Create account (`POST /auth/register`). The session cookie is set by the
 * server; this component only collects credentials and reacts to the
 * resolved `useAuth` state.
 *
 * Threat model — what this page defends against, and what is delegated:
 *   - Brute force / credential stuffing: per-IP `authLimiter` on the server.
 *     This page maps `ApiError` *status codes* (not server message text) to
 *     a fixed string lookup, and does NOT distinguish "wrong email" from
 *     "wrong password" — the server intentionally collapses both into one
 *     shape, and the client refuses to expand it.
 *   - Username enumeration: same shape + same timing on bad email vs bad
 *     password — implemented server-side; this page just renders whatever
 *     the server returns.
 *   - XSS via reflected error: `messageFor` below ONLY returns strings from
 *     a fixed lookup table — `err.message` from `ApiError` is NEVER echoed
 *     to the UI. React's text-node interpolation HTML-escapes anyway, but
 *     defence in depth: a future server PR that adds a detailed validation
 *     message (`"password must contain a digit"`) MUST NOT be able to leak
 *     through to the auth page where it could become an oracle (or, with a
 *     future drift to `dangerouslySetInnerHTML` or a markdown renderer, an
 *     XSS vector). The table below is the contract — anything not in the
 *     table falls through to a fixed generic message.
 *   - Password leaks via autofill: `<input type="password">` and
 *     `autoComplete` hints keep password managers behaving.
 *   - Double-submit race: the form sets `submitting` and disables the
 *     button. Server-side rate limiting is the real backstop.
 *   - Confused-deputy on register: server schema only accepts
 *     `{ email, password, display_name? }`; this page never sends anything
 *     else.
 *
 * Accessibility:
 *   - Labels are linked via `htmlFor`/`id`.
 *   - Error message has `role="alert"` so screen readers announce it.
 *   - First *editable* field receives `autoFocus` on mount so keyboard users
 *     don't have to Tab past the seal stamp and eyebrow. (`autoFocus` is the
 *     correct React primitive — it only fires on mount, not on every render.)
 *     We trust the router to scope this to the `/login` route only.
 *   - Submitting state: the form sets `aria-busy="true"` and the button
 *     text update is announced via a `role="status" aria-live="polite"`
 *     wrapper so screen-reader users hear "One moment…" without losing
 *     focus context.
 */
import {
  useId,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { SealStamp } from '../components/SealStamp';
import { DoubleRule } from '../components/DoubleRule';
import { ApiError } from '../services/api';
import { useAuth } from '../hooks/useAuth';

type Mode = 'login' | 'register';

const PASSWORD_MIN = 12;

export default function Login(): JSX.Element {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();
  const errorId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'register') {
        await register(email.trim(), password, displayName.trim() || undefined);
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      const msg = messageFor(err, mode);
      // Empty string is the sentinel for "swallow this" (e.g. a canceled
      // request from a navigation away — surfacing an alert there would be
      // a confusing lie). Anything else paints the alert region.
      if (msg) setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(): void {
    setMode((m) => (m === 'login' ? 'register' : 'login'));
    setError(null);
  }

  return (
    <div className="km-shell">
      <div className="km-shell__statusbar" aria-hidden="true" />
      <main className="km-shell__scroll km-login">
        <div className="km-login__seal" aria-hidden="true">
          <SealStamp char="韓" size="lg" />
        </div>
        <Eyebrow>한국어 마스터 · Korean Master</Eyebrow>
        <h1 className="kr-display km-login__title">
          {mode === 'login' ? '환영합니다' : '계정 만들기'}
        </h1>
        <p className="km-login__lede">
          {mode === 'login'
            ? 'Sign in to continue your study.'
            : 'Create an account to start studying.'}
        </p>
        <DoubleRule accent style={{ margin: '18px 0 22px' }} />

        <form
          className="km-login__form"
          onSubmit={handleSubmit}
          noValidate
          aria-busy={submitting}
        >
          {mode === 'register' ? (
            <div className="km-field">
              <label htmlFor={nameId} className="km-field__label">
                Name <span className="km-field__hint">(optional)</span>
              </label>
              <input
                id={nameId}
                className="km-field__input"
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                }}
                maxLength={80}
              />
            </div>
          ) : null}

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
              // First editable field gets focus on mount. `autoFocus` only
              // fires on mount in React (not on every render), which is what
              // we want. The general jsx-a11y/no-autofocus caution is about
              // autofocus yanking focus on content pages; on a dedicated
              // sign-in route whose sole job is this form, focusing the first
              // field is the expected, helpful behaviour — the documented
              // exception to the rule. Disabled for this one line with cause.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </div>

          <div className="km-field">
            <label htmlFor={passwordId} className="km-field__label">
              Password
            </label>
            <input
              id={passwordId}
              className="km-field__input"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              minLength={mode === 'register' ? PASSWORD_MIN : 1}
              maxLength={256}
              placeholder={
                mode === 'register'
                  ? `At least ${String(PASSWORD_MIN)} characters`
                  : ''
              }
              aria-describedby={
                mode === 'register' ? `${passwordId}-hint` : undefined
              }
            />
            {mode === 'register' ? (
              <div id={`${passwordId}-hint`} className="km-field__hint">
                A long passphrase beats short complex strings. Anything goes —
                length is what matters.
              </div>
            ) : null}
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
            disabled={submitting}
            aria-describedby={error ? errorId : undefined}
          >
            <span role="status" aria-live="polite">
              {submitting
                ? 'One moment…'
                : mode === 'register'
                  ? 'Create account'
                  : 'Sign in'}
            </span>
          </Button>
        </form>

        <div className="km-login__switch">
          <button
            type="button"
            className="km-link focusring"
            onClick={switchMode}
          >
            {mode === 'register'
              ? 'Already have an account? Sign in'
              : "Don't have an account? Create one"}
          </button>
        </div>
      </main>
    </div>
  );
}

/**
 * Map an unknown error from `useAuth` into a user-safe message.
 *
 * Fixed lookup table — `err.message` from the server is NEVER returned. See
 * the threat-model header §"XSS via reflected error": a future server PR
 * that adds a detailed validation message must NOT be able to leak through
 * to the auth page where it could become a username-enumeration oracle or
 * (after future drift) an XSS vector. Everything outside the table maps to
 * a fixed generic.
 */
function messageFor(err: unknown, mode: Mode): string {
  const GENERIC = 'Authentication failed. Please try again.';
  if (!(err instanceof ApiError)) return GENERIC;

  // status === 0 branch: discriminate the three "no response" cases the
  // axios layer normalises (see services/api.ts). Each gets distinct UX.
  if (err.status === 0) {
    if (err.code === 'canceled') return ''; // user navigated away; swallow
    if (err.code === 'timeout') {
      return 'The server is taking too long to respond. Try again in a moment.';
    }
    return 'Could not reach the server. Check your connection and retry.';
  }

  if (err.status === 401) return 'Email or password is incorrect.';
  if (err.status === 409 && mode === 'register') {
    return 'An account with these details already exists.';
  }
  if (err.status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (err.status === 400) {
    return mode === 'register'
      ? 'Please check the email and password and try again. Passwords need at least 12 characters.'
      : 'Please check the email and password and try again.';
  }
  if (err.status >= 500) {
    return 'The server is having trouble. Try again in a moment.';
  }
  return GENERIC;
}
