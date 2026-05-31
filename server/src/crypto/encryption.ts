/**
 * Authenticated symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * Used to encrypt the TOTP factor secret before it touches the database
 * (`user_totp.secret_encrypted`). The key lives ONLY in the environment
 * (`TOTP_SECRET_ENC_KEY`, validated to exactly 32 bytes at config load) — never
 * in the DB and never in a tracked file. A DB read alone therefore does not
 * yield a usable factor secret; an attacker needs both the DB dump AND the env
 * key.
 *
 * Threat model (server/SECURITY.md §18):
 *   - Secret-at-rest disclosure (DB dump / backup leak): GCM ciphertext is
 *     useless without the env key. We NEVER log plaintext, the key, or the
 *     ciphertext.
 *   - Ciphertext tampering / bit-flipping: GCM is authenticated — `decryptSecret`
 *     verifies the 16-byte auth tag and THROWS on any mismatch (truncation,
 *     flipped bit, swapped IV). Callers treat a throw as "secret unusable".
 *   - IV reuse (catastrophic for GCM — leaks the keystream / forges tags): a
 *     fresh 12-byte CSPRNG IV is generated per `encryptSecret` call and stored
 *     alongside the ciphertext. We never reuse or derive the IV.
 *   - Key confusion / wrong-length key: the key is loaded once from config,
 *     which has already refined it to exactly 32 bytes; we assert again here so
 *     a misconfiguration fails loud at first use, not with a cryptic OpenSSL
 *     error deep in a request.
 *
 * Store format: a single base64 string of `iv (12B) ‖ authTag (16B) ‖ ciphertext`.
 * Self-describing — decrypt slices the fixed-width IV and tag back off the front.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadConfig } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256 → 256-bit key.
const IV_BYTES = 12; // GCM standard nonce size (96-bit) — never reuse.
const AUTH_TAG_BYTES = 16; // GCM tag (128-bit).

/**
 * The 32-byte key, decoded once from config and cached. Loaded lazily so config
 * validation has run (and so test config overrides take effect) before first
 * use. We cache the Buffer rather than re-decoding base64 on every call.
 */
let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;
  const cfg = loadConfig();
  // Config has already refined this to base64-of-32-bytes (config/index.ts B5),
  // but we re-validate so a future config drift fails here with a clear message
  // rather than as an opaque "Invalid key length" from OpenSSL.
  const key = Buffer.from(cfg.TOTP_SECRET_ENC_KEY, 'base64');
  if (key.length !== KEY_BYTES) {
    // Do NOT include the key (or its length-derived material) beyond the byte
    // count — never echo the secret itself.
    throw new Error(
      `TOTP_SECRET_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  _key = key;
  return _key;
}

/**
 * Reset the cached key — test-only. Lets a test that overrides config re-derive
 * the key without leaking the previous test's key into the next.
 */
export function _resetEncryptionKeyForTesting(): void {
  _key = null;
}

/**
 * Encrypt a secret string. Returns base64(iv ‖ authTag ‖ ciphertext).
 *
 * @throws if the key is misconfigured (wrong length). Never logs the plaintext.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES); // fresh per-call nonce — GCM IV reuse is fatal.
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 16 bytes.
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypt a value produced by `encryptSecret`. Verifies the GCM auth tag.
 *
 * @throws if the input is malformed (too short / not base64) or if the auth tag
 *         does not verify (tampering, wrong key, truncation). Callers MUST treat
 *         a throw as "secret unusable" and fail the operation — never fall back
 *         to trusting unverified plaintext. Never logs the plaintext.
 */
export function decryptSecret(stored: string): string {
  const key = getKey();
  const buf = Buffer.from(stored, 'base64');
  // Minimum length: IV + tag + at least 0 bytes of ciphertext. Reject anything
  // shorter BEFORE handing slices to OpenSSL (a too-short tag yields a confusing
  // native error otherwise).
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('encrypted secret is malformed (too short)');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // `final()` throws "Unsupported state or unable to authenticate data" if the
  // tag does not verify — that throw is the tamper-detection boundary.
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
