/**
 * Unit tests for src/crypto/encryption.ts (AES-256-GCM secret-at-rest).
 *
 * No Postgres needed — these exercise the pure crypto path. We provision the
 * fixed test key via the same config seam the app uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  _setConfigForTesting,
  resetConfig,
  TEST_TOTP_SECRET_ENC_KEY,
} from '../../src/config/index.js';
import {
  _resetEncryptionKeyForTesting,
  decryptSecret,
  encryptSecret,
} from '../../src/crypto/encryption.js';

beforeAll(() => {
  process.env.TOTP_SECRET_ENC_KEY = TEST_TOTP_SECRET_ENC_KEY;
  // Provide the rest of the required env so EnvSchema.parse succeeds.
  process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
  process.env.KIWI_URL ??= 'http://kiwi.invalid/';
  process.env.CLIENT_ORIGIN ??= 'http://localhost:5173';
  resetConfig();
  _setConfigForTesting({});
  _resetEncryptionKeyForTesting();
});

afterAll(() => {
  resetConfig();
  _resetEncryptionKeyForTesting();
});

describe('encryptSecret / decryptSecret round-trip', () => {
  it('decrypts back to the original plaintext', () => {
    const plain = 'JBSWY3DPEHPK3PXP'; // a representative base32 TOTP secret
    const stored = encryptSecret(plain);
    expect(decryptSecret(stored)).toBe(plain);
  });

  it('does not store the plaintext (ciphertext != plaintext)', () => {
    const plain = 'RIAKHZBEHZUGLWVS5YZK2HW74RLUOLR2';
    const stored = encryptSecret(plain);
    expect(stored).not.toContain(plain);
    // The stored blob is base64 of iv|tag|ct — never the readable base32 secret.
    expect(Buffer.from(stored, 'base64').toString('utf8')).not.toContain(plain);
  });

  it('produces a different ciphertext each call (fresh IV per encrypt)', () => {
    const plain = 'SAMESECRETVALUE2';
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b); // distinct IVs → distinct ciphertext
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it('round-trips unicode and empty strings', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('');
    expect(decryptSecret(encryptSecret('안녕하세요-secret'))).toBe('안녕하세요-secret');
  });
});

describe('decryptSecret tamper detection (GCM auth tag)', () => {
  it('throws when a ciphertext byte is flipped', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP');
    const buf = Buffer.from(stored, 'base64');
    // Flip a bit in the last byte (ciphertext region). writeUInt8 keeps tsc's
    // noUncheckedIndexedAccess happy vs. an indexed compound-assign.
    const lastIdx = buf.length - 1;
    buf.writeUInt8(buf.readUInt8(lastIdx) ^ 0x01, lastIdx);
    const tampered = buf.toString('base64');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('throws when the auth tag is flipped', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP');
    const buf = Buffer.from(stored, 'base64');
    // Tag occupies bytes [12, 28). Flip a bit there.
    buf.writeUInt8(buf.readUInt8(13) ^ 0x80, 13);
    expect(() => decryptSecret(buf.toString('base64'))).toThrow();
  });

  it('throws on a truncated / malformed blob', () => {
    expect(() => decryptSecret('AAAA')).toThrow(/malformed/);
    expect(() => decryptSecret('')).toThrow();
  });
});
