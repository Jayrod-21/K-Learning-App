/**
 * Single-use TOTP recovery (backup) codes.
 *
 * Codes are the "lost authenticator but kept my codes" escape hatch. Each is
 * high-entropy (10 Crockford-base32 chars → 50 bits) so a SHA-256-at-rest store
 * is sufficient — these are NOT low-entropy passwords, so Argon2 would only add
 * login latency for no security gain (PASS_LOGIN_CONTRACT B3). Plaintext is
 * shown to the user exactly ONCE (at enrollment-confirm / regenerate); only the
 * hash is persisted.
 *
 * Threat model (server/SECURITY.md §18):
 *   - DB disclosure: hashes only; the plaintext never lands in the DB or logs.
 *   - Reuse / replay: enforced single-use at the DB (atomic UPDATE … WHERE
 *     used_at IS NULL rowCount gate) — this module only mints + hashes.
 *   - Guessing: 50 bits of entropy from a CSPRNG; the per-IP authLimiter bounds
 *     online attempts.
 *   - Ambiguous transcription: Crockford base32 excludes I, L, O, U, so there is
 *     no I/1 or O/0 confusion when a user reads codes off paper.
 */
import { createHash, randomInt } from 'node:crypto';

/**
 * Crockford base32 alphabet (no I, L, O, U → unambiguous when read aloud /
 * transcribed). 32 symbols → 5 bits each.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Total significant chars per code → 10 × 5 bits = 50 bits of entropy. */
const CODE_CHARS = 10;
/** Group size for the readable `XXXXX-XXXXX` display form. */
const GROUP = 5;

export interface GeneratedRecoveryCodes {
  /** Display form (`XXXXX-XXXXX`), shown to the user ONCE. Index-aligned with `hashes`. */
  plaintext: string[];
  /** SHA-256 hex of each normalized code, for storage. Index-aligned with `plaintext`. */
  hashes: string[];
}

/**
 * Normalize a recovery code to its canonical form before hashing or comparison:
 * uppercase and strip dashes/whitespace. This makes user input forgiving (they
 * may omit the dash or paste lowercase) while keeping the stored hash canonical.
 */
export function normalizeRecoveryCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** SHA-256 hex of the normalized code — the at-rest representation. */
export function hashRecoveryCode(raw: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(raw), 'utf8').digest('hex');
}

/** Draw one CSPRNG character from the Crockford alphabet. */
function randomChar(): string {
  // randomInt is rejection-sampled and unbiased over [0, ALPHABET.length).
  return ALPHABET[randomInt(ALPHABET.length)] as string;
}

/** Generate a single display-form code (`XXXXX-XXXXX`). */
function generateOne(): string {
  let body = '';
  for (let i = 0; i < CODE_CHARS; i += 1) body += randomChar();
  // Insert a dash every GROUP chars for readability (10 chars → one dash).
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += GROUP) {
    groups.push(body.slice(i, i + GROUP));
  }
  return groups.join('-');
}

/**
 * Generate `n` fresh recovery codes. Returns index-aligned plaintext (display
 * form) and hashes. Caller persists the hashes and surfaces the plaintext once.
 *
 * @param n number of codes (RECOVERY_CODE_COUNT). Must be a positive integer.
 */
export function generateRecoveryCodes(n = 10): GeneratedRecoveryCodes {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('recovery code count must be a positive integer');
  }
  const plaintext: string[] = [];
  const hashes: string[] = [];
  // Within a single set, dedupe defensively: a collision is astronomically
  // unlikely at 50 bits, but a duplicate hash would violate the table's UNIQUE
  // constraint and abort the whole insert — cheaper to regenerate the rare
  // clash here than to fail the user's enrollment.
  const seen = new Set<string>();
  while (plaintext.length < n) {
    const code = generateOne();
    const hash = hashRecoveryCode(code);
    if (seen.has(hash)) continue;
    seen.add(hash);
    plaintext.push(code);
    hashes.push(hash);
  }
  return { plaintext, hashes };
}
