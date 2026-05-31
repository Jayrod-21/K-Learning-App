/**
 * Unit tests for src/auth/recoveryCodes.ts. No Postgres needed.
 *
 * Covers: format, normalization, hash stability/shape, set size, and the
 * within-set uniqueness that protects the DB UNIQUE constraint.
 */
import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from '../../src/auth/recoveryCodes.js';

describe('generateRecoveryCodes', () => {
  it('generates the requested count with index-aligned plaintext + hashes', () => {
    const { plaintext, hashes } = generateRecoveryCodes(10);
    expect(plaintext).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    for (let i = 0; i < plaintext.length; i += 1) {
      expect(hashes[i]).toBe(hashRecoveryCode(plaintext[i]!));
    }
  });

  it('formats codes as XXXXX-XXXXX in the Crockford alphabet', () => {
    const { plaintext } = generateRecoveryCodes(5);
    for (const code of plaintext) {
      // 5 + dash + 5, Crockford base32 (no I, L, O, U).
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
  });

  it('produces unique codes within a set (no UNIQUE-constraint collision)', () => {
    const { hashes } = generateRecoveryCodes(20);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('rejects a non-positive or non-integer count', () => {
    expect(() => generateRecoveryCodes(0)).toThrow();
    expect(() => generateRecoveryCodes(-3)).toThrow();
    expect(() => generateRecoveryCodes(2.5)).toThrow();
  });
});

describe('normalizeRecoveryCode', () => {
  it('uppercases and strips dashes/whitespace', () => {
    expect(normalizeRecoveryCode('ab12c-d34ef')).toBe('AB12CD34EF');
    expect(normalizeRecoveryCode(' AB12C D34EF ')).toBe('AB12CD34EF');
  });
});

describe('hashRecoveryCode', () => {
  it('is a 64-char lowercase hex digest', () => {
    const h = hashRecoveryCode('AB12C-D34EF');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is invariant to display formatting (dash/case)', () => {
    const canonical = hashRecoveryCode('AB12CD34EF');
    expect(hashRecoveryCode('ab12c-d34ef')).toBe(canonical);
    expect(hashRecoveryCode('  AB12C-D34EF ')).toBe(canonical);
  });

  it('differs for different codes', () => {
    expect(hashRecoveryCode('AB12C-D34EF')).not.toBe(hashRecoveryCode('ZZ12C-D34EF'));
  });
});
