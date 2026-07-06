/**
 * skillBand — unit tests for the F-011 confidence-band helpers.
 *
 * These pin the DEFENSIVE contract, not just the happy path: `SkillBar`'s
 * comments promise that an inverted server pair can't render a negative-width
 * band and that out-of-range edges are clamped before the visibility compare.
 * Those promises live here as failing tests rather than comment claims — a
 * refactor that "simplifies" the clamp/sort away must go red (fixpass R3 S1).
 */
import { describe, it, expect } from 'vitest';
import { SKILL_MAX, clampScore, hasVisibleBand } from './skillBand';

describe('clampScore', () => {
  it('passes in-range values through untouched', () => {
    expect(clampScore(0)).toBe(0);
    expect(clampScore(62)).toBe(62);
    expect(clampScore(SKILL_MAX)).toBe(SKILL_MAX);
  });

  it('clamps out-of-range values to the 0–100 scale', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(101)).toBe(SKILL_MAX);
    expect(clampScore(9999)).toBe(SKILL_MAX);
  });

  it('collapses NaN to 0 (the documented malformed-data floor)', () => {
    expect(clampScore(Number.NaN)).toBe(0);
  });
});

describe('hasVisibleBand', () => {
  it('is false when either edge is missing', () => {
    expect(hasVisibleBand(undefined, undefined)).toBe(false);
    expect(hasVisibleBand(52, undefined)).toBe(false);
    expect(hasVisibleBand(undefined, 68)).toBe(false);
  });

  it('is false for a degenerate pair (low == high — the server "confidence unknown" fallback)', () => {
    expect(hasVisibleBand(45, 45)).toBe(false);
    expect(hasVisibleBand(0, 0)).toBe(false);
    expect(hasVisibleBand(100, 100)).toBe(false);
  });

  it('is true for a real range', () => {
    expect(hasVisibleBand(52, 68)).toBe(true);
  });

  it('is false for a pair that only differs OUTSIDE the scale (clamp collapses it)', () => {
    // 101 and 102 both clamp to 100 — distinct raw values, but no honest
    // range remains on the 0–100 track, so no band renders.
    expect(hasVisibleBand(101, 102)).toBe(false);
    expect(hasVisibleBand(-3, -1)).toBe(false);
  });

  it('is true for an inverted pair (low > high) — SkillBar sorts it, never hides it', () => {
    // The server invariant is scoreLow <= scoreHigh, but a corrupt pair must
    // not vanish silently: visibility says "there IS a range here" and the
    // renderer (SkillBar) min/max-sorts the edges into a non-negative width.
    expect(hasVisibleBand(68, 52)).toBe(true);
  });

  it('pins the current NaN contract: NaN collapses to 0 before the compare', () => {
    // NaN mirrors clampScore's NaN→0 floor, so a single-NaN pair still counts
    // as a range against a non-zero edge, and an all-NaN pair degenerates to
    // no band. (R3 N1 notes a stricter Number.isFinite guard as a candidate
    // tightening — if that lands, update these pins deliberately.)
    expect(hasVisibleBand(Number.NaN, 70)).toBe(true);
    expect(hasVisibleBand(Number.NaN, Number.NaN)).toBe(false);
    expect(hasVisibleBand(Number.NaN, 0)).toBe(false);
  });
});
