/**
 * recommend — pure two-stage next-exercise ranking (F-212 P4). No DB, no
 * clock: every case pins the locked RECOMMENDER_CONFIG semantics —
 * weakest-dimension targeting, EXPLORE_BASE dominance for insufficient
 * dimensions, the due-load flip at (and not below) DUE_SAT, the uncertainty
 * term, b* difficulty targeting with NEUTRAL_PROX for unplaced items, the
 * md5 tie-break determinism, and the all-insufficient cold-start null.
 */
import { describe, expect, it } from 'vitest';
import {
  RECOMMENDER_CONFIG,
  composeReason,
  dimensionScore,
  itemScore,
  rankRecommendations,
  reasonCodeFor,
  targetDifficulty,
  type CandidateItem,
  type DimensionSignal,
  type RankInput,
} from '../../../src/services/ability/recommend.js';
import { ESTIMATE_SPREAD } from '../../../src/services/diagnostic/scoring.js';
import { DEFAULT_ESTIMATOR_CONFIG } from '../../../src/services/ability/irt.js';

/** A sufficient dimension signal with sane defaults, overridable per test. */
function sufficient(
  dimension: DimensionSignal['dimension'],
  theta: number,
  overrides: Partial<DimensionSignal> = {},
): DimensionSignal {
  return { dimension, theta, se: 0.6, insufficient: false, dueCount: 0, ...overrides };
}

function insufficient(dimension: DimensionSignal['dimension']): DimensionSignal {
  return { dimension, theta: null, se: null, insufficient: true, dueCount: 0 };
}

/** One placed candidate with defaults. */
function item(itemKey: string, b: number | null, overrides: Partial<CandidateItem> = {}): CandidateItem {
  return {
    itemKey,
    b,
    deepLink: '/learn/vocab',
    level: 'L3',
    title: itemKey,
    mins: 5,
    ...overrides,
  };
}

function rank(input: Partial<RankInput>): ReturnType<typeof rankRecommendations> {
  return rankRecommendations({
    userKey: '42',
    dayKey: '2026-08-17',
    dimensions: [],
    candidates: {},
    ...input,
  });
}

describe('RECOMMENDER_CONFIG — locked constants', () => {
  it('pins the locked Phase-4 values and the reused scale constants', () => {
    expect(RECOMMENDER_CONFIG.wDeficit).toBe(0.5);
    expect(RECOMMENDER_CONFIG.wDue).toBe(0.3);
    expect(RECOMMENDER_CONFIG.wUncertainty).toBe(0.2);
    expect(RECOMMENDER_CONFIG.exploreBase).toBe(1.0);
    expect(RECOMMENDER_CONFIG.dueSat).toBe(20);
    expect(RECOMMENDER_CONFIG.tau).toBe(0.75);
    expect(RECOMMENDER_CONFIG.targetOffset).toBe(0.4);
    expect(RECOMMENDER_CONFIG.neutralProx).toBe(0.5);
    expect(RECOMMENDER_CONFIG.probeCenterB).toBe(3.5);
    // SPREAD / PRIOR_SD are wired to the SAME locked constants the diagnostic
    // and estimator use — the scales cannot drift apart.
    expect(RECOMMENDER_CONFIG.spread).toBe(ESTIMATE_SPREAD);
    expect(RECOMMENDER_CONFIG.priorSd).toBe(DEFAULT_ESTIMATOR_CONFIG.priorSd);
  });
});

describe('targetDifficulty — b* = clamp(θ + 0.4, 1, 6), probe center when null', () => {
  it('offsets above the estimate', () => {
    expect(targetDifficulty(3.0)).toBeCloseTo(3.4, 10);
  });
  it('clamps at the scale top and bottom', () => {
    expect(targetDifficulty(5.9)).toBe(6);
    expect(targetDifficulty(0.2)).toBe(1); // sub-floor θ can't target below 1
  });
  it('insufficient (null θ) → the 3.5 probe center', () => {
    expect(targetDifficulty(null)).toBe(3.5);
  });
});

