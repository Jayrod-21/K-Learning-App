/**
 * Unit tests for src/services/cloze.ts (F-208) — pure span-finding + grading
 * helpers, exercised with a canned lemmatizer (no network, no DB).
 *
 * The load-bearing case: the entry headword is a LEMMA (먹다) while the
 * sentence carries a CONJUGATED surface (먹었어요) — the span finder must match
 * on token.lemma and blank the SURFACE span, never string-match the lemma
 * against the raw sentence.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BLANK_MARKER,
  answerMatchesLemma,
  blankSentence,
  buildClozePrompt,
  clozeHint,
  normalizeAnswer,
  type ClozeToken,
} from '../../src/services/cloze.js';

/** Canned lemmatizer over a fixed token list. */
function fakeLemmatize(tokens: ClozeToken[]) {
  return vi.fn(async (_text: string) => ({ tokens }));
}

/** Token helper — offsets must be REAL UTF-16 offsets into the test sentence. */
function tok(surface: string, lemma: string, pos: string, start: number): ClozeToken {
  return { surface, lemma, pos, start, end: start + surface.length };
}

describe('buildClozePrompt — span finding', () => {
  // '저는 매일 밥을 먹었어요.' — 먹었어요 occupies [9, 13).
  const SENTENCE = '저는 매일 밥을 먹었어요.';
  const TOKENS: ClozeToken[] = [
    tok('저', '저', 'NP', 0),
    tok('는', '는', 'JX', 1),
    tok('매일', '매일', 'MAG', 3),
    tok('밥', '밥', 'NNG', 6),
    tok('을', '을', 'JKO', 7),
    tok('먹었어요', '먹다', 'VV', 9),
    tok('.', '.', 'SF', 13),
  ];

  it('matches on LEMMA and blanks the conjugated SURFACE span', async () => {
    const lemmatize = fakeLemmatize(TOKENS);
    const draft = await buildClozePrompt(
      { korean: '먹다', sentence: SENTENCE, english: 'I eat rice every day.' },
      lemmatize,
    );
    expect(draft).toEqual({
      korean: SENTENCE,
      english: 'I eat rice every day.',
      blankStart: 9,
      blankEnd: 13,
      answerSurface: '먹었어요',
    });
    // Sanity: the blanked span really is the conjugated form, not the lemma.
    expect(SENTENCE.slice(9, 13)).toBe('먹었어요');
    expect(lemmatize).toHaveBeenCalledWith(SENTENCE);
  });

  it('returns null when no token lemma matches the headword', async () => {
    const draft = await buildClozePrompt(
      { korean: '마시다', sentence: SENTENCE },
      fakeLemmatize(TOKENS),
    );
    expect(draft).toBeNull();
  });

  it('a lemma that appears as a raw substring but not as a token does NOT match', async () => {
    // '먹다' appears verbatim inside '먹다가' in this sentence, but the only
    // token carries lemma '먹다가' — a naive string match would blank wrongly;
    // the lemma match correctly yields null.
    const s = '먹다가 잠들었어요.';
    const tokens = [tok('먹다가', '먹다가', 'MAG', 0)];
    const draft = await buildClozePrompt({ korean: '먹다', sentence: s }, fakeLemmatize(tokens));
    expect(draft).toBeNull();
  });

  it('blanks the FIRST occurrence when the lemma appears twice', async () => {
    // '먹고 또 먹었어요.' — 먹고 [0,2), 먹었어요 [5,9).
    const s = '먹고 또 먹었어요.';
    const tokens = [
      tok('먹고', '먹다', 'VV', 0),
      tok('또', '또', 'MAG', 3),
      tok('먹었어요', '먹다', 'VV', 5),
      tok('.', '.', 'SF', 9),
    ];
    const draft = await buildClozePrompt({ korean: '먹다', sentence: s }, fakeLemmatize(tokens));
    expect(draft?.blankStart).toBe(0);
    expect(draft?.blankEnd).toBe(2);
    expect(draft?.answerSurface).toBe('먹고');
  });

  it('skips a matching token whose offsets do not reproduce its surface (drift guard), and falls through to a later valid one', async () => {
    const s = '먹고 또 먹었어요.';
    const tokens = [
      // Drifted: claims 먹고 at [1,3) where the sentence has '고 '.
      { surface: '먹고', lemma: '먹다', pos: 'VV', start: 1, end: 3 },
      tok('먹었어요', '먹다', 'VV', 5),
    ];
    const draft = await buildClozePrompt({ korean: '먹다', sentence: s }, fakeLemmatize(tokens));
    expect(draft?.answerSurface).toBe('먹었어요');
    expect(draft?.blankStart).toBe(5);
  });

  it('returns null when every matching token has out-of-bounds offsets', async () => {
    const s = '밥을 먹었어요.';
    const tokens = [{ surface: '먹었어요', lemma: '먹다', pos: 'VV', start: 3, end: 99 }];
    const draft = await buildClozePrompt({ korean: '먹다', sentence: s }, fakeLemmatize(tokens));
    expect(draft).toBeNull();
  });

  it('returns null (without calling the lemmatizer) for an empty headword, empty sentence, or an over-long sentence', async () => {
    const lemmatize = fakeLemmatize(TOKENS);
    expect(await buildClozePrompt({ korean: '  ', sentence: SENTENCE }, lemmatize)).toBeNull();
    expect(await buildClozePrompt({ korean: '먹다', sentence: '   ' }, lemmatize)).toBeNull();
    expect(
      await buildClozePrompt({ korean: '먹다', sentence: '가'.repeat(2001) }, lemmatize),
    ).toBeNull();
    expect(lemmatize).not.toHaveBeenCalled();
  });

  it('normalizes NFD input to NFC before matching (IME/corpus encoding drift)', async () => {
    // NFD 먹다 (decomposed jamo) must still match tokens carrying NFC lemmas.
    const nfdHeadword = '먹다'.normalize('NFD');
    expect(nfdHeadword).not.toBe('먹다'); // sanity: really decomposed
    const draft = await buildClozePrompt(
      { korean: nfdHeadword, sentence: SENTENCE },
      fakeLemmatize(TOKENS),
    );
    expect(draft?.answerSurface).toBe('먹었어요');
  });

  it('maps a blank/whitespace english to null', async () => {
    const draft = await buildClozePrompt(
      { korean: '먹다', sentence: SENTENCE, english: '   ' },
      fakeLemmatize(TOKENS),
    );
    expect(draft?.english).toBeNull();
  });
});

