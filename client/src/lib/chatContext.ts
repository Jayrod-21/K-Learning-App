/**
 * chatContext — the generic per-page "discuss this page?" context (chat
 * rework Slice 3).
 *
 * Three cooperating pieces, all in this module so the contract lives in one
 * place:
 *
 *   1. **`ChatContext`** — a lightweight descriptor of "what this page is
 *      showing" that any page may publish (Today's plan, a TOPIK item, the
 *      open Ttmik episode…). Generic on purpose: F-020's TOPIK-shaped
 *      `buildAskSeed` remains one *producer* of seed text; this shape is the
 *      page-agnostic envelope the FAB hands to Chat.
 *
 *   2. **A module-level context store** with a subscribe API. Pages publish
 *      their descriptor via the `useChatContext` hook (hooks/useChatContext);
 *      the Shell-level ChatFab reads the current one via
 *      `useSyncExternalStore`. A plain external store (not React context)
 *      keeps the publish path free of set-state-in-effect and needs no
 *      provider threading between the Shell and every routed page.
 *      Publishing is token-based so an out-of-order cleanup (page A's
 *      unmount cleanup running after page B already published) can never
 *      clobber the newer page's descriptor.
 *
 *   3. **Router-state helpers** for the FAB → `/chat` hand-off
 *      (`buildChatOpenState` / `readChatOpenState`) plus the Yes-branch seed
 *      composer (`buildContextSeed`).
 *
 * Threat model (mirrors askSeed.ts):
 *   - **Untrusted router state.** `history.state` is writable by any script
 *     and survives reloads, so Chat runtime-narrows the unknown into a
 *     `ChatOpenRequest` (or null) and clamps every string to a hard budget —
 *     a forged state can never overflow the composer or the popup.
 *   - **No injection surface.** Every field renders as a React text node or
 *     a `<textarea>` value — never HTML.
 */

/** A page's "what I'm showing right now" descriptor. */
export interface ChatContext {
  /** Short page name for the popup's FROM line (e.g. "Today · 오늘"). */
  pageLabel: string;
  /** One-line summary of the page's current content. */
  summary: string;
  /**
   * Optional page-authored seed message for the Yes branch. When absent,
   * `buildContextSeed` composes one from `pageLabel` + `summary`.
   */
  seedText?: string;
}

/** Server-side cap on one chat message — matches askSeed.ts. */
const MESSAGE_CHAR_CAP = 4000;
/** Seed budget below the cap so the user keeps edit headroom. */
const SEED_CHAR_BUDGET = 3200;
/** Popup display fields stay short — they render in a small dialog. */
const LABEL_CHAR_CAP = 120;
const SUMMARY_CHAR_CAP = 400;

/** Hard truncation with a single-char ellipsis; no-op when under `max`. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// ─── Context store (pages write, the FAB reads) ─────────────────────────

/** One published entry — the token IS the entry object (identity compare). */
interface PublishedEntry {
  context: ChatContext;
}

let current: PublishedEntry | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Publish a page's descriptor. Returns an opaque token the caller passes to
 * `retractChatContext` on unmount. A later publish simply replaces an
 * earlier one (last mount wins — matches route-transition commit order,
 * where the outgoing page's cleanup runs before the incoming page's effect).
 */
export function publishChatContext(context: ChatContext): object {
  const entry: PublishedEntry = { context };
  current = entry;
  notify();
  return entry;
}

/**
 * Retract a previously-published descriptor. Token-guarded: if a NEWER page
 * already published (so `current` is no longer this token), the retract is
 * a no-op — an out-of-order cleanup can never clobber the live descriptor.
 */
export function retractChatContext(token: object): void {
  if (current !== token) return;
  current = null;
  notify();
}

/** Current descriptor, or null when no page has one published. */
export function getChatContext(): ChatContext | null {
  return current?.context ?? null;
}

/** Subscribe to store changes — `useSyncExternalStore` contract. */
export function subscribeChatContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ─── FAB → /chat router-state hand-off ──────────────────────────────────

/**
 * The router state a FAB tap carries to `/chat`. `kmChatOpen` is the
 * discriminator (an F-020 `ChatSeedState` has no such field, so the two
 * producers can never be confused on read). `context` is absent when the
 * current page published nothing — Chat then skips the popup and goes
 * straight to the "what would you like to chat about?" opener.
 */
export interface ChatOpenState {
  kmChatOpen: true;
  context?: ChatContext;
}

/** What Chat actually consumes after narrowing. */
export interface ChatOpenRequest {
  context: ChatContext | null;
}

/** Build the navigation state for a FAB tap. */
export function buildChatOpenState(context: ChatContext | null): ChatOpenState {
  return context === null
    ? { kmChatOpen: true }
    : { kmChatOpen: true, context };
}

/**
 * Runtime-narrow untrusted router state into a `ChatOpenRequest`, or null
 * when the state is not a FAB open request. Every string is type-checked and
 * clamped; a malformed `context` degrades to "no context" (the popup is an
 * enhancement — a broken payload must not block opening the chat).
 */
export function readChatOpenState(state: unknown): ChatOpenRequest | null {
  if (typeof state !== 'object' || state === null) return null;
  const rec = state as Record<string, unknown>;
  if (rec['kmChatOpen'] !== true) return null;

  const raw = rec['context'];
  if (typeof raw !== 'object' || raw === null) return { context: null };
  const ctx = raw as Record<string, unknown>;
  const pageLabel = ctx['pageLabel'];
  const summary = ctx['summary'];
  if (
    typeof pageLabel !== 'string' ||
    pageLabel.trim() === '' ||
    typeof summary !== 'string' ||
    summary.trim() === ''
  ) {
    return { context: null };
  }
  const out: ChatContext = {
    pageLabel: truncate(pageLabel.trim(), LABEL_CHAR_CAP),
    summary: truncate(summary.trim(), SUMMARY_CHAR_CAP),
  };
  const seedText = ctx['seedText'];
  if (typeof seedText === 'string' && seedText.trim() !== '') {
    out.seedText = truncate(seedText, MESSAGE_CHAR_CAP);
  }
  return { context: out };
}

// ─── Yes-branch seed composer ────────────────────────────────────────────

/**
 * Compose the composer pre-fill for the popup's Yes branch. A page-authored
 * `seedText` wins verbatim (clamped); otherwise a natural, editable English
 * wrapper around the page label + summary — same spirit as F-020's
 * `buildAskSeed`, but page-agnostic. Never auto-sent: the user reviews and
 * hits Send themselves.
 */
export function buildContextSeed(context: ChatContext): string {
  if (context.seedText !== undefined && context.seedText.trim() !== '') {
    return truncate(context.seedText, SEED_CHAR_BUDGET);
  }
  return truncate(
    [
      `I was just looking at ${context.pageLabel.trim()}:`,
      context.summary.trim(),
      'Can we talk about this?',
    ].join('\n\n'),
    SEED_CHAR_BUDGET,
  );
}