describe('dimensionScore — Stage A terms', () => {
  it('an insufficient dimension scores EXPLORE_BASE and outscores any sufficient one', () => {
    const explore = dimensionScore(insufficient('vocab'), 4.0);
    expect(explore.score).toBe(RECOMMENDER_CONFIG.exploreBase);
    expect(explore.exploratory).toBe(true);

    // A maximally bad sufficient dimension: full deficit clamp, saturated due
    // load, se just under the prior (the post-gate posterior SD is always
    // strictly below the prior SD) — still strictly below EXPLORE_BASE.
    const worst = dimensionScore(
      sufficient('grammar', 1.0, { se: 1.49, dueCount: 999 }),
      6.0,
    );
    expect(worst.score).toBeLessThan(explore.score);
  });

  it('deficit measures distance below θ_ref, normalized by SPREAD and clamped', () => {
    const { terms } = dimensionScore(sufficient('reading', 2.0, { se: 0 }), 3.5);
    expect(terms.deficit).toBeCloseTo(0.5 * ((3.5 - 2.0) / 1.5), 10); // = 0.5 (clamp edge)
    const clamped = dimensionScore(sufficient('reading', 1.0, { se: 0 }), 6.0);
    expect(clamped.terms.deficit).toBe(0.5); // (6−1)/1.5 > 1 → clamped
    const ahead = dimensionScore(sufficient('reading', 5.0, { se: 0 }), 3.5);
    expect(ahead.terms.deficit).toBe(0); // above θ_ref → never negative
  });

  it('due term saturates at DUE_SAT — dueCount 20 and 40 score identically', () => {
    const at = dimensionScore(sufficient('vocab', 3.5, { dueCount: 20 }), 3.5);
    const beyond = dimensionScore(sufficient('vocab', 3.5, { dueCount: 40 }), 3.5);
    const below = dimensionScore(sufficient('vocab', 3.5, { dueCount: 10 }), 3.5);
    expect(at.terms.due).toBeCloseTo(0.3, 10);
    expect(beyond.terms.due).toBeCloseTo(0.3, 10);
    expect(below.terms.due).toBeCloseTo(0.15, 10);
  });

  it('uncertainty term scales se against the prior SD', () => {
    const { terms } = dimensionScore(sufficient('grammar', 3.5, { se: 0.75 }), 3.5);
    expect(terms.uncertainty).toBeCloseTo(0.2 * (0.75 / 1.5), 10);
  });
});

describe('itemScore — Stage B proximity', () => {
  it('peaks at b = b* and decays with distance', () => {
    expect(itemScore(3.4, 3.4)).toBe(1);
    const near = itemScore(3.5, 3.4);
    const far = itemScore(5.4, 3.4);
    expect(near).toBeGreaterThan(far);
    // exp(−(2)²/(2·0.75²)) — the exact locked kernel.
    expect(far).toBeCloseTo(Math.exp(-4 / (2 * 0.5625)), 10);
  });

  it('null b scores the fixed NEUTRAL_PROX', () => {
    expect(itemScore(null, 3.4)).toBe(RECOMMENDER_CONFIG.neutralProx);
  });
});

