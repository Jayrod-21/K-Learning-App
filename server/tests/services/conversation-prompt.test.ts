import { describe, it, expect } from 'vitest';

import { buildConversationRequest } from '../../src/services/claude/prompts/conversation.js';
import { ConversationInputSchema } from '../../src/services/claude/models.js';

/**
 * Regression for the chat 400 (B-010 follow-up): Anthropic processes
 * `cache_control` blocks in the order tools → system → messages and rejects a
 * `ttl:'1h'` block that appears AFTER a `ttl:'5m'` block. The conversation
 * system block previously defaulted to 5m while the scenario block is 1h, so
 * every chat request 400'd — and no test caught it. These pin the invariant.
 */
describe('buildConversationRequest — cache_control TTL ordering', () => {
  const input = ConversationInputSchema.parse({
    scenario: 'ordering coffee at a cafe',
    registerTarget: '해요체',
  });

  /** Every cache_control TTL in Anthropic's processing order (system, then messages). */
  function ttlsInProcessingOrder(): Array<'5m' | '1h'> {
    const req = buildConversationRequest(input, 'claude-sonnet-4-6');
    const blocks = [...(req.system ?? []), ...req.messages.flatMap((m) => m.content)];
    return blocks
      .map((b) => (b as { cache_control?: { ttl?: '5m' | '1h' } }).cache_control)
      .filter((cc): cc is { ttl?: '5m' | '1h' } => Boolean(cc))
      // A cache_control block with no explicit ttl defaults to 5m.
      .map((cc) => cc.ttl ?? '5m');
  }

  it('caches the system prompt for 1h', () => {
    const req = buildConversationRequest(input, 'claude-sonnet-4-6');
    const cc = (req.system?.[0] as { cache_control?: { ttl?: string } } | undefined)
      ?.cache_control;
    expect(cc?.ttl).toBe('1h');
  });

  it('never places a 1h cache_control block after a 5m one (Anthropic 400)', () => {
    const ttls = ttlsInProcessingOrder();
    let seen5m = false;
    for (const ttl of ttls) {
      if (ttl === '5m') seen5m = true;
      expect(ttl === '1h' && seen5m).toBe(false);
    }
  });
});
