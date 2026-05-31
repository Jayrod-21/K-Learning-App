/**
 * TOTP (RFC 6238) authenticator factor — thin wrapper over `otplib`.
 *
 * Parameters are the authenticator-app standard so any Google Authenticator /
 * Authy / 1Password client interoperates:
 *   - SHA1, 6 digits, 30-second step.
 *   - Verification window ±1 step (accept previous / current / next) to absorb
 *     phone-vs-server clock skew. otplib expresses this as a ±30s epoch
 *     tolerance.
 *
 * Replay defense lives in the ROUTE, not here: `verifyTotp` returns the matched
 * time-step so the caller can enforce `step > user_totp.last_used_step` (a
 * stateless TOTP verify would otherwise accept the same code repeatedly for the
 * full 90-second skew window). This module is pure — no DB, no logging of the
 * secret or the code.
 */
import { generate, generateSecret, generateURI, verify } from 'otplib';

/** RFC 6238 step in seconds (authenticator-app standard). */
const PERIOD_SECONDS = 30;
/**
 * ±1 step acceptance window expressed as an epoch tolerance in seconds. One
 * period each side (prev/curr/next) → delta ∈ {-1, 0, +1}. We do NOT widen this:
 * a larger window trades brute-force resistance for skew tolerance, and 30s each
 * way already covers any reasonable phone clock drift.
 */
const EPOCH_TOLERANCE_SECONDS = PERIOD_SECONDS;

/** Issuer label shown in the authenticator app and embedded in the otpauth URI. */
const ISSUER = 'Korean Master';

/**
 * Generate a fresh base32 TOTP secret (otplib default 20 bytes / 160 bits).
 * Returned plaintext is the value the caller encrypts before storage and shows
 * ONCE to the enrolling user for manual entry.
 */
export function generateSecret_(): string {
  return generateSecret();
}

// Re-exported under the contract name; the trailing underscore above avoids
// shadowing the imported otplib `generateSecret` within this module.
export { generateSecret_ as generateSecret };

/**
 * Build the `otpauth://totp/...` URI the client renders as a QR code.
 *
 * Format: `otpauth://totp/Korean%20Master:<email>?secret=…&issuer=Korean%20Master`
 * (otplib URL-encodes the issuer and label).
 */
export function buildOtpauthUri(secret: string, accountLabel: string): string {
  return generateURI({ issuer: ISSUER, label: accountLabel, secret });
}

export interface TotpVerifyResult {
  /** True if the code matched within the ±1-step window. */
  ok: boolean;
  /**
   * The RFC-6238 time-step number the code matched at, for the route's replay
   * guard (`step > last_used_step`). null when `ok` is false.
   */
  step: number | null;
}

/**
 * Generate the current TOTP code for a secret.
 *
 * TEST-ONLY (Crypto-SF3): this mints a live, valid code for ANY secret, so it
 * must NEVER be imported by a request-handling route — doing so would hand the
 * server a code-minting oracle. It exists solely for the enrollment-confirm /
 * login integration tests (which need the live code without a real authenticator
 * app). The production routes import only `generateSecret`/`verifyTotp`; a grep
 * for `generateTotp` in `src/routes` MUST stay empty. Async because otplib's
 * default crypto plugin is async.
 */
export async function generateTotp(secret: string): Promise<string> {
  return generate({ secret });
}

/**
 * Verify a 6-digit TOTP `code` against `secret` within the ±1-step window.
 * Returns `{ ok, step }`; the matched step lets the caller enforce monotonic
 * replay protection. Never throws on a bad code — returns `{ ok: false }`.
 */
export async function verifyTotp(
  secret: string,
  code: string,
): Promise<TotpVerifyResult> {
  // Normalize defensively: strip whitespace a user might paste between digits.
  // We do NOT reject non-numeric here — otplib's constant-time compare handles a
  // wrong code, and the route already shape-checks the input via Zod.
  const normalized = code.replace(/\s+/g, '');
  const result = await verify({
    secret,
    token: normalized,
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
  });
  // otplib's top-level `verify` is typed as the HOTP|TOTP union; only the TOTP
  // valid branch carries `timeStep`. We always use the default TOTP strategy, so
  // a valid result always has it — narrow defensively via `in` so TS is satisfied
  // and a hypothetical HOTP result (impossible here) degrades to a null step
  // rather than NaN.
  if (result.valid && 'timeStep' in result) {
    return { ok: true, step: result.timeStep };
  }
  return { ok: false, step: null };
}