describe('rankRecommendations — Stage A winner', () => {
  it('picks the weakest sufficient dimension (reasonCode weakest_dimension)', () => {
    const { recommendation, alternatives } = rank({
      dimensions: [
        sufficient('reading', 2.0),
        sufficient('listening', 4.0),
      ],
      candidates: {
        reading: [item('reading:story:1', 2.4, { deepLink: '/learn/reading?story=1' })],
        listening: [item('listening:iyagi:9', null, { deepLink: '/learn/listen?corpus=iyagi&episode=9' })],
      },
    });
    expect(recommendation?.dimension).toBe('reading');
    expect(recommendation?.reasonCode).toBe('weakest_dimension');
    expect(recommendation?.exploratory).toBe(false);
    expect(recommendation?.deepLink).toBe('/learn/reading?story=1');
    // Runner-up dimension's best item rides along as the alternative.
    expect(alternatives.map((a) => a.dimension)).toEqual(['listening']);
  });

  it('an insufficient dimension outranks every sufficient one (exploration dominance)', () => {
    const { recommendation } = rank({
      dimensions: [
        // A screaming sufficient signal: far behind, saturated due backlog.
        sufficient('vocab', 1.2, { dueCount: 50, se: 1.2 }),
        sufficient('reading', 5.0),
        insufficient('listening'),
      ],
      candidates: {
        vocab: [item('vocab:card:1', 1.5)],
        reading: [item('reading:story:2', 5.2)],
        listening: [item('listening:iyagi:3', null)],
      },
    });
    expect(recommendation?.dimension).toBe('listening');
    expect(recommendation?.exploratory).toBe(true);
    expect(recommendation?.reasonCode).toBe('exploration');
  });

  it('due backlog flips the winner exactly at DUE_SAT, not below', () => {
    // reading: deficit 0.5·((3.5−2.63)/1.5) = 0.29; vocab: due·0.3/20.
    // Equal se on both sides cancels the uncertainty term in the comparison,
    // so vocab overtakes exactly when 0.3·due/20 > 0.29 → at due = 20 (0.30),
    // not at 19 (0.285).
    const base = (dueCount: number) =>
      rank({
        dimensions: [
          sufficient('reading', 2.63),
          sufficient('vocab', 3.5, { dueCount }),
        ],
        candidates: {
          reading: [item('reading:chapter:1', null)],
          vocab: [item('vocab:card:9', 3.5)],
        },
      });
    expect(base(19).recommendation?.dimension).toBe('reading');
    const flipped = base(20);
    expect(flipped.recommendation?.dimension).toBe('vocab');
    expect(flipped.recommendation?.reasonCode).toBe('due_backlog');
    expect(flipped.recommendation?.reasonEn).toContain('20');
    expect(flipped.recommendation?.reasonKr).toContain('20');
  });

  it('the uncertainty term breaks an otherwise-equal pair toward the shakier estimate', () => {
    const { recommendation } = rank({
      dimensions: [
        sufficient('reading', 3.5, { se: 0.3 }),
        sufficient('grammar', 3.5, { se: 1.2 }),
      ],
      candidates: {
        reading: [item('reading:story:1', 3.9)],
        grammar: [item('grammar:entry:4', 3.9, { deepLink: '/learn/grammar' })],
      },
    });
    expect(recommendation?.dimension).toBe('grammar');
    expect(recommendation?.reasonCode).toBe('low_confidence');
  });

  it('cold start — ALL dimensions insufficient → null even when candidates exist', () => {
    const result = rank({
      dimensions: [
        insufficient('reading'),
        insufficient('listening'),
        insufficient('vocab'),
        insufficient('grammar'),
      ],
      candidates: { reading: [item('reading:story:1', 3.0)] },
    });
    expect(result.recommendation).toBeNull();
    expect(result.alternatives).toEqual([]);
  });

  it('a winning dimension with no candidates is skipped; none anywhere → null', () => {
    const skipped = rank({
      dimensions: [
        sufficient('reading', 1.5), // weakest — but nothing to read
        sufficient('vocab', 4.0),
      ],
      candidates: { reading: [], vocab: [item('vocab:card:2', 4.2)] },
    });
    expect(skipped.recommendation?.dimension).toBe('vocab');
    expect(skipped.alternatives).toEqual([]);

    const empty = rank({
      dimensions: [sufficient('reading', 3.0)],
      candidates: {},
    });
    expect(empty.recommendation).toBeNull();
  });
});

