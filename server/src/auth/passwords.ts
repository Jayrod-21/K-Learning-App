/**
 * Argon2id password hashing.
 *
 * Parameters per ADR-002: memoryCost=65536 (64 MiB), timeCost=3, parallelism=1.
 * The encoded PHC string carries the params, so we can rotate per-user on
 * successful login by checking `needsRehash`.
 *
 * Library: @node-rs/argon2 (Rust binding, fast, well-maintained). Falls back
 * to a synchronous wrapper API.
 */
import { hash, verify, Algorithm } from '@node-rs/argon2';

const ARGON2ID_PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

const MAX_PASSWORD_BYTES = 256; // OWASP: cap input to bound CPU/mem on hash.

export async function hashPassword(plaintext: string): Promise<string> {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error('password exceeds maximum allowed length');
  }
  return hash(plaintext, ARGON2ID_PARAMS);
}

export async function verifyPassword(
  encoded: string,
  plaintext: string,
): Promise<boolean> {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
    // Always run verify on the dummy hash so timing matches the "valid user, wrong pw"
    // branch and the request doesn't reveal whether the input was over-long.
    await safeDummyVerify();
    return false;
  }
  if (!encoded.startsWith('$argon2id$')) {
    await safeDummyVerify();
    return false;
  }
  try {
    return await verify(encoded, plaintext);
  } catch {
    return false;
  }
}

/**
 * Constant-ish-time dummy verify to keep "user not found" and "user found,
 * wrong password" branches close in timing. Bar §"Security": defends against
 * username-enumeration via timing oracle.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$ZHVtbXlzYWx0c2FsdHNhbHQ$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy';
export async function safeDummyVerify(): Promise<void> {
  try {
    await verify(DUMMY_HASH, 'never-matches');
  } catch {
    /* ignore */
  }
}
