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
  it('seed theta lands at L1 (gradual start-easy ramp, diagnostic-upgrade Phase B)', () => {
    expect(bandForTheta(SEED_THETA)).toBe('L1');
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

describe('stepForAnswer (gradual ramp, diagnostic-upgrade Phase B)', () => {
  it('decays from 0.7 by 0.03 per answer', () => {
    expect(stepForAnswer(1)).toBeCloseTo(0.7);
    expect(stepForAnswer(2)).toBeCloseTo(0.67);
    expect(stepForAnswer(3)).toBeCloseTo(0.64);
    expect(stepForAnswer(5)).toBeCloseTo(0.58);
  });
  it('floors at 0.35 (from answer 13 on: 0.7 − 0.03·12 = 0.34, floored)', () => {
    expect(stepForAnswer(13)).toBeCloseTo(0.35);
    expect(stepForAnswer(20)).toBeCloseTo(0.35);
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

describe('nextTheta (gradual step, diagnostic-upgrade Phase B)', () => {
  it('rises on correct by step', () => {
    expect(nextTheta(4.0, true, 1)).toBeCloseTo(4.7); // +0.70
    expect(nextTheta(4.0, true, 2)).toBeCloseTo(4.67); // +0.67
  });
  it('falls on wrong/skip by step', () => {
    expect(nextTheta(4.0, false, 1)).toBeCloseTo(3.3); // −0.70
    expect(nextTheta(4.0, false, 2)).toBeCloseTo(3.33); // −0.67
  });
  it('clamps to the valid range', () => {
    expect(nextTheta(5.8, true, 1)).toBe(THETA_MAX); // 5.8 + 0.7 = 6.5 → 6
    expect(nextTheta(1.2, false, 1)).toBe(THETA_MIN); // 1.2 − 0.7 = 0.5 → 1
    // A miss from low θ still floors in one step (1.5 − 0.7 = 0.8 → 1.0)…
    expect(nextTheta(1.5, false, 1)).toBe(THETA_MIN);
    // …but the GENTLE step no longer floors a mid-band miss in one move: a
    // wrong answer from L3 lands at L2 (2.2 − 0.7 = 1.5), not the floor — the
    // gradual descent that mirrors the gradual climb.
    expect(nextTheta(2.2, false, 1)).toBeCloseTo(1.5);
  });

  it('θ reaches 1.0 (L1 band) after a SINGLE miss from the seed', () => {
    // SEED_THETA 1.2, step1 = 0.7: 1.2 − 0.7 = 0.5 → clamped to 1.0. Even with
    // the gentle step, a first miss from the low L1 seed floors immediately,
    // so a struggling beginner is placed at the bottom without a long descent.
    expect(nextTheta(SEED_THETA, false, 1)).toBe(THETA_MIN);
  });

  it('climbs GRADUALLY from the L1 seed — reaching L5+ only by the 6th correct answer and the ceiling by the 9th', () => {
    // Gradual start-easy ramp (diagnostic-upgrade Phase B retune). From
    // SEED_THETA=1.2 an all-correct run climbs by the decaying step
    // (0.70, 0.67, 0.64, …): 1.2 → 1.90 → 2.57 → 3.21 → 3.82 → 4.40 → 4.95 →
    // 5.47 → 5.96 → 6.0 (clamped). Contrast the OLD steep ramp, which jumped
    // 2.0 → 3.5 → 4.85 → 6.0 and hit the ceiling by answer 3 — so its "easy"
    // opener lasted a single question. Here the opener is a true L1 item and
    // the learner only reaches advanced (L5+) after six correct answers.
    const expected = [1.9, 2.57, 3.21, 3.82, 4.4, 4.95, 5.47, 5.96, 6.0];
    let theta = SEED_THETA;
    const bands: string[] = [bandForTheta(theta)]; // bands[0] = seed band
    for (let n = 1; n <= expected.length; n += 1) {
      theta = nextTheta(theta, true, n);
      expect(theta).toBeCloseTo(expected[n - 1]!, 2);
      bands.push(bandForTheta(theta)); // bands[n] = band after the n-th answer
    }
    expect(theta).toBe(THETA_MAX);
    expect(bands[0]).toBe('L1'); // easy L1 opener
    expect(bands[5]).toBe('L4'); // after 5 correct answers, still L4 (θ 4.40)
    expect(bands[6]).toBe('L5+'); // advanced reached only at the 6th (θ 4.95)
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