describe('rankRecommendations — Stage B item choice', () => {
  it('targets b* = θ + 0.4: the closest-difficulty item wins', () => {
    const { recommendation } = rank({
      dimensions: [sufficient('vocab', 3.0)],
      candidates: {
        vocab: [
          item('vocab:card:low', 2.0),
          item('vocab:card:target', 3.5), // |3.5 − 3.4| = 0.1 — closest
          item('vocab:card:high', 5.5),
        ],
      },
    });
    expect(recommendation?.title).toBe('vocab:card:target');
  });

  it('NEUTRAL_PROX: an unplaced item beats a far-off placed one, loses to a close one', () => {
    const farVsNull = rank({
      dimensions: [sufficient('reading', 3.0)],
      candidates: {
        reading: [item('reading:story:far', 5.5), item('reading:chapter:1', null)],
      },
    });
    // Proximity(5.5, 3.4) ≈ 0.023 < 0.5 → the null-b chapter wins.
    expect(farVsNull.recommendation?.title).toBe('reading:chapter:1');

    const closeVsNull = rank({
      dimensions: [sufficient('reading', 3.0)],
      candidates: {
        reading: [item('reading:story:close', 3.3), item('reading:chapter:1', null)],
      },
    });
    expect(closeVsNull.recommendation?.title).toBe('reading:story:close');
  });

  it('insufficient exploration probes at b* = 3.5', () => {
    const { recommendation } = rank({
      dimensions: [insufficient('vocab'), sufficient('reading', 5.5)],
      candidates: {
        vocab: [item('vocab:card:probe', 3.5), item('vocab:card:hard', 5.5)],
        reading: [item('reading:story:1', 5.9)],
      },
    });
    expect(recommendation?.dimension).toBe('vocab');
    expect(recommendation?.title).toBe('vocab:card:probe');
  });

  it('equal-score ties resolve by the md5(user‖day‖itemKey) hash — deterministic and seed-sensitive', () => {
    const input = {
      dimensions: [sufficient('vocab', 3.0)],
      candidates: {
        vocab: [item('vocab:card:a', 3.4), item('vocab:card:b', 3.4)], // exact tie
      },
    };
    const first = rank(input);
    const second = rank(input);
    expect(second).toEqual(first); // same (user, day) → same winner
    // A different day may pick either card, but stays internally deterministic.
    const otherDay = rank({ ...input, dayKey: '2026-08-18' });
    expect(otherDay).toEqual(rank({ ...input, dayKey: '2026-08-18' }));
  });

  it('strips the internal itemKey/b fields from the wire Recommendation', () => {
    const { recommendation } = rank({
      dimensions: [sufficient('vocab', 3.0)],
      candidates: { vocab: [item('vocab:card:1', 3.4)] },
    });
    expect(recommendation).not.toHaveProperty('itemKey');
    expect(recommendation).not.toHaveProperty('b');
  });

  it('passes deep-link id fields through (the TodayTask-union contract)', () => {
    const { recommendation } = rank({
      dimensions: [sufficient('listening', 3.0)],
      candidates: {
        listening: [
          item('listening:iyagi:7', null, {
            deepLink: '/learn/listen?corpus=iyagi&episode=7',
            corpus: 'iyagi',
            episodeNumber: 7,
          }),
        ],
      },
    });
    expect(recommendation?.corpus).toBe('iyagi');
    expect(recommendation?.episodeNumber).toBe(7);
  });
});

describe('reason attribution', () => {
  it('reasonCodeFor picks the dominant term with deficit → due → uncertainty tie priority', () => {
    expect(
      reasonCodeFor({ score: 0.5, exploratory: false, terms: { deficit: 0.3, due: 0.1, uncertainty: 0.1 } }),
    ).toBe('weakest_dimension');
    expect(
      reasonCodeFor({ score: 0.5, exploratory: false, terms: { deficit: 0.1, due: 0.3, uncertainty: 0.1 } }),
    ).toBe('due_backlog');
    expect(
      reasonCodeFor({ score: 0.5, exploratory: false, terms: { deficit: 0.1, due: 0.1, uncertainty: 0.3 } }),
    ).toBe('low_confidence');
    // Exact ties resolve in term order.
    expect(
      reasonCodeFor({ score: 0.4, exploratory: false, terms: { deficit: 0.2, due: 0.2, uncertainty: 0.2 } }),
    ).toBe('weakest_dimension');
    // Nothing contributed → an honest baseline, not a fabricated deficit.
    expect(
      reasonCodeFor({ score: 0, exploratory: false, terms: { deficit: 0, due: 0, uncertainty: 0 } }),
    ).toBe('baseline');
    expect(
      reasonCodeFor({ score: 1, exploratory: true, terms: { deficit: 0, due: 0, uncertainty: 0 } }),
    ).toBe('exploration');
  });

  it('composeReason is bilingual and honest per code', () => {
    const backlog = composeReason('due_backlog', 'vocab', 12);
    expect(backlog.reasonEn).toContain('12');
    expect(backlog.reasonKr).toContain('12');
    expect(backlog.reasonEn).toContain('vocabulary');
    expect(backlog.reasonKr).toContain('어휘');

    const explore = composeReason('exploration', 'listening', 0);
    expect(explore.reasonEn.toLowerCase()).not.toContain('weakest');
    expect(explore.reasonEn).toContain('listening');
    expect(explore.reasonKr).toContain('듣기');

    // Never an "optimal path" claim on any code (the honesty bar).
    for (const code of ['weakest_dimension', 'due_backlog', 'low_confidence', 'exploration', 'baseline'] as const) {
      const { reasonEn } = composeReason(code, 'grammar', 3);
      expect(reasonEn.toLowerCase()).not.toContain('optimal');
      expect(reasonEn.toLowerCase()).not.toContain('best path');
    }
  });
});
