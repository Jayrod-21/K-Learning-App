/**
 * tapChain — tokeniser boundaries, popover fold-down fallbacks, and the
 * abort contract of the slow-path chain (the pieces Reading/Ttmik page
 * tests exercise only indirectly).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lemmatize } from '../services/lemmatize';
import { defineEntry } from '../services/define';
import { enrich } from '../services/enrich';
import {
  GLOSS_UNAVAILABLE,
  buildWordPopover,
  isPlaceholderGloss,
  resolveBasePopover,
  resolveEnrichment,
  resolveWordPopover,
  tokeniseKorean,
} from './tapChain';
import type { DefineResult, EnrichResult } from '../types/domain';

vi.mock('../services/lemmatize', () => ({ lemmatize: vi.fn() }));
vi.mock('../services/define', () => ({ defineEntry: vi.fn() }));
vi.mock('../services/enrich', () => ({ enrich: vi.fn() }));

beforeEach(() => {
  vi.mocked(lemmatize).mockReset();
  vi.mocked(defineEntry).mockReset();
  vi.mocked(enrich).mockReset();
});

describe('tokeniseKorean', () => {
  it('splits on eojeol boundaries, keeping spaces as bare tokens', () => {
    const tokens = tokeniseKorean('재택근무 합니다.');
    expect(tokens.map((t) => t.w)).toEqual(['재택근무', ' ', '합니다.']);
    // Words carry a placeholder gloss (tap surface); spaces do not.
    expect(tokens[0]?.gloss).toBeDefined();
    expect(tokens[1]?.gloss).toBeUndefined();
    expect(tokens[2]?.gloss).toBeDefined();
    expect(isPlaceholderGloss(tokens[0]!.gloss!)).toBe(true);
  });

  it('returns no tokens for an empty string', () => {
    expect(tokeniseKorean('')).toEqual([]);
  });
});

describe('buildWordPopover', () => {
  it('falls back to the fixed unavailable literal when both sources are empty', () => {
    const pop = buildWordPopover('먹다', null, null);
    expect(pop.kr).toBe('먹다');
    expect(pop.en).toBe(GLOSS_UNAVAILABLE);
    expect(pop.krdictEntryId).toBeUndefined();
  });
});

/** A realistic `/define` envelope for the staged-chain tests (F-209). */
const DEFINE_먹다: DefineResult = {
  word: '먹다',
  entries: [
    {
      id: 42,
      headword: '먹다',
      part_of_speech: 'v.',
      definition_korean: '음식을 입에 넣고 삼키다.',
      definition_english: 'to eat',
      examples: [{ korean: '밥을 먹다', english: 'to eat a meal' }],
    },
  ],
};

/** A realistic `/enrich` envelope (inner shape owned by B4's schema). */
const ENRICH_먹다: EnrichResult = {
  result: {
    nuance: 'Neutral everyday register.',
    usageNote: '드시다 is the honorific.',
    examples: [{ korean: '같이 먹어요', english: 'Let’s eat together' }],
    dontConfuseWith: [{ lemma: '마시다', distinction: 'to drink' }],
    proficiency: 'beginner',
  },
};

describe('resolveBasePopover — stage 1 (F-209)', () => {
  it('resolves the KRDICT popover without ever calling enrich', async () => {
    const ctrl = new AbortController();
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '먹어요', lemma: '먹다', tag: 'VV', start: 0, length: 3 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue(DEFINE_먹다);

    const base = await resolveBasePopover('먹어요', ctrl.signal);

    expect(vi.mocked(enrich)).not.toHaveBeenCalled();
    expect(base).not.toBeNull();
    expect(base?.lemma).toBe('먹다');
    expect(base?.defineResult).toBe(DEFINE_먹다);
    // The popover is fully paintable off KRDICT alone.
    expect(base?.popover.kr).toBe('먹다');
    expect(base?.popover.en).toBe('to eat');
    expect(base?.popover.pos).toBe('v.');
    expect(base?.popover.krdictEntryId).toBe(42);
    expect(base?.popover.ex_kr).toBe('밥을 먹다');
    // No enrichment fields yet.
    expect(base?.popover.notes).toBeUndefined();
    expect(base?.popover.contrast).toBeUndefined();
  });

  it('resolves null and skips define when aborted during lemmatize', async () => {
    const ctrl = new AbortController();
    vi.mocked(lemmatize).mockImplementation(async () => {
      ctrl.abort();
      return [{ form: '먹다', lemma: '먹다', tag: 'VV', start: 0, length: 2 }];
    });

    const base = await resolveBasePopover('먹다', ctrl.signal);

    expect(base).toBeNull();
    expect(vi.mocked(defineEntry)).not.toHaveBeenCalled();
  });
});

