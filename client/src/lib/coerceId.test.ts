/**
 * coerceId — the shared BIGINT-wire-id guard (F-204).
 *
 * The suite is written to be mutation-worthy — the load-bearing guard
 * clauses each have a case that ONLY that clause rejects, so a mutant
 * dropping a single assert fails here:
 *   - `'9007199254740993'` and `2 ** 53 + 2` are finite and positive but
 *     NOT safe integers → kill a dropped `isSafeInteger` (and the
 *     fractional cases kill a mutant that swapped it for `isInteger`).
 *   - `0` / `-1` (number and string) are finite safe integers → kill a
 *     dropped `n > 0`.
 *   - `Infinity` and `NaN` are covered explicitly; note `isSafeInteger`
 *     already implies finiteness, so `isFinite` in the implementation is
 *     deliberate belt-and-suspenders (documented intent), not a clause
 *     these tests can isolate.
 */
import { describe, expect, it } from 'vitest';
import { coerceId } from './coerceId';

describe('coerceId', () => {
  it('accepts a valid positive number and returns it unchanged', () => {
    expect(coerceId(42)).toBe(42);
    expect(coerceId(1)).toBe(1);
    expect(coerceId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts a valid numeric string (BIGINT-as-string wire shape)', () => {
    expect(coerceId('42')).toBe(42);
    expect(coerceId('1')).toBe(1);
    expect(coerceId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('throws on the empty string (Number("") === 0)', () => {
    expect(() => coerceId('')).toThrow(/Invalid id from server/);
  });

  it('throws on a non-numeric string', () => {
    expect(() => coerceId('abc')).toThrow(/Invalid id from server: "abc"/);
  });

  it('throws on an unsafe integer string (> 2^53, int8 precision loss)', () => {
    expect(() => coerceId('9007199254740993')).toThrow(
      /Invalid id from server/,
    );
  });

  it('throws on an unsafe integer number', () => {
    expect(() => coerceId(2 ** 53 + 2)).toThrow(/Invalid id from server/);
  });

  it('throws on zero (ids are 1-based; 0 is the classic Number("") junk)', () => {
    expect(() => coerceId(0)).toThrow(/Invalid id from server/);
    expect(() => coerceId('0')).toThrow(/Invalid id from server/);
  });

  it('throws on negatives', () => {
    expect(() => coerceId(-1)).toThrow(/Invalid id from server/);
    expect(() => coerceId('-1')).toThrow(/Invalid id from server/);
  });

  it('throws on NaN', () => {
    expect(() => coerceId(NaN)).toThrow(/Invalid id from server/);
  });

  it('throws on Infinity', () => {
    expect(() => coerceId(Infinity)).toThrow(/Invalid id from server/);
    expect(() => coerceId('Infinity')).toThrow(/Invalid id from server/);
  });

  it('throws on fractional inputs (string and number)', () => {
    expect(() => coerceId('1.5')).toThrow(/Invalid id from server/);
    expect(() => coerceId(1.5)).toThrow(/Invalid id from server/);
  });
});
