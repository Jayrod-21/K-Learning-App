/**
 * useChatContext / useCurrentChatContext — a page publishes its descriptor
 * while mounted; the FAB-side hook tracks the store live. Route-transition
 * ordering (old page's cleanup vs. new page's publish) must never leave the
 * store empty or stale.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { useChatContext, useCurrentChatContext } from './useChatContext';
import { getChatContext, type ChatContext } from '../lib/chatContext';

function Publisher({ descriptor }: { descriptor: ChatContext | null }): null {
  useChatContext(descriptor);
  return null;
}

function Reader(): JSX.Element {
  const ctx = useCurrentChatContext();
  return (
    <div data-testid="current">{ctx === null ? 'none' : ctx.pageLabel}</div>
  );
}

const TODAY: ChatContext = {
  pageLabel: 'Today · 오늘',
  summary: '3 review cards due',
};
const PROGRESS: ChatContext = {
  pageLabel: 'Progress · 성장',
  summary: 'Latest diagnostic: Reading 62%',
};

describe('useChatContext', () => {
  it('publishes on mount and retracts on unmount', () => {
    const { unmount } = render(<Publisher descriptor={TODAY} />);
    expect(getChatContext()).toEqual(TODAY);
    unmount();
    expect(getChatContext()).toBeNull();
  });

  it('publishes nothing for a null descriptor (page still loading)', () => {
    const { unmount } = render(<Publisher descriptor={null} />);
    expect(getChatContext()).toBeNull();
    unmount();
  });

  it('a null → descriptor flip publishes; flipping back retracts', () => {
    const { rerender, unmount } = render(<Publisher descriptor={null} />);
    rerender(<Publisher descriptor={TODAY} />);
    expect(getChatContext()).toEqual(TODAY);
    rerender(<Publisher descriptor={null} />);
    expect(getChatContext()).toBeNull();
    unmount();
  });

  it('field changes re-publish (same hook, new descriptor object each render)', () => {
    const { rerender, unmount } = render(<Publisher descriptor={TODAY} />);
    // Same field VALUES in a fresh object — must not churn the store.
    rerender(<Publisher descriptor={{ ...TODAY }} />);
    expect(getChatContext()).toEqual(TODAY);
    rerender(
      <Publisher descriptor={{ ...TODAY, summary: '0 review cards due' }} />,
    );
    expect(getChatContext()?.summary).toBe('0 review cards due');
    unmount();
  });

  it('the newest publisher wins across an overlap, and an old unmount never clobbers it', () => {
    const a = render(<Publisher descriptor={TODAY} />);
    const b = render(<Publisher descriptor={PROGRESS} />);
    expect(getChatContext()).toEqual(PROGRESS);
    // Old page unmounts AFTER the new one published — token guard holds.
    a.unmount();
    expect(getChatContext()).toEqual(PROGRESS);
    b.unmount();
    expect(getChatContext()).toBeNull();
  });
});

describe('useCurrentChatContext', () => {
  it('tracks publish and retract live', () => {
    render(<Reader />);
    expect(screen.getByTestId('current')).toHaveTextContent('none');

    const publisher = render(<Publisher descriptor={TODAY} />);
    expect(screen.getByTestId('current')).toHaveTextContent('Today · 오늘');

    publisher.unmount();
    expect(screen.getByTestId('current')).toHaveTextContent('none');
  });
});
