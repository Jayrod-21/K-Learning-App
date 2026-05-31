/**
 * Login / Register screen — hanji-styled, cookie-session backed, with the
 * mandatory TOTP 2FA flow (PASS LOGIN — PART C3).
 *
 * The screen is a small state machine driven by the AuthProvider's `pending`
 * state plus two pieces of local UI state (recovery codes + the enroll's QR):
 *
 *   1. Credentials — email + password. Submit → `login()`. On a no-2FA build
 *      this authenticates directly; on the mandatory-2FA build it sets
 *      `pending` and the screen advances.
 *   2. Code  (`pending.kind === 'mfa'`) — 6-digit TOTP input
 *      (autoComplete `one-time-code`, inputMode numeric) with a "use a recovery
 *      code" toggle. Submit → `submitTotp()` → authenticated (redirect).
 *   3. Enroll (`pending.kind === 'enroll'`) — render a QR from the otpauth URI,
 *      show the secret for manual entry, take a 6-digit confirm → `enroll()` /
 *      `confirmEnroll()`.
 *   4. Recovery codes — the codes returned by `confirmEnroll`, shown ONCE with
 *      copy + download, gated behind an "I saved them" acknowledgement that
 *      calls `completeEnrollment()` to finally enter the app.
 *
 * Threat model — what this page defends against, and what is delegated:
 *   - Brute force / credential stuffing: per-IP `authLimiter` + per-account
 *     lockout on the server. This page maps `ApiError` *status/code* (never
 *     server message text) to a fixed string lookup; it never distinguishes
 *     "wrong email" from "wrong password".
 *   - Username enumeration: same shape + timing on bad email vs password
 *     (server-side); this page just renders the fixed mapping.
 *   - XSS / oracle via reflected error: `messageFor`/`codeMessageFor` ONLY
 *     return strings from fixed tables — `err.message` from `ApiError` is NEVER
 *     echoed. The tables ARE the contract; anything unknown falls through to a
 *     fixed generic. This closes both the enumeration-oracle and the (future)
 *     `dangerouslySetInnerHTML`-drift XSS vector.
 *   - Pending-token leakage: the 2FA challenge token lives in AuthProvider
 *     state only (memory) — this screen never reads, stores, or echoes it. The
 *     recovery codes + the enrollment secret it DOES hold are kept in local
 *     React state for exactly the render that displays them and are never
 *     persisted (see RecoveryCodesPanel + the QR helper).
 *   - One-time-code autofill: the code input declares `autoComplete
 *     ="one-time-code"` + `inputMode="numeric"` so platform OTP autofill works
 *     and mobile keyboards show digits.
 *   - Double-submit race: every submit handler guards on `submitting` and the
 *     button disables; server-side rate limiting is the real backstop.
 *
 * Accessibility:
 *   - Labels linked via `htmlFor`/`id`; the active error has `role="alert"`.
 *   - Each step exposes a single autofocused first field on entry so keyboard
 *     users land on the input (the documented `jsx-a11y/no-autofocus`
 *     exception for a dedicated single-purpose auth route).
 *   - Submitting state sets `aria-busy` + announces button text via a
 *     `role="status" aria-live="polite"` wrapper.
 */
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { SealStamp } from '../components/SealStamp';
import { DoubleRule } from '../components/DoubleRule';
import { RecoveryCodesPanel } from '../components/RecoveryCodesPanel';
import { ApiError } from '../services/api';
import { otpauthUriToDataUrl } from '../lib/qr';
import { useAuth } from '../hooks/useAuth';

type Mode = 'login' | 'register';

const PASSWORD_MIN = 12;
/** TOTP codes are 6 digits; recovery codes are `XXXXX-XXXXX` (10 chars + dash). */
const TOTP_CODE_LENGTH = 6;

