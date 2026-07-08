/**
 * useChatContext — the two React faces of the chat-context store (chat
 * rework Slice 3).
 *
 *   - `useChatContext(descriptor)` — a page calls this to publish "what I'm
 *     showing" while it is mounted. Pass `null` while the page has nothing
 *     to offer yet (loading, browse view) — publishing is skipped and any
 *     earlier publish from this mount is retracted. The effect depends on
 *     the descriptor's FIELDS (not its object identity), so pages may build
 *     the descriptor inline per render without re-publish churn.
 *
 *   - `useCurrentChatContext()` — the Shell-level ChatFab reads the current
 *     page's descriptor via `useSyncExternalStore`, so a route change that
 *     swaps the publishing page re-renders the FAB with the fresh context.
 *
 * The store itself lives in `lib/chatContext` (see its header for the
 * token-guarded retract semantics that make out-of-order unmount cleanups
 * safe).
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  getChatContext,
  publishChatContext,
  retractChatContext,
  subscribeChatContext,
  type ChatContext,
} from '../lib/chatContext';

/** Publish `descriptor` to the chat-context store while mounted. */
export function useChatContext(descriptor: ChatContext | null): void {
  const pageLabel = descriptor?.pageLabel ?? null;
  const summary = descriptor?.summary ?? null;
  const seedText = descriptor?.seedText;

  useEffect(() => {
    if (pageLabel === null || pageLabel.trim() === '') return;
    if (summary === null || summary.trim() === '') return;
    const token = publishChatContext({
      pageLabel,
      summary,
      ...(seedText !== undefined ? { seedText } : {}),
    });
    return () => {
      retractChatContext(token);
    };
  }, [pageLabel, summary, seedText]);
}

/** The currently-published page descriptor, or null. */
export function useCurrentChatContext(): ChatContext | null {
  return useSyncExternalStore(
    subscribeChatContext,
    getChatContext,
    // Server snapshot (unused — the app is client-rendered, but the
    // signature demands it and null is the honest "nothing published").
    () => null,
  );
}
