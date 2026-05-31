/**
 * Unit tests for src/auth/totp.ts (otplib wrapper). No Postgres needed.
 *
 * Covers: round-trip verify, the ±1-step skew window, the matched-step return
 * used by the route's replay guard, otpauth URI format, and bad-code rejection.
 */
import { describe, expect, it } from 'vitest';
import { generate as otplibGenerate } from 'otplib';
import {
  buildOtpauthUri,
  generateSecret,
  generateTotp,
  verifyTotp,
} from '../../src/auth/totp.js';

/** RFC 6238 step (seconds) — matches PERIOD_SECONDS in src/auth/totp.ts. */
const STEP_SECONDS = 30;

/**
 * Mint the code for `secret` at a specific time-step offset from the CURRENT
 * step, anchored to the MIDDLE of that step.
 *
 * `verifyTotp` always verifies against the real "now"; we drive `generate`'s
 * `epoch` so the test can place a code N steps away and assert the acceptance
 * WINDOW WIDTH, not just the current code. otplib's `epoch` is Unix SECONDS
 * (verified in @otplib/totp: `Math.floor((epoch - t0) / period)`).
 *
 * Anchoring to the step middle (`stepStart + 15s`) makes the test deterministic:
 * a code at offset K lands in step `currentStep + K` with ≥15s of slack to the
 * nearest boundary, so the few-ms gap before `verifyTotp` reads its own "now"
 * can never push the code into an adjacent step. The returned `currentStep` lets
 * the caller assert against the same anchor.
 */
function currentStep(): number {
  return Math.floor(Date.now() / 1000 / STEP_SECONDS);
}

async function codeAtStepOffset(
  secret: string,
  baseStep: number,
  stepOffset: number,
): Promise<string> {
  // Middle of the target step: stepStart + 15s. Unix SECONDS.
  const epochSeconds = (baseStep + stepOffset) * STEP_SECONDS + Math.floor(STEP_SECONDS / 2);
  return otplibGenerate({ secret, epoch: epochSeconds });
}

describe('generateSecret', () => {
  it('returns a base32 secret', () => {
    const s = generateSecret();
    expect(s.length).toBeGreaterThanOrEqual(16);
    expect(s).toMatch(/^[A-Z2-7]+=*$/); // RFC 4648 base32 alphabet
  });
});

describe('verifyTotp', () => {
  it('accepts the current code and returns its time-step', async () => {
    const secret = generateSecret();
    const code = await generateTotp(secret);
    const r = await verifyTotp(secret, code);
    expect(r.ok).toBe(true);
    expect(typeof r.step).toBe('number');
    expect(r.step).toBeGreaterThan(0);
  });

  it('rejects a wrong code and returns a null step', async () => {
    const secret = generateSecret();
    const live = await generateTotp(secret);
    // Pick a 6-digit code guaranteed to differ from the live one.
    const wrong = live === '000000' ? '111111' : '000000';
    const r = await verifyTotp(secret, wrong);
    expect(r.ok).toBe(false);
    expect(r.step).toBeNull();
  });

  it('rejects a code generated for a different secret', async () => {
    const a = generateSecret();
    const b = generateSecret();
    const codeForB = await generateTotp(b);
    const r = await verifyTotp(a, codeForB);
    expect(r.ok).toBe(false);
  });

  it('tolerates surrounding whitespace in the submitted code', async () => {
    const secret = generateSecret();
    const code = await generateTotp(secret);
    const r = await verifyTotp(secret, ` ${code} `);
    expect(r.ok).toBe(true);
  });

  // SECURITY (Crypto-SF2): the whole "±1 step only, not wider" guarantee rests on
  // EPOCH_TOLERANCE_SECONDS = 30. A regression that widened it (e.g. to 90s / ±3
  // steps) would pass every "current code verifies" test. These assert the WINDOW
  // WIDTH: prev (-1) and next (+1) step codes are accepted; ±2-step codes are not.
  //
  // `verifyTotp` reads its own "now"; we re-run the whole accept-or-reject decision
  // inside the SAME wall-clock step as the anchor so a step rollover mid-test can
  // never misclassify a code (retried, not slept — keeps the unit test fast).
  async function withinOneStep<T>(fn: (baseStep: number) => Promise<T>): Promise<T> {
    for (;;) {
      const baseStep = currentStep();
      const result = await fn(baseStep);
      if (currentStep() === baseStep) return result; // no boundary crossed → trustworthy
      // A step boundary elapsed during the verify; the window shifted under us.
      // Discard and retry on the new step.
    }
  }

  it('accepts a previous-step code (clock skew, -1 step)', async () => {
    const secret = generateSecret();
    const ok = await withinOneStep(async (baseStep) => {
      const prev = await codeAtStepOffset(secret, baseStep, -1);
      return verifyTotp(secret, prev);
    });
    expect(ok.ok).toBe(true);
    expect(typeof ok.step).toBe('number');
  });

  it('accepts a next-step code (clock skew, +1 step)', async () => {
    const secret = generateSecret();
    const ok = await withinOneStep(async (baseStep) => {
      const next = await codeAtStepOffset(secret, baseStep, 1);
      return verifyTotp(secret, next);
    });
    expect(ok.ok).toBe(true);
    expect(typeof ok.step).toBe('number');
  });

  it('rejects a +2-step code (outside the ±1 window)', async () => {
    const secret = generateSecret();
    const r = await withinOneStep(async (baseStep) => {
      const future = await codeAtStepOffset(secret, baseStep, 2);
      return verifyTotp(secret, future);
    });
    expect(r.ok).toBe(false);
    expect(r.step).toBeNull();
  });

  it('rejects a -2-step code (outside the ±1 window)', async () => {
    const secret = generateSecret();
    const r = await withinOneStep(async (baseStep) => {
      const past = await codeAtStepOffset(secret, baseStep, -2);
      return verifyTotp(secret, past);
    });
    expect(r.ok).toBe(false);
    expect(r.step).toBeNull();
  });

  it('returns a monotonically meaningful step (later step > earlier)', async () => {
    // The step is floor(epoch / 30); two verifies of the current code share a
    // step, and the route enforces strict-greater for replay. We assert the
    // step is the RFC time-step (epoch/30 magnitude), not an offset.
    const secret = generateSecret();
    const code = await generateTotp(secret);
    const r = await verifyTotp(secret, code);
    expect(r.ok && r.step !== null && r.step > 50_000_000).toBe(true);
  });
});

describe('buildOtpauthUri', () => {
  it('produces the Korean Master otpauth URI with issuer + label + secret', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const uri = buildOtpauthUri(secret, 'jared@example.com');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('Korean%20Master');
    expect(uri).toContain('jared%40example.com');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Korean%20Master');
  });
});
