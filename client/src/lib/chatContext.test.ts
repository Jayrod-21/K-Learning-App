/**
 * chatContext — store semantics (token-guarded retract), FAB router-state
 * narrowing (untrusted history state), and the Yes-branch seed composer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildChatOpenState,
  buildContextSeed,
  getChatContext,
  publishChatContext,
  readChatOpenState,
  retractChatContext,
  subscribeChatContext,
  type ChatContext,
} from './chatContext';

const CTX: ChatContext = {
  pageLabel: 'Today · 오늘',
  summary: '3 review cards due',
};

describe('chatContext store', () => {
  it('publish → get → retract round-trips', () => {
    expect(getChatContext()).toBeNull();
    const token = publishChatContext(CTX);
    expect(getChatContext()).toEqual(CTX);
    retractChatContext(token);
    expect(getChatContext()).toBeNull();
  });

  it('a stale retract never clobbers a newer publish (token guard)', () => {
    const tokenA = publishChatContext(CTX);
    const ctxB: ChatContext = { pageLabel: 'Progress · 성장', summary: 'x' };
    const tokenB = publishChatContext(ctxB);
    // Page A's unmount cleanup runs AFTER page B already published — the
    // route-transition ordering hazard the token exists for.
    retractChatContext(tokenA);
    expect(getChatContext()).toEqual(ctxB);
    retractChatContext(tokenB);
    expect(getChatContext()).toBeNull();
  });

  it('notifies subscribers on publish and retract, and unsubscribes cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatContext(listener);
    const token = publishChatContext(CTX);
    expect(listener).toHaveBeenCalledTimes(1);
    retractChatContext(token);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    const token2 = publishChatContext(CTX);
    expect(listener).toHaveBeenCalledTimes(2);
    retractChatContext(token2);
  });
});

describe('readChatOpenState (untrusted router state)', () => {
  it('round-trips buildChatOpenState with a context', () => {
    const req = readChatOpenState(buildChatOpenState(CTX));
    expect(req).not.toBeNull();
    expect(req?.context).toEqual(CTX);
  });

  it('round-trips buildChatOpenState without a context', () => {
    const req = readChatOpenState(buildChatOpenState(null));
    expect(req).toEqual({ context: null });
  });

  it('returns null for non-open-request states (incl. F-020 seed shape)', () => {
    expect(readChatOpenState(null)).toBeNull();
    expect(readChatOpenState(undefined)).toBeNull();
    expect(readChatOpenState('kmChatOpen')).toBeNull();
    expect(readChatOpenState({})).toBeNull();
    expect(readChatOpenState({ kmChatOpen: 'true' })).toBeNull();
    // An F-020 ChatSeedState must never be misread as a FAB open request.
    expect(
      readChatOpenState({ seedText: 'About this TOPIK question…' }),
    ).toBeNull();
  });

  it('degrades a malformed context to "no context" instead of rejecting the open', () => {
    expect(
      readChatOpenState({ kmChatOpen: true, context: 'nope' }),
    ).toEqual({ context: null });
    expect(
      readChatOpenState({
        kmChatOpen: true,
        context: { pageLabel: 42, summary: 'x' },
      }),
    ).toEqual({ context: null });
    expect(
      readChatOpenState({
        kmChatOpen: true,
        context: { pageLabel: '  ', summary: 'x' },
      }),
    ).toEqual({ context: null });
  });

  it('clamps oversized fields and drops a non-string seedText', () => {
    const req = readChatOpenState({
      kmChatOpen: true,
      context: {
        pageLabel: `  ${'L'.repeat(500)}  `,
        summary: 'S'.repeat(2000),
        seedText: 12345,
      },
    });
    expect(req?.context).not.toBeNull();
    const ctx = req?.context;
    expect(ctx?.pageLabel.length).toBeLessThanOrEqual(120);
    expect(ctx?.summary.length).toBeLessThanOrEqual(400);
    expect(ctx?.summary.endsWith('…')).toBe(true);
    expect(ctx?.seedText).toBeUndefined();
  });
});

describe('buildContextSeed', () => {
  it('uses a page-authored seedText verbatim when present', () => {
    const seed = buildContextSeed({
      ...CTX,
      seedText: 'Explain the -(으)면 pattern from my Today plan.',
    });
    expect(seed).toBe('Explain the -(으)면 pattern from my Today plan.');
  });

  it('composes an editable wrapper from label + summary otherwise', () => {
    const seed = buildContextSeed(CTX);
    expect(seed).toContain('Today · 오늘');
    expect(seed).toContain('3 review cards due');
    expect(seed).toContain('Can we talk about this?');
  });

  it('truncates a runaway seed under the composer budget', () => {
    const seed = buildContextSeed({
      ...CTX,
      seedText: 'x'.repeat(10_000),
    });
    expect(seed.length).toBeLessThanOrEqual(3200);
    expect(seed.endsWith('…')).toBe(true);
  });
});
