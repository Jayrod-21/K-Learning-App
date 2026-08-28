/**
 * Unit tests for `buildWritingItemRequest` (F-220 P4 writing-item BANK
 * generator) and its input/output Zod schemas.
 *
 * Unlike diagnostic_reading_item.test.ts, this route has NO live proxy
 * method wired (F-220 P4 ships DARK — see writing_item.ts's header) — the
 * builder is called directly by the offline `generate-item-bank.ts` CLI, so
 * these tests exercise the pure builder function + schemas directly, no SDK
 * stub / ClaudeProxy needed.
 *
 * Covers:
 *   - every WritingItemKind builds a request naming that kind's ITEM TYPE in
 *     the system prompt, and every kind produces a DISTINCT system prompt.
 *   - the topic rides the user turn wrapped in <user_input>.
 *   - tool-use is forced (submit_writing_item, tool_choice pinned).
 *   - WritingItemGenInputSchema rejects L1/L2 (writing is TOPIK II only).
 *   - WritingItemGenResultSchema accepts a well-formed per-kind response and
 *     rejects a malformed one (missing prompt, missing rubric, bad rubric
 *     shape, criteria maxScores not summing to rubric.maxScore, and a
 *     rubric whose criteria names don't match its own kind).
 */
import { describe, expect, it } from 'vitest';
import { buildWritingItemRequest } from '../../../../src/services/claude/prompts/writing_item';
import {
  WritingItemGenInputSchema,
  WritingItemGenResultSchema,
  WritingItemKindSchema,
  type WritingItemGenInput,
} from '../../../../src/services/claude/models';

const KINDS = WritingItemKindSchema.options;

function baseInput(kind: (typeof KINDS)[number]): WritingItemGenInput {
  return { kind, targetLevel: 'L4', topic: '환경' };
}

describe('buildWritingItemRequest — request shape', () => {
  it('forces tool-use: submit_writing_item, tool_choice pinned to it', () => {
    for (const kind of KINDS) {
      const req = buildWritingItemRequest(baseInput(kind), 'claude-sonnet-4-6');
      expect(req.tools).toHaveLength(1);
      expect(req.tools![0]!.name).toBe('submit_writing_item');
      expect(req.tool_choice).toEqual({ type: 'tool', name: 'submit_writing_item' });
    }
  });

  it('wraps the bare topic as <user_input> in the user turn, carrying kind + target_level', () => {
    const req = buildWritingItemRequest(baseInput('essay'), 'claude-sonnet-4-6');
    const userBlock = req.messages[0]!.content[0]!;
    const userText = userBlock.type === 'text' ? userBlock.text : '';
    expect(userText).toContain('<user_input>');
    expect(userText).toContain('"kind":"essay"');
    expect(userText).toContain('"target_level":"L4"');
    expect(userText).toContain('"topic":"환경"');
  });

  it('every WritingItemKind names ITEM TYPE = <kind> in the system prompt', () => {
    for (const kind of KINDS) {
      const req = buildWritingItemRequest(baseInput(kind), 'claude-sonnet-4-6');
      const block = req.system![0]!;
      const systemText = block.type === 'text' ? block.text : '';
      expect(systemText).toContain(`ITEM TYPE = ${kind}`);
    }
  });

  it('every WritingItemKind produces a DISTINCT system prompt (never silently reuses another kind\'s rule)', () => {
    const texts = new Set(
      KINDS.map((kind) => {
        const req = buildWritingItemRequest(baseInput(kind), 'claude-sonnet-4-6');
        const block = req.system![0]!;
        return block.type === 'text' ? block.text : '';
      }),
    );
    expect(texts.size).toBe(KINDS.length);
  });

  it('short-answer-blanks instructs TWO labeled blanks (㉠/㉡) and a required modelAnswer', () => {
    const req = buildWritingItemRequest(baseInput('short-answer-blanks'), 'claude-sonnet-4-6');
    const block = req.system![0]!;
    const systemText = block.type === 'text' ? block.text : '';
    expect(systemText).toContain('㉠');
    expect(systemText).toContain('㉡');
    expect(systemText).toContain('"modelAnswer" MUST');
    expect(systemText).toContain('Do NOT include "minWords"/"maxWords"');
  });

  it('chart-description instructs SYNTHETIC/invented statistics and a 200-300자 band', () => {
    const req = buildWritingItemRequest(baseInput('chart-description'), 'claude-sonnet-4-6');
    const block = req.system![0]!;
    const systemText = block.type === 'text' ? block.text : '';
    expect(systemText).toContain('INVENT a SYNTHETIC statistic');
    expect(systemText).toContain('NEVER a real reported figure');
    expect(systemText).toContain('"minWords"=200');
    expect(systemText).toContain('"maxWords"=300');
  });

  it('essay instructs an INVENTED debate prompt, no stimulus, and a 600-700자 band', () => {
    const req = buildWritingItemRequest(baseInput('essay'), 'claude-sonnet-4-6');
    const block = req.system![0]!;
    const systemText = block.type === 'text' ? block.text : '';
    expect(systemText).toContain('INVENT an ORIGINAL argumentative');
    expect(systemText).toContain('Do NOT include "stimulus"');
    expect(systemText).toContain('"minWords"=600');
    expect(systemText).toContain('"maxWords"=700');
  });
});

