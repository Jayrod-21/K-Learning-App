/**
 * askSeed (F-020) — seed-builder + router-state validation tests.
 *
 * Covers section inclusion/omission (explanation / passage / userPick),
 * whitespace hygiene, the passage + overall char caps, and the runtime
 * narrowing of untrusted history state (`readChatSeedState`).
 */
import { describe, it, expect } from 'vitest';
import { buildAskSeed, readChatSeedState } from './askSeed';

const FULL_INPUT = {
  prompt: '이 글의 내용과 같은 것은?',
  correctText: '나 정답',
  explanation: '정답은 나입니다.',
  passage: '한국의 전통 시장은 지역 경제의 중심이다.',
  userPick: '가 오답',
};

describe('buildAskSeed', () => {
  it('includes every section, in reading order, when all fields are present', () => {
    const seed = buildAskSeed(FULL_INPUT);
    expect(seed).toContain('About this TOPIK question:');
    expect(seed).toContain(FULL_INPUT.prompt);
    expect(seed).toContain(`지문: ${FULL_INPUT.passage}`);
    expect(seed).toContain(`Correct answer: ${FULL_INPUT.correctText}`);
    expect(seed).toContain(`My answer: ${FULL_INPUT.userPick} (incorrect)`);
    expect(seed).toContain(`Why: ${FULL_INPUT.explanation}`);
    expect(seed).toContain(
      'Can you explain this further — especially why the other options are wrong?',
    );
    // Reading order: prompt → passage → key → miss → why → follow-up.
    const order = [
      seed.indexOf(FULL_INPUT.prompt),
      seed.indexOf('지문:'),
      seed.indexOf('Correct answer:'),
      seed.indexOf('My answer:'),
      seed.indexOf('Why:'),
      seed.indexOf('Can you explain'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it('omits the passage, userPick, and explanation sections when absent', () => {
    const seed = buildAskSeed({
      prompt: FULL_INPUT.prompt,
      correctText: FULL_INPUT.correctText,
    });
    expect(seed).toContain(FULL_INPUT.prompt);
    expect(seed).toContain(`Correct answer: ${FULL_INPUT.correctText}`);
    expect(seed).not.toContain('지문:');
    expect(seed).not.toContain('My answer:');
    expect(seed).not.toContain('Why:');
  });

  it('treats blank/whitespace-only optional fields as absent', () => {
    const seed = buildAskSeed({
      prompt: FULL_INPUT.prompt,
      correctText: FULL_INPUT.correctText,
      explanation: '   ',
      passage: '',
      userPick: '\n',
    });
    expect(seed).not.toContain('지문:');
    expect(seed).not.toContain('My answer:');
    expect(seed).not.toContain('Why:');
  });

  it('omits the Correct answer line when the correct text is unknown', () => {
    const seed = buildAskSeed({ prompt: FULL_INPUT.prompt, correctText: '' });
    expect(seed).not.toContain('Correct answer:');
    expect(seed).toContain(FULL_INPUT.prompt);
  });

  it('never emits blank-label leftovers or triple newlines from omitted sections', () => {
    const seed = buildAskSeed({
      prompt: FULL_INPUT.prompt,
      correctText: FULL_INPUT.correctText,
    });
    expect(seed).not.toMatch(/\n{3,}/);
  });

  it('truncates an oversized passage with an ellipsis', () => {
    const hugePassage = '가'.repeat(5000);
    const seed = buildAskSeed({
      prompt: FULL_INPUT.prompt,
      correctText: FULL_INPUT.correctText,
      passage: hugePassage,
    });
    expect(seed).toContain('지문: ');
    expect(seed).toContain('…');
    expect(seed).not.toContain(hugePassage);
  });

  it('keeps the whole seed well under the 4000-char message cap', () => {
    const seed = buildAskSeed({
      prompt: '문'.repeat(3000),
      correctText: '답'.repeat(3000),
      explanation: '설'.repeat(3000),
      passage: '지'.repeat(5000),
      userPick: '오'.repeat(3000),
    });
    expect(seed.length).toBeLessThanOrEqual(3200);
    expect(seed.length).toBeLessThan(4000);
  });
});

describe('readChatSeedState', () => {
  it('accepts a well-formed seed state', () => {
    const out = readChatSeedState({ seedText: 'hello', mode: 'topik_prep' });
    expect(out).toEqual({ seedText: 'hello', mode: 'topik_prep' });
  });

  it('accepts a seed without a mode', () => {
    expect(readChatSeedState({ seedText: 'hello' })).toEqual({
      seedText: 'hello',
    });
  });

  it('drops an unrecognised mode instead of forwarding it to the server', () => {
    const out = readChatSeedState({ seedText: 'hello', mode: 'evil_mode' });
    expect(out).toEqual({ seedText: 'hello' });
  });

  it('rejects null, non-objects, and missing/blank/non-string seedText', () => {
    expect(readChatSeedState(null)).toBeNull();
    expect(readChatSeedState(undefined)).toBeNull();
    expect(readChatSeedState('seed')).toBeNull();
    expect(readChatSeedState(42)).toBeNull();
    expect(readChatSeedState({})).toBeNull();
    expect(readChatSeedState({ seedText: 42 })).toBeNull();
    expect(readChatSeedState({ seedText: '   ' })).toBeNull();
  });

  it('clamps a forged oversized seedText to the message cap', () => {
    const out = readChatSeedState({ seedText: 'x'.repeat(100_000) });
    expect(out).not.toBeNull();
    expect(out?.seedText.length).toBeLessThanOrEqual(4000);
  });
});
