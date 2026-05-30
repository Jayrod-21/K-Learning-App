/**
 * Unit tests for the CAT-lite ability-tracking helpers (pure math).
 */
import { describe, expect, it } from 'vitest';
import {
  SEED_THETA,
  THETA_MIN,
  THETA_MAX,
  bandForTheta,
  clampTheta,
  nextTheta,
  proficiencyToNumber,
  stepForAnswer,
  targetLevelForTheta,
  thetaToNumeric,
} from '../../../src/services/diagnostic/cat.js';

describe('proficiencyToNumber', () => {
  it('maps the locked anchors', () => {
    expect(proficiencyToNumber('basic')).toBe(2);
    expect(proficiencyToNumber('L3')).toBe(3);
    expect(proficiencyToNumber('L4')).toBe(4);
    expect(proficiencyToNumber('L5+')).toBe(5.5);
  });
});

describe('bandForTheta', () => {
  it('floors low theta to basic', () => {
    expect(bandForTheta(2.0)).toBe('basic');
    expect(bandForTheta(2.49)).toBe('basic');
  });
  it('maps the middle bands by nearest anchor', () => {
    expect(bandForTheta(2.5)).toBe('L3');
    expect(bandForTheta(3.49)).toBe('L3');
    expect(bandForTheta(3.5)).toBe('L4');
    expect(bandForTheta(4.74)).toBe('L4');
  });
  it('maps high theta to L5+', () => {
    expect(bandForTheta(4.75)).toBe('L5+');
    expect(bandForTheta(6)).toBe('L5+');
  });
  it('seed theta lands at L4', () => {
    expect(bandForTheta(SEED_THETA)).toBe('L4');
  });
});

describe('targetLevelForTheta', () => {
  it('floors basic to L3 for generation (Claude has no sub-L3 target)', () => {
    expect(targetLevelForTheta(2.0)).toBe('L3');
  });
  it('passes L3/L4/L5+ through', () => {
    expect(targetLevelForTheta(3.0)).toBe('L3');
    expect(targetLevelForTheta(4.0)).toBe('L4');
    expect(targetLevelForTheta(5.5)).toBe('L5+');
  });
});

describe('stepForAnswer', () => {
  it('decays from 1.0 by 0.1 per answer', () => {
    expect(stepForAnswer(1)).toBeCloseTo(1.0);
    expect(stepForAnswer(2)).toBeCloseTo(0.9);
    expect(stepForAnswer(5)).toBeCloseTo(0.6);
  });
  it('floors at 0.4', () => {
    expect(stepForAnswer(7)).toBeCloseTo(0.4);
    expect(stepForAnswer(20)).toBeCloseTo(0.4);
  });
  it('rejects non-positive answer numbers', () => {
    expect(() => stepForAnswer(0)).toThrow(RangeError);
    expect(() => stepForAnswer(-1)).toThrow(RangeError);
  });
});

describe('clampTheta', () => {
  it('clamps to [THETA_MIN, THETA_MAX]', () => {
    expect(clampTheta(1.0)).toBe(THETA_MIN);
    expect(clampTheta(7.0)).toBe(THETA_MAX);
    expect(clampTheta(4.2)).toBe(4.2);
  });
});

describe('nextTheta', () => {
  it('rises on correct by step', () => {
    expect(nextTheta(4.0, true, 1)).toBeCloseTo(5.0);
    expect(nextTheta(4.0, true, 2)).toBeCloseTo(4.9);
  });
  it('falls on wrong/skip by step', () => {
    expect(nextTheta(4.0, false, 1)).toBeCloseTo(3.0);
    expect(nextTheta(4.0, false, 2)).toBeCloseTo(3.1);
  });
  it('clamps to the valid range', () => {
    expect(nextTheta(5.8, true, 1)).toBe(THETA_MAX); // 6.8 → 6
    expect(nextTheta(2.2, false, 1)).toBe(THETA_MIN); // 1.2 → 2
  });
});

describe('thetaToNumeric', () => {
  it('rounds to 2 decimals and clamps', () => {
    expect(thetaToNumeric(4.005)).toBeCloseTo(4.01);
    expect(thetaToNumeric(7)).toBe(THETA_MAX);
    expect(thetaToNumeric(1)).toBe(THETA_MIN);
  });
});
