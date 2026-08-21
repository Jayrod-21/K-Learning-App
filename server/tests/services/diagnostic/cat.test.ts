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
    expect(proficiencyToNumber('L1')).toBe(1);
    expect(proficiencyToNumber('L2')).toBe(2);
    expect(proficiencyToNumber('basic')).toBe(2); // content tag, kept at the L2 anchor
    expect(proficiencyToNumber('L3')).toBe(3);
    expect(proficiencyToNumber('L4')).toBe(4);
    expect(proficiencyToNumber('L5+')).toBe(5.5);
  });
});

describe('bandForTheta (5-band F-002 cuts)', () => {
  it('maps low theta to L1 (never the retired basic collapse)', () => {
    expect(bandForTheta(1.0)).toBe('L1');
    expect(bandForTheta(1.49)).toBe('L1');
  });
  it('maps the L2 band', () => {
    expect(bandForTheta(1.5)).toBe('L2');
    expect(bandForTheta(2.0)).toBe('L2');
    expect(bandForTheta(2.49)).toBe('L2');
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
  it('seed theta lands at L2 (start-easy ramp, diagnostic-upgrade Phase A)', () => {
    expect(bandForTheta(SEED_THETA)).toBe('L2');
  });
  it("never emits 'basic' anywhere across the θ range", () => {
    for (let theta = THETA_MIN; theta <= THETA_MAX; theta += 0.05) {
      expect(['L1', 'L2', 'L3', 'L4', 'L5+']).toContain(bandForTheta(theta));
    }
  });
});

describe('targetLevelForTheta', () => {
  it('hands the generator L1/L2 at low θ (no more L3 floor)', () => {
    expect(targetLevelForTheta(1.0)).toBe('L1');
    expect(targetLevelForTheta(1.49)).toBe('L1');
    expect(targetLevelForTheta(1.5)).toBe('L2');
    expect(targetLevelForTheta(2.0)).toBe('L2');
  });
  it('passes L3/L4/L5+ through', () => {
    expect(targetLevelForTheta(3.0)).toBe('L3');
    expect(targetLevelForTheta(4.0)).toBe('L4');
    expect(targetLevelForTheta(5.5)).toBe('L5+');
  });
});

describe('stepForAnswer (steepened for the start-easy ramp, diagnostic-upgrade Phase A)', () => {
  it('decays from 1.5 by 0.15 per answer', () => {
    expect(stepForAnswer(1)).toBeCloseTo(1.5);
    expect(stepForAnswer(2)).toBeCloseTo(1.35);
    expect(stepForAnswer(3)).toBeCloseTo(1.2);
    expect(stepForAnswer(5)).toBeCloseTo(0.9);
  });
  it('floors at 0.4 (from answer 9 on: 1.5 − 0.15·8 = 0.3, floored)', () => {
    expect(stepForAnswer(9)).toBeCloseTo(0.4);
    expect(stepForAnswer(20)).toBeCloseTo(0.4);
  });
  it('rejects non-positive answer numbers', () => {
    expect(() => stepForAnswer(0)).toThrow(RangeError);
    expect(() => stepForAnswer(-1)).toThrow(RangeError);
  });
});

describe('clampTheta', () => {
  it('clamps to [THETA_MIN, THETA_MAX] with the F-002 floor at 1.0', () => {
    expect(THETA_MIN).toBe(1.0); // L1 territory must be reachable
    expect(clampTheta(0.4)).toBe(THETA_MIN);
    expect(clampTheta(1.0)).toBe(1.0); // no longer floored up to 2.0
    expect(clampTheta(7.0)).toBe(THETA_MAX);
    expect(clampTheta(4.2)).toBe(4.2);
  });
});

describe('nextTheta (steepened step, diagnostic-upgrade Phase A)', () => {
  it('rises on correct by step', () => {
    expect(nextTheta(4.0, true, 1)).toBeCloseTo(5.5);
    expect(nextTheta(4.0, true, 2)).toBeCloseTo(5.35);
  });
  it('falls on wrong/skip by step', () => {
    expect(nextTheta(4.0, false, 1)).toBeCloseTo(2.5);
    expect(nextTheta(4.0, false, 2)).toBeCloseTo(2.65);
  });
  it('clamps to the valid range', () => {
    expect(nextTheta(5.8, true, 1)).toBe(THETA_MAX); // 7.3 → 6
    expect(nextTheta(1.2, false, 1)).toBe(THETA_MIN); // 1.2 − 1.5 = −0.3 → 1
    // The steeper step now clamps this case too (0.7 → floor), unlike the
    // old max(0.4, 1.0−0.1(n−1)) step, which left it at 1.2 unclamped.
    expect(nextTheta(2.2, false, 1)).toBe(THETA_MIN);
  });

  it('θ reaches 1.0 (L1 band) after a SINGLE miss from the new seed', () => {
    // SEED_THETA 2.0, step1 = 1.5: 2.0 − 1.5 = 0.5 → clamped to 1.0. The
    // lower seed + steeper early step means a struggling learner lands in L1
    // almost immediately, rather than the old 4-answer descent from L4.
    expect(nextTheta(SEED_THETA, false, 1)).toBe(THETA_MIN);
  });

  it('θ reaches 6.0 (THETA_MAX) by the 3rd correct answer from the new seed', () => {
    // The start-easy-ramp re-simulation the Phase A spec calls for: from
    // SEED_THETA=2.0, an all-correct run climbs 2.0 → 3.5 → 4.85 → 6.0
    // (clamped) — reaching the ceiling just as fast as the OLD seed/step
    // reached it from L4, so a genuinely advanced learner is not stuck
    // answering easy items for long.
    let theta = SEED_THETA;
    theta = nextTheta(theta, true, 1);
    expect(theta).toBeCloseTo(3.5);
    theta = nextTheta(theta, true, 2);
    expect(theta).toBeCloseTo(4.85);
    theta = nextTheta(theta, true, 3);
    expect(theta).toBe(THETA_MAX);
    expect(theta).toBe(6.0);
    // …and the FIRST item was served at the easy L2 band while the
    // all-correct learner still reaches L5+ (advanced) within 3 answers.
    expect(bandForTheta(SEED_THETA)).toBe('L2');
    expect(bandForTheta(theta)).toBe('L5+');
  });
});

describe('thetaToNumeric', () => {
  it('rounds to 2 decimals and clamps', () => {
    expect(thetaToNumeric(4.005)).toBeCloseTo(4.01);
    expect(thetaToNumeric(7)).toBe(THETA_MAX);
    expect(thetaToNumeric(0.5)).toBe(THETA_MIN);
    expect(thetaToNumeric(1)).toBe(1.0); // valid L1 θ passes through unclamped
  });
});