describe('resolveEnrichment — stage 2 (F-209)', () => {
  it('returns the envelope and threads the signal into the call', async () => {
    const ctrl = new AbortController();
    vi.mocked(enrich).mockResolvedValue(ENRICH_먹다);

    const result = await resolveEnrichment('먹다', '먹다 좋아요.', ctrl.signal);

    expect(vi.mocked(enrich)).toHaveBeenCalledWith(
      { lemma: '먹다', sourceSentence: '먹다 좋아요.' },
      ctrl.signal,
    );
    expect(result).toBe(ENRICH_먹다);
  });

  it('degrades to null on enrich failure — never rejects', async () => {
    const ctrl = new AbortController();
    vi.mocked(enrich).mockRejectedValue(new Error('claude timeout'));

    await expect(
      resolveEnrichment('먹다', '먹다 좋아요.', ctrl.signal),
    ).resolves.toBeNull();
  });

  it('returns null without calling enrich when already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      resolveEnrichment('먹다', '먹다 좋아요.', ctrl.signal),
    ).resolves.toBeNull();
    expect(vi.mocked(enrich)).not.toHaveBeenCalled();
  });

  it('returns null when the signal aborts while enrich is in flight', async () => {
    const ctrl = new AbortController();
    vi.mocked(enrich).mockImplementation(async () => {
      ctrl.abort();
      return ENRICH_먹다;
    });

    await expect(
      resolveEnrichment('먹다', '먹다 좋아요.', ctrl.signal),
    ).resolves.toBeNull();
  });
});

describe('staged merge parity (F-209)', () => {
  it('base popover + late enrichment folds to the same popover the one-shot chain produces', async () => {
    const ctrl = new AbortController();
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '먹다', lemma: '먹다', tag: 'VV', start: 0, length: 2 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue(DEFINE_먹다);
    vi.mocked(enrich).mockResolvedValue(ENRICH_먹다);

    const oneShot = await resolveWordPopover('먹다', '먹다 좋아요.', ctrl.signal);
    const base = await resolveBasePopover('먹다', ctrl.signal);
    const enrichment = await resolveEnrichment('먹다', '먹다 좋아요.', ctrl.signal);
    const merged = buildWordPopover(base!.lemma, base!.defineResult, enrichment);

    expect(merged).toEqual(oneShot);
    // And the merged popover actually carries the enrichment payload.
    expect(merged.notes).toBe('드시다 is the honorific.');
    expect(merged.contrast).toBe('마시다 — to drink');
    expect(merged.extra).toEqual([{ kr: '같이 먹어요', en: 'Let’s eat together' }]);
  });
});

describe('resolveWordPopover — abort contract', () => {
  it('resolves null and skips the rest of the chain when aborted mid-flight', async () => {
    const ctrl = new AbortController();
    // lemmatize resolves, but the user closed the popover while it ran.
    vi.mocked(lemmatize).mockImplementation(async () => {
      ctrl.abort();
      return [{ form: '먹다', lemma: '먹다', tag: 'VV', start: 0, length: 2 }];
    });

    const result = await resolveWordPopover('먹다', '먹다 좋아요.', ctrl.signal);

    expect(result).toBeNull();
    expect(vi.mocked(defineEntry)).not.toHaveBeenCalled();
    expect(vi.mocked(enrich)).not.toHaveBeenCalled();
  });

  it('threads the signal into every service call', async () => {
    const ctrl = new AbortController();
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '먹다', lemma: '먹다', tag: 'VV', start: 0, length: 2 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue({ word: '먹다', entries: [] });
    vi.mocked(enrich).mockRejectedValue(new Error('claude timeout'));

    const result = await resolveWordPopover('먹다', '먹다 좋아요.', ctrl.signal);

    expect(vi.mocked(lemmatize)).toHaveBeenCalledWith('먹다', ctrl.signal);
    expect(vi.mocked(defineEntry)).toHaveBeenCalledWith('먹다', ctrl.signal);
    expect(vi.mocked(enrich)).toHaveBeenCalledWith(
      { lemma: '먹다', sourceSentence: '먹다 좋아요.' },
      ctrl.signal,
    );
    // Enrich failure is non-fatal — the popover still resolves.
    expect(result).not.toBeNull();
    expect(result?.en).toBe(GLOSS_UNAVAILABLE);
  });
});
