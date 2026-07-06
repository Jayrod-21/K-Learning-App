/**
 * askSeed — build the "Ask about this" Chat seed message (F-020).
 *
 * Every review surface (Mistakes log, TOPIK mock reveal, TOPIK study reveal,
 * Diagnostic reveal) can hand a just-reviewed item to the Chat tutor for an
 * AI follow-up. The seed is ONE natural, editable English message wrapping
 * the Korean item content — it pre-fills the Chat composer; the user reviews
 * and hits Send themselves (never auto-sent).
 *
 * Deliberately decoupled from the nav manifest / any nav-item id: this module
 * only knows how to phrase the message and how to validate the router state
 * that carries it. Where Chat lives in the nav (F-016 may rename its entry)
 * is the button's concern, not the seed's.
 *
 * Threat model:
 *   - **Untrusted router state.** `history.state` is writable by any script
 *     in the page and survives reloads, so Chat must not trust its shape.
 *     `readChatSeedState` runtime-narrows the unknown into a `ChatSeedState`
 *     (or null), drops an unrecognised `mode`, and clamps `seedText` to the
 *     server's message cap so a forged state can never overflow the composer.
 *   - **No injection surface.** The seed is plain text rendered into a
 *     `<textarea>` value and later escaped as a React text node in the
 *     thread — never HTML.
 */
import type { ConversationMode } from '../types/domain';

/** Server-side cap on one chat message (`POST /conversation/:id/messages`). */
const MESSAGE_CHAR_CAP = 4000;

/**
 * Budget for the whole seed — well under the 4000-char message cap so the
 * user still has headroom to edit or append before sending.
 */
const SEED_CHAR_BUDGET = 3200;

/** A shared passage can be long — cap it so it can't eat the whole budget. */
const PASSAGE_CHAR_LIMIT = 1200;

/**
 * The reviewed-item fields a surface hands to `buildAskSeed`. Only `prompt`
 * and `correctText` are expected everywhere; the rest render as bracketed
 * optional sections and are omitted cleanly when absent or blank.
 */
export interface AskSeedInput {
  /** The item's question stem. */
  prompt: string;
  /** Display text of the correct choice. */
  correctText: string;
  /** The reveal's explanation, when the surface has one. */
  explanation?: string;
  /** The shared reading passage the item was asked about, when any. */
  passage?: string;
  /** The user's WRONG answer text — pass only when the pick was incorrect. */
  userPick?: string;
}

/**
 * Router state an "Ask about this" navigation carries to `/chat`. Chat reads
 * it once on mount, pre-fills the composer with `seedText`, prefers `mode`
 * when lazily starting a conversation, then clears the state so a reload or
 * back-navigation never re-seeds.
 */
export interface ChatSeedState {
  seedText: string;
  mode?: ConversationMode;
}

/** Hard truncation with a single-char ellipsis; no-op when under `max`. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Compose the seed message. Sections appear in reading order — prompt,
 * passage, answer key, the user's miss, the explanation — then a follow-up
 * question the tutor can act on. Absent/blank sections are omitted without
 * leaving stray labels or blank lines.
 */
export function buildAskSeed(input: AskSeedInput): string {
  const prompt = input.prompt.trim();
  const passage = input.passage?.trim() ?? '';
  const correctText = input.correctText.trim();
  const userPick = input.userPick?.trim() ?? '';
  const explanation = input.explanation?.trim() ?? '';

  const blocks: string[] = ['About this TOPIK question:'];
  if (prompt !== '') blocks.push(prompt);
  if (passage !== '') {
    blocks.push(`지문: ${truncate(passage, PASSAGE_CHAR_LIMIT)}`);
  }

  const answerLines: string[] = [];
  if (correctText !== '') answerLines.push(`Correct answer: ${correctText}`);
  if (userPick !== '') answerLines.push(`My answer: ${userPick} (incorrect)`);
  if (explanation !== '') answerLines.push(`Why: ${explanation}`);
  if (answerLines.length > 0) blocks.push(answerLines.join('\n'));

  blocks.push(
    'Can you explain this further — especially why the other options are wrong?',
  );

  return truncate(blocks.join('\n\n'), SEED_CHAR_BUDGET);
}

/** Every mode the server accepts — mirrors the `ConversationMode` union. */
const CONVERSATION_MODES: ReadonlyArray<ConversationMode> = [
  'casual',
  'business',
  'research',
  'topik_prep',
  'register_drill',
];

/**
 * Runtime-narrow untrusted router state into a `ChatSeedState`, or null when
 * it isn't one. History state is attacker-shapeable (see module threat
 * model), so every field is checked: `seedText` must be a non-blank string
 * (clamped to the message cap), and a `mode` that isn't a known
 * `ConversationMode` is dropped rather than passed to the server.
 */
export function readChatSeedState(state: unknown): ChatSeedState | null {
  if (typeof state !== 'object' || state === null) return null;
  const rec = state as Record<string, unknown>;
  const seedText = rec['seedText'];
  if (typeof seedText !== 'string' || seedText.trim() === '') return null;
  const out: ChatSeedState = {
    seedText: truncate(seedText, MESSAGE_CHAR_CAP),
  };
  const mode = rec['mode'];
  if (
    typeof mode === 'string' &&
    (CONVERSATION_MODES as ReadonlyArray<string>).includes(mode)
  ) {
    out.mode = mode as ConversationMode;
  }
  return out;
}