describe('WritingItemGenInputSchema — TOPIK II only', () => {
  it('accepts L3/L4/L5+', () => {
    for (const targetLevel of ['L3', 'L4', 'L5+'] as const) {
      const parsed = WritingItemGenInputSchema.safeParse({
        kind: 'essay',
        targetLevel,
        topic: '건강',
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects L1/L2 (writing has no TOPIK I form)', () => {
    for (const targetLevel of ['L1', 'L2']) {
      const parsed = WritingItemGenInputSchema.safeParse({
        kind: 'essay',
        targetLevel,
        topic: '건강',
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects an unrecognized kind', () => {
    const parsed = WritingItemGenInputSchema.safeParse({
      kind: 'not-a-real-kind',
      targetLevel: 'L4',
      topic: '건강',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('WritingItemGenResultSchema — per-kind shape', () => {
  const GOOD_RUBRIC = {
    kind: 'essay',
    maxScore: 50,
    criteria: [
      { name: 'content', maxScore: 20, descriptor: 'addresses the prompt' },
      { name: 'organization', maxScore: 20, descriptor: 'clear structure' },
      { name: 'languageUse', maxScore: 10, descriptor: 'accurate grammar' },
    ],
  };

  it('accepts a well-formed essay response (no stimulus/modelAnswer, minWords/maxWords present)', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: '다음 주제에 대해 자신의 의견을 쓰십시오.',
      rubric: GOOD_RUBRIC,
      minWords: 600,
      maxWords: 700,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a well-formed short-answer-blanks response (stimulus + modelAnswer present)', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: '다음을 읽고 ㉠과 ㉡에 들어갈 말을 각각 쓰십시오.',
      stimulus: '안녕하세요. ( ㉠ ) 회의 시간이 변경되었습니다. ( ㉡ ).',
      rubric: {
        kind: 'short-answer-blanks',
        maxScore: 10,
        criteria: [
          { name: 'blank1', maxScore: 5, descriptor: '문법적으로, 의미상으로 적절함' },
          { name: 'blank2', maxScore: 5, descriptor: '문법적으로, 의미상으로 적절함' },
        ],
      },
      modelAnswer: '㉠: 알려 드립니다 / ㉡: 참고 부탁드립니다',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a response missing prompt', () => {
    const parsed = WritingItemGenResultSchema.safeParse({ rubric: GOOD_RUBRIC });
    expect(parsed.success).toBe(false);
  });

  it('rejects a response missing rubric', () => {
    const parsed = WritingItemGenResultSchema.safeParse({ prompt: 'p' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a rubric with no criteria', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: 'p',
      rubric: { kind: 'essay', maxScore: 50, criteria: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a rubric criterion missing a descriptor', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: 'p',
      rubric: {
        kind: 'essay',
        maxScore: 50,
        criteria: [{ name: 'content', maxScore: 50 }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a rubric whose criteria maxScores do not sum to rubric.maxScore', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: 'p',
      rubric: {
        ...GOOD_RUBRIC,
        // content 20 + organization 20 + languageUse 10 = 50, but maxScore
        // claims 60 — a miscounted/malformed rubric.
        maxScore: 60,
      },
      minWords: 600,
      maxWords: 700,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an essay rubric whose criteria are under-total by construction (dropped criterion)', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: 'p',
      rubric: {
        kind: 'essay',
        maxScore: 50,
        criteria: [
          { name: 'content', maxScore: 20, descriptor: 'addresses the prompt' },
          { name: 'organization', maxScore: 20, descriptor: 'clear structure' },
          // languageUse dropped — criteria now sum to 40, not 50.
        ],
      },
      minWords: 600,
      maxWords: 700,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a rubric whose criteria names do not match its kind (cross-kind mix-up)', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: 'p',
      rubric: {
        kind: 'essay',
        maxScore: 10,
        // These are short-answer-blanks' criteria names, not essay's.
        criteria: [
          { name: 'blank1', maxScore: 5, descriptor: 'mock' },
          { name: 'blank2', maxScore: 5, descriptor: 'mock' },
        ],
      },
      minWords: 600,
      maxWords: 700,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a short-answer-blanks rubric missing one of the two required criteria', () => {
    const parsed = WritingItemGenResultSchema.safeParse({
      prompt: '다음을 읽고 ㉠과 ㉡에 들어갈 말을 각각 쓰십시오.',
      stimulus: '안녕하세요. ( ㉠ ) 회의 시간이 변경되었습니다. ( ㉡ ).',
      rubric: {
        kind: 'short-answer-blanks',
        maxScore: 5,
        criteria: [{ name: 'blank1', maxScore: 5, descriptor: '문법적으로 적절함' }],
      },
      modelAnswer: '㉠: 알려 드립니다 / ㉡: 참고 부탁드립니다',
    });
    expect(parsed.success).toBe(false);
  });
});