describe('blankSentence', () => {
  it('replaces [start, end) with the marker', () => {
    expect(blankSentence('저는 매일 밥을 먹었어요.', 9, 13)).toBe(
      `저는 매일 밥을 ${BLANK_MARKER}.`,
    );
  });

  it('handles a span at the very start and very end', () => {
    expect(blankSentence('먹었어요 우리', 0, 4)).toBe(`${BLANK_MARKER} 우리`);
    expect(blankSentence('우리 먹었어요', 3, 7)).toBe(`우리 ${BLANK_MARKER}`);
  });
});

describe('answerMatchesLemma', () => {
  it('accepts a DIFFERENT valid conjugation (lemma tolerance)', () => {
    // Learner typed 먹는다 for a sentence that had 먹었어요.
    const tokens = [tok('먹는다', '먹다', 'VV', 0)];
    expect(answerMatchesLemma(tokens, '먹다')).toBe(true);
  });

  it('accepts when the match is one of several tokens (stem + ending split, trailing punctuation)', () => {
    const tokens = [
      tok('먹', '먹다', 'VV', 0),
      tok('어요', '어요', 'EF', 1),
      tok('.', '.', 'SF', 3),
    ];
    expect(answerMatchesLemma(tokens, '먹다')).toBe(true);
  });

  it('rejects a different word', () => {
    const tokens = [tok('마셔요', '마시다', 'VV', 0)];
    expect(answerMatchesLemma(tokens, '먹다')).toBe(false);
  });

  it('rejects an empty headword (never vacuously matches)', () => {
    expect(answerMatchesLemma([tok('먹다', '먹다', 'VV', 0)], '  ')).toBe(false);
  });
});

describe('normalizeAnswer / clozeHint', () => {
  it('normalizeAnswer trims and NFC-normalizes', () => {
    expect(normalizeAnswer('  먹었어요 ')).toBe('먹었어요');
    expect(normalizeAnswer('먹었어요'.normalize('NFD'))).toBe('먹었어요');
  });

  it('clozeHint reveals ONLY first syllable + character count', () => {
    expect(clozeHint('먹었어요')).toEqual({ firstChar: '먹', length: 4 });
    expect(clozeHint('가')).toEqual({ firstChar: '가', length: 1 });
    expect(clozeHint('')).toEqual({ firstChar: '', length: 0 });
  });
});
