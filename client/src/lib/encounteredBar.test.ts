/**
 * encounteredBar — unit tests for the F-077 client-composed hanja status
 * line, independent of page markup (fixpass B7 R2 N1).
 *
 * The Hanja screen and the Progress Hanja tab both render
 * `hanjaProgressSummary`'s output verbatim; their page tests assert it
 * through the DOM. These tests pin the EN/KR templates, the reconstructed
 * `encountered/total` denominator (total = banked + practicing + new, per
 * the /hanja/progress route contract), and the zero-count shape directly,
 * so a template edit can't hide behind looser page-level matchers.
 */
import { describe, it, expect } from 'vitest';
import { hanjaProgressSummary } from './encounteredBar';
import { HANJA_PROGRESS_FIXTURE } from '../data/mocks/hanja';

describe('hanjaProgressSummary', () => {
  it.each([
    // banked, practicing, new, encountered, expected EN, expected KR
    [
      6,
      4,
      990,
      142,
      '6 mastered · 4 practicing · 142/1000 encountered',
      '숙달 6 · 연습 중 4 · 접한 한자 142/1000',
    ],
    [
      0,
      1,
      7,
      3,
      '0 mastered · 1 practicing · 3/8 encountered',
      '숙달 0 · 연습 중 1 · 접한 한자 3/8',
    ],
    // Zero-count shape: no pluralization or hidden segments — every field
    // renders, including a 0/0 denominator on a fully empty corpus.
    [
      0,
      0,
      0,
      0,
      '0 mastered · 0 practicing · 0/0 encountered',
      '숙달 0 · 연습 중 0 · 접한 한자 0/0',
    ],
  ])(
    'composes banked=%i practicing=%i new=%i encountered=%i',
    (banked, practicing, newCount, encountered, en, kr) => {
      const summary = hanjaProgressSummary({
        banked,
        practicing,
        new: newCount,
        encountered,
      });
      expect(summary.en).toBe(en);
      expect(summary.kr).toBe(kr);
    },
  );

  it('mock fixture reconciles: banked + practicing + new covers encountered', () => {
    // Regression guard (fixpass B7 R2 S1): the dev-mock fixture once carried
    // new: 2, which the client-side composition rendered as an impossible
    // "142/12 encountered". The reconstructed total must stay a plausible
    // corpus-wide denominator for the encountered count it ships with.
    const total =
      HANJA_PROGRESS_FIXTURE.banked +
      HANJA_PROGRESS_FIXTURE.practicing +
      HANJA_PROGRESS_FIXTURE.new;
    expect(total).toBeGreaterThanOrEqual(HANJA_PROGRESS_FIXTURE.encountered);
  });
});
