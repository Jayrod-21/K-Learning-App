/**
 * Tests for src/services/voicePalette.ts (F-210 v2 — multi-voice assignment).
 *
 * Pure function, no I/O: assignVoices takes the turns plus an explicit
 * narrator voice id, so nothing here loads config or touches a DB.
 *
 * Coverage:
 *   - distinct male speakers → distinct male-pool voices, in first-appearance
 *     order; same for female
 *   - round-robin wrap-around when speakers outnumber a pool
 *   - the literal 'narrator' speaker, gender 'narrator', and a MISSING gender
 *     all land on the narrator voice
 *   - a speaker's first assignment is stable across all their turns, even
 *     against a later conflicting gender tag
 *   - pools never bleed into each other or into the narrator voice
 */
import { describe, expect, it } from 'vitest';
import type { StoryTurn } from '../../src/services/claude/models.js';
import {
  assignVoices,
  FEMALE_VOICE_POOL,
  MALE_VOICE_POOL,
} from '../../src/services/voicePalette.js';

const NARRATOR = 'narrator-voice-id';

function turn(speaker: string, gender?: 'male' | 'female' | 'narrator'): StoryTurn {
  return { speaker, text: '대사입니다.', ...(gender !== undefined ? { gender } : {}) };
}

describe('assignVoices', () => {
  it('gives two male speakers two DIFFERENT male voices, in appearance order', () => {
    const map = assignVoices(
      [turn('narrator', 'narrator'), turn('민수', 'male'), turn('철수', 'male')],
      NARRATOR,
    );
    expect(map.get('민수')).toBe(MALE_VOICE_POOL[0]);
    expect(map.get('철수')).toBe(MALE_VOICE_POOL[1]);
    expect(map.get('민수')).not.toBe(map.get('철수'));
  });

  it('gives female speakers female-pool voices in appearance order', () => {
    const map = assignVoices([turn('지은', 'female'), turn('미소', 'female')], NARRATOR);
    expect(map.get('지은')).toBe(FEMALE_VOICE_POOL[0]);
    expect(map.get('미소')).toBe(FEMALE_VOICE_POOL[1]);
  });

  it('wraps around when distinct speakers outnumber the male pool', () => {
    const speakers = ['남1', '남2', '남3', '남4', '남5', '남6'];
    const map = assignVoices(
      speakers.map((s) => turn(s, 'male')),
      NARRATOR,
    );
    for (let i = 0; i < speakers.length; i++) {
      expect(map.get(speakers[i]!)).toBe(MALE_VOICE_POOL[i % MALE_VOICE_POOL.length]);
    }
    // 5th and 6th male speakers reuse the first two voices (pool of 4).
    expect(map.get('남5')).toBe(MALE_VOICE_POOL[0]);
    expect(map.get('남6')).toBe(MALE_VOICE_POOL[1]);
  });

  it('wraps around the female pool too (pool of 5)', () => {
    const speakers = ['여1', '여2', '여3', '여4', '여5', '여6'];
    const map = assignVoices(
      speakers.map((s) => turn(s, 'female')),
      NARRATOR,
    );
    expect(map.get('여6')).toBe(FEMALE_VOICE_POOL[0]);
  });

  it("the literal 'narrator' speaker gets the narrator voice regardless of tag", () => {
    // Even a (wrong) gendered tag on a narrator turn must not pull a pool
    // voice — the speaker name wins.
    const map = assignVoices([turn('narrator', 'male')], NARRATOR);
    expect(map.get('narrator')).toBe(NARRATOR);
  });

  it("gender 'narrator' and a MISSING gender both fall back to the narrator voice", () => {
    const map = assignVoices([turn('해설', 'narrator'), turn('구버전 화자')], NARRATOR);
    expect(map.get('해설')).toBe(NARRATOR);
    expect(map.get('구버전 화자')).toBe(NARRATOR);
  });

  it('an untagged speaker does NOT consume a pool slot', () => {
    const map = assignVoices([turn('구버전 화자'), turn('민수', 'male')], NARRATOR);
    expect(map.get('구버전 화자')).toBe(NARRATOR);
    expect(map.get('민수')).toBe(MALE_VOICE_POOL[0]); // pool index unaffected
  });

  it('a speaker keeps their FIRST voice across repeated turns and conflicting tags', () => {
    const map = assignVoices(
      [
        turn('민수', 'male'),
        turn('지은', 'female'),
        turn('민수', 'male'),
        turn('민수', 'female'), // model inconsistency — first assignment sticks
        turn('민수'),
      ],
      NARRATOR,
    );
    expect(map.get('민수')).toBe(MALE_VOICE_POOL[0]);
    expect(map.get('지은')).toBe(FEMALE_VOICE_POOL[0]);
    expect(map.size).toBe(2);
  });

  it('pools are disjoint from each other (a config sanity lock)', () => {
    const all = [...MALE_VOICE_POOL, ...FEMALE_VOICE_POOL];
    expect(new Set(all).size).toBe(all.length);
  });

  it('returns an empty map for an empty script', () => {
    expect(assignVoices([], NARRATOR).size).toBe(0);
  });
});