export default function Login(): JSX.Element {
  const { pending } = useAuth();

  // The credentials step is the only one that owns the register toggle; the
  // 2FA steps are driven entirely by `pending`. Recovery codes are held at the
  // top level so they survive the brief window between `confirmEnroll`
  // resolving and `completeEnrollment` redirecting.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  return (
    <div className="km-shell">
      <div className="km-shell__statusbar" aria-hidden="true" />
      <main className="km-shell__scroll km-login">
        <div className="km-login__seal" aria-hidden="true">
          <SealStamp char="韓" size="lg" />
        </div>
        <Eyebrow>한국어 마스터 · Korean Master</Eyebrow>

        {recoveryCodes !== null ? (
          <RecoveryStep codes={recoveryCodes} />
        ) : pending === null ? (
          <CredentialsStep />
        ) : pending.kind === 'mfa' ? (
          <CodeStep />
        ) : (
          <EnrollStep
            onConfirmed={(codes) => {
              setRecoveryCodes(codes);
            }}
          />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Step 1 — Credentials (sign in / create account)
// ─────────────────────────────────────────────────────────────

function CredentialsStep(): JSX.Element {
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
      // On 2FA paths `login` resolves having set `pending`; the parent swaps
      // in the next step. Nothing to do here.
    } catch (err) {
      const msg = messageFor(err, mode);
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
    <>
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
            // First editable field gets focus on mount — the documented
            // exception for a dedicated sign-in route (see header).
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
              mode === 'register' ? `At least ${String(PASSWORD_MIN)} characters` : ''
            }
            aria-describedby={mode === 'register' ? `${passwordId}-hint` : undefined}
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
        <button type="button" className="km-link focusring" onClick={switchMode}>
          {mode === 'register'
            ? 'Already have an account? Sign in'
            : "Don't have an account? Create one"}
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Step 2 — Code (existing factor)
// ─────────────────────────────────────────────────────────────

function CodeStep(): JSX.Element {
  const { submitTotp, logout } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const codeId = useId();
  const errorId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await submitTotp(code.trim());
      // On success the provider authenticates and the route redirects.
    } catch (err) {
      const msg = codeMessageFor(err);
      if (msg) setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  /** "Start again" — drop the pending challenge and return to credentials. */
  function startOver(): void {
    void logout();
  }

  return (
    <>
      <h1 className="kr-display km-login__title">확인 코드</h1>
      <p className="km-login__lede">
        {useRecovery
          ? 'Enter one of your saved recovery codes.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <DoubleRule accent style={{ margin: '18px 0 22px' }} />

      <form
        className="km-login__form"
        onSubmit={handleSubmit}
        noValidate
        aria-busy={submitting}
      >
        <div className="km-field">
          <label htmlFor={codeId} className="km-field__label">
            {useRecovery ? 'Recovery code' : 'Authentication code'}
          </label>
          <input
            id={codeId}
            className="km-field__input km-login__code-input"
            type="text"
            // OTP autofill + numeric keyboard for the TOTP path. Recovery codes
            // are alphanumeric (Crockford base32 + dash), so when that toggle is
            // on we relax inputMode to text and drop the one-time-code hint.
            autoComplete={useRecovery ? 'off' : 'one-time-code'}
            inputMode={useRecovery ? 'text' : 'numeric'}
            maxLength={useRecovery ? 16 : TOTP_CODE_LENGTH}
            required
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
            placeholder={useRecovery ? 'XXXXX-XXXXX' : '000000'}
            aria-describedby={error ? errorId : undefined}
            // The code field is the sole input on this step — focus it on entry.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
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
          disabled={submitting}
          aria-describedby={error ? errorId : undefined}
        >
          <span role="status" aria-live="polite">
            {submitting ? 'One moment…' : 'Verify'}
          </span>
        </Button>
      </form>

      <div className="km-login__switch">
        <button
          type="button"
          className="km-link focusring"
          onClick={() => {
            setUseRecovery((v) => !v);
            setCode('');
            setError(null);
          }}
        >
          {useRecovery
            ? 'Use your authenticator app instead'
            : 'Use a recovery code'}
        </button>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="km-link focusring" onClick={startOver}>
            Start again
          </button>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Step 3 — Enroll (no factor yet)
// ─────────────────────────────────────────────────────────────

function EnrollStep({
  onConfirmed,
}: {
  onConfirmed: (recoveryCodes: string[]) => void;
}): JSX.Element {
  const { enroll, confirmEnroll, logout } = useAuth();

  // The pending secret + its QR. `null` until `enroll()` resolves. Held in
  // memory only — never persisted.
  const [secret, setSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const codeId = useId();
  const secretId = useId();
  const confirmErrorId = useId();

  // Kick off enrollment once, on mount. The QR render is async (qrcode →
  // data URL); a render failure falls back to the manual-entry secret.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { otpauthUri, secret: sec } = await enroll();
        if (!active) return;
        setSecret(sec);
        try {
          const dataUrl = await otpauthUriToDataUrl(otpauthUri);
          if (active) setQrDataUrl(dataUrl);
        } catch {
          // QR encode failed — the manual-entry secret is the fallback path.
          if (active) setQrFailed(true);
        }
      } catch (err) {
        if (active) setEnrollError(codeMessageFor(err));
      }
    })();
    return () => {
      active = false;
    };
    // `enroll` is stable from the provider; run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConfirm(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setConfirmError(null);
    setSubmitting(true);
    try {
      const { recoveryCodes } = await confirmEnroll(code.trim());
      onConfirmed(recoveryCodes);
    } catch (err) {
      const msg = codeMessageFor(err);
      if (msg) setConfirmError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function startOver(): void {
    void logout();
  }

  return (
    <>
      <h1 className="kr-display km-login__title">2단계 인증 설정</h1>
      <p className="km-login__lede">
        Two-factor authentication is required. Scan the code with an
        authenticator app (Google Authenticator, 1Password, Authy…), then enter
        the 6-digit code it shows.
      </p>
      <DoubleRule accent style={{ margin: '18px 0 22px' }} />

      {enrollError ? (
        <div role="alert" className="km-login__error">
          {enrollError}
        </div>
      ) : (
        <div className="km-enroll">
          <div className="km-enroll__qr">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR code for setting up two-factor authentication"
                className="km-enroll__qr-img"
                width={220}
                height={220}
              />
            ) : qrFailed ? (
              <p className="km-field__hint">
                The QR couldn&apos;t be drawn. Enter the setup key below in your
                authenticator app instead.
              </p>
            ) : (
              <p className="km-field__hint" role="status" aria-live="polite">
                Preparing your setup code…
              </p>
            )}
          </div>

          {secret ? (
            <div className="km-enroll__secret">
              <label htmlFor={secretId} className="km-field__label">
                Or enter this setup key manually
              </label>
              <code id={secretId} className="km-enroll__secret-value">
                {secret}
              </code>
            </div>
          ) : null}

          <form
            className="km-login__form"
            onSubmit={handleConfirm}
            noValidate
            aria-busy={submitting}
          >
            <div className="km-field">
              <label htmlFor={codeId} className="km-field__label">
                Authentication code
              </label>
              <input
                id={codeId}
                className="km-field__input km-login__code-input"
                type="text"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={TOTP_CODE_LENGTH}
                required
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                }}
                placeholder="000000"
                disabled={secret === null}
                aria-describedby={confirmError ? confirmErrorId : undefined}
              />
            </div>

            {confirmError ? (
              <div id={confirmErrorId} role="alert" className="km-login__error">
                {confirmError}
              </div>
            ) : null}

            <Button
              type="submit"
              variant="gold"
              size="lg"
              fullWidth
              disabled={submitting || secret === null}
              aria-describedby={confirmError ? confirmErrorId : undefined}
            >
              <span role="status" aria-live="polite">
                {submitting ? 'One moment…' : 'Confirm & continue'}
              </span>
            </Button>
          </form>
        </div>
      )}

      <div className="km-login__switch">
        <button type="button" className="km-link focusring" onClick={startOver}>
          Start again
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Step 4 — Recovery codes (post-enroll, gates app entry)
// ─────────────────────────────────────────────────────────────

function RecoveryStep({ codes }: { codes: string[] }): JSX.Element {
  const { completeEnrollment } = useAuth();
  const [finishing, setFinishing] = useState(false);

  return (
    <>
      <h1 className="kr-display km-login__title">복구 코드</h1>
      <DoubleRule accent style={{ margin: '18px 0 22px' }} />
      <RecoveryCodesPanel
        codes={codes}
        acknowledgeLabel={finishing ? 'One moment…' : 'I saved them — enter'}
        onAcknowledge={() => {
          if (finishing) return;
          setFinishing(true);
          // `completeEnrollment` re-probes and flips the gate → the route
          // redirects into the app. If it somehow fails, the user is still
          // signed in server-side; a reload reconciles.
          void completeEnrollment();
        }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Fixed error tables (NEVER echo server message text)
// ─────────────────────────────────────────────────────────────

/**
 * Map a credentials-step error to user-safe copy. Fixed lookup — `err.message`
 * is NEVER returned (see header §"XSS / oracle via reflected error").
 */
function messageFor(err: unknown, mode: Mode): string {
  const GENERIC = 'Authentication failed. Please try again.';
  if (!(err instanceof ApiError)) return GENERIC;

  if (err.status === 0) {
    if (err.code === 'canceled') return ''; // user navigated away; swallow
    if (err.code === 'timeout') {
      return 'The server is taking too long to respond. Try again in a moment.';
    }
    return 'Could not reach the server. Check your connection and retry.';
  }

  if (err.status === 401) return 'Email or password is incorrect.';
  if (err.status === 403 && err.code === 'registration_closed') {
    return 'Registration is closed.';
  }
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

/**
 * Map a code / enroll-step error to user-safe copy. Fixed lookup, same
 * never-echo contract. Covers the 2FA-specific server codes:
 *   - `challenge_invalid` / 401      → the sign-in expired, start again.
 *   - `invalid_code`                 → the code didn't match.
 *   - `account_locked` / 423         → too many attempts; wait N minutes
 *                                      (N from `retry_after` if the server
 *                                      surfaced it via `ApiError`, else generic).
 */
function codeMessageFor(err: unknown): string {
  const GENERIC = 'That didn’t work. Please try again.';
  if (!(err instanceof ApiError)) return GENERIC;

  if (err.status === 0) {
    if (err.code === 'canceled') return '';
    if (err.code === 'timeout') {
      return 'The server is taking too long to respond. Try again in a moment.';
    }
    if (err.code === 'network') {
      return 'Could not reach the server. Check your connection and retry.';
    }
    // `no_pending` (a step rendered without a live challenge) is a programming
    // error, not something the user can fix — generic copy + a "start again".
    return 'Your sign-in expired. Start again.';
  }

  if (err.status === 423) {
    const minutes = retryAfterMinutes(err);
    return minutes !== null
      ? `Too many attempts — wait ${String(minutes)} ${
          minutes === 1 ? 'minute' : 'minutes'
        } and try again.`
      : 'Too many attempts — wait a few minutes and try again.';
  }
  // Discriminate by `code` first — `/auth/login/totp` returns 401 for BOTH a
  // bad code (`invalid_code`) and a dead challenge (`challenge_invalid`), so
  // status alone is ambiguous. `confirm` returns 400 `invalid_code`.
  if (err.code === 'invalid_code') {
    return 'That code didn’t match. Check it and try again.';
  }
  if (err.code === 'challenge_invalid') {
    return 'Your sign-in expired. Start again.';
  }
  if (err.status === 400) {
    return 'That code didn’t match. Check it and try again.';
  }
  if (err.status === 401) {
    return 'Your sign-in expired. Start again.';
  }
  if (err.status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (err.status >= 500) {
    return 'The server is having trouble. Try again in a moment.';
  }
  return GENERIC;
}

/**
 * Whole-minute lockout window from a 423 `ApiError`. The server's lockout body
 * carries `retry_after` (seconds), which the api layer preserves on
 * `ApiError.retryAfter`. Round UP to the next whole minute (and floor at 1) so a
 * 90-second lockout reads "wait 2 minutes", never "wait 1 minute" then a failed
 * retry. Returns `null` when the server supplied no window — the caller falls
 * back to the generic copy. We never parse or echo the raw server prose here.
 */
function retryAfterMinutes(err: ApiError): number | null {
  if (typeof err.retryAfter === 'number' && err.retryAfter > 0) {
    return Math.max(1, Math.ceil(err.retryAfter / 60));
  }
  return null;
}
