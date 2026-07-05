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
  resolveWordPopover,
  tokeniseKorean,
} from './tapChain';

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
